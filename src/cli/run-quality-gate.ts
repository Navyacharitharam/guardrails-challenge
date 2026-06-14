#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { mastra } from '../mastra/index.js';
import { tcAILogger, buildQuestionLookupFromScorecard } from '../utils/index.js';
import { waitForWorkspaceIndexing } from '../mastra/workspaces/review.js';
import type { ScoringDistillerOutput } from '../mastra/agents/scoring-distiller/instructions.js';
import { astIndexerService, indexedDocumentPaths } from '../mastra/workspaces/review.js';

// Types for workflow outputs
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

interface ToolUsage {
    totalCalls: number;
    uniqueTools: string[];
    callsByTool: Record<string, number>;
    successCount: number;
    errorCount: number;
}

interface RequirementAnalysisResult {
    id: string;
    title: string;
    requirementAnalyzer: string;
    scoring?: ScoringDistillerOutput;
    tokenUsage?: TokenUsage;
    toolUsage?: ToolUsage;
}

interface ScorerWorkflowOutput {
    scorecard: {
        groupId: string;
        groupName: string;
        weight: number;
        sections: {
            sectionId: string;
            sectionName: string;
            weight: number;
            questions: {
                questionId: string;
                questionDescription: string;
                questionType: 'SCALE' | 'YES_NO' | 'TEST_CASE';
                weight: number;
                scorer: {
                    score: number;
                    report: string;
                };
                tokenUsage?: TokenUsage;
                toolUsage?: ToolUsage;
                error?: string;
            }[];
        }[];
    }[];
    totalUsage: TokenUsage;
    toolUsage: ToolUsage;
    summary: {
        totalQuestions: number;
        successCount: number;
        errorCount: number;
        totalDurationMs: number;
    };
}

// Combined usage data for API reporting
interface CombinedUsage {
    inputTokens: number;
    outputTokens: number;
    totalCalls: number;
    successCount: number;
    errorCount: number;
    callsByTool: Record<string, number>;
}

// Safety timeout to force exit if shutdown hangs (50 seconds - increased for CI)
const SHUTDOWN_TIMEOUT_MS = 50000;
const WORKFLOW_RUN_TIMEOUT_MS = Number(process.env.WORKFLOW_RUN_TIMEOUT_MS ?? 900000);

const CHALLENGE_CONTEXT_WORKFLOW_ID = 'challenge-context';
const WORKFLOW_POLL_INTERVAL = 2000; // 2 seconds
const WORKFLOW_POLL_TIMEOUT = 300000; // 5 minutes

interface WorkflowRunResult {
    status: string;
    result?: unknown;
    error?: { message: string };
}

interface ActiveOperationRecord {
    kind: string;
    label: string;
    startedAt: number;
    metadata?: Record<string, unknown>;
}

let gracefulExitStarted = false;
let mainCompletedSuccessfully = false;

function getActiveOperationRegistry(): Map<string, ActiveOperationRecord> {
    const globalWithRegistry = globalThis as typeof globalThis & {
        __TC_AI_ACTIVE_OPERATIONS__?: Map<string, ActiveOperationRecord>;
    };

    if (!globalWithRegistry.__TC_AI_ACTIVE_OPERATIONS__) {
        globalWithRegistry.__TC_AI_ACTIVE_OPERATIONS__ = new Map<string, ActiveOperationRecord>();
    }

    return globalWithRegistry.__TC_AI_ACTIVE_OPERATIONS__;
}

function dumpExitDiagnostics(origin: string): void {
    const processWithInternals = process as typeof process & {
        _getActiveHandles?: () => unknown[];
        _getActiveRequests?: () => unknown[];
    };

    const activeOperations = [...getActiveOperationRegistry().values()].map((operation) => ({
        ...operation,
        ageMs: Date.now() - operation.startedAt,
    }));
    const activeHandles = processWithInternals._getActiveHandles?.().map((handle) =>
        handle && typeof handle === 'object' && 'constructor' in handle
            ? (handle as { constructor?: { name?: string } }).constructor?.name ?? 'unknown-handle'
            : typeof handle,
    ) ?? [];
    const activeRequests = processWithInternals._getActiveRequests?.().map((request) =>
        request && typeof request === 'object' && 'constructor' in request
            ? (request as { constructor?: { name?: string } }).constructor?.name ?? 'unknown-request'
            : typeof request,
    ) ?? [];

    const payload = JSON.stringify({
        origin,
        pid: process.pid,
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        mainCompletedSuccessfully,
        gracefulExitStarted,
        activeOperations,
        activeHandles,
        activeRequests,
    }, null, 2);

    console.error(`[cli:quality-gate] Exit diagnostics from ${origin}:\n${payload}`);
    tcAILogger.error(`[cli:quality-gate] Exit diagnostics from ${origin}: ${payload}`);
}

