import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { UnifiedChallengeContext, Scorecard } from '../../utils/schema/challenge-context';
import { tcAILogger } from '../../utils/logger';


const workflowInputSchema = z.object({
    rootPath: z.string().default('submission').describe('Workspace-relative root path for the submission'),
    aiWorkflowPath: z.string().describe('Absolute path to the scorecard JSON file'),
});

const requirementsAnalyzerInputSchema = z.object({
    challengeContext: z.any(),
    aiWorkflowPath: z.string(),
});

const requirementsAnalyzerOutputSchema = z.object({
    // Define the output schema for the requirements analyzer step here
});

const requirementsAnalyzer = createStep({
    id: 'requirements-analyzer',
    description: 'Executes the requirements analyzer agent',
    inputSchema: requirementsAnalyzerInputSchema,
    outputSchema: requirementsAnalyzerOutputSchema,
    execute: async ({ inputData }) => {
        const ctx = inputData.challengeContext as UnifiedChallengeContext;

        tcAILogger.info(`[ai-reviewer:requirements-analyzer] Starting requirements analysis for challenge "${ctx.title}"`);

        //Load and parse AI workflow (scorecard + LLM config)
        const aiWorkflowRaw = readFileSync(inputData.aiWorkflowPath, 'utf-8');
        const aiWorkflow = JSON.parse(aiWorkflowRaw) as { scorecard: Scorecard };
        const scorecard = aiWorkflow.scorecard;



        return {};
    },
});

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

/**
 * Reads the pre-computed challenge context from `challenge-context.json` at the workspace root.
 */
const readWorkspaceChallengeContext = createStep({
    id: 'read-workspace-challenge-context',
    description: 'Reads challenge-context.json from the workspace root folder to load the pre-computed unified challenge context.',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({ challengeContext: z.any() }),
    execute: async ({ mastra }) => {
        const workspace = mastra!.getWorkspace();
        const fs = workspace?.filesystem;
        if (!fs) {
            tcAILogger.error('[ai-reviewer:read-context] Workspace filesystem is not available');
            throw new Error('Workspace filesystem is not available — cannot read challenge-context.json');
        }

        const fsInfo = fs.getInfo?.();
        const basePath = (fsInfo && 'basePath' in fsInfo) ? (fsInfo as { basePath?: string }).basePath : 'unknown';
        tcAILogger.info(`[ai-reviewer:read-context] Workspace basePath: ${basePath}`);
        tcAILogger.info('[ai-reviewer:read-context] Reading challenge-context.json from workspace root...');

        try {
            const raw = await fs.readFile('challenge-context.json');
            const content = typeof raw === 'string' ? raw : String(raw);
            const challengeContext = JSON.parse(content);
            tcAILogger.info(`[ai-reviewer:read-context] Challenge context loaded: "${challengeContext.title ?? 'Untitled'}" (${content.length} chars)`);
            return { challengeContext };
        } catch (error) {
            tcAILogger.error(`[ai-reviewer:read-context] Failed to read challenge-context.json: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    },
});

/**
 * Pass-through step that forwards the aiWorkflowPath through the
 * parallel fan-out so it is available in the downstream .map() merge.
 */
const passThroughScorecardPath = createStep({
    id: 'passthrough-scorecard-path',
    description: 'Forwards the aiWorkflowPath unchanged so it survives the parallel fan-out.',
    inputSchema: workflowInputSchema,
    outputSchema: z.object({ aiWorkflowPath: z.string() }),
    execute: async ({ inputData }) => ({
        aiWorkflowPath: inputData.aiWorkflowPath,
    }),
});



/**
 * Pipeline C — scorecard file path pass-through.
 */
const scorecardPathPipeline = createWorkflow({
    id: 'scorecard-path-pipeline',
    inputSchema: workflowInputSchema,
    outputSchema: z.any(),
})
    .then(passThroughScorecardPath)
    .commit();

/**
 * Main workflow — AI Reviewer V2.
 *
 */
export const aiReviewerV2Workflow = createWorkflow({
    id: 'ai-reviewer-v2',
    inputSchema: workflowInputSchema,
    outputSchema: requirementsAnalyzerOutputSchema,
})
    .parallel([readWorkspaceChallengeContext, scorecardPathPipeline])
    .then(requirementsAnalyzer)
    .commit();
