/**
 * False-Positive Prevention Guardrail
 *
 * Prevents the agent from hallucinating implementations or claiming evidence
 * for code it never actually read.
 *
 * Strategy:
 *  - processInputStep: maintain a running set of "verifiedPaths" - every file
 *    path and symbolPath that was returned by a successful submission_read
 *    call (search results do NOT count). Also tracks truncated reads.
 *  - processOutputStep: when the final report text contains a COVERED or
 *    PARTIAL verdict:
 *    1. Cross-check all cited file/symbol paths against verifiedPaths.
 *    2. Detect speculative/hallucination language and flag it.
 *    3. Block (not just warn) code snippets that cannot be traced to any
 *       read content.
 *    4. Detect quantitative claims in reports where all evidence reads
 *       were truncated.
 *    5. AST symbol validation: when checks 1-4 pass, any path:symbolName
 *       reference in the report is looked up against
 *       astIndexerService.getStore().getSymbolsForFile(filePath). If a cited
 *       symbol does not exist in the AST index for that file, this is a
 *       blocking failure - the report is rejected with retry feedback naming
 *       the unresolved symbol(s), satisfying the requirement that "AST symbol
 *       references must match indexed data from astIndexerService."
 *  - If any check fails, abort with retry feedback naming the exact issue.
 *  - The `verify_constraint` tool gives the agent a cheap, synchronous way to
 *    validate a candidate symbol BEFORE writing it into the report, so this
 *    guardrail check should rarely fire in practice.
 */

import type {
    Processor,
    ProcessInputStepArgs,
    ProcessInputStepResult,
    ProcessOutputStepArgs,
    ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraToolInvocationPart, MessageList } from '@mastra/core/agent/message-list';
import type { MastraDBMessage } from '@mastra/core/memory';
import { tcAILogger } from '../../../../utils/logger';
import { RunStateStore, getRunKey } from './run-state';

// Lazy import of astIndexerService — falls back gracefully if unavailable.
// Uses the real ASTIndexerService API: astIndexerService.getStore().getSymbolsForFile(filePath)
// returns IndexedSymbol[] for a file; we check whether any indexed symbol's
// name matches the claimed symbolName, rather than guessing at a composite
// symbol-ID format for a direct getSymbol(filePath, symbolName) lookup.
export interface MinimalAstStore {
    getSymbolsForFile?: (filePath: string) => Array<{ name?: string; symbolName?: string }>;
}
export interface MinimalAstIndexer {
    getStore?: () => MinimalAstStore;
}

/**
 * No-op AST indexer stub for unit tests.
 *
 * The real `getAstIndexer()` lazily imports `../../../workspaces/review`,
 * which has heavy module-level side effects (full AST + text + vector
 * indexing of the workspace - 100s of seconds). That's fine in production
 * (the module is already warm by the time the agent runs), but unit tests
 * that don't pass an `astIndexerOverride` would otherwise trigger this real
 * import on first use and pay the full indexing cost.
 *
 * Passing `NO_OP_AST_INDEXER` as the second constructor argument makes
 * `FalsePositiveGuardrail` skip AST symbol validation entirely (no
 * `getStore`/`getSymbolsForFile`), exactly like "AST indexer unavailable" -
 * which is a safe, non-blocking no-op per Check 6's design.
 */
export const NO_OP_AST_INDEXER = async (): Promise<MinimalAstIndexer> => ({});

let _astIndexerService: MinimalAstIndexer | null = null;
async function getAstIndexer(): Promise<MinimalAstIndexer> {
    if (_astIndexerService !== null) return _astIndexerService;
    try {
        const mod = await import('../../../workspaces/review') as Record<string, unknown>;
        _astIndexerService = (mod.astIndexerService as MinimalAstIndexer) ?? {};
    } catch {
        _astIndexerService = {};
    }
    return _astIndexerService;
}

/**
 * Speculative/hallucination language patterns.
 * When the agent uses these to justify COVERED/PARTIAL without code evidence,
 * it's guessing rather than citing observed code.
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
    /\blikely\s+implement/i,
    /\bprobably\s+implement/i,
    /\bappears\s+to\s+implement/i,
    /\bseems\s+to\s+implement/i,
    /\bshould\s+implement/i,
    /\bmay\s+implement/i,
    /\bimplicit(?:ly)?\s+(?:implement|cover|handle)/i,
    /\bassume[sd]?\s+(?:to\s+be\s+)?implement/i,
    /\binferred?\s+(?:from|to\s+be)/i,
    /\bstandard\s+(?:pattern|practice)\s+(?:would|should)/i,
];

/** Quantitative claims that require full file content to verify. */
const QUANTITATIVE_CLAIM_RE = /\b(?:at least|minimum|≥|>=|exactly|creates?\s+\d+|\d+\s+(?:record|row|entr|item|compan|user|contact))/i;