function installProcessExitTracing(): void {
    const originalExit = process.exit.bind(process);

    process.exit = ((code?: number | string | null | undefined) => {
        const normalizedCode = typeof code === 'number' ? code : Number(code ?? process.exitCode ?? 0);
        const isSuccess = normalizedCode === 0;

        if (isSuccess) {
            // Friendly info for successful exit
            console.log(`[cli:quality-gate] Process exiting successfully (code ${normalizedCode})`);
            tcAILogger.info(`[cli:quality-gate] Process exiting successfully (code ${normalizedCode})`);
        } else {
            // Error trace for non-zero exit codes
            const stack = new Error(`[cli:quality-gate] process.exit(${normalizedCode}) called`).stack;
            console.error(stack);
            tcAILogger.error(stack ?? `[cli:quality-gate] process.exit(${normalizedCode}) called`);
            dumpExitDiagnostics(`process.exit(${normalizedCode})`);
        }

        return originalExit(normalizedCode);
    }) as typeof process.exit;
}

installProcessExitTracing();

async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

async function fetchChallengeContext(challengeId: string, apiBaseUrl: string, apiToken: string): Promise<unknown> {
    const url = `${apiBaseUrl}/ai-review/context/${challengeId}`;
    tcAILogger.info(`[cli:quality-gate] Fetching challenge context from: ${url}`);

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch challenge context: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

async function postChallengeReviewContext(
    challengeId: string,
    context: unknown,
    apiBaseUrl: string,
    apiToken: string,
): Promise<void> {
    const url = `${apiBaseUrl}/ai-review/context`;
    tcAILogger.info(`[cli:quality-gate] Posting challenge review context to: ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            challengeId,
            context,
            status: 'AI_GENERATED',
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to post challenge review context: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    tcAILogger.info(`[cli:quality-gate] Challenge review context posted successfully`);
}

async function startWorkflowRun(
    workflowId: string,
    inputData: Record<string, unknown>,
    apiBaseUrl: string,
    apiToken: string,
): Promise<string> {
    // Step 1: Create the run
    const createResponse = await fetch(`${apiBaseUrl}/ai/workflows/${workflowId}/create-run`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        },
    });

    if (!createResponse.ok) {
        throw new Error(`Failed to create workflow run: ${createResponse.status} ${createResponse.statusText}`);
    }

    const createResult = await createResponse.json() as { runId?: string };
    const runId = createResult.runId;

    if (!runId) {
        throw new Error('No runId returned from workflow creation');
    }

    // Step 2: Start the run with input
    const startResponse = await fetch(`${apiBaseUrl}/ai/workflows/${workflowId}/start?runId=${runId}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputData }),
    });

    if (!startResponse.ok) {
        throw new Error(`Failed to start workflow run: ${startResponse.status} ${startResponse.statusText}`);
    }

    return runId;
}

async function pollWorkflowRunStatus(
    workflowId: string,
    runId: string,
    apiBaseUrl: string,
    apiToken: string,
): Promise<WorkflowRunResult> {
    const startTime = Date.now();

    while (true) {
        const response = await fetch(`${apiBaseUrl}/ai/workflows/${workflowId}/runs/${runId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to poll workflow status: ${response.status} ${response.statusText}`);
        }

        const result = await response.json() as WorkflowRunResult;

        if (result.status === 'success') {
            return result;
        }

        if (result.status === 'failed') {
            const errorMsg = result.error?.message || 'Workflow execution failed';
            throw new Error(`Workflow failed: ${errorMsg}`);
        }

        const elapsed = Date.now() - startTime;
        if (elapsed > WORKFLOW_POLL_TIMEOUT) {
            throw new Error(`Workflow polling timeout after ${elapsed}ms`);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, WORKFLOW_POLL_INTERVAL));
    }
}

async function triggerChallengeContextWorkflow(
    challengeId: string,
    apiBaseUrl: string,
    apiToken: string,
): Promise<unknown> {
    tcAILogger.info(`[cli:quality-gate] Triggering challenge-context workflow for challenge: ${challengeId}`);

    const runId = await startWorkflowRun(
        CHALLENGE_CONTEXT_WORKFLOW_ID,
        { challengeId },
        apiBaseUrl,
        apiToken,
    );

    tcAILogger.info(`[cli:quality-gate] Workflow started with runId: ${runId}, polling for completion...`);

    const result = await pollWorkflowRunStatus(
        CHALLENGE_CONTEXT_WORKFLOW_ID,
        runId,
        apiBaseUrl,
        apiToken,
    );

    tcAILogger.info(`[cli:quality-gate] Challenge context workflow completed successfully`);

    return result.result;
}

