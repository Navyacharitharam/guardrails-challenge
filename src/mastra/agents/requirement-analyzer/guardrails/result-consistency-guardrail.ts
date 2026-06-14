/**
 * Result Consistency Guardrail
 *
 * Ensures that repeated runs of the SAME requirement against the SAME
 * codebase yield the SAME (or near-identical, within tolerance) coverage
 * score and verdict.
 *
 * Since the underlying LLM (qwen3:4b-instruct via Ollama) is inherently
 * non-deterministic even at low temperature, true bit-identical outputs
 * across runs are not realistic. Instead this guardrail:
 *
 *  1. Computes a stable "codebase fingerprint" for the requirement: a hash
 *     of (requirementId + sorted list of indexed file paths + sorted list
 *     of file content hashes for files actually read during THIS run).
 *     This fingerprint is deterministic given the same requirement + codebase.
 *
 *  2. Persists (requirementId, fingerprint) -> { verdict, coverageScore,
 *     constraintStatuses } to a LibSQL-backed store (or in-memory map in
 *     tests) after a SUCCESSFUL run.
 *
 *  3. On a SUBSEQUENT run with the same fingerprint:
 *     - If a prior result exists and the new result's coverageScore differs
 *       by more than `scoreTolerance`, OR the verdict differs, the
 *       processor logs a consistency warning and (if retries remain)
 *       requests the agent to re-verify by re-reading the SAME evidence
 *       files referenced in the prior run, focusing on the constraints
 *       whose status flipped.
 *     - If the new result is within tolerance, it's accepted and the
 *       stored result is updated (rolling average) to dampen drift.
 *
 * This both (a) catches wild non-deterministic swings (e.g. COVERED on one
 * run, MISSING on the next for identical inputs - a sign of a flaky/low
 * quality analysis) and (b) provides a feedback loop that nudges the model
 * toward convergent answers without requiring bit-for-bit determinism.
 */

import { createHash } from 'crypto';
import type {
    Processor,
    ProcessInputStepArgs,
    ProcessInputStepResult,
    ProcessOutputStepArgs,
    ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraToolInvocationPart } from '@mastra/core/agent/message-list';
import { tcAILogger } from '../../../../utils/logger';
import { OutputQualityGuardrail, type ReportFields } from './output-quality-guardrail';
import { RunStateStore, getRunKey } from './run-state';

// ============================================================================
// Config
// ============================================================================

export interface ResultConsistencyGuardrailConfig {
    /** Allowed absolute difference in coverageScore between runs before flagging. */
    scoreTolerance: number;
    /** Max retries for consistency-mismatch feedback loops. */
    maxRetries: number;
}

const DEFAULT_CONFIG: ResultConsistencyGuardrailConfig = {
    scoreTolerance: 0.15,
    maxRetries: 1, // consistency retries are expensive - keep tight
};

// ============================================================================
// Store interface (pluggable - default in-memory; LibSQL impl provided separately)
// ============================================================================

export interface StoredResult {
    verdict: 'COVERED' | 'PARTIAL' | 'MISSING';
    coverageScore: number;
    constraintStatuses: Record<string, string>; // constraint text -> status
    sampleCount: number;
    updatedAt: number;
}

export interface ConsistencyStore {
    get(fingerprint: string): Promise<StoredResult | undefined>;
    set(fingerprint: string, result: StoredResult): Promise<void>;
}

/**
 * Default in-memory store. In production, swap for a LibSQL-backed
 * implementation (see `libsql-consistency-store.ts`) configured with the
 * same LibSQLStore instance used for agent memory, so results persist
 * across process restarts and are included in the submitted .db artifact.
 */
export class InMemoryConsistencyStore implements ConsistencyStore {
    private map = new Map<string, StoredResult>();

    async get(fingerprint: string): Promise<StoredResult | undefined> {
        return this.map.get(fingerprint);
    }

    async set(fingerprint: string, result: StoredResult): Promise<void> {
        this.map.set(fingerprint, result);
    }

    /** Clear all stored results. Used in tests for isolation between test cases. */
    clearAll(): void {
        this.map.clear();
    }
}

// ============================================================================
// Helpers
// ============================================================================

function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function looksLikeFinalReport(text: string): boolean {
    return /#\s*Requirement.*Analysis Report/i.test(text)
        || /##\s*4\.\s*Coverage Assessment/i.test(text)
        || /\*\*?Verdict:?\*\*?/i.test(text);
}

/**
 * Build a deterministic constraint-status map from parsed report fields,
 * keyed by a normalized (lowercased, trimmed) version of the constraint text
 * so minor wording shifts don't break comparisons.
 */
function buildConstraintStatusMap(fields: ReportFields): Record<string, string> {
    const map: Record<string, string> = {};
    for (const row of fields.constraintRows) {
        const key = row.constraint.trim().toLowerCase().slice(0, 80);
        map[key] = row.status;
    }
    return map;
}

