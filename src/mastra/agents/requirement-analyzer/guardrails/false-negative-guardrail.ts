/**
 * False-Negative Minimization Guardrail
 *
 * Prevents the agent from concluding "MISSING" / "not implemented" without
 * having executed a sufficient, *diverse* search-and-read effort, and without
 * having tried domain-synonym variants of the requirement's key terms.
 *
 * Strategy:
 *  - processInputStep: tracks every submission_search / submission_read call
 *    (query, path, success/empty) across the whole run.
 *  - processOutputStep: when the model's final text contains a report with
 *    Verdict: MISSING (or PARTIAL with "Not Found" rows), validate that:
 *      1. minSearchAttempts distinct search queries were executed
 *      2. at least one submission_read of a real file/symbol happened
 *      3. domain-synonym searches for the requirement's key terms were tried
 *    If validation fails AND retries remain, abort with structured feedback
 *    that lists exactly which synonym searches / reads are still missing.
 *  - Handles empty/junk codebases: if the inventory (file list) is empty or
 *    near-empty, and the agent already searched >= minSearchAttempts times
 *    with zero results, MISSING is accepted immediately (no infinite loop).
 */

import type {
    Processor,
    ProcessInputStepArgs,
    ProcessInputStepResult,
    ProcessOutputStepArgs,
    ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraToolInvocationPart } from '@mastra/core/agent/message-list';
import { tcAILogger } from '../../../../utils/logger';

import { buildSynonymLookup } from './domain-concepts';
import { RunStateStore, getRunKey } from './run-state';

// ============================================================================
// Domain synonym map - derived from the SAME table rendered into
// AGENT_INSTRUCTIONS (see domain-concepts.ts), so the guardrail can never
// drift out of sync with what the prompt tells the model to search for.
// ============================================================================

const DOMAIN_SYNONYMS: Record<string, string[]> = buildSynonymLookup();

// ============================================================================
// Config
// ============================================================================

export interface FalseNegativeGuardrailConfig {
    /** Minimum distinct search queries before a MISSING verdict is trusted. */
    minSearchAttempts: number;
    /** Minimum submission_read calls (with real content returned) before MISSING is trusted. */
    minReadAttempts: number;
    /** Max retries for insufficient-search feedback loops. */
    maxRetries: number;
}

const DEFAULT_CONFIG: FalseNegativeGuardrailConfig = {
    minSearchAttempts: 3,
    minReadAttempts: 1,
    maxRetries: 2,
};

// ============================================================================
// Tracking state
// ============================================================================

interface SearchAttempt {
    query: string;
    step: number;
    resultCount: number; // files + documents found
}

interface ReadAttempt {
    path: string;
    step: number;
    hadError: boolean;
    truncated?: boolean;
    filePath?: string;
}

interface ToolCallSummary {
    tool: string;
    query?: string;
    path?: string;
    step: number;
    resultCount?: number;
}

/** Per-(requirement-analysis-run) state, keyed by threadId. */
interface FalseNegativeRunState {
    searchAttempts: SearchAttempt[];
    readAttempts: ReadAttempt[];
    currentStep: number;
    /** Total files+documents in the indexed inventory - to detect empty/junk submissions. */
    inventorySize: number;
    /** Requirement text captured from the first user message (set once). */
    requirementText: string | null;
}