async function main(): Promise<void> {
    const aiWorkflowDetailsPath = process.env.AI_WORKFLOW_DETAILS_PATH;
    const challengeId = process.env.CHALLENGE_ID;
    const workspacePath = process.env.WORKSPACE_PATH;
    const tcApiBaseUrl = process.env.TC_API_BASE_URL;
    const tcApiToken = process.env.TC_API_TOKEN;

    if (!aiWorkflowDetailsPath) {
        console.error('Error: AI_WORKFLOW_DETAILS_PATH environment variable is required');
        process.exit(1);
    }

    if (!challengeId) {
        console.error('Error: CHALLENGE_ID environment variable is required');
        process.exit(1);
    }

    if (!workspacePath) {
        console.error('Error: WORKSPACE_PATH environment variable is required');
        process.exit(1);
    }

    if (!tcApiBaseUrl) {
        console.error('Error: TC_API_BASE_URL environment variable is required');
        process.exit(1);
    }

    if (!tcApiToken) {
        console.error('Error: TC_API_TOKEN environment variable is required');
        process.exit(1);
    }

    const absoluteWorkflowPath = resolve(process.cwd(), aiWorkflowDetailsPath);

    if (!existsSync(absoluteWorkflowPath)) {
        console.error(`Error: AI workflow file not found at: ${absoluteWorkflowPath}`);
        process.exit(1);
    }

    // Ensure workspace directory exists
    if (!existsSync(workspacePath)) {
        mkdirSync(workspacePath, { recursive: true });
    }

    const contextPath = resolve(workspacePath, 'challenge-context.json');

    // Try to fetch existing challenge context, fallback to triggering workflow
    let challengeContext: unknown = null;
    let contextLoadedFromFile = false;

    // Check if challenge context already exists locally
    if (existsSync(contextPath)) {
        tcAILogger.info(`[cli:quality-gate] Challenge context found at: ${contextPath}, skipping fetch`);
        try {
            const existingContent = readFileSync(contextPath, 'utf-8');
            challengeContext = JSON.parse(existingContent);
            contextLoadedFromFile = true;
            tcAILogger.info(`[cli:quality-gate] Challenge context loaded from local file`);
        } catch (parseError) {
            tcAILogger.warn(`[cli:quality-gate] Failed to parse existing context file, will fetch fresh: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
            challengeContext = null;
        }
    }

    // Fetch from API or trigger workflow if not available locally
    if (!challengeContext) {
        try {
            tcAILogger.info(`[cli:quality-gate] Attempting to fetch existing challenge context...`);
            const response = await fetchChallengeContext(challengeId, tcApiBaseUrl, tcApiToken) as { context?: unknown };
            challengeContext = response.context;
            tcAILogger.info(`[cli:quality-gate] Challenge context fetched successfully`);
        } catch {
            tcAILogger.warn(`[cli:quality-gate] Challenge context not found, triggering workflow to generate it...`);

            try {
                challengeContext = await triggerChallengeContextWorkflow(challengeId, tcApiBaseUrl, tcApiToken);
                tcAILogger.info(`[cli:quality-gate] Challenge context generated via workflow`);

                // Post the generated context to the Review API
                try {
                    await postChallengeReviewContext(challengeId, challengeContext, tcApiBaseUrl, tcApiToken);
                } catch (postError) {
                    // 409 Conflict means context already exists - this is fine, continue
                    const errorMessage = postError instanceof Error ? postError.message : String(postError);
                    // Check for statusCode:409 in the JSON response
                    const statusCodeMatch = errorMessage.match(/"statusCode"\s*:\s*(\d+)/);
                    const statusCode = statusCodeMatch ? parseInt(statusCodeMatch[1], 10) : null;
                    if (statusCode === 409) {
                        tcAILogger.info(`[cli:quality-gate] Challenge review context already exists, continuing...`);
                    } else {
                        throw postError;
                    }
                }
            } catch (workflowError) {
                tcAILogger.error(`[cli:quality-gate] Failed to generate challenge context: ${workflowError instanceof Error ? workflowError.message : String(workflowError)}`);
                console.error('Failed to obtain challenge context', workflowError);
                process.exit(1);
            }
        }
    }

    // Only write to file if fetched or generated (not loaded from existing file)
    if (!contextLoadedFromFile) {
        writeFileSync(contextPath, JSON.stringify(challengeContext, null, 2), 'utf-8');
        tcAILogger.info(`[cli:quality-gate] Challenge context written to: ${contextPath}`);
    }

    tcAILogger.info(`[cli:quality-gate] Starting quality gate pipeline`);
    tcAILogger.info(`[cli:quality-gate] AI workflow path: ${absoluteWorkflowPath}`);
    tcAILogger.info(`[cli:quality-gate] Submission ID: ${process.env.SUBMISSION_ID ?? 'not set'}`);
    tcAILogger.info(`[cli:quality-gate] Challenge ID: ${challengeId}`);
    tcAILogger.info(`[cli:quality-gate] Workspace path: ${workspacePath}`);
    tcAILogger.info(`[cli:quality-gate] LLM Provider: ${process.env.LLM_PROVIDER_NAME ?? 'not set'}`);
    tcAILogger.info(`[cli:quality-gate] LLM Model: ${process.env.LLM_MODEL_NAME ?? 'not set'}`);

    // Wait for workspace indexing to complete before executing workflows
    tcAILogger.info(`[cli:quality-gate] Waiting for workspace indexing to complete...`);
    await waitForWorkspaceIndexing();
    tcAILogger.info(`[cli:quality-gate] Workspace indexing complete, proceeding with workflows`);

    // Create output folder for artifacts
    const outputDir = resolve(process.cwd(), 'output');
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
        tcAILogger.info(`[cli:quality-gate] Created output directory: ${outputDir}`);
    }

    try {
        // Load AI workflow details to get the workflow ID
        const aiWorkflowDetails = JSON.parse(readFileSync(absoluteWorkflowPath, 'utf-8'));
        const aiWorkflowId = aiWorkflowDetails.id;
        // Build question lookup from scorecard to get proper scaleMin/scaleMax values
        const questionLookup = aiWorkflowDetails.scorecard
            ? buildQuestionLookupFromScorecard(aiWorkflowDetails.scorecard)
            : undefined;

        // =========================================================================
        // Step 0: Empty/Junk submission check & exit
        // =========================================================================
        if (process.env.TC_RUN_ID) {
            tcAILogger.info(`[cli:quality-gate] === STEP 0: Submission Check ===`);

            const store = astIndexerService.getStore();
            const codeFilePaths = store.getFilePaths();
            const allIndexedPaths = [...new Set([...codeFilePaths, ...indexedDocumentPaths])];

            if (allIndexedPaths.length === 0 || codeFilePaths.length === 0) {
                tcAILogger.warn(`[cli:quality-gate] Empty/Junk submission detected! Failing quality gate with zero scores and exiting gracefully...`);

                const reason = allIndexedPaths.length === 0
                    ? 'No files qualified for indexing found in the submission. Unable to perform quality review.'
                    : 'No code files found in the submission. Unable to perform quality review.';

                const emptyScorerOutput: ScorerWorkflowOutput = {
                    scorecard: generateEmptyScorecard(aiWorkflowDetails.scorecard.scorecardGroups, reason),
                    totalUsage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        totalTokens: 0,
                    },
                    toolUsage: {
                        totalCalls: 0,
                        uniqueTools: [],
                        callsByTool: {},
                        successCount: 0,
                        errorCount: 0,
                    },
                    summary: {
                        totalQuestions: 0,
                        successCount: 0,
                        errorCount: 0,
                        totalDurationMs: 0,
                    },
                };

                // Post results with zero scores and empty evidence to TC API to indicate successful run with no files
                const tcApiResult = await postScorerResultsToTCApi(emptyScorerOutput, aiWorkflowId, questionLookup, {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalCalls: 0,
                    successCount: 0,
                    errorCount: 0,
                    callsByTool: {},
                });

                if (tcApiResult.success) {
                    tcAILogger.info(
                        `[cli:quality-gate] TC API report completed: ` +
                        `${tcApiResult.runItemsCreated} items created, ` +
                        `totalScore=${tcApiResult.totalScore}`,
                    );
                } else {
                    tcAILogger.error(
                        `[cli:quality-gate] TC API report failed: ${tcApiResult.errors.join('; ')}`,
                    );
                    return await gracefulExit(1);
                }

                mainCompletedSuccessfully = true;
                return await gracefulExit(0);
            }
        }

        // =========================================================================
        // Step 1: Execute Requirements Analyzer Workflow
        // =========================================================================
        tcAILogger.info(`[cli:quality-gate] === STEP 1: Requirements Analysis ===`);
        const requirementsWorkflow = mastra.getWorkflow('requirementsAnalyzerWorkflow');
        const requirementsRun = await requirementsWorkflow.createRun();

        tcAILogger.info(
            `[cli:quality-gate] Executing requirements analyzer workflow with timeout ${WORKFLOW_RUN_TIMEOUT_MS}ms`,
        );

        const requirementsResult = await withTimeout(
            requirementsRun.start({
                inputData: {
                    rootPath: 'submission',
                },
            }),
            WORKFLOW_RUN_TIMEOUT_MS,
            'requirementsAnalyzerWorkflow.run.start',
        );

        tcAILogger.info(`[cli:quality-gate] Requirements analysis workflow completed`);

        // Store requirements analysis output to JSON file
        const requirementsOutputPath = resolve(outputDir, 'requirements-analysis-report.json');
        writeFileSync(requirementsOutputPath, JSON.stringify(requirementsResult, null, 2), 'utf-8');
        tcAILogger.info(`[cli:quality-gate] Requirements analysis report written to: ${requirementsOutputPath}`);

        // Extract requirement analysis results for scorer workflow
        const reqWorkflowResult = requirementsResult as { status: string; result?: RequirementAnalysisResult[] };
        if (reqWorkflowResult.status !== 'success' || !reqWorkflowResult.result) {
            throw new Error('Requirements analyzer workflow did not complete successfully');
        }

        // Write individual markdown files for each requirement analysis
        const requirementsMarkdownDir = resolve(outputDir, 'requirements');
        if (!existsSync(requirementsMarkdownDir)) {
            mkdirSync(requirementsMarkdownDir, { recursive: true });
        }

        for (const req of reqWorkflowResult.result) {
            if (req.requirementAnalyzer) {
                // Sanitize filename: replace invalid characters
                const safeId = req.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                const mdFilePath = resolve(requirementsMarkdownDir, `${safeId}.md`);
                const mdContent = `# ${req.title}\n\n**Requirement ID:** ${req.id}\n\n---\n\n${req.requirementAnalyzer}`;
                writeFileSync(mdFilePath, mdContent, 'utf-8');
            }
        }
        tcAILogger.info(`[cli:quality-gate] Requirement analysis markdown files written to: ${requirementsMarkdownDir}`);

        // Extract scoring data from requirements analysis
        const requirementAnalysis = reqWorkflowResult.result
            .filter((r: RequirementAnalysisResult) => r.scoring)
            .map((r: RequirementAnalysisResult) => r.scoring!);

        // Accumulate token and tool usage from requirements analysis step
        const requirementsUsage = reqWorkflowResult.result.reduce(
            (acc, r) => {
                if (r.tokenUsage) {
                    acc.inputTokens += r.tokenUsage.inputTokens;
                    acc.outputTokens += r.tokenUsage.outputTokens;
                }
                if (r.toolUsage) {
                    acc.totalCalls += r.toolUsage.totalCalls;
                    acc.successCount += r.toolUsage.successCount;
                    acc.errorCount += r.toolUsage.errorCount;
                    // Merge callsByTool
                    for (const [tool, count] of Object.entries(r.toolUsage.callsByTool)) {
                        acc.callsByTool[tool] = (acc.callsByTool[tool] ?? 0) + count;
                    }
                }
                return acc;
            },
            {
                inputTokens: 0,
                outputTokens: 0,
                totalCalls: 0,
                successCount: 0,
                errorCount: 0,
                callsByTool: {} as Record<string, number>,
            },
        );

        tcAILogger.info(`[cli:quality-gate] Extracted ${requirementAnalysis.length} requirement scoring results`);
        tcAILogger.info(
            `[cli:quality-gate] Requirements analysis usage: ` +
            `tokens(in=${requirementsUsage.inputTokens}, out=${requirementsUsage.outputTokens}), ` +
            `tools(calls=${requirementsUsage.totalCalls}, success=${requirementsUsage.successCount}, errors=${requirementsUsage.errorCount})`,
        );

        // =========================================================================
        // Step 2: Execute Scorer Workflow
        // =========================================================================
        tcAILogger.info(`[cli:quality-gate] === STEP 2: Scorecard Scoring ===`);
        const scorerWorkflow = mastra.getWorkflow('scorerWorkflow');
        const scorerRun = await scorerWorkflow.createRun();

        tcAILogger.info(
            `[cli:quality-gate] Executing scorer workflow with timeout ${WORKFLOW_RUN_TIMEOUT_MS}ms`,
        );

        const scorerResult = await withTimeout(
            scorerRun.start({
                inputData: {
                    aiWorkflowPath: absoluteWorkflowPath,
                    requirementAnalysis,
                },
            }),
            WORKFLOW_RUN_TIMEOUT_MS,
            'scorerWorkflow.run.start',
        );

        tcAILogger.info(`[cli:quality-gate] Scorer workflow completed`);

        // Store scorer output to JSON file
        const scorerOutputPath = resolve(outputDir, 'scorer-report.json');
        writeFileSync(scorerOutputPath, JSON.stringify(scorerResult, null, 2), 'utf-8');
        tcAILogger.info(`[cli:quality-gate] Scorer report written to: ${scorerOutputPath}`);

        // =========================================================================
        // Step 3: Post Results to TC API
        // =========================================================================
        if (process.env.TC_RUN_ID) {
            tcAILogger.info(`[cli:quality-gate] === STEP 3: Post Results to TC API ===`);
            tcAILogger.info(`[cli:quality-gate] TC_RUN_ID detected, posting results to TC API...`);

            const scorerWorkflowResult = scorerResult as { status: string; result?: ScorerWorkflowOutput };
            const scorerOutput = scorerWorkflowResult.status === 'success' ? scorerWorkflowResult.result : undefined;

            if (scorerOutput && scorerOutput.scorecard) {
                if (!aiWorkflowId) {
                    tcAILogger.error(`[cli:quality-gate] AI workflow ID not found in ${absoluteWorkflowPath}`);
                } else {
                    // Calculate combined usage from all steps (requirements + scorer)
                    const combinedUsage: CombinedUsage = {
                        inputTokens: requirementsUsage.inputTokens + scorerOutput.totalUsage.inputTokens,
                        outputTokens: requirementsUsage.outputTokens + scorerOutput.totalUsage.outputTokens,
                        totalCalls: requirementsUsage.totalCalls + scorerOutput.toolUsage.totalCalls,
                        successCount: requirementsUsage.successCount + scorerOutput.toolUsage.successCount,
                        errorCount: requirementsUsage.errorCount + scorerOutput.toolUsage.errorCount,
                        callsByTool: { ...requirementsUsage.callsByTool },
                    };

                    // Merge scorer tool usage
                    for (const [tool, count] of Object.entries(scorerOutput.toolUsage.callsByTool ?? {})) {
                        combinedUsage.callsByTool[tool] = (combinedUsage.callsByTool[tool] ?? 0) + count;
                    }

                    tcAILogger.info(
                        `[cli:quality-gate] Combined usage: ` +
                        `tokens(in=${combinedUsage.inputTokens}, out=${combinedUsage.outputTokens}), ` +
                        `tools(calls=${combinedUsage.totalCalls}, success=${combinedUsage.successCount}, errors=${combinedUsage.errorCount})`,
                    );
                    tcAILogger.info(`[cli:quality-gate] Tool calls breakdown: ${JSON.stringify(combinedUsage.callsByTool)}`);

                    // Post results using the new scorer output format with combined usage
                    const tcApiResult = await postScorerResultsToTCApi(scorerOutput, aiWorkflowId, questionLookup, combinedUsage);

                    if (tcApiResult.success) {
                        tcAILogger.info(
                            `[cli:quality-gate] TC API report completed: ` +
                            `${tcApiResult.runItemsCreated} items created, ` +
                            `totalScore=${tcApiResult.totalScore}`,
                        );
                    } else {
                        tcAILogger.error(
                            `[cli:quality-gate] TC API report failed: ${tcApiResult.errors.join('; ')}`,
                        );
                        await gracefulExit(1);
                    }
                }
            } else {
                tcAILogger.warn(`[cli:quality-gate] Scorer workflow result does not contain valid scorecard`);
            }
        } else {
            tcAILogger.info(`[cli:quality-gate] TC_RUN_ID not set, skipping TC API posting`);
        }

        mainCompletedSuccessfully = true;

    } catch (error) {
        tcAILogger.error(`[cli:quality-gate] Workflow execution failed: ${error instanceof Error ? error.message : String(error)}`);
        console.error('Workflow execution failed:', error);
        await gracefulExit(1);
    }

    await gracefulExit(0);
}