/** Compare two constraint-status maps; return list of constraints whose status changed. */
function diffConstraintStatuses(prev: Record<string, string>, next: Record<string, string>): string[] {
    const changed: string[] = [];
    for (const [key, prevStatus] of Object.entries(prev)) {
        const nextStatus = next[key];
        if (nextStatus && nextStatus !== prevStatus) {
            changed.push(key);
        }
    }
    return changed;
}

// ============================================================================
// Processor
// ============================================================================

// ============================================================================
// Per-run tracking state (NOT the persisted consistency store - that's
// intentionally cross-run via `ConsistencyStore`)
// ============================================================================

interface ConsistencyRunState {
    /** Requirement ID for this run (extracted from prompt / first user message). */
    requirementId: string | null;
    /** Sorted list of file paths in the repo-wide inventory (from ToolResultManager system message). */
    inventoryPaths: string[];
    /** Hashes of content actually read during this run, keyed by path. */
    readHashes: Map<string, string>;
}

function createConsistencyRunState(): ConsistencyRunState {
    return { requirementId: null, inventoryPaths: [], readHashes: new Map() };
}

export class ResultConsistencyGuardrail implements Processor {
    id = 'result-consistency-guardrail';

    private config: ResultConsistencyGuardrailConfig;
    private store: ConsistencyStore;
    private runStates = new RunStateStore<ConsistencyRunState>(createConsistencyRunState);