function createFalseNegativeRunState(): FalseNegativeRunState {
    return {
        searchAttempts: [],
        readAttempts: [],
        currentStep: 0,
        inventorySize: 0,
        requirementText: null,
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract candidate "concept" keywords from requirement text by matching
 * against the DOMAIN_SYNONYMS table. Case-insensitive substring match.
 */
function extractConcepts(requirementText: string): string[] {
    const lower = requirementText.toLowerCase();
    const found = new Set<string>();
    for (const concept of Object.keys(DOMAIN_SYNONYMS)) {
        if (lower.includes(concept)) {
            found.add(concept);
        }
    }
    return [...found];
}

/**
 * Given concepts found in the requirement, and queries already executed,
 * return synonym terms that have NOT yet been searched for.
 */
function findMissingSynonymSearches(concepts: string[], executedQueries: string[]): string[] {
    const executedLower = executedQueries.map(q => q.toLowerCase());
    const missing = new Set<string>();

    for (const concept of concepts) {
        const synonyms = DOMAIN_SYNONYMS[concept] || [];
        const anyTried = synonyms.some(syn =>
            executedLower.some(q => q.includes(syn.toLowerCase()))
        );
        if (!anyTried) {
            // Suggest the top 3 synonyms for this concept
            synonyms.slice(0, 3).forEach(s => missing.add(s));
        }
    }

    return [...missing];
}

/**
 * Extract literal file/path references mentioned in the requirement text
 * (title, description, constraints) - e.g. "docs/agents.md", "schema.prisma",
 * "RunStatus.tsx", "/prospect/[runId]". These are the files the agent is
 * instructed to read FIRST and FULLY per the prompt's "Read files mentioned
 * in the requirement FIRST!" rule. If the agent concludes MISSING/PARTIAL
 * without having read one of these, or read it but got a truncated result,
 * that's a strong false-negative risk signal independent of search breadth.
 */
const FILE_REF_RE = /([a-zA-Z0-9_\-./[\]]+\.(?:ts|tsx|js|jsx|py|md|prisma|json|sql|yaml|yml|toml))/g;

function extractFileReferences(requirementText: string): string[] {
    const refs = new Set<string>();
    for (const m of requirementText.matchAll(FILE_REF_RE)) {
        refs.add(m[1].replace(/^\.?\//, ''));
    }
    return [...refs];
}

/** Normalize a path for loose comparison: strip submission/ prefix and leading ./ */
function normalizeForCompare(p: string): string {
    return p.trim().replace(/^submission\//, '').replace(/^\.\//, '');
}


function declaresMissingVerdict(text: string): boolean {
    return /\*\*?Verdict:?\*\*?\s*MISSING/i.test(text)
        || /Coverage Verdict[:\s]*MISSING/i.test(text)
        || /requirement\s+is\s+(NOT\s+(IMPLEMENTED|FOUND|COVERED))/i.test(text);
}

/** PARTIAL or MISSING - i.e. the report claims something is NOT fully covered. */
function declaresNonCoveredVerdict(text: string): boolean {
    return /\*\*?Verdict:?\*\*?\s*(MISSING|PARTIAL)/i.test(text)
        || declaresMissingVerdict(text);
}

/**
 * Quick check: does the report's text contain a "# Requirement Analysis Report"
 * style header, i.e. is this a final-output candidate (vs. mid-analysis chatter)?
 */
function looksLikeFinalReport(text: string): boolean {
    return /#\s*Requirement.*Analysis Report/i.test(text)
        || /##\s*4\.\s*Coverage Assessment/i.test(text)
        || /\*\*?Verdict:?\*\*?/i.test(text);
}

// ============================================================================
// Processor
// ============================================================================

export class FalseNegativeGuardrail implements Processor {
    id = 'false-negative-guardrail';

    private config: FalseNegativeGuardrailConfig;
    private runStates = new RunStateStore<FalseNegativeRunState>(createFalseNegativeRunState);

    constructor(config: Partial<FalseNegativeGuardrailConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // --------------------------------------------------------------------
    // Input step: passive tracking of tool invocations + inventory size
    // --------------------------------------------------------------------

    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
        const { messageList, stepNumber, systemMessages } = args;
        const state = this.runStates.get(getRunKey(args));
        state.currentStep = stepNumber;

        // Capture requirement text once (first user message) for concept extraction.
        if (!state.requirementText) {
            for (const msg of messageList.get.all.db()) {
                if (msg.role !== 'user') continue;
                const parts = msg.content?.parts;
                if (!Array.isArray(parts)) continue;
                for (const part of parts) {
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 20) {
                        state.requirementText = part.text;
                        break;
                    }
                }
                if (state.requirementText) break;
            }
        }

        // Derive inventory size from the "files available for review" system message
        // injected by ToolResultManager, if present.
        for (const msg of systemMessages) {
            if (typeof msg.content !== 'string') continue;
            const m = msg.content.match(/The following files are available for requirement review[^:]*:\n([\s\S]*)/i);
            if (m) {
                const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
                state.inventorySize = lines.length;
            }
        }

        // Track new tool-invocation results since last step.
        for (const msg of messageList.get.all.db()) {
            if (!Array.isArray(msg.content?.parts)) continue;

            for (const part of msg.content.parts) {
                if (part.type !== 'tool-invocation') continue;
                const { toolInvocation } = part as MastraToolInvocationPart;
                if (!toolInvocation?.result || toolInvocation.state !== 'result') continue;

                const result = toolInvocation.result as Record<string, unknown>;
                if (result._dropped || result._compressed) continue;

                if (toolInvocation.toolName === 'submission_search') {
                    const query = (toolInvocation.args as { query?: string })?.query || '';
                    const alreadyTracked = state.searchAttempts.some(
                        a => a.query === query
                    );
                    if (!alreadyTracked && query) {
                        const files = (result.files as unknown[]) || [];
                        const documents = (result.documents as unknown[]) || [];
                        const skippedSymbols = (result._skippedSymbols as unknown[]) || [];
                        const skippedDocs = (result._skippedDocuments as unknown[]) || [];
                        const resultCount = files.length + documents.length + skippedSymbols.length + skippedDocs.length;
                        state.searchAttempts.push({ query, step: state.currentStep, resultCount });
                    }
                }

                // submission_search_terms runs multiple sub-queries in one call.
                // Each sub-query must count toward minSearchAttempts and synonym
                // coverage — the agent followed instructions by batching, so it
                // should not be penalised for not also making individual calls.
                if (toolInvocation.toolName === 'submission_search_terms') {
                    const queries = (toolInvocation.args as { queries?: string[] })?.queries || [];
                    const perQuery = (result.perQuery as Array<{ query: string; fileCount?: number; symbolCount?: number; documentCount?: number }>) || [];
                    for (const q of queries) {
                        const alreadyTracked = state.searchAttempts.some(a => a.query === q);
                        if (!alreadyTracked && q) {
                            const pq = perQuery.find(p => p.query === q);
                            const resultCount = (pq?.fileCount ?? 0) + (pq?.symbolCount ?? 0) + (pq?.documentCount ?? 0);
                            state.searchAttempts.push({ query: q, step: state.currentStep, resultCount });
                        }
                    }
                }

                if (toolInvocation.toolName === 'submission_read') {
                    const path = (toolInvocation.args as { path?: string })?.path || '';
                    const alreadyTracked = state.readAttempts.some(
                        a => a.path === path
                    );
                    if (!alreadyTracked && path) {
                        const hadError = typeof result.error === 'string';
                        const truncated = result.truncated === true;
                        const filePath = (result.filePath as string) || path;
                        state.readAttempts.push({ path, step: state.currentStep, hadError, truncated, filePath });
                    }
                }
            }
        }

        // Inject proactive synonym guidance when the agent has searched 2+ times
        // but hasn't tried domain synonyms yet. This saves a full retry cycle
        // (~30-45s on qwen3:4b) by correcting course before a MISSING verdict.
        const distinctQueries = [...new Set(state.searchAttempts.map(s => s.query))];
        if (distinctQueries.length >= 2 && state.readAttempts.length === 0) {
            const concepts = state.requirementText ? extractConcepts(state.requirementText) : [];
            const missingSynonyms = findMissingSynonymSearches(concepts, distinctQueries);

            if (missingSynonyms.length > 0) {
                const guidance = `[Search Guidance] You have run ${distinctQueries.length} search(es) but haven't yet tried these domain-specific code patterns for this requirement: ${missingSynonyms.slice(0, 5).map(s => `"${s}"`).join(', ')}. Try submission_search_terms([${missingSynonyms.slice(0, 4).map(s => `"${s}"`).join(', ')}]) before concluding not implemented. Also, use submission_read on any promising file paths before finalizing your verdict.`;
                return {
                    systemMessages: [
                        ...systemMessages,
                        { role: 'system' as const, content: guidance },
                    ],
                };
            }
        }

        // Inject truncation warning: if a file mentioned in the requirement was
        // read but truncated, warn the agent BEFORE it writes the final report.
        if (state.requirementText) {
            const referencedFiles = extractFileReferences(state.requirementText);
            const truncatedReferenced = referencedFiles.filter(ref => {
                const normalizedRef = normalizeForCompare(ref);
                return state.readAttempts.some(r =>
                    r.truncated && !r.hadError &&
                    (normalizeForCompare(r.filePath || r.path) === normalizedRef ||
                     normalizeForCompare(r.filePath || r.path).endsWith(normalizedRef))
                );
            });

            if (truncatedReferenced.length > 0) {
                const warning = `[Truncation Warning] The following file(s) referenced in the requirement were read but TRUNCATED: ${truncatedReferenced.map(f => `"${f}"`).join(', ')}. The relevant content may be in the unread portion. Use submission_read("file.ext:specificSymbol") to read specific sections, or use submission_search_terms to locate the specific content before concluding MISSING or PARTIAL.`;
                return {
                    systemMessages: [
                        ...systemMessages,
                        { role: 'system' as const, content: warning },
                    ],
                };
            }
        }

        return undefined;
    }

    // --------------------------------------------------------------------
    // Output step: validate MISSING verdicts against search/read effort
    // --------------------------------------------------------------------

    processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult {
        const text = args.text?.trim() ?? '';

        // Only validate when the model is producing what looks like the final report.
        if (!looksLikeFinalReport(text)) {
            return args.messageList;
        }

        const state = this.runStates.get(getRunKey(args));
        const retryLimitReached = args.retryCount >= this.config.maxRetries;

        // --------------------------------------------------------------
        // Check 0 (applies to PARTIAL and MISSING): files explicitly named
        // in the requirement text that were either NEVER read, or were read
        // but TRUNCATED. This targets the dominant real-world false-negative
        // pattern: "the agent read docs/agents.md but the relevant section
        // (at line 37) was past the truncation cutoff / missed in the
        // model's summary, so it concluded the content wasn't there."
        // --------------------------------------------------------------
        if (declaresNonCoveredVerdict(text) && !retryLimitReached) {
            const referencedFiles = state.requirementText ? extractFileReferences(state.requirementText) : [];

            const unreadReferencedFiles: string[] = [];
            const truncatedReferencedFiles: string[] = [];

            for (const ref of referencedFiles) {
                const normalizedRef = normalizeForCompare(ref);
                const matchingReads = state.readAttempts.filter(r => {
                    const candidate = normalizeForCompare(r.filePath || r.path);
                    return candidate === normalizedRef || candidate.endsWith(normalizedRef) || normalizedRef.endsWith(candidate);
                });

                if (matchingReads.length === 0) {
                    unreadReferencedFiles.push(ref);
                } else if (matchingReads.some(r => r.truncated && !r.hadError)) {
                    truncatedReferencedFiles.push(ref);
                }
            }

            if (unreadReferencedFiles.length > 0 || truncatedReferencedFiles.length > 0) {
                const lines: string[] = [
                    'The requirement text explicitly references the following file(s), which the instructions require you ' +
                    'to read FULLY before concluding this requirement is not covered:',
                ];

                if (unreadReferencedFiles.length > 0) {
                    lines.push(
                        `- NOT YET READ: ${unreadReferencedFiles.map(f => `"${f}"`).join(', ')}. ` +
                        'Use submission_read on each of these before finalizing your verdict.'
                    );
                }

                if (truncatedReferencedFiles.length > 0) {
                    lines.push(
                        `- READ BUT TRUNCATED: ${truncatedReferencedFiles.map(f => `"${f}"`).join(', ')}. ` +
                        'Your previous submission_read of this file was truncated and may not contain the section ' +
                        'relevant to this requirement. Try reading specific SYMBOLS within this file ' +
                        '("file.ext:symbolName") to get untruncated content for the relevant section, ' +
                        'or use submission_search_terms with terms from the requirement to locate the specific section.'
                    );
                }

                lines.push(
                    'After reading the full content of these files, re-evaluate whether the requirement is actually ' +
                    'COVERED or PARTIAL before reporting MISSING/PARTIAL.'
                );

                tcAILogger.warn(`[${this.id}] Non-COVERED verdict but requirement-referenced file(s) unread/truncated - requesting retry`, {
                    unreadReferencedFiles,
                    truncatedReferencedFiles,
                    retryCount: args.retryCount,
                });

                args.abort(lines.join('\n'), { retry: true });
                return args.messageList; // stop here — don't let search-effort check overwrite this message
            }
        }

        if (!declaresMissingVerdict(text)) {
            // COVERED / PARTIAL (without the above file-mention issue) - the
            // remaining checks below are MISSING-specific.
            return args.messageList;
        }

        const distinctQueries = [...new Set(state.searchAttempts.map(s => s.query))];
        const successfulReads = state.readAttempts.filter(r => !r.hadError);

        // --------------------------------------------------------------
        // Empty/junk submission guard: if the inventory is essentially
        // empty AND the agent has already searched the minimum number of
        // times with zero hits, accept MISSING immediately - do not loop.
        // --------------------------------------------------------------
        const allSearchesEmpty = state.searchAttempts.length > 0
            && state.searchAttempts.every(s => s.resultCount === 0);

        if (state.inventorySize <= 1 && allSearchesEmpty && distinctQueries.length >= this.config.minSearchAttempts) {
            tcAILogger.info(`[${this.id}] Empty/junk submission detected - accepting MISSING verdict without further retries`, {
                inventorySize: state.inventorySize,
                distinctQueries: distinctQueries.length,
            });
            return args.messageList;
        }

        // --------------------------------------------------------------
        // Check 1: minimum distinct search attempts
        // --------------------------------------------------------------
        const searchDeficit = Math.max(0, this.config.minSearchAttempts - distinctQueries.length);

        // --------------------------------------------------------------
        // Check 2: minimum successful reads
        // --------------------------------------------------------------
        const readDeficit = Math.max(0, this.config.minReadAttempts - successfulReads.length);

        // --------------------------------------------------------------
        // Check 3: domain-synonym coverage based on requirement text
        // --------------------------------------------------------------
        const concepts = state.requirementText ? extractConcepts(state.requirementText) : [];
        const missingSynonyms = findMissingSynonymSearches(concepts, distinctQueries);

        const hasDeficiency = searchDeficit > 0 || readDeficit > 0 || missingSynonyms.length > 0;

        if (!hasDeficiency) {
            tcAILogger.info(`[${this.id}] MISSING verdict validated - sufficient search/read effort`, {
                distinctQueries: distinctQueries.length,
                successfulReads: successfulReads.length,
                concepts,
            });
            return args.messageList;
        }

        if (retryLimitReached) {
            tcAILogger.warn(`[${this.id}] MISSING verdict has search deficiencies but retry limit reached - accepting`, {
                searchDeficit,
                readDeficit,
                missingSynonyms,
                retryCount: args.retryCount,
            });
            return args.messageList;
        }

        // --------------------------------------------------------------
        // Build retry feedback with concrete next steps
        // --------------------------------------------------------------
        const feedbackLines: string[] = [
            'Your conclusion is "MISSING / not implemented", but your search effort so far is insufficient ' +
            'to be confident the requirement is truly absent. Before finalizing MISSING, do ALL of the following:',
        ];

        if (searchDeficit > 0) {
            const MAX_LISTED = 8;
            const shownQueries = distinctQueries.slice(-MAX_LISTED); // most recent are most relevant
            const omitted = distinctQueries.length - shownQueries.length;
            feedbackLines.push(
                `- Run at least ${searchDeficit} more DIFFERENT submission_search queries ` +
                `(you have run ${distinctQueries.length}/${this.config.minSearchAttempts} distinct queries so far` +
                (omitted > 0 ? `, most recent ${shownQueries.length}` : '') + `: ` +
                `${shownQueries.map(q => `"${q}"`).join(', ') || 'none'}).`
            );
        }

        if (readDeficit > 0) {
            feedbackLines.push(
                `- Use submission_read on at least ${this.config.minReadAttempts} concrete file(s)/symbol(s) ` +
                `that plausibly relate to this requirement before concluding it is missing ` +
                `(successful reads so far: ${successfulReads.length}).`
            );
        }

        if (missingSynonyms.length > 0) {
            feedbackLines.push(
                `- Search for these domain-specific code patterns you haven't tried yet: ` +
                missingSynonyms.slice(0, 6).map(s => `"${s}"`).join(', ') + '.'
            );
        }

        feedbackLines.push(
            'After these additional searches/reads, if you STILL find no evidence, you may report MISSING ' +
            '— but include the additional queries/reads in your "What was searched" notes.'
        );

        const reason = feedbackLines.join('\n');

        tcAILogger.warn(`[${this.id}] MISSING verdict rejected - insufficient search effort, requesting retry`, {
            searchDeficit,
            readDeficit,
            missingSynonyms,
            retryCount: args.retryCount,
        });

        args.abort(reason, { retry: true });

        return args.messageList;
    }

    /**
     * Expose a summary of tool-call history for a given run, useful for
     * debugging / for the Output Quality Guardrail to reuse.
     */
    getToolCallHistory(threadId: string): ToolCallSummary[] {
        const state = this.runStates.get(threadId);
        const fromSearches: ToolCallSummary[] = state.searchAttempts.map(s => ({
            tool: 'submission_search',
            query: s.query,
            step: s.step,
            resultCount: s.resultCount,
        }));
        const fromReads: ToolCallSummary[] = state.readAttempts.map(r => ({
            tool: 'submission_read',
            path: r.path,
            step: r.step,
        }));
        return [...fromSearches, ...fromReads].sort((a, b) => a.step - b.step);
    }

    /** Clear accumulated state for a finished run (call when a thread completes). */
    clearRun(threadId: string): void {
        this.runStates.clear(threadId);
    }
}
