/**
 * Tracking callbacks for the Requirement Analyzer Agent
 */

import { tcAILogger } from '../../../utils/logger';
import {
    MAX_STEPS,
    EARLY_WARNING_THRESHOLD,
    SUGGESTED_NEXT_STEPS,
    summarizeGatheredContext,
} from './utils';

const currentRunId = '';

export const onIterationComplete = (context: any) => {
    const { iteration, maxIterations, text, toolCalls, finishReason, isFinal } = context;

    tcAILogger.debug('[RequirementAnalyzer] Iteration complete', {
        iteration,
        maxIterations,
        finishReason,
        isFinal,
        toolCallsCount: toolCalls?.length || 0,
        textLength: text?.length || 0,
    });

    // Check if output was produced in this iteration
    const hasTextOutput = !!(text?.trim());

    // Early warning: approaching maxSteps, encourage output generation
    if (maxIterations && iteration >= EARLY_WARNING_THRESHOLD && !hasTextOutput) {
        const remainingSteps = maxIterations - iteration;
        tcAILogger.info(`[RequirementAnalyzer] Approaching maxSteps limit without output`, {
            iteration,
            maxIterations,
            remainingSteps,
            hasTextOutput,
        });

        return {
            feedback: `IMPORTANT: You have used ${iteration} of ${maxIterations} iterations. ` +
                `You MUST produce your final JSON output in the next ${remainingSteps} iterations. ` +
                `Do not make more tool calls - synthesize your findings NOW. ` +
                `Based on the evidence gathered, produce the complete JSON response with requirementId, matches, coverageScore, coverageVerdict, and constraints.`,
        };
    }

    // Final iteration handling: if we're at the last step and no output yet
    if (isFinal && !hasTextOutput) {
        tcAILogger.warn('[RequirementAnalyzer] Final iteration reached without output', {
            iteration,
            maxIterations,
            finishReason,
        });
    }

    return undefined;
};

/**
 * Extract tool name from a tool call object (handles multiple possible structures)
 */
function getToolName(tc: any): string {
    // Direct toolName property (AI SDK standard)
    if (tc.toolName) return tc.toolName;
    // Nested in payload (Mastra wrapper)
    if (tc.payload?.toolName) return tc.payload.toolName;
    // Function name property
    if (tc.name) return tc.name;
    // Nested function
    if (tc.function?.name) return tc.function.name;

    // Debug: log the structure when we can't find the name
    tcAILogger.debug('[RequirementAnalyzer] Unknown tool call structure', {
        keys: Object.keys(tc),
        sample: JSON.stringify(tc).slice(0, 500),
    });

    return 'unknown';
}

/**
 * Analyze steps to extract detailed tool usage statistics
 */