/**
 * Matches claims that attribute a fact to a document BY DESCRIPTION rather
 * than by path - e.g. "the architecture document explicitly states...",
 * "the README confirms...", "architecture docs mention...". These are
 * checkable claims (a real document is being cited as evidence) but
 * extractClaimedPaths() won't catch them since no file path/extension is
 * present in the text - only a descriptive noun phrase.
 *
 * Real example (false-positive test data, REQ_01): the agent's only
 * File/Symbol citation was gtm-platform/backbone/models.py, but
 * 2 of 4 constraints were verified by citing quoted text attributed to
 * "the architecture document" / "architecture docs" - docs/architecture.md
 * was never read via submission_read, so these claims are unverifiable by
 * path-based checks but still functioned as the evidence that got those
 * constraints marked "Verified".
 */
const DOCUMENT_BY_DESCRIPTION_RE = new RegExp('\\bthe\\s+(\\w+(?:\\s+\\w+){0,2})\\s+(?:document|docs|doc|file|readme)\\s+(?:explicitly\\s+)?(?:states?|says?|confirms?|mentions?|notes?)\\b', "gi");

// ============================================================================
// Config
// ============================================================================

export interface FalsePositiveGuardrailConfig {
    /** Minimum length (chars) for an inline code block to count as "evidence". */
    minEvidenceLength: number;
    /** Max retries for unverified-evidence feedback loops. */
    maxRetries: number;
    /** Whether to validate AST symbol references via astIndexerService. */
    validateAstSymbols: boolean;
}

const DEFAULT_CONFIG: FalsePositiveGuardrailConfig = {
    minEvidenceLength: 10,
    maxRetries: 2,
    validateAstSymbols: true,
};

// ============================================================================
// Helpers
// ============================================================================