    constructor(config: Partial<ResultConsistencyGuardrailConfig> = {}, store: ConsistencyStore = new InMemoryConsistencyStore()) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.store = store;
    }

    // --------------------------------------------------------------------
    // Input step: track inventory + read content hashes, extract requirementId
    // --------------------------------------------------------------------

    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
        const { messageList, systemMessages } = args;
        const state = this.runStates.get(getRunKey(args));

        if (!state.requirementId) {
            for (const msg of messageList.get.all.db()) {
                if (msg.role !== 'user') continue;
                const parts = msg.content?.parts;
                if (!Array.isArray(parts)) continue;
                for (const part of parts) {
                    if (part.type !== 'text' || typeof part.text !== 'string') continue;
                    const m = part.text.match(/\*\*Requirement ID:\*\*\s*([^\n*]+)/i)
                        || part.text.match(/"id"\s*:\s*"([^"]+)"/);
                    if (m) {
                        state.requirementId = m[1].trim();
                        break;
                    }
                }
                if (state.requirementId) break;
            }
        }

        if (state.inventoryPaths.length === 0) {
            for (const msg of systemMessages) {
                if (typeof msg.content !== 'string') continue;
                const m = msg.content.match(/The following files are available for requirement review[^:]*:\n([\s\S]*)/i);
                if (m) {
                    state.inventoryPaths = m[1].split('\n').map(l => l.trim()).filter(Boolean).sort();
                }
            }
        }

        for (const msg of messageList.get.all.db()) {
            if (!Array.isArray(msg.content?.parts)) continue;
            for (const part of msg.content.parts) {
                if (part.type !== 'tool-invocation') continue;
                const { toolInvocation } = part as MastraToolInvocationPart;
                if (toolInvocation?.toolName !== 'submission_read') continue;
                if (!toolInvocation.result || toolInvocation.state !== 'result') continue;

                const result = toolInvocation.result as Record<string, unknown>;
                if (typeof result.error === 'string') continue;

                const path = (result.filePath as string) || (result.symbolPath as string);
                if (!path) continue;

                const content = JSON.stringify(result);
                state.readHashes.set(path, hashContent(content));
            }
        }

        return undefined;
    }

    // --------------------------------------------------------------------
    // Output step: compare against stored result for this fingerprint
    // --------------------------------------------------------------------

    async processOutputStep(args: ProcessOutputStepArgs): Promise<ProcessorMessageResult> {
        const text = args.text?.trim() ?? '';

        if (!looksLikeFinalReport(text)) {
            return args.messageList;
        }

        const fields = OutputQualityGuardrail.parseReportFields(text);
        if (!fields) {
            return args.messageList;
        }

        const state = this.runStates.get(getRunKey(args));
        const requirementId = state.requirementId || fields.requirementId || 'unknown';
        const fingerprint = this.computeFingerprint(requirementId, state);

        const prior = await this.store.get(fingerprint);
        const retryLimitReached = args.retryCount >= this.config.maxRetries;

        if (!prior) {
            // First run for this (requirement, codebase) pair - store baseline.
            await this.store.set(fingerprint, {
                verdict: fields.verdict,
                coverageScore: fields.coverageScore,
                constraintStatuses: buildConstraintStatusMap(fields),
                sampleCount: 1,
                updatedAt: Date.now(),
            });

            tcAILogger.info(`[${this.id}] Stored baseline result for ${requirementId}`, {
                fingerprint,
                verdict: fields.verdict,
                coverageScore: fields.coverageScore,
            });

            return args.messageList;
        }

        const scoreDiff = Math.abs(prior.coverageScore - fields.coverageScore);
        const verdictChanged = prior.verdict !== fields.verdict;
        const scoreOutOfTolerance = scoreDiff > this.config.scoreTolerance;

        if (!verdictChanged && !scoreOutOfTolerance) {
            // Consistent - update rolling average and accept.
            const n = prior.sampleCount;
            const newScore = (prior.coverageScore * n + fields.coverageScore) / (n + 1);

            await this.store.set(fingerprint, {
                verdict: fields.verdict,
                coverageScore: newScore,
                constraintStatuses: buildConstraintStatusMap(fields),
                sampleCount: n + 1,
                updatedAt: Date.now(),
            });

            tcAILogger.info(`[${this.id}] Result consistent with prior runs`, {
                requirementId,
                priorScore: prior.coverageScore,
                newScore: fields.coverageScore,
                scoreDiff,
                sampleCount: n + 1,
            });

            return args.messageList;
        }

        // Inconsistent result.
        if (retryLimitReached) {
            // Accept this run's result but log loudly + still update the store
            // with a rolling average so future runs trend toward stability.
            const n = prior.sampleCount;
            const newScore = (prior.coverageScore * n + fields.coverageScore) / (n + 1);

            await this.store.set(fingerprint, {
                verdict: fields.verdict,
                coverageScore: newScore,
                constraintStatuses: buildConstraintStatusMap(fields),
                sampleCount: n + 1,
                updatedAt: Date.now(),
            });

            tcAILogger.warn(`[${this.id}] Inconsistent result vs prior run, retry limit reached - accepting`, {
                requirementId,
                priorVerdict: prior.verdict,
                newVerdict: fields.verdict,
                priorScore: prior.coverageScore,
                newScore: fields.coverageScore,
                scoreDiff,
            });

            return args.messageList;
        }

        const changedConstraints = diffConstraintStatuses(prior.constraintStatuses, buildConstraintStatusMap(fields));

        const feedbackLines: string[] = [
            `A previous analysis of this SAME requirement against this codebase reached verdict ` +
            `"${prior.verdict}" with coverage score ${prior.coverageScore.toFixed(2)}, but this run produced ` +
            `"${fields.verdict}" with score ${fields.coverageScore.toFixed(2)} (difference: ${scoreDiff.toFixed(2)}, ` +
            `tolerance: ${this.config.scoreTolerance}).`,
            'Before finalizing, re-verify your conclusion:',
            '- Re-check the constraints below using submission_read on the relevant files - confirm whether they are ' +
            'actually verified, partial, or not found based on the CURRENT evidence (the prior run may have been wrong).',
        ];

        if (changedConstraints.length > 0) {
            const MAX_LISTED = 8;
            const shown = changedConstraints.slice(0, MAX_LISTED);
            const remainder = changedConstraints.length - shown.length;
            feedbackLines.push(
                `- Constraint(s) whose status changed between runs: ${shown.map(c => `"${c}"`).join(', ')}` +
                (remainder > 0 ? `, and ${remainder} more` : '') + '. ' +
                'Double-check these specifically.'
            );
        }

        feedbackLines.push(
            'If, after re-verification, you are confident in your NEW result, keep it and explain the discrepancy briefly ' +
            'in "What\'s Missing or Unclear". If the PRIOR result was more accurate, revise your verdict/score to match it.'
        );

        const reason = feedbackLines.join('\n');

        tcAILogger.warn(`[${this.id}] Inconsistent result vs prior run - requesting re-verification`, {
            requirementId,
            priorVerdict: prior.verdict,
            newVerdict: fields.verdict,
            priorScore: prior.coverageScore,
            newScore: fields.coverageScore,
            scoreDiff,
            changedConstraints,
        });

        args.abort(reason, { retry: true });

        return args.messageList;
    }

    // --------------------------------------------------------------------
    // Fingerprint computation
    // --------------------------------------------------------------------

    /**
     * Fingerprint = hash(requirementId + sorted inventory paths + sorted
     * read-content hashes). Two runs with the same requirement against the
     * same codebase state will have the same inventory; if the agent reads
     * the same files, the read-hashes match too, yielding the same
     * fingerprint and enabling a direct comparison.
     *
     * If the agent reads a DIFFERENT set of files on the second run, the
     * fingerprint will differ and no comparison is made (treated as a fresh
     * baseline) - this is intentional: we only compare "apples to apples"
     * runs that examined the same evidence.
     */
    private computeFingerprint(requirementId: string, state: ConsistencyRunState): string {
        const sortedReadHashes = [...state.readHashes.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, hash]) => `${path}:${hash}`);

        const payload = JSON.stringify({
            requirementId,
            inventory: state.inventoryPaths,
            reads: sortedReadHashes,
        });

        return hashContent(payload);
    }

    /** Clear accumulated per-run tracking state for a finished run (does NOT touch the persisted ConsistencyStore). */
    clearRun(threadId: string): void {
        this.runStates.clear(threadId);
    }
}