// ---------------------------------------------------------------------------
// TC API Posting for Scorer Workflow Output
// ---------------------------------------------------------------------------

interface TCApiReportResult {
    success: boolean;
    runItemsCreated: number;
    runUpdated: boolean;
    totalScore: number;
    errors: string[];
}

type QuestionLookup = Record<string, {
    id: string;
    type: 'YES_NO' | 'SCALE' | 'TEST_CASE';
    description: string;
    guidelines: string;
    scaleMin?: number | null;
    scaleMax?: number | null;
}>;

function generateEmptyScorecard(
    scorecard: any[],
    reason: string
): ScorerWorkflowOutput['scorecard'] {
    return scorecard.map((group: any) => ({
        ...group,
        sections: group.sections.map((section: any) => ({
            ...section,
            questions: section.questions.map((question: any) => ({
                ...question,
                scorer: {
                    score: 0,
                    report: reason,
                },
                error: reason,
            })),
        })),
    }));
}

async function postScorerResultsToTCApi(
    scorerOutput: ScorerWorkflowOutput,
    aiWorkflowId: string,
    questionLookup?: QuestionLookup,
    combinedUsage?: CombinedUsage,
): Promise<TCApiReportResult> {
    const { createAIWorkflowRunItems, updateAIWorkflowRun } = await import('tc-ai-utils');

    const result: TCApiReportResult = {
        success: false,
        runItemsCreated: 0,
        runUpdated: false,
        totalScore: 0,
        errors: [],
    };

    // Validate required environment variables
    if (!process.env.TC_API_BASE_URL) {
        result.errors.push('TC_API_BASE_URL environment variable is not set');
        return result;
    }

    if (!process.env.TC_RUN_ID) {
        result.errors.push('TC_RUN_ID environment variable is not set');
        return result;
    }

    if (!process.env.TC_API_TOKEN) {
        result.errors.push('TC_API_TOKEN environment variable is not set');
        return result;
    }

    tcAILogger.info(`[cli:quality-gate] Starting TC API report for workflow ${aiWorkflowId}`);

    // Collect all question results and calculate weighted total score
    // Score formula: totalScore = Σ(groupWeight × sectionWeight × questionWeight × normalizedScore) / 100
    // Where normalizedScore = score / maxScore (0-1 range)
    // Weights are percentages (0-100), so we divide by 100^2 to normalize
    const runItems: { scorecardQuestionId: string; content: string; questionScore: number }[] = [];
    let weightedScoreSum = 0;
    let totalGroupWeight = 0;

    for (const group of scorerOutput.scorecard) {
        const groupWeight = group.weight;
        totalGroupWeight += groupWeight;

        for (const section of group.sections) {
            const sectionWeight = section.weight;

            for (const question of section.questions) {
                const resolvedQuestionId = question.questionId || ((question as unknown as { id?: string }).id ?? '');
                const questionInfo = questionLookup?.[resolvedQuestionId];
                const score = question.scorer.score;
                const questionMaxScore = questionInfo?.scaleMax ?? 5;
                const questionWeight = question.weight;

                // Normalize question score to 0-1 range
                const normalizedScore = questionMaxScore > 0 ? score / questionMaxScore : 0;

                // Calculate weighted contribution:
                // groupWeight (%) × sectionWeight (%) × questionWeight (%) × normalizedScore
                // Divide by 100^2 since section and question weights are percentages within their parent
                const weightedContribution = (groupWeight * sectionWeight * questionWeight * normalizedScore) / 10000;
                weightedScoreSum += weightedContribution;

                // Generate markdown content from scorer report
                const verdictEmoji = score >= 4 ? '✅' : score >= 2 ? '⚠️' : '❌';
                const content = [
                    `## ${verdictEmoji} Score: **${score}/${questionMaxScore}**`,
                    '',
                    question.scorer.report,
                    question.error ? `\n### Error\n${question.error}` : '',
                ].filter(Boolean).join('\n');

                if (!resolvedQuestionId) {
                    result.errors.push(`Missing scorecard question ID for question \"${question.questionDescription}\"`);
                    tcAILogger.error(`[cli:quality-gate] Missing scorecard question ID for question "${question.questionDescription}", skipping run item`);
                    continue;
                }

                runItems.push({
                    scorecardQuestionId: resolvedQuestionId,
                    content,
                    questionScore: score,
                });
            }
        }
    }

    // Total score is the weighted sum (0-100 scale)
    // If all questions score perfectly (normalizedScore=1), totalScore = sum of all group weights
    const totalScore = Math.round(weightedScoreSum * 100) / 100;
    result.totalScore = totalScore;
    tcAILogger.info(`[cli:quality-gate] Prepared ${runItems.length} run items, totalScore=${totalScore} (weighted, max=${totalGroupWeight})`);

    // Post run items in batches as TC API has limitation on payload size and WAF stops large requests
    const MAX_BATCH_SIZE = 2;
    try {
        for (let i = 0; i < runItems.length; i += MAX_BATCH_SIZE) {
            const batch = runItems.slice(i, i + MAX_BATCH_SIZE);
            tcAILogger.info(`[cli:quality-gate] Sending batch ${Math.floor(i / MAX_BATCH_SIZE) + 1}/${Math.ceil(runItems.length / MAX_BATCH_SIZE)}`);

            const response = await createAIWorkflowRunItems(aiWorkflowId, batch);
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            result.runItemsCreated += batch.length;
        }

        tcAILogger.info(`[cli:quality-gate] Successfully created ${result.runItemsCreated} run items`);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to create run items: ${errorMsg}`);
        tcAILogger.error(`[cli:quality-gate] Failed to create run items: ${errorMsg}`);
        return result;
    }

    // Update workflow run with final score and combined usage from all steps
    // Use combined usage if provided, otherwise fall back to scorer-only usage
    const finalTokenUsage = combinedUsage ?? scorerOutput.totalUsage;
    const finalToolUsage = combinedUsage ?? scorerOutput.toolUsage;
    try {
        const updateData = {
            score: totalScore,
            usage: {
                input: finalTokenUsage.inputTokens,
                output: finalTokenUsage.outputTokens,
                toolCalls: finalToolUsage.totalCalls,
                toolCallsSuccess: finalToolUsage.successCount,
                toolCallsError: finalToolUsage.errorCount,
                callsByTool: combinedUsage?.callsByTool ?? scorerOutput.toolUsage.callsByTool,
            },
        };

        const response = await updateAIWorkflowRun(aiWorkflowId, updateData);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        result.runUpdated = true;
        tcAILogger.info(
            `[cli:quality-gate] Successfully updated workflow run: ` +
            `score=${totalScore}, tokens(in=${finalTokenUsage.inputTokens}, out=${finalTokenUsage.outputTokens}), ` +
            `tools(calls=${finalToolUsage.totalCalls}, success=${finalToolUsage.successCount}, errors=${finalToolUsage.errorCount})`,
        );
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to update workflow run: ${errorMsg}`);
        tcAILogger.error(`[cli:quality-gate] Failed to update workflow run: ${errorMsg}`);
        return result;
    }

    result.success = true;
    return result;
}

