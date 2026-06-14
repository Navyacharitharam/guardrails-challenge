/**
 * Utility types and functions for the Requirement Analyzer agent.
 */

// ============================================================================
// Types
// ============================================================================

export interface MaxStepsReachedResult {
    success: false;
    reason: 'max_steps_reached';
    partialOutput: {
        requirementId: string | null;
        title: string | null;
        searchQueries: string[];
        matches: {
            symbolPath: string;
            score: number;
            relevance: string;
            reasoning: string;
        }[];
        coverageScore: number;
        coverageVerdict: 'missing' | 'partial' | 'covered';
        constraints: {
            id: string;
            text: string;
            verified: boolean | null;
            evidence: string | null;
        }[];
    } | null;
    message: string;
    suggestedNextSteps: string[];
    stepsExecuted: number;
    maxSteps: number;
    gatheredContext: string;
}

export interface ToolCallLog {
    toolName: string;
    args: unknown;
    timestamp: string;
}

export interface ToolResultLog {
    toolName: string;
    result: unknown;
    timestamp: string;
}

export interface StepLog {
    stepNumber: number;
    text: string;
    toolCalls: ToolCallLog[];
    toolResults: ToolResultLog[];
    finishReason: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
    timestamp: string;
}

export interface AgentRunLog {
    runId: string;
    startTime: string;
    endTime?: string;
    input: string;
    steps: StepLog[];
    totalUsage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
    finalOutput?: unknown;
}

// ============================================================================
// Configuration
// ============================================================================

export const MAX_STEPS = 25;
export const EARLY_WARNING_THRESHOLD = 20;

export const SUGGESTED_NEXT_STEPS = [
    'Increase maxSteps if the requirement is complex and needs more tool calls',
    'Break down the requirement into smaller, more focused sub-requirements',
    'Pre-filter the search scope by specifying relevant file paths or patterns',
    'Review the partial output and manually verify the remaining constraints',
    'Consider using a more specific search query based on the partial results',
];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract tool name from various possible structures
 */
function getToolNameFromCall(tc: unknown): string | undefined {
    const tcRecord = tc as Record<string, unknown>;
    // AI SDK direct property
    if (tcRecord.toolName) return String(tcRecord.toolName);
    // Mastra wrapper with payload
    if (tcRecord.payload && typeof tcRecord.payload === 'object') {
        const payload = tcRecord.payload as Record<string, unknown>;
        if (payload.toolName) return String(payload.toolName);
    }
    // Function-style
    if (tcRecord.name) return String(tcRecord.name);
    if (tcRecord.function && typeof tcRecord.function === 'object') {
        const fn = tcRecord.function as Record<string, unknown>;
        if (fn.name) return String(fn.name);
    }
    return undefined;
}

export function summarizeGatheredContext(toolCalls: unknown[]): string {
    const summary: string[] = [];
    const toolCounts: Record<string, number> = {};

    for (const tc of toolCalls) {
        const toolName = getToolNameFromCall(tc) || 'unknown';

        // Normalize and count
        let category: string;
        if (toolName.includes('search')) {
            category = 'search';
        } else if (toolName.includes('read')) {
            category = 'read';
        } else {
            category = toolName;
        }

        toolCounts[category] = (toolCounts[category] || 0) + 1;
    }

    // Build summary string
    if (toolCounts.search) summary.push(`${toolCounts.search} search operations`);
    if (toolCounts.read) summary.push(`${toolCounts.read} file reads`);

    // Add any other tools
    for (const [tool, count] of Object.entries(toolCounts)) {
        if (tool !== 'search' && tool !== 'read' && tool !== 'unknown') {
            summary.push(`${count} ${tool} calls`);
        }
    }

    if (toolCounts.unknown) {
        summary.push(`${toolCounts.unknown} unidentified tool calls`);
    }

    return summary.length > 0 ? summary.join(', ') : 'No tool calls recorded';
}
