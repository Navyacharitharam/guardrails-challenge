/**
 * Requirement Analyzer Agent
 *
 * Maps software requirements to codebase implementations using AST-aware search.
 *
 * **Guardrails (Guardrails Implementation Challenge):**
 * - FalseNegativeGuardrail: blocks premature MISSING verdicts without sufficient
 *   search/read effort and domain-synonym coverage; handles empty/junk codebases.
 * - FalsePositiveGuardrail: blocks COVERED/PARTIAL verdicts citing files/symbols
 *   that were never actually read via submission_read.
 * - OutputQualityGuardrail: validates the final report against the required
 *   template (sections present + non-empty, valid verdict/score, consistent
 *   score range, constraint table populated).
 * - ResultConsistencyGuardrail: persists per-(requirement, codebase) results and
 *   flags/retries when a re-run diverges beyond tolerance.
 *
 * **Context requirements:**
 * - Minimum 16K context recommended (tool results can be large)
 * - 32K context optimal for analyzing larger codebases
 * - MAX_CONTEXT_SIZE=43960 for Ollama/qwen3:4b-instruct (challenge constraint)
 *
 * Set model via environment variable: LLM_MODEL_NAME=qwen3:4b-instruct
 */

import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { APIErrorProcessor, createModel } from '../../../utils';
import { submissionToolsRaw } from './tools';
import { submissionSearchTermsTool } from './tools/submission-search-terms-tool';
import { verifyConstraintTool } from './tools/verify-constraint-tool';
import { AGENT_INSTRUCTIONS } from './instructions';
import { defaultOptions } from './options';
import { requirementAnalyzerAgentMemory } from './memory';
import {
    OutputQualityProcessor,
    ToolResultManager,
} from './processors';
import {
    FalseNegativeGuardrail,
    FalsePositiveGuardrail,
    OutputQualityGuardrail,
    ResultConsistencyGuardrail,
    LibSQLConsistencyStore,
} from './guardrails';

// Feature flag: Enable scorers only in local dev
const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';

// Model configuration - override via LLM_MODEL_NAME env var
// Challenge constraint: must run fully on Ollama/qwen3:4b-instruct with
// MAX_CONTEXT_SIZE=43960. No other LLMs/providers without forum approval.
const DEFAULT_MODEL = 'qwen3:4b-instruct';
const MODEL_ID = process.env.LLM_MODEL_NAME || DEFAULT_MODEL;
const PROVIDER_NAME = process.env.LLM_PROVIDER_NAME || 'TC-Ollama';

// ============================================================================
// Shared processor instances
// ============================================================================

const toolResultManager = new ToolResultManager();
const outputQualityProcessor = new OutputQualityProcessor();

// Guardrail 1: False-negative minimization
const falseNegativeGuardrail = new FalseNegativeGuardrail({
    minSearchAttempts: 3,
    minReadAttempts: 1,
    maxRetries: 2,
});

// Guardrail 2: False-positive prevention
const falsePositiveGuardrail = new FalsePositiveGuardrail({
    minEvidenceLength: 10,
    maxRetries: 2,
});

// Guardrail 3: Output quality verification
const outputQualityGuardrail = new OutputQualityGuardrail({
    maxRetries: 2,
});

// Guardrail 4: Result consistency
// Persisted to a LibSQL .db file so consistency state (and the artifact
// itself) survives across runs and can be included in the submission's
// LibSQLStore artifacts as required.
const consistencyStore = new LibSQLConsistencyStore(
    new LibSQLStore({
        id: 'requirement-analyzer-consistency',
        url: process.env.CONSISTENCY_DB_URL || 'file:./requirement-analyzer-consistency.db',
    })
);

// Explicitly initialize the backing table at module load time so the first
// processOutputStep call doesn't race against table creation.
consistencyStore.init().catch((err: unknown) => {
    // Non-fatal: falls back to in-memory if LibSQL is unavailable.
    console.warn('[agent] LibSQLConsistencyStore init() failed - consistency will be in-memory only:', err);
});

const resultConsistencyGuardrail = new ResultConsistencyGuardrail(
    { scoreTolerance: 0.15, maxRetries: 1 },
    consistencyStore,
);

// ============================================================================
// Tools: existing submission_search/read + new "smart" tools
// ============================================================================

const requirementAnalyzerTools = {
    ...submissionToolsRaw,
    submission_search_terms: submissionSearchTermsTool,
    verify_constraint: verifyConstraintTool,
};

export const requirementAnalyzerAgent = new Agent({
    id: 'requirement-analyzer-agent',
    name: 'Requirement Analyzer',
    description: 'Analyzes a SINGLE requirement against submission code. Call with a specific requirement description. Returns: detailed analysis report with code evidence, coverage score (0-1), and implementation verification. Use for each requirement separately.',
    instructions: AGENT_INSTRUCTIONS,
    model: createModel(PROVIDER_NAME, MODEL_ID),
    tools: requirementAnalyzerTools,
    memory: IS_LOCAL_DEV ? requirementAnalyzerAgentMemory : undefined,
    scorers: IS_LOCAL_DEV ? {} : undefined,
    defaultOptions: {
        ...defaultOptions,
        activeTools: ['submission_search', 'submission_read', 'submission_search_terms', 'verify_constraint'],
    },

    // Input processors run before each LLM step (order matters: dedup/token
    // management first, then guardrails that read tool-call history).
    inputProcessors: [
        toolResultManager,
        falseNegativeGuardrail,
        falsePositiveGuardrail,
        resultConsistencyGuardrail,
    ],

    // Output processors validate the model's response for THIS step.
    // Order: empty-response check first (cheapest), then structural
    // quality, then the evidence-based guardrails which require a
    // well-formed report to inspect.
    outputProcessors: [
        outputQualityProcessor,
        outputQualityGuardrail,
        falseNegativeGuardrail,
        falsePositiveGuardrail,
        resultConsistencyGuardrail,
    ],

    maxProcessorRetries: 2, // Max retries for processors before failing the agent run

    errorProcessors: [
        new APIErrorProcessor({
            maxRetries: 2,
            retryablePatterns: [
                'timeout',
                'ETIMEDOUT',
                'ECONNRESET',
                'ECONNREFUSED',
                'socket hang up',
                '503',
                '502',
                '504',
                'rate limit',
                'overloaded',
                /context.*length.*exceeded/i,
                /model.*busy/i,
            ],
        }),
    ],
});