/** Normalize a path for comparison: strip leading "submission/", trailing slashes. */
function normalizePath(p: string): string {
    return p.trim().replace(/^submission\//, '').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Strip a trailing :symbolName / :symbolName:line-range suffix to get the bare file path. */
function fileOnly(p: string): string {
    const idx = p.lastIndexOf(':');
    if (idx === -1) return p;
    const rest = p.slice(idx + 1);
    if (/^[A-Za-z0-9_$]+(\:\d+-\d+)?$/.test(rest) || /^\d+-\d+$/.test(rest)) {
        return p.slice(0, idx);
    }
    return p;
}

/** Extract symbolName from a path:symbolName reference, or null if no symbol suffix. */
function symbolOnly(p: string): string | null {
    const idx = p.lastIndexOf(':');
    if (idx === -1) return null;
    const rest = p.slice(idx + 1);
    if (/^[A-Za-z0-9_$]+$/.test(rest)) return rest;
    return null;
}

/** Plausible "file path" token: recognizable code/doc/config extension. */
const FILE_PATH_RE = /([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs|prisma|sql|json|yaml|yml|md|toml|sh|env|cfg|ini|txt))(?::[A-Za-z0-9_$]+)?/g;

/**
 * Extract candidate file paths mentioned in the agent's final report.
 * Looks at "**File:**" lines, inline-code spans, and bare path tokens.
 */
function extractClaimedPaths(text: string): string[] {
    const claimed = new Set<string>();

    // **File:** `path/to/file.ts` or **File:** path/to/file.ts
    const fileLineRe = /\*\*File:?\*\*\s*`?([^\n`]+)`?/gi;
    for (const m of text.matchAll(fileLineRe)) {
        const candidate = m[1].trim();
        if (candidate && candidate.toLowerCase() !== 'n/a' && candidate.toLowerCase() !== 'none') {
            claimed.add(normalizePath(fileOnly(candidate)));
        }
    }

    // Inline code spans that look like file paths
    const inlineCodeRe = /`([^`]+)`/g;
    for (const m of text.matchAll(inlineCodeRe)) {
        const content = m[1].trim();
        const fileMatches = content.matchAll(FILE_PATH_RE);
        for (const fm of fileMatches) {
            claimed.add(normalizePath(fileOnly(fm[1])));
        }
    }

    // Bare path-like tokens elsewhere
    const bareMatches = text.matchAll(FILE_PATH_RE);
    for (const m of bareMatches) {
        claimed.add(normalizePath(fileOnly(m[1])));
    }

    return [...claimed].filter(p => p.length > 0 && p !== 'n/a');
}

/**
 * Extract path:symbolName pairs from the report text for AST validation.
 */
function extractClaimedSymbols(text: string): Array<{ filePath: string; symbolName: string }> {
    const results: Array<{ filePath: string; symbolName: string }> = [];
    // Match inline code spans with :symbol suffix
    const inlineCodeRe = /`([^`]+)`/g;
    for (const m of text.matchAll(inlineCodeRe)) {
        const content = m[1].trim();
        // e.g. src/auth.ts:login or src/db.ts:createUser
        const symRe = /([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs)):([A-Za-z0-9_$]+)/g;
        for (const sm of content.matchAll(symRe)) {
            results.push({ filePath: normalizePath(sm[1]), symbolName: sm[2] });
        }
    }
    // Also match bare path:symbol references (not in backticks)
    const bareSymRe = /\b([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs)):([A-Za-z0-9_$]+)\b/g;
    for (const m of text.matchAll(bareSymRe)) {
        results.push({ filePath: normalizePath(m[1]), symbolName: m[2] });
    }
    return results;
}

/** Detect verdict from the final report. */
function extractVerdict(text: string): 'COVERED' | 'PARTIAL' | 'MISSING' | null {
    const m = text.match(/\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING)/i);
    if (!m) return null;
    return m[1].toUpperCase() as 'COVERED' | 'PARTIAL' | 'MISSING';
}

/** Does the report look like the final structured report? */
function looksLikeFinalReport(text: string): boolean {
    return /#\s*Requirement.*Analysis Report/i.test(text)
        || /##\s*4\.\s*Coverage Assessment/i.test(text)
        || /\*\*?Verdict:?\*\*?/i.test(text);
}

/** Extract fenced code blocks from the report. */
function extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /```[\w-]*\n([\s\S]*?)```/g;
    for (const m of text.matchAll(re)) {
        blocks.push(m[1]);
    }
    return blocks;
}

/** Detect any speculative/hallucination language in the report text. */
function detectHallucinationPhrases(text: string): string[] {
    const found: string[] = [];
    for (const pattern of HALLUCINATION_PATTERNS) {
        const m = text.match(pattern);
        if (m) found.push(m[0]);
    }
    return found;
}

/**
 * Find "the X document/docs states/confirms/..." citations where X doesn't
 * correspond to any file actually read via submission_read. Returns the
 * matched phrases (e.g. "The architecture document explicitly states") for
 * the ones that have no backing read.
 *
 * This catches evidence that's checkable in principle (it names a document)
 * but was never verified - distinct from Check 5's hallucination-LANGUAGE
 * check, which looks for speculative wording about CODE regardless of
 * whether a document is named.
 */
function findUnverifiedDocumentCitations(text: string, readPaths: string[]): string[] {
    const unverified: string[] = [];
    const readPathsLower = readPaths.map(p => p.toLowerCase());

    for (const m of text.matchAll(DOCUMENT_BY_DESCRIPTION_RE)) {
        const nounPhrase = m[1].toLowerCase();
        // Skip generic/non-specific phrases that don't name a particular document
        if (['this', 'that', 'the', 'above', 'same', 'said'].includes(nounPhrase)) continue;

        const words = nounPhrase.split(/\s+/).filter(w => w.length > 2);
        const backedByRead = words.some(word =>
            readPathsLower.some(p => p.includes(word))
        );
        if (!backedByRead) {
            unverified.push(m[0]);
        }
    }
    return unverified;
}

// ============================================================================
// Per-run state
// ============================================================================

interface FalsePositiveRunState {
    /** Normalized file paths actually returned by successful submission_read. */
    verifiedPaths: Set<string>;
    /** Raw content from successful reads, used to trace snippet provenance. */
    readContents: { path: string; content: string; truncated: boolean }[];
}

function createFalsePositiveRunState(): FalsePositiveRunState {
    return { verifiedPaths: new Set<string>(), readContents: [] };
}

// ============================================================================
// Processor
// ============================================================================

export class FalsePositiveGuardrail implements Processor {
    id = 'false-positive-guardrail';

    private config: FalsePositiveGuardrailConfig;
    private runStates = new RunStateStore<FalsePositiveRunState>(createFalsePositiveRunState);
    /** Optional override for the AST indexer lookup, used by unit tests to avoid the real workspace-loading import. */
    private astIndexerOverride?: () => Promise<MinimalAstIndexer>;

    constructor(config: Partial<FalsePositiveGuardrailConfig> = {}, astIndexerOverride?: () => Promise<MinimalAstIndexer>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.astIndexerOverride = astIndexerOverride;
    }

    private getAstIndexer(): Promise<MinimalAstIndexer> {
        return this.astIndexerOverride ? this.astIndexerOverride() : getAstIndexer();
    }

    // --------------------------------------------------------------------
    // Input step: track verified (actually-read) paths
    // --------------------------------------------------------------------

    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
        const { messageList } = args;
        const state = this.runStates.get(getRunKey(args));

        for (const msg of messageList.get.all.db()) {
            if (!Array.isArray(msg.content?.parts)) continue;

            for (const part of msg.content.parts) {
                if (part.type !== 'tool-invocation') continue;
                const { toolInvocation } = part as MastraToolInvocationPart;
                if (toolInvocation?.toolName !== 'submission_read') continue;
                if (!toolInvocation.result || toolInvocation.state !== 'result') continue;

                const result = toolInvocation.result as Record<string, unknown>;
                if (typeof result.error === 'string') continue; // failed read

                const truncated = result.truncated === true;

                // Symbol read: { symbolPath, symbol: { bodyText, ... } }
                if (typeof result.symbolPath === 'string') {
                    const filePath = normalizePath(fileOnly(result.symbolPath));
                    state.verifiedPaths.add(filePath);
                    state.verifiedPaths.add(normalizePath(result.symbolPath));

                    const symbol = result.symbol as Record<string, unknown> | undefined;
                    const body = symbol?.bodyText;
                    if (typeof body === 'string' && body.length > 0 && !result._deduped) {
                        state.readContents.push({ path: filePath, content: body, truncated });
                    }
                }

                // File-with-symbols read: { filePath, symbols: [...] }
                if (typeof result.filePath === 'string' && Array.isArray(result.symbols)) {
                    const filePath = normalizePath(result.filePath as string);
                    state.verifiedPaths.add(filePath);
                    for (const sym of result.symbols as Record<string, unknown>[]) {
                        const name = (sym.symbolName || sym.symbol) as string | undefined;
                        if (name) state.verifiedPaths.add(`${filePath}:${name}`);
                        const body = sym.bodyText;
                        if (typeof body === 'string' && body.length > 0) {
                            state.readContents.push({ path: filePath, content: body, truncated });
                        }
                    }
                }

                // Document read: { filePath, content }
                if (typeof result.filePath === 'string' && typeof result.content === 'string') {
                    const filePath = normalizePath(result.filePath as string);
                    state.verifiedPaths.add(filePath);
                    if (!result._deduped) {
                        state.readContents.push({ path: filePath, content: result.content as string, truncated });
                    }
                }
            }
        }

        return undefined;
    }

    // --------------------------------------------------------------------
    // Output step: validate claimed evidence against verifiedPaths
    // --------------------------------------------------------------------

    processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult {
        const text = args.text?.trim() ?? '';

        if (!looksLikeFinalReport(text)) {
            return args.messageList;
        }

        const verdict = extractVerdict(text);
        // Only enforce evidence for positive findings.
        if (verdict !== 'COVERED' && verdict !== 'PARTIAL') {
            return args.messageList;
        }

        return this._processOutputStepAsync(args, text, verdict);
    }

    private async _processOutputStepAsync(
        args: ProcessOutputStepArgs,
        text: string,
        verdict: 'COVERED' | 'PARTIAL',
    ): Promise<MessageList | MastraDBMessage[]> {
        const state = this.runStates.get(getRunKey(args));
        const retryLimitReached = args.retryCount >= this.config.maxRetries;

        const feedbackLines: string[] = [];

        // ------------------------------------------------------------------
        // Check 1: Verified file paths
        // ------------------------------------------------------------------
        const claimedPaths = extractClaimedPaths(text);
        const unverified: string[] = [];

        for (const claimed of claimedPaths) {
            if (state.verifiedPaths.has(claimed)) continue;

            const fuzzyMatch = [...state.verifiedPaths].some(verified =>
                verified.endsWith(claimed) || claimed.endsWith(verified) ||
                verified.includes(claimed) || claimed.includes(verified)
            );
            if (fuzzyMatch) continue;

            unverified.push(claimed);
        }

        if (unverified.length > 0) {
            const MAX_LISTED = 8;
            const shown = unverified.slice(0, MAX_LISTED);
            const remainder = unverified.length - shown.length;
            feedbackLines.push(
                `Your report has a verdict of ${verdict} but cites file(s)/symbol(s) you never actually read with ` +
                `submission_read. Search snippets alone are NOT sufficient evidence.\n` +
                `The following path(s) referenced in your evidence were never read via submission_read: ` +
                shown.map(p => `"${p}"`).join(', ') +
                (remainder > 0 ? `, and ${remainder} more` : '') + '.\n' +
                'For each of these, either: (a) call submission_read on the exact path and incorporate the ' +
                'real content into your evidence, or (b) remove the claim and adjust the verdict/score accordingly.'
            );
        }

        // ------------------------------------------------------------------
        // Check 2: COVERED with zero reads
        // ------------------------------------------------------------------
        if (verdict === 'COVERED' && state.readContents.length === 0) {
            feedbackLines.push(
                'You declared the requirement COVERED but have not performed any successful submission_read ' +
                'calls. A COVERED verdict requires reading actual implementation code as evidence.'
            );
        }

        // ------------------------------------------------------------------
        // Check 3: Code snippet traceability (BLOCKING — not just a warning)
        // ------------------------------------------------------------------
        const codeBlocks = extractCodeBlocks(text).filter(b => b.trim().length >= this.config.minEvidenceLength);
        const untraceableBlocks = codeBlocks.filter(block => {
            const normalizedBlock = block.replace(/\s+/g, ' ').trim();
            if (normalizedBlock.length === 0) return false;
            const sample = normalizedBlock.slice(0, Math.min(40, normalizedBlock.length));
            return !state.readContents.some(rc => rc.content.replace(/\s+/g, ' ').includes(sample));
        });

        if (untraceableBlocks.length > 0 && state.readContents.length > 0) {
            // Only flag if we DO have read content — if we have no reads, Check 2 already fires.
            feedbackLines.push(
                `${untraceableBlocks.length} code snippet(s) in your report cannot be traced to any content ` +
                `returned by submission_read. These snippets appear to be fabricated or copied from search ` +
                `snippets (which are not sufficient evidence). Either (a) perform submission_read on the ` +
                `relevant file(s) so you have the actual code, or (b) remove the unverifiable snippet(s) ` +
                `and adjust your verdict/score.`
            );
        }

        // ------------------------------------------------------------------
        // Check 4: Truncated-read quantitative claims
        // ------------------------------------------------------------------
        const allReadsTruncated = state.readContents.length > 0 && state.readContents.every(r => r.truncated);
        if (allReadsTruncated && QUANTITATIVE_CLAIM_RE.test(text)) {
            feedbackLines.push(
                'Your report makes quantitative claims (counts, thresholds, "at least N") but ALL of your ' +
                'submission_read results were truncated — you cannot reliably count records or verify thresholds ' +
                'from incomplete file content. Either read specific symbols/sections to get the full content, ' +
                'or remove the quantitative claims and base your verdict on what you actually verified.'
            );
        }

        // ------------------------------------------------------------------
        // Check 5: Speculative/hallucination language
        // ------------------------------------------------------------------
        const hallucinationPhrases = detectHallucinationPhrases(text);
        if (hallucinationPhrases.length > 0 && state.readContents.length === 0) {
            feedbackLines.push(
                `Your report uses speculative language ("${hallucinationPhrases[0]}" and similar) to justify ` +
                `a ${verdict} verdict, but contains no code evidence from submission_read. ` +
                `Speculative claims without read evidence are not acceptable. Read the relevant files and ` +
                `provide actual code snippets, or downgrade the verdict to MISSING.`
            );
        }

        // ------------------------------------------------------------------
        // Check 5b: Unverified document-by-description citations
        //
        // Catches: "the architecture document explicitly states...",
        // "the README confirms...", "architecture docs mention..." where the
        // named document was never read via submission_read. This is the real
        // false-positive pattern found in the provided test data (REQ_01):
        // constraints were marked "Verified" by citing quoted phrases
        // attributed to "the architecture document" - but docs/architecture.md
        // never appeared as a **File:** line and was never read, so all
        // extractClaimedPaths()/Check 1 could see was models.py (legitimately
        // read). The constraint-table evidence was 100% unverified prose.
        //
        // Only fires when no other check already triggered (don't pile on).
        // Avoids false positives by skipping when the document noun matches a
        // word in an actually-read path (e.g. "the models file confirms" ->
        // 'models' appears in 'backbone/models.py' -> skip).
        // ------------------------------------------------------------------
        const unverifiedDocCitations = findUnverifiedDocumentCitations(text, [...state.verifiedPaths]);
        if (unverifiedDocCitations.length > 0 && feedbackLines.length === 0) {
            const MAX_SHOWN = 3;
            const shown = unverifiedDocCitations.slice(0, MAX_SHOWN);
            const remainder = unverifiedDocCitations.length - shown.length;
            feedbackLines.push(
                `Your report attributes evidence to a document by description rather than by reading it: ` +
                shown.map(s => `"${s}"`).join(', ') +
                (remainder > 0 ? ` (and ${remainder} more)` : '') + `. ` +
                `This evidence cannot be verified because the document was never read via submission_read. ` +
                `Either: (a) call submission_read on the actual file (e.g. docs/architecture.md, README.md) ` +
                `and quote the relevant content directly, or (b) remove the constraint-verification claim ` +
                `and adjust the verdict/score to reflect only what you can actually cite from code you read.`
            );
        }

        // ------------------------------------------------------------------
        // Check 6: AST symbol validation (blocking)
        // ------------------------------------------------------------------
        // Only run when path-level checks already pass, to avoid double-flagging
        // a path that's already being rejected for a more fundamental reason.
        if (this.config.validateAstSymbols && unverified.length === 0 && feedbackLines.length === 0) {
            const claimedSymbols = extractClaimedSymbols(text);
            if (claimedSymbols.length > 0) {
                try {
                    const indexer = await this.getAstIndexer();
                    const store = indexer?.getStore?.();
                    if (store?.getSymbolsForFile) {
                        const notInAst: string[] = [];
                        for (const { filePath, symbolName } of claimedSymbols) {
                            try {
                                const symbols = store.getSymbolsForFile(filePath) ?? [];
                                const found = symbols.some(s => (s.name ?? s.symbolName) === symbolName);
                                if (!found) notInAst.push(`${filePath}:${symbolName}`);
                            } catch {
                                // Individual symbol lookup failed — skip, don't fail the whole check
                            }
                        }
                        if (notInAst.length > 0) {
                            feedbackLines.push(
                                `Your report cites the following symbol(s) that do not exist in the AST index ` +
                                `for the file(s) you read: ${notInAst.map(s => `"${s}"`).join(', ')}. ` +
                                `This usually means the symbol name is wrong, was renamed, or doesn't exist in the ` +
                                `actual file. Use verify_constraint to confirm the correct symbol name before citing it, ` +
                                `or remove the reference and adjust your evidence/verdict accordingly.`
                            );
                            tcAILogger.warn(`[false-positive-guardrail] AST symbol validation failed - requesting retry`, {
                                notInAst,
                                verdict,
                            });
                        }
                    }
                } catch {
                    // AST indexer unavailable — don't block on infrastructure issues
                }
            }
        }

        // ------------------------------------------------------------------
        // Decide: accept or retry
        // ------------------------------------------------------------------
        if (feedbackLines.length === 0) {
            tcAILogger.info(`[false-positive-guardrail] Evidence validated`, {
                verdict,
                claimedPaths: claimedPaths.length,
                verifiedPaths: state.verifiedPaths.size,
            });
            return args.messageList;
        }

        if (retryLimitReached) {
            tcAILogger.warn(`[false-positive-guardrail] Evidence issues found but retry limit reached - accepting`, {
                verdict,
                issues: feedbackLines.length,
                retryCount: args.retryCount,
            });
            return args.messageList;
        }

        const reason = feedbackLines.join('\n\n');
        tcAILogger.warn(`[false-positive-guardrail] Unverified/speculative evidence in ${verdict} report - requesting retry`, {
            unverified,
            untraceableBlocks: untraceableBlocks.length,
            hallucinationPhrases,
            retryCount: args.retryCount,
        });

        args.abort(reason, { retry: true });
        return args.messageList;
    }

    /** Snapshot of currently verified paths for a run (for tests / debugging). */
    getVerifiedPaths(threadId: string): Set<string> {
        return new Set(this.runStates.get(threadId).verifiedPaths);
    }

    /** Clear accumulated state for a finished run. */
    clearRun(threadId: string): void {
        this.runStates.clear(threadId);
    }
}
