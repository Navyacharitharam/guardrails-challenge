import { createStep } from "@mastra/core/workflows";
import { readFile } from "node:fs/promises";
import path from "node:path";
import z from "zod";
import { tcAILogger } from "../../../utils";
import { unifiedContextSchema } from "../../../utils";

const readChallengeContextFromWorkspaceInputSchema = z.object({
    rootPath: z.string().default('submission').describe('Workspace-relative root path for the submission'),
});

/**
 * Reads the pre-computed challenge context from `challenge-context.json` at the workspace root.
 */
export const readChallengeContextFromWorkspace = createStep({
    id: 'read-workspace-challenge-context',
    description: 'Reads challenge-context.json from the workspace root folder to load the pre-computed unified challenge context.',
    inputSchema: readChallengeContextFromWorkspaceInputSchema,
    outputSchema: unifiedContextSchema,
    execute: async () => {
        const challengeContextPath = path.resolve(process.env.WORKSPACE_PATH as string, 'challenge-context.json');

        tcAILogger.info(`[ai-reviewer:read-context] Reading challenge-context.json from: ${challengeContextPath}`);

        try {
            const content = await readFile(challengeContextPath, 'utf-8');
            const challengeContext = JSON.parse(content);
            tcAILogger.info(`[ai-reviewer:read-context] Challenge context loaded: "${challengeContext.title ?? 'Untitled'}" (${content.length} chars)`);
            return { ...challengeContext };
        } catch (error) {
            tcAILogger.error(`[ai-reviewer:read-context] Failed to read ${challengeContextPath}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    },
});