/**
 * Gracefully shutdown and exit the process.
 * Includes a safety timeout to force exit if shutdown hangs.
 */
async function gracefulExit(code: number): Promise<never> {
    if (gracefulExitStarted) {
        console.error(`[cli:quality-gate] gracefulExit already in progress; forcing exit with code ${code}`);
        process.exit(code);
    }
    gracefulExitStarted = true;

    tcAILogger.info(`[cli:quality-gate] Initiating graceful shutdown with code ${code}`);

    // Set up safety timeout to force exit if shutdown hangs
    // This timer is critical - LibSQL, observability, or other resources may keep event loop alive
    const safetyTimer = setTimeout(() => {
        console.error(`[cli:quality-gate] Shutdown timeout reached (${SHUTDOWN_TIMEOUT_MS}ms), forcing exit`);
        process.exit(code);
    }, SHUTDOWN_TIMEOUT_MS);
    safetyTimer.unref(); // Don't keep process alive just for this timer

    try {
        // Attempt to close mastra resources (storage, observability, etc.)
        // Mastra may not have a close method, but try to access it dynamically
        const mastraAny = mastra as unknown as { close?: () => Promise<void> };
        if (typeof mastraAny.close === 'function') {
            tcAILogger.info(`[cli:quality-gate] Closing mastra resources...`);
            await Promise.race([
                mastraAny.close(),
                new Promise(resolve => setTimeout(resolve, 2000)), // 2s timeout for close
            ]);
            tcAILogger.info(`[cli:quality-gate] Mastra resources closed`);
        }
    } catch (closeError) {
        tcAILogger.warn(`[cli:quality-gate] Error closing mastra resources: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }

    clearTimeout(safetyTimer);
    tcAILogger.info(`[cli:quality-gate] Exiting with code ${code}`);

    // Ensure stdout/stderr are flushed before exit
    // This is critical in CI environments where output may be buffered
    await new Promise<void>((resolve) => {
        process.stdout.write('', () => {
            process.stderr.write('', () => {
                resolve();
            });
        });
    });

    // Force immediate exit - don't wait for event loop to drain
    // This is necessary because LibSQL/observability may keep connections alive
    process.exit(code);
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
    const msg = `[cli:quality-gate] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`;
    console.error(msg);
    tcAILogger.error(msg);
    gracefulExit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    const msg = `[cli:quality-gate] Uncaught exception: ${error.stack || error.message}`;
    console.error(msg);
    tcAILogger.error(msg);
    gracefulExit(1);
});

// Handle termination signals (CI environments may send these)
process.on('SIGTERM', () => {
    const code = mainCompletedSuccessfully ? 0 : 1;
    console.log(`[cli:quality-gate] Received SIGTERM signal (mainCompletedSuccessfully=${mainCompletedSuccessfully})`);
    tcAILogger.warn(`[cli:quality-gate] Received SIGTERM signal (mainCompletedSuccessfully=${mainCompletedSuccessfully}); exiting with code ${code}`);
    gracefulExit(code);
});

process.on('SIGINT', () => {
    const code = mainCompletedSuccessfully ? 0 : 1;
    console.log(`[cli:quality-gate] Received SIGINT signal (mainCompletedSuccessfully=${mainCompletedSuccessfully})`);
    tcAILogger.warn(`[cli:quality-gate] Received SIGINT signal (mainCompletedSuccessfully=${mainCompletedSuccessfully}); exiting with code ${code}`);
    gracefulExit(code);
});

// Add exit handler to log when process is actually exiting
process.on('exit', (code) => {
    console.log(`[cli:quality-gate] Process exit event with code: ${code}`);
});

process.on('beforeExit', (code) => {
    console.error(`[cli:quality-gate] beforeExit event with code: ${code}`);
    dumpExitDiagnostics(`beforeExit(${code})`);
});

main().catch((error) => {
    const msg = `[cli:quality-gate] Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`;
    console.error(msg);
    tcAILogger.error(msg);
    gracefulExit(1);
});
