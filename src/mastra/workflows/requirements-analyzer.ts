import { createStep, createWorkflow } from "@mastra/core/workflows";
import z from "zod";
import pLimit from "p-limit";
import { unifiedContextSchema } from "../../utils/schema/challenge-context";
import { readChallengeContextFromWorkspace } from "./steps";
import { tcAILogger } from "../../utils";
import { resetToolCache } from "../agents/requirement-analyzer/tools";
import { buildAllRequirementPrompts } from "../agents/requirement-analyzer/prompt-builder";
import { ScoringDistillerSchema, type ScoringDistillerOutput } from "../agents/scoring-distiller/instructions";

// Configuration
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes default
const ITERATION_TIMEOUT_MS = parseInt(process.env.REQUIREMENT_ANALYZER_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
const SCORING_TIMEOUT_MS = parseInt(process.env.SCORING_DISTILLER_TIMEOUT_MS || '', 10) || 60_000; // 1 minute for scoring
const MAX_RETRIES = 1;
const SCORING_MAX_RETRIES = 1;
const MAX_CONCURRENT_ANALYSES = parseInt(process.env.REQUIREMENT_ANALYZER_BATCH_SIZE || '', 10) || 2;
const MAX_CONCURRENT_SCORING_DISTILLERS = parseInt(process.env.SCORING_DISTILLER_BATCH_SIZE || '', 10) || 2;

const requirementsAnalyzerWorkflowInputSchema = z.object({
    rootPath: z.string().default('submission').describe('Workspace-relative root path for the submission'),
});

/**
 * Token usage schema matching Mastra/AI SDK LanguageModelUsage type.
 * @see https://sdk.vercel.ai/docs/ai-sdk-core/generating-text#usage
 */
const tokenUsageSchema = z.object({
    inputTokens: z.number().describe('Number of tokens in the prompt/input'),
    outputTokens: z.number().describe('Number of tokens in the completion/output'),
    totalTokens: z.number().describe('Total tokens used (inputTokens + outputTokens)'),
    cachedInputTokens: z.number().optional().describe('Number of input tokens read from cache'),
    cacheCreationInputTokens: z.number().optional().describe('Number of input tokens written to cache'),
    reasoningTokens: z.number().optional().describe('Number of tokens used for reasoning (chain-of-thought)'),
});

/**
 * Tool call record schema matching Mastra/AI SDK ToolCallPayload type.
 * @see https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
 */
const toolCallRecordSchema = z.object({
    toolCallId: z.string().describe('Unique identifier for the tool call'),
    toolName: z.string().describe('Name of the tool that was called'),
    args: z.record(z.string(), z.unknown()).optional().describe('Arguments passed to the tool'),
    durationMs: z.number().optional().describe('Execution duration in milliseconds'),
    success: z.boolean().optional().describe('Whether the tool call succeeded'),
    error: z.string().optional().describe('Error message if the tool call failed'),
});

/**
 * Aggregated tool usage statistics for an analysis run.
 */
const toolUsageSchema = z.object({
    totalCalls: z.number().describe('Total number of tool calls made'),
    uniqueTools: z.array(z.string()).describe('List of unique tool names used'),
    callsByTool: z.record(z.string(), z.number()).describe('Number of calls per tool name'),
    totalDurationMs: z.number().optional().describe('Total time spent in tool executions'),
    successCount: z.number().describe('Number of successful tool calls'),
    errorCount: z.number().describe('Number of failed tool calls'),
    calls: z.array(toolCallRecordSchema).optional().describe('Detailed log of each tool call'),
});

const requirementAnalysisResultSchema = unifiedContextSchema.shape.requirements.element.extend({
    requirementAnalyzer: z.string().describe('Result of the requirement analyzer agent run for this requirement'),
    scoring: ScoringDistillerSchema.optional().describe('Distilled scoring data from the scoring-distiller agent'),
    scoringError: z.string().optional().describe('Error message if scoring distillation failed'),
    tokenUsage: tokenUsageSchema.optional().describe('Combined token usage for requirement analysis + scoring'),
    toolUsage: toolUsageSchema.optional().describe('Tool usage statistics for this requirement analysis'),
    durationMs: z.number().optional().describe('Total duration of analysis + scoring in milliseconds'),
    retryCount: z.number().optional().describe('Number of retries needed for requirement analysis'),
    scoringRetryCount: z.number().optional().describe('Number of retries needed for scoring distillation'),
    error: z.string().optional().describe('Error message if analysis failed'),
});

const requirementsAnalyzerOutputSchema = z.array(requirementAnalysisResultSchema);

type RequirementAnalysisResult = z.infer<typeof requirementAnalysisResultSchema>;
type TokenUsage = z.infer<typeof tokenUsageSchema>;
type ToolUsage = z.infer<typeof toolUsageSchema>;
type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

/**
 * Executes agent.generate with timeout and abort support.
 */
async function executeWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        tcAILogger.warn(`[ai-reviewer:requirements-analyzer] ${label} - Timeout after ${timeoutMs}ms`);
    }, timeoutMs);

    try {
        const result = await operation(controller.signal);
        return result;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Analyzes a single requirement with retry logic and timeout handling.
 */
/**
 * Raw tool call from agent - handles multiple possible structures from Mastra/AI SDK.
 * The SDK may return:
 * - { toolCallId, toolName, args } (standard)
 * - { toolCallId, name, args } (some AI providers)
 * - { type: 'tool-call', payload: { toolCallId, toolName, args } } (chunked/stream format)
 */
interface RawToolCall {
    toolCallId?: string;
    toolName?: string;
    name?: string;
    args?: Record<string, unknown>;
    type?: string;
    payload?: {
        toolCallId?: string;
        toolName?: string;
        name?: string;
        args?: Record<string, unknown>;
    };
}

interface RawToolResult {
    toolCallId?: string;
    toolName?: string;
    name?: string;
    result?: unknown;
    isError?: boolean;
    type?: string;
    payload?: {
        toolCallId?: string;
        toolName?: string;
        name?: string;
        result?: unknown;
        isError?: boolean;
    };
}

/** Agent generate result type */
interface AgentGenerateResult {
    text: string;
    totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        cacheCreationInputTokens?: number;
        reasoningTokens?: number;
    };
    finishReason?: string;
    toolCalls?: RawToolCall[];
    toolResults?: RawToolResult[];
    runId?: string;
    error?: { message: string };
    tripwire?: unknown;
    warnings?: unknown[];
}