function analyzeSteps(steps: any[]): {
    stepBreakdown: { initial: number; continue: number; toolResult: number; unknown: number };
    toolUsage: Record<string, { count: number; inputTokens: number; outputTokens: number; totalTokens: number }>;
    totalToolTokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    toolCallOrder: string[];
} {
    const stepBreakdown = { initial: 0, continue: 0, toolResult: 0, unknown: 0 };
    const toolUsage: Record<string, { count: number; inputTokens: number; outputTokens: number; totalTokens: number }> = {};
    const totalToolTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolCallOrder: string[] = [];

    for (const step of steps) {
        // Count step types
        const stepType = step.stepType as string;
        if (stepType === 'initial') stepBreakdown.initial++;
        else if (stepType === 'continue') stepBreakdown.continue++;
        else if (stepType === 'tool-result') stepBreakdown.toolResult++;
        else stepBreakdown.unknown++;

        // Extract tool calls from this step
        const stepToolCalls = step.toolCalls || [];
        const stepUsage = step.usage || {};

        for (const tc of stepToolCalls) {
            const toolName = getToolName(tc);
            toolCallOrder.push(toolName);

            if (!toolUsage[toolName]) {
                toolUsage[toolName] = { count: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            }
            toolUsage[toolName].count++;
        }

        // Attribute step tokens to tools called in that step (distributed evenly if multiple)
        if (stepToolCalls.length > 0) {
            const inputTokens = stepUsage.inputTokens || stepUsage.promptTokens || 0;
            const outputTokens = stepUsage.outputTokens || stepUsage.completionTokens || 0;
            const totalTokens = stepUsage.totalTokens || (inputTokens + outputTokens);

            const tokensPerTool = {
                inputTokens: Math.round(inputTokens / stepToolCalls.length),
                outputTokens: Math.round(outputTokens / stepToolCalls.length),
                totalTokens: Math.round(totalTokens / stepToolCalls.length),
            };

            for (const tc of stepToolCalls) {
                const toolName = getToolName(tc);
                toolUsage[toolName].inputTokens += tokensPerTool.inputTokens;
                toolUsage[toolName].outputTokens += tokensPerTool.outputTokens;
                toolUsage[toolName].totalTokens += tokensPerTool.totalTokens;
            }

            totalToolTokens.inputTokens += inputTokens;
            totalToolTokens.outputTokens += outputTokens;
            totalToolTokens.totalTokens += totalTokens;
        }
    }

    return { stepBreakdown, toolUsage, totalToolTokens, toolCallOrder };
}

export const onFinish = (result: any) => {
    const usage = (result.usage || {}) as Record<string, number>;
    const steps = (result as Record<string, unknown>).steps as any[] | undefined;
    const stepsCount = steps?.length || 0;

    const hasOutput = !!(result.text?.trim() || result.object);
    const maxStepsReached = stepsCount >= MAX_STEPS;

    // Analyze steps for detailed breakdown
    const stepsAnalysis = steps ? analyzeSteps(steps) : null;

    // Build tool usage summary
    const toolsSummary = stepsAnalysis ? Object.entries(stepsAnalysis.toolUsage).map(([name, stats]) => ({
        tool: name,
        calls: stats.count,
        tokens: stats.totalTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
    })) : [];

    tcAILogger.info(`[RequirementAnalyzer] Run completed`, {
        runId: currentRunId,
        totalSteps: stepsCount,
        stepBreakdown: stepsAnalysis?.stepBreakdown || null,
        totalUsage: {
            inputTokens: usage.inputTokens || usage.promptTokens || 0,
            outputTokens: usage.outputTokens || usage.completionTokens || 0,
            totalTokens: usage.totalTokens || 0,
        },
        toolUsage: {
            tools: toolsSummary,
            totalToolCalls: toolsSummary.reduce((sum, t) => sum + t.calls, 0),
            totalToolTokens: stepsAnalysis?.totalToolTokens || null,
            callOrder: stepsAnalysis?.toolCallOrder || [],
        },
        finishReason: result.finishReason,
        hasObject: !!result.object,
        textLength: result.text?.length || 0,
        maxStepsReached,
        hasOutput,
    });

    const toolCalls = (result as Record<string, unknown>).toolCalls as unknown[] | undefined;
    const gatheredContext = summarizeGatheredContext(toolCalls || []);

    if (maxStepsReached && !hasOutput) {
        tcAILogger.error('[RequirementAnalyzer] MaxSteps reached without any output', {
            stepsExecuted: stepsCount,
            maxSteps: MAX_STEPS,
            finishReason: result.finishReason,
            gatheredContext,
            message: 'Agent stopped before producing output. Consider increasing maxSteps or simplifying the requirement.',
            suggestedNextSteps: SUGGESTED_NEXT_STEPS,
        });
    } else if (maxStepsReached && hasOutput) {
        tcAILogger.warn('[RequirementAnalyzer] MaxSteps reached but output was generated', {
            stepsExecuted: stepsCount,
            maxSteps: MAX_STEPS,
            finishReason: result.finishReason,
            gatheredContext,
            message: 'Output generated based on partial analysis. Results may be incomplete.',
            suggestedNextSteps: SUGGESTED_NEXT_STEPS.slice(0, 3),
        });
    }
};