/**
 * Normalizes a raw tool call to standard format, handling different structures.
 */
function normalizeToolCall(raw: RawToolCall): { toolCallId: string; toolName: string; args?: Record<string, unknown> } | null {
    // Handle payload wrapper (chunk format)
    const data = raw.payload ?? raw;

    const toolCallId = data.toolCallId ?? '';
    const toolName = data.toolName ?? data.name ?? '';
    const args = data.args;

    if (!toolName) {
        return null;
    }

    return { toolCallId, toolName, args };
}

/**
 * Normalizes a raw tool result to standard format.
 */
function normalizeToolResult(raw: RawToolResult): { toolCallId: string; toolName: string; result: unknown; isError?: boolean } | null {
    const data = raw.payload ?? raw;

    const toolCallId = data.toolCallId ?? '';
    const toolName = data.toolName ?? data.name ?? '';
    const result = data.result;
    const isError = data.isError;

    return { toolCallId, toolName, result, isError };
}

/**
 * Extracts tool usage statistics from agent result.
 */
function extractToolUsage(toolCalls: RawToolCall[] | undefined, toolResults: RawToolResult[] | undefined): ToolUsage {
    const rawCalls = toolCalls ?? [];
    const rawResults = toolResults ?? [];

    // Normalize all calls and results
    const calls = rawCalls.map(normalizeToolCall).filter((c): c is NonNullable<typeof c> => c !== null);
    const results = rawResults.map(normalizeToolResult).filter((r): r is NonNullable<typeof r> => r !== null);

    // Build a map of results by toolCallId for quick lookup
    const resultMap = new Map(results.map(r => [r.toolCallId, r]));

    // Count calls per tool
    const callsByTool: Record<string, number> = {};
    for (const call of calls) {
        callsByTool[call.toolName] = (callsByTool[call.toolName] ?? 0) + 1;
    }

    // Build detailed call records
    const callRecords: ToolCallRecord[] = calls.map(call => {
        const result = resultMap.get(call.toolCallId);
        return {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
            success: result ? !result.isError : undefined,
            error: result?.isError ? String(result.result) : undefined,
        };
    });

    // Count successes and errors based on results, not just filtered records
    // If we have results, use them; otherwise count calls as unknown
    const successCount = results.filter(r => !r.isError).length;
    const errorCount = results.filter(r => r.isError).length;

    return {
        totalCalls: calls.length,
        uniqueTools: [...new Set(calls.map(c => c.toolName))],
        callsByTool,
        successCount,
        errorCount,
        calls: callRecords.length > 0 ? callRecords : undefined,
    };
}

/** Scoring distiller agent result type */
interface ScoringAgentResult {
    object?: ScoringDistillerOutput;
    text?: string;
    totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
    error?: { message: string };
}

/**
 * Runs the scoring distiller agent on requirement analyzer output.
 * Includes retry logic and timeout handling.
 */
async function runScoringDistiller(
    agent: { generate: (prompt: string, options?: unknown) => Promise<unknown> },
    requirementAnalyzerOutput: string,
    requirementId: string,
    logPrefix: string,
): Promise<{ scoring?: ScoringDistillerOutput; tokenUsage?: TokenUsage; error?: string; retryCount: number; durationMs: number }> {
    let retryCount = 0;
    let lastError: Error | null = null;
    const startTime = Date.now();

    while (retryCount <= SCORING_MAX_RETRIES) {
        const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${SCORING_MAX_RETRIES})` : '';
        tcAILogger.info(`${logPrefix} [scoring] Starting distillation${attemptLabel}`);

        try {
            const rawResult = await executeWithTimeout(
                async (_signal) => {
                    return agent.generate(requirementAnalyzerOutput);
                },
                SCORING_TIMEOUT_MS,
                `${logPrefix} [scoring] Agent execution`,
            );

            const result = rawResult as ScoringAgentResult;
            const durationMs = Date.now() - startTime;

            // Extract token usage
            const tokenUsage: TokenUsage = {
                inputTokens: result.totalUsage?.inputTokens ?? 0,
                outputTokens: result.totalUsage?.outputTokens ?? 0,
                totalTokens: result.totalUsage?.totalTokens ?? 0,
            };

            if (result.error) {
                tcAILogger.error(`${logPrefix} [scoring] Agent error: ${result.error.message}`);
                throw new Error(result.error.message);
            }

            // Check for structured output
            if (result.object) {
                tcAILogger.info(`${logPrefix} [scoring] Distillation complete in ${durationMs}ms`);
                tcAILogger.info(`${logPrefix} [scoring] Tokens: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}`);
                tcAILogger.debug(`${logPrefix} [scoring] Status: ${result.object.status}, Coverage: ${result.object.coverageScore}`);
                return { scoring: result.object, tokenUsage, retryCount, durationMs };
            }

            // Try to parse from text if no structured output
            if (result.text) {
                try {
                    const parsed = JSON.parse(result.text);
                    const validated = ScoringDistillerSchema.parse(parsed);
                    tcAILogger.info(`${logPrefix} [scoring] Parsed from text output in ${durationMs}ms`);
                    return { scoring: validated, tokenUsage, retryCount, durationMs };
                } catch (parseError) {
                    tcAILogger.warn(`${logPrefix} [scoring] Failed to parse text output: ${parseError}`);
                    throw new Error('Failed to parse scoring output as JSON', { cause: parseError });
                }
            }

            throw new Error('No structured output or text returned from scoring agent');
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const isTimeout = lastError.name === 'AbortError' || lastError.message.includes('abort');

            tcAILogger.error(`${logPrefix} [scoring] Failed: ${lastError.message}`);

            if (retryCount < SCORING_MAX_RETRIES) {
                retryCount++;
                const retryReason = isTimeout ? 'timeout' : 'error';
                tcAILogger.info(`${logPrefix} [scoring] Retrying due to ${retryReason}`);
                continue;
            }

            // Max retries exhausted
            const durationMs = Date.now() - startTime;
            tcAILogger.error(`${logPrefix} [scoring] All retries exhausted`);
            return { error: lastError.message, retryCount, durationMs };
        }
    }

    const durationMs = Date.now() - startTime;
    return { error: lastError?.message || 'Unknown error', retryCount, durationMs };
}

/**
 * Combines token usage from two sources.
 */
function combineTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage {
    return {
        inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
        outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
        totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
        cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0) || undefined,
        cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0) || undefined,
        reasoningTokens: (a?.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0) || undefined,
    };
}

/**
 * Intermediate result from requirement analysis (before scoring).
 */
interface AnalysisOnlyResult {
    requirement: { id: string; title: string; description: string; priority: 'high' | 'medium' | 'low'; constraints: { id: string; text: string }[] };
    analyzerOutput: string;
    tokenUsage: TokenUsage;
    toolUsage: ToolUsage;
    durationMs: number;
    retryCount: number;
    error?: string;
    index: number;
}

/**
 * Analyzes a single requirement (analysis only, no scoring).
 * Scoring is decoupled and runs in a separate parallel pipeline.
 */
async function analyzeRequirementOnly(
    requirementAgent: { generate: (prompt: string, options?: unknown) => Promise<unknown> },
    challengeId: string,
    requirement: { id: string; title: string; description: string; priority: 'high' | 'medium' | 'low'; constraints: { id: string; text: string }[] },
    prompt: string,
    index: number,
    total: number,
): Promise<AnalysisOnlyResult> {
    const logPrefix = `[ai-reviewer:requirements-analyzer] [${index + 1}/${total}] [${requirement.id}]`;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount <= MAX_RETRIES) {
        const startTime = Date.now();
        const threadId = `${challengeId}-req-${requirement.id}-${process.env.SUBMISSION_ID || 'SUB_ID_UNKNOWN'}-${Date.now()}`;

        // Reset tool cache for fresh state
        resetToolCache(threadId);

        const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : '';
        tcAILogger.info(`${logPrefix} Starting analysis${attemptLabel} (thread: ${threadId})`);
        tcAILogger.debug(`${logPrefix} Priority: ${requirement.priority}, Constraints: ${requirement.constraints.length}`);

        try {
            const rawResult = await executeWithTimeout(
                async (_signal) => {
                    return requirementAgent.generate(prompt, {
                        memory: {
                            thread: threadId,
                            resource: `${challengeId}-req-${requirement.id}`,
                        },
                    });
                },
                ITERATION_TIMEOUT_MS,
                `${logPrefix} Requirement analyzer execution`,
            );

            const analysisResult = rawResult as AgentGenerateResult;
            const analyzerDurationMs = Date.now() - startTime;
            const tokenUsage: TokenUsage = {
                inputTokens: analysisResult.totalUsage?.inputTokens ?? 0,
                outputTokens: analysisResult.totalUsage?.outputTokens ?? 0,
                totalTokens: analysisResult.totalUsage?.totalTokens ?? 0,
                cachedInputTokens: analysisResult.totalUsage?.cachedInputTokens,
                cacheCreationInputTokens: analysisResult.totalUsage?.cacheCreationInputTokens,
                reasoningTokens: analysisResult.totalUsage?.reasoningTokens,
            };

            const toolUsage = extractToolUsage(analysisResult.toolCalls, analysisResult.toolResults);

            tcAILogger.info(`${logPrefix} === REQUIREMENT ANALYSIS COMPLETE ===`);
            tcAILogger.info(`${logPrefix} Duration: ${analyzerDurationMs}ms`);
            tcAILogger.info(`${logPrefix} Token Usage: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}, total=${tokenUsage.totalTokens}`);
            tcAILogger.info(`${logPrefix} Tool Usage: calls=${toolUsage.totalCalls}, success=${toolUsage.successCount}, errors=${toolUsage.errorCount}`);
            tcAILogger.info(`${logPrefix} Tools Used: ${toolUsage.uniqueTools.join(', ') || 'none'}`);
            if (Object.keys(toolUsage.callsByTool).length > 0) {
                tcAILogger.info(`${logPrefix} Calls by Tool: ${JSON.stringify(toolUsage.callsByTool)}`);
            }
            tcAILogger.info(`${logPrefix} Finish Reason: ${analysisResult.finishReason}`);
            tcAILogger.info(`${logPrefix} Output Length: ${analysisResult.text?.length || 0} chars`);
            tcAILogger.info(`${logPrefix} Run ID: ${analysisResult.runId}`);

            if (analysisResult.error) {
                tcAILogger.error(`${logPrefix} Agent Error: ${analysisResult.error.message}`);
            }
            if (analysisResult.tripwire) {
                tcAILogger.warn(`${logPrefix} Tripwire: ${JSON.stringify(analysisResult.tripwire)}`);
            }
            if (analysisResult.warnings?.length) {
                tcAILogger.warn(`${logPrefix} Warnings: ${JSON.stringify(analysisResult.warnings)}`);
            }

            return {
                requirement,
                analyzerOutput: analysisResult.text,
                tokenUsage,
                toolUsage,
                durationMs: analyzerDurationMs,
                retryCount,
                index,
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            lastError = error instanceof Error ? error : new Error(String(error));
            const isTimeout = lastError.name === 'AbortError' || lastError.message.includes('abort');

            tcAILogger.error(`${logPrefix} Failed after ${durationMs}ms: ${lastError.message}`);

            if (retryCount < MAX_RETRIES) {
                retryCount++;
                const retryReason = isTimeout ? 'timeout' : 'error';
                tcAILogger.info(`${logPrefix} Retrying due to ${retryReason} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
                continue;
            }

            tcAILogger.error(`${logPrefix} All retries exhausted. Returning error result.`);
            return {
                requirement,
                analyzerOutput: `Analysis failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`,
                tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
                durationMs,
                retryCount,
                error: lastError.message,
                index,
            };
        }
    }

    return {
        requirement,
        analyzerOutput: `Unexpected state: ${lastError?.message || 'Unknown error'}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
        durationMs: 0,
        retryCount,
        error: lastError?.message,
        index,
    };
}

/**
 * Scoring task for the decoupled scoring pipeline.
 */
interface ScoringTask {
    analysisResult: AnalysisOnlyResult;
    total: number;
}

/**
 * Processes scoring tasks using a streaming worker pool.
 * Tasks start as soon as a slot frees, instead of waiting for batch completion.
 * Maintains timeout and retry functionality.
 */
async function processScoringQueue(
    scoringAgent: { generate: (prompt: string, options?: unknown) => Promise<unknown> },
    tasks: ScoringTask[],
): Promise<Map<string, { scoring?: ScoringDistillerOutput; tokenUsage?: TokenUsage; error?: string; retryCount: number; durationMs: number }>> {
    const results = new Map<string, { scoring?: ScoringDistillerOutput; tokenUsage?: TokenUsage; error?: string; retryCount: number; durationMs: number }>();

    if (tasks.length === 0) {
        return results;
    }

    const limit = pLimit(MAX_CONCURRENT_SCORING_DISTILLERS);
    let completedCount = 0;

    tcAILogger.info(`[ai-reviewer:scoring-pipeline] === STARTING STREAMING SCORING PIPELINE ===`);
    tcAILogger.info(`[ai-reviewer:scoring-pipeline] Total scoring tasks: ${tasks.length}`);
    tcAILogger.info(`[ai-reviewer:scoring-pipeline] Concurrency limit: ${MAX_CONCURRENT_SCORING_DISTILLERS}`);

    const scoringPromises = tasks.map((task) => 
        limit(async () => {
            const { analysisResult, total } = task;
            const logPrefix = `[ai-reviewer:requirements-analyzer] [${analysisResult.index + 1}/${total}] [${analysisResult.requirement.id}]`;

            // Skip scoring if analysis failed
            if (analysisResult.error) {
                tcAILogger.info(`${logPrefix} [scoring] Skipping - analysis failed`);
                completedCount++;
                tcAILogger.info(`[ai-reviewer:scoring-pipeline] Progress: ${completedCount}/${tasks.length} completed`);
                return {
                    requirementId: analysisResult.requirement.id,
                    result: { error: 'Skipped due to analysis failure', retryCount: 0, durationMs: 0 },
                };
            }

            const scoringResult = await runScoringDistiller(
                scoringAgent,
                analysisResult.analyzerOutput,
                analysisResult.requirement.id,
                logPrefix,
            );

            completedCount++;
            tcAILogger.info(`[ai-reviewer:scoring-pipeline] Progress: ${completedCount}/${tasks.length} completed`);

            return {
                requirementId: analysisResult.requirement.id,
                result: scoringResult,
            };
        })
    );

    const allResults = await Promise.all(scoringPromises);

    for (const { requirementId, result } of allResults) {
        results.set(requirementId, result);
    }

    tcAILogger.info(`[ai-reviewer:scoring-pipeline] === SCORING PIPELINE COMPLETE ===`);
    return results;
}

const processChallengeContextWithRequirementsAnalyzer = createStep({
    id: 'process-challenge-context-with-requirements-analyzer',
    description: 'Processes the unified challenge context with the requirements analyzer agent and scoring distiller to produce enriched requirement analysis results.',
    inputSchema: unifiedContextSchema,
    outputSchema: requirementsAnalyzerOutputSchema,
    execute: async ({ mastra, inputData }) => {
        // Get both agents
        const requirementAnalyzerAgent = mastra!.getAgentById('requirement-analyzer-agent');
        if (!requirementAnalyzerAgent) {
            throw new Error('Requirement Analyzer Agent not found in Mastra');
        }

        const scoringDistillerAgent = mastra!.getAgentById('scoring-distiller-agent');
        if (!scoringDistillerAgent) {
            throw new Error('Scoring Distiller Agent not found in Mastra');
        }

        const requirementPrompts = buildAllRequirementPrompts(inputData);
        const totalRequirements = requirementPrompts.length;

        if (totalRequirements === 0) {
            tcAILogger.warn('[ai-reviewer:requirements-analyzer] No requirements found in challenge context.');
            return [];
        }

        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === STARTING DECOUPLED REQUIREMENTS ANALYSIS ===`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] LLM Configuration for Requirement Analyzer Agent: ${JSON.stringify(requirementAnalyzerAgent.model, null, 2)}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] LLM Configuration for Scoring Distiller Agent: ${JSON.stringify(scoringDistillerAgent.model, null, 2)}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Challenge: ${inputData.challengeId}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Requirements: ${totalRequirements}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Timeout: ${ITERATION_TIMEOUT_MS}ms, Scoring Timeout: ${SCORING_TIMEOUT_MS}ms`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Retries: ${MAX_RETRIES}, Scoring Retries: ${SCORING_MAX_RETRIES}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Batch Size: ${MAX_CONCURRENT_ANALYSES}, Scoring Batch Size: ${MAX_CONCURRENT_SCORING_DISTILLERS}`);

        const pipelineStartTime = Date.now();

        // ============================================
        // PHASE 1: Run all requirement analyses using streaming worker pool
        // ============================================
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 1: REQUIREMENT ANALYSIS ===`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Concurrency limit: ${MAX_CONCURRENT_ANALYSES}`);

        const analysisLimit = pLimit(MAX_CONCURRENT_ANALYSES);
        let analysisCompletedCount = 0;

        const analysisPromises = requirementPrompts.map(({ requirement, prompt }, globalIndex) =>
            analysisLimit(async () => {
                tcAILogger.info(`[ai-reviewer:requirements-analyzer] [${globalIndex + 1}/${totalRequirements}] [${requirement.id}] Starting analysis`);

                try {
                    const result = await analyzeRequirementOnly(
                        requirementAnalyzerAgent,
                        inputData.challengeId,
                        requirement,
                        prompt,
                        globalIndex,
                        totalRequirements,
                    );
                    analysisCompletedCount++;
                    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis progress: ${analysisCompletedCount}/${totalRequirements} completed`);
                    return result;
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    tcAILogger.error(`[ai-reviewer:requirements-analyzer] [${globalIndex + 1}/${totalRequirements}] [${requirement.id}] Unexpected error: ${errorMessage}`);
                    analysisCompletedCount++;
                    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis progress: ${analysisCompletedCount}/${totalRequirements} completed`);
                    return {
                        requirement,
                        analyzerOutput: `Analysis failed with unexpected error: ${errorMessage}`,
                        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                        toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
                        durationMs: 0,
                        retryCount: 0,
                        error: errorMessage,
                        index: globalIndex,
                    } as AnalysisOnlyResult;
                }
            })
        );

        const analysisResults = await Promise.all(analysisPromises);

        const analysisPhaseTime = Date.now() - pipelineStartTime;
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 1 COMPLETE === (${analysisPhaseTime}ms)`);

        // ============================================
        // PHASE 2: Run scoring in parallel (decoupled pipeline)
        // ============================================
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 2: SCORING DISTILLATION ===`);
        const scoringStartTime = Date.now();

        const scoringTasks: ScoringTask[] = analysisResults.map(result => ({
            analysisResult: result,
            total: totalRequirements,
        }));

        const scoringResults = await processScoringQueue(scoringDistillerAgent, scoringTasks);

        const scoringPhaseTime = Date.now() - scoringStartTime;
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 2 COMPLETE === (${scoringPhaseTime}ms)`);

        // ============================================
        // PHASE 3: Merge results
        // ============================================
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 3: MERGING RESULTS ===`);

        const results: RequirementAnalysisResult[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalAnalysisDurationMs = 0;
        let totalScoringDurationMs = 0;
        let totalToolCalls = 0;
        let totalToolSuccess = 0;
        let totalToolErrors = 0;
        const aggregatedToolCalls: Record<string, number> = {};
        let analysisSuccessCount = 0;
        let analysisErrorCount = 0;
        let scoringSuccessCount = 0;
        let scoringErrorCount = 0;

        for (const analysisResult of analysisResults) {
            const scoringResult = scoringResults.get(analysisResult.requirement.id);

            // Combine token usage
            const combinedTokenUsage = combineTokenUsage(analysisResult.tokenUsage, scoringResult?.tokenUsage);
            const totalDurationMs = analysisResult.durationMs + (scoringResult?.durationMs ?? 0);

            // Build final result
            const finalResult: RequirementAnalysisResult = {
                ...analysisResult.requirement,
                requirementAnalyzer: analysisResult.analyzerOutput,
                scoring: scoringResult?.scoring,
                scoringError: scoringResult?.error,
                scoringRetryCount: scoringResult?.retryCount,
                tokenUsage: combinedTokenUsage,
                toolUsage: analysisResult.toolUsage,
                durationMs: totalDurationMs,
                retryCount: analysisResult.retryCount,
                error: analysisResult.error,
            };

            results.push(finalResult);

            // Aggregate stats
            if (analysisResult.error) {
                analysisErrorCount++;
            } else {
                analysisSuccessCount++;
            }

            if (scoringResult?.scoring) {
                scoringSuccessCount++;
            } else if (scoringResult?.error) {
                scoringErrorCount++;
            }

            totalInputTokens += combinedTokenUsage.inputTokens;
            totalOutputTokens += combinedTokenUsage.outputTokens;
            totalAnalysisDurationMs += analysisResult.durationMs;
            totalScoringDurationMs += scoringResult?.durationMs ?? 0;
            totalToolCalls += analysisResult.toolUsage.totalCalls;
            totalToolSuccess += analysisResult.toolUsage.successCount;
            totalToolErrors += analysisResult.toolUsage.errorCount;

            for (const [tool, count] of Object.entries(analysisResult.toolUsage.callsByTool)) {
                aggregatedToolCalls[tool] = (aggregatedToolCalls[tool] ?? 0) + count;
            }
        }

        const totalPipelineTime = Date.now() - pipelineStartTime;

        // Log summary
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === DECOUPLED PIPELINE SUMMARY ===`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Processed: ${totalRequirements} requirements`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis: success=${analysisSuccessCount}, errors=${analysisErrorCount}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Scoring: success=${scoringSuccessCount}, errors=${scoringErrorCount}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Tokens: input=${totalInputTokens}, output=${totalOutputTokens}, total=${totalInputTokens + totalOutputTokens}`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Tool Calls: ${totalToolCalls} (success=${totalToolSuccess}, errors=${totalToolErrors})`);
        if (Object.keys(aggregatedToolCalls).length > 0) {
            tcAILogger.info(`[ai-reviewer:requirements-analyzer] Tool Call Distribution: ${JSON.stringify(aggregatedToolCalls)}`);
        }
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] === TIMING BREAKDOWN ===`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis Phase (wall clock): ${analysisPhaseTime}ms (${(analysisPhaseTime / 1000).toFixed(1)}s)`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Scoring Phase (wall clock): ${scoringPhaseTime}ms (${(scoringPhaseTime / 1000).toFixed(1)}s)`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Pipeline (wall clock): ${totalPipelineTime}ms (${(totalPipelineTime / 1000).toFixed(1)}s)`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Cumulative Analysis Time: ${totalAnalysisDurationMs}ms`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Cumulative Scoring Time: ${totalScoringDurationMs}ms`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Avg Analysis per Requirement: ${totalRequirements > 0 ? (totalAnalysisDurationMs / totalRequirements).toFixed(0) : 0}ms`);
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Avg Scoring per Requirement: ${totalRequirements > 0 ? (totalScoringDurationMs / totalRequirements).toFixed(0) : 0}ms`);

        // Calculate parallelism efficiency
        const sequentialTime = totalAnalysisDurationMs + totalScoringDurationMs;
        const parallelismSpeedup = sequentialTime > 0 ? (sequentialTime / totalPipelineTime).toFixed(2) : 'N/A';
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Parallelism Speedup: ${parallelismSpeedup}x (sequential would be ${(sequentialTime / 1000).toFixed(1)}s)`);

        return results;
    }
});

export const requirementsAnalyzerWorkflow = createWorkflow({
    id: 'requirements-analyzer',
    description: 'Reads the challenge context from the workspace and executes the requirements analyzer agent over it.',
    inputSchema: requirementsAnalyzerWorkflowInputSchema,
    outputSchema: requirementsAnalyzerOutputSchema,
})
    .then(readChallengeContextFromWorkspace)
    .then(processChallengeContextWithRequirementsAnalyzer);
