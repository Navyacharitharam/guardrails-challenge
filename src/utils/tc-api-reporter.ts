import {
    createAIWorkflowRunItems,
    updateAIWorkflowRun,
    type CreateAIWorkflowRunItem,
    type UpdateAIWorkflowRun,
} from 'tc-ai-utils';
import { tcAILogger } from './logger';
import type { ScorecardReport } from '../mastra/workflows/submission-quality-gate';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_REQUEST_BODY_SIZE = 8000; // WAF limit in characters
const API_OPERATION_TIMEOUT_MS = 10000;

// Patterns that commonly trigger WAF rules (SQL injection, XSS, etc.)
const WAF_SENSITIVE_PATTERNS = [
    /DATABASE_URL\s*=\s*[^\s]+/gi,
    /postgresql:\/\/[^\s]+/gi,
    /mysql:\/\/[^\s]+/gi,
    /mongodb:\/\/[^\s]+/gi,
    /redis:\/\/[^\s]+/gi,
    /password\s*[:=]\s*[^\s]+/gi,
    /secret\s*[:=]\s*[^\s]+/gi,
    /api[_-]?key\s*[:=]\s*[^\s]+/gi,
    /auth[_-]?token\s*[:=]\s*[^\s]+/gi,
    /<script[^>]*>/gi,
    /<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
];

interface QuestionAnswer {
    questionId: string;
    applicable: boolean;
    verdict: 'PASS' | 'FAIL' | 'WARN' | 'N_A';
    evidence: string;
    reasoning: string;
    decision: string;
    yesNoAnswer?: boolean | null;
    scaleAnswer?: number | null;
    testCasePass?: boolean | null;
    fileInspections?: {
        filePath: string;
        lineStart?: number | null;
        lineEnd?: number | null;
        snippet?: string;
        observation?: string;
    }[];
    requirementMapping?: {
        requirementId: string;
        status: 'FOUND' | 'PARTIAL' | 'MISSING';
        evidenceRefs?: string[];
    }[];
    evidenceCitations?: {
        filePath: string;
        lineStart?: number | null;
        lineEnd?: number | null;
    }[];
    applicabilityBasis?: {
        checkedSources?: string[];
        summary?: string;
    };
}

interface ScorecardQuestion {
    id: string;
    type: 'YES_NO' | 'SCALE' | 'TEST_CASE';
    description: string;
    guidelines: string;
    scaleMin?: number | null;
    scaleMax?: number | null;
}

function formatFileInspection(inspection: NonNullable<QuestionAnswer['fileInspections']>[number]): string {
    const lines = inspection.lineStart && inspection.lineEnd
        ? ` (L${inspection.lineStart}-L${inspection.lineEnd})`
        : '';
    const observation = inspection.observation ? ` - ${inspection.observation}` : '';
    const snippet = inspection.snippet
        ? `\n\`\`\`\n${inspection.snippet.slice(0, 500)}${inspection.snippet.length > 500 ? '...' : ''}\n\`\`\``
        : '';
    return `- \`${inspection.filePath}\`${lines}${observation}${snippet}`;
}

function formatRequirementMapping(mapping: NonNullable<QuestionAnswer['requirementMapping']>[number]): string {
    const statusEmoji = mapping.status === 'FOUND' ? '✅' : mapping.status === 'PARTIAL' ? '⚠️' : '❌';
    const refs = mapping.evidenceRefs?.length
        ? `\n  - Evidence: ${mapping.evidenceRefs.join(', ')}`
        : '';
    return `- ${statusEmoji} **${mapping.requirementId}**: ${mapping.status}${refs}`;
}

function formatEvidenceCitation(citation: NonNullable<QuestionAnswer['evidenceCitations']>[number]): string {
    const lines = citation.lineStart && citation.lineEnd
        ? `:${citation.lineStart}-${citation.lineEnd}`
        : '';
    return `\`${citation.filePath}${lines}\``;
}

/**
 * Sanitizes content to avoid WAF false positives.
 * Replaces patterns that look like SQL injection, credentials, or XSS attacks.
 */
function sanitizeContentForWAF(content: string): string {
    let sanitized = content;
    for (const pattern of WAF_SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, (match) => {
            // Replace with a safe placeholder that preserves context
            if (match.toLowerCase().includes('database_url') || match.includes('://')) {
                return '[CONNECTION_STRING_REDACTED]';
            }
            if (match.toLowerCase().includes('password')) {
                return '[PASSWORD_REDACTED]';
            }
            if (match.toLowerCase().includes('secret')) {
                return '[SECRET_REDACTED]';
            }
            if (match.toLowerCase().includes('api') || match.toLowerCase().includes('key')) {
                return '[API_KEY_REDACTED]';
            }
            if (match.toLowerCase().includes('token')) {
                return '[TOKEN_REDACTED]';
            }
            if (match.startsWith('<') || match.includes('javascript')) {
                return '[SCRIPT_REMOVED]';
            }
            return '[REDACTED]';
        });
    }
    return sanitized;
}

/**
 * Splits an array of items into batches where each batch's JSON size is under the limit.
 * This prevents WAF from blocking large requests.
 */
function batchItemsBySize<T>(items: T[], maxSize: number): T[][] {
    const batches: T[][] = [];
    let currentBatch: T[] = [];
    let currentSize = 2; // Account for '[]' wrapper

    for (const item of items) {
        const itemSize = JSON.stringify(item).length + 1; // +1 for comma separator

        if (currentBatch.length > 0 && currentSize + itemSize > maxSize) {
            batches.push(currentBatch);
            currentBatch = [item];
            currentSize = 2 + itemSize;
        } else {
            currentBatch.push(item);
            currentSize += itemSize;
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

function generateQuestionContentMarkdown(
    answer: QuestionAnswer,
    question: ScorecardQuestion | undefined,
): string {
    const sections: string[] = [];

    // Header with verdict
    const verdictEmoji = {
        'PASS': '✅',
        'FAIL': '❌',
        'WARN': '⚠️',
        'N_A': '➖',
    }[answer.verdict];
    sections.push(`## ${verdictEmoji} Verdict: **${answer.verdict}**`);

    // Answer value based on type (put this early, right after verdict)
    if (question && answer.applicable) {
        if (question.type === 'YES_NO' && answer.yesNoAnswer !== null && answer.yesNoAnswer !== undefined) {
            sections.push(`**Answer:** ${answer.yesNoAnswer ? 'YES' : 'NO'}`);
        } else if (question.type === 'SCALE' && answer.scaleAnswer !== null && answer.scaleAnswer !== undefined) {
            const min = question.scaleMin ?? 1;
            const max = question.scaleMax ?? null;
            if (max !== null) {
                sections.push(`**Score:** ${answer.scaleAnswer} / ${max} (min: ${min})`);
            } else {
                sections.push(`**Score:** ${answer.scaleAnswer}`);
            }
        } else if (question.type === 'TEST_CASE' && answer.testCasePass !== null && answer.testCasePass !== undefined) {
            sections.push(`**Test Result:** ${answer.testCasePass ? 'PASSED' : 'FAILED'}`);
        }
    }

    // Applicability
    if (!answer.applicable) {
        sections.push(`**Applicability:** Not applicable to this submission.`);
        if (answer.applicabilityBasis?.summary) {
            sections.push(`> ${answer.applicabilityBasis.summary}`);
        }
        return sections.join('\n\n');
    }



    // Evidence
    if (answer.evidence && !answer.evidence.includes('(output truncated')) {
        sections.push(`### Evidence\n${answer.evidence}`);
    }

    // File Inspections
    if (answer.fileInspections?.length) {
        const inspections = answer.fileInspections
            .slice(0, 10) // Limit to 10 inspections
            .map(formatFileInspection)
            .join('\n');
        sections.push(`### File Inspections\n${inspections}`);
    }

    // Evidence Citations
    if (answer.evidenceCitations?.length) {
        const citations = answer.evidenceCitations
            .slice(0, 15) // Limit citations
            .map(formatEvidenceCitation)
            .join(', ');
        sections.push(`### References\n${citations}`);
    }

    // Requirement Mapping
    if (answer.requirementMapping?.length) {
        const mappings = answer.requirementMapping
            .map(formatRequirementMapping)
            .join('\n');
        sections.push(`### Requirement Coverage\n${mappings}`);
    }

    // Reasoning
    if (answer.reasoning && !answer.reasoning.includes('(output truncated')) {
        sections.push(`### Reasoning\n${answer.reasoning}`);
    }

    // Decision
    if (answer.decision && !answer.decision.includes('(output truncated')) {
        sections.push(`### Decision\n${answer.decision}`);
    }

    // Applicability Basis
    if (answer.applicabilityBasis?.checkedSources?.length) {
        sections.push(`### Applicability Check\n- Sources checked: ${answer.applicabilityBasis.checkedSources.join(', ')}`);
        if (answer.applicabilityBasis.summary) {
            sections.push(`- Summary: ${answer.applicabilityBasis.summary}`);
        }
    }

    return sections.join('\n\n');
}

function calculateQuestionScore(
    answer: QuestionAnswer,
    question: ScorecardQuestion | undefined,
): number {
    const questionType = question?.type;

    // N/A questions should receive max score (not penalized)
    if (!answer.applicable || answer.verdict === 'N_A') {
        switch (questionType) {
            case 'YES_NO':
            case 'TEST_CASE':
                return 1; // Max score for binary questions
            case 'SCALE':
                return question?.scaleMax ?? 5; // Max scale value
            default:
                return 1;
        }
    }

    switch (questionType) {
        case 'YES_NO':
            return answer.yesNoAnswer === true ? 1 : 0;
        case 'SCALE':
            return answer.scaleAnswer ?? (question?.scaleMin ?? 1);
        case 'TEST_CASE':
            return answer.testCasePass === true ? 1 : 0;
        default:
            // Fallback based on verdict
            return answer.verdict === 'PASS' ? 1 : 0;
    }
}

async function withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            tcAILogger.info(`[tc-api-reporter] ${operationName} - attempt ${attempt}/${MAX_RETRIES}`);
            return await operation();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            tcAILogger.warn(
                `[tc-api-reporter] ${operationName} failed on attempt ${attempt}/${MAX_RETRIES}: ${lastError.message}`,
            );

            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAY_MS * attempt;
                tcAILogger.info(`[tc-api-reporter] Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError ?? new Error(`${operationName} failed after ${MAX_RETRIES} attempts`);
}

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

type QuestionLookup = Record<string, ScorecardQuestion>;

interface AIWorkflowScorecard {
    scorecardGroups: {
        sections: {
            questions: {
                id: string;
                type: 'YES_NO' | 'SCALE' | 'TEST_CASE';
                description: string;
                guidelines: string;
                scaleMin?: number | null;
                scaleMax?: number | null;
            }[];
        }[];
    }[];
}

export function buildQuestionLookupFromScorecard(scorecard: AIWorkflowScorecard): QuestionLookup {
    const lookup: QuestionLookup = {};

    for (const group of scorecard.scorecardGroups) {
        for (const section of group.sections) {
            for (const question of section.questions) {
                lookup[question.id] = {
                    id: question.id,
                    type: question.type,
                    description: question.description,
                    guidelines: question.guidelines,
                    scaleMin: question.scaleMin,
                    scaleMax: question.scaleMax,
                };
            }
        }
    }

    return lookup;
}

function buildQuestionLookupFromReport(report: ScorecardReport): QuestionLookup {
    const lookup: QuestionLookup = {};

    for (const group of report.groups) {
        for (const section of group.sections) {
            for (const qa of section.questionAnswers) {
                // Infer type from the answer values when scorecard is not available
                const inferredType: 'YES_NO' | 'SCALE' | 'TEST_CASE' =
                    qa.yesNoAnswer !== null && qa.yesNoAnswer !== undefined ? 'YES_NO' :
                        qa.scaleAnswer !== null && qa.scaleAnswer !== undefined ? 'SCALE' :
                            qa.testCasePass !== null && qa.testCasePass !== undefined ? 'TEST_CASE' :
                                'YES_NO'; // Default

                lookup[qa.questionId] = {
                    id: qa.questionId,
                    type: inferredType,
                    description: '',
                    guidelines: '',
                };
            }
        }
    }

    return lookup;
}

export interface TCApiReportResult {
    success: boolean;
    runItemsCreated: number;
    runUpdated: boolean;
    errors: string[];
}

export async function postReviewResultsToTCApi(
    report: ScorecardReport,
    aiWorkflowId: string,
    scorecardQuestions?: QuestionLookup,
): Promise<TCApiReportResult> {
    const result: TCApiReportResult = {
        success: false,
        runItemsCreated: 0,
        runUpdated: false,
        errors: [],
    };

    // Validate required environment variables
    if (!process.env.TC_API_BASE_URL) {
        result.errors.push('TC_API_BASE_URL environment variable is not set');
        tcAILogger.error('[tc-api-reporter] TC_API_BASE_URL environment variable is not set');
        return result;
    }

    if (!process.env.TC_RUN_ID) {
        result.errors.push('TC_RUN_ID environment variable is not set');
        tcAILogger.error('[tc-api-reporter] TC_RUN_ID environment variable is not set');
        return result;
    }

    if (!process.env.TC_API_TOKEN) {
        result.errors.push('TC_API_TOKEN environment variable is not set');
        tcAILogger.error('[tc-api-reporter] TC_API_TOKEN environment variable is not set');
        return result;
    }

    tcAILogger.info(`[tc-api-reporter] Starting TC API report for workflow ${aiWorkflowId}, run ${process.env.TC_RUN_ID}`);

    // Build question lookup if not provided
    const questionLookup = scorecardQuestions ?? buildQuestionLookupFromReport(report);

    // Collect all question answers with their content
    const runItems: CreateAIWorkflowRunItem[] = [];

    for (const group of report.groups) {
        for (const section of group.sections) {
            for (const qa of section.questionAnswers) {
                const question = questionLookup[qa.questionId];
                const content = generateQuestionContentMarkdown(qa as QuestionAnswer, question);
                const questionScore = calculateQuestionScore(qa as QuestionAnswer, question);

                runItems.push({
                    scorecardQuestionId: qa.questionId,
                    content,
                    questionScore,
                });

                tcAILogger.debug(
                    `[tc-api-reporter] Prepared item for question ${qa.questionId}: ` +
                    `verdict=${qa.verdict}, score=${questionScore}`,
                );
            }
        }
    }

    tcAILogger.info(`[tc-api-reporter] Prepared ${runItems.length} run items for submission`);

    // Split run items into batches to avoid WAF blocking large requests
    const batches = batchItemsBySize(runItems, MAX_REQUEST_BODY_SIZE);
    tcAILogger.info(
        `[tc-api-reporter] Split ${runItems.length} run items into ${batches.length} batch(es) ` +
        `(max body size: ${MAX_REQUEST_BODY_SIZE} chars)`,
    );

    // Create run items with retry, processing batches sequentially
    // Handles 403 WAF blocks by sanitizing content and retrying
    try {
        let itemsCreated = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const batchLabel = `${i + 1}/${batches.length}`;
            tcAILogger.info(
                `[tc-api-reporter] Sending batch ${batchLabel} with ${batch.length} items`,
            );

            let success = false;
            let lastError: Error | undefined;

            // Attempt 1: Send as-is
            for (let attempt = 1; attempt <= MAX_RETRIES && !success; attempt++) {
                try {
                    tcAILogger.info(`[tc-api-reporter] Create AI Workflow Run Items (batch ${batchLabel}) - attempt ${attempt}/${MAX_RETRIES}`);
                    const response = await withTimeout(
                        createAIWorkflowRunItems(aiWorkflowId, batch),
                        API_OPERATION_TIMEOUT_MS,
                        `createAIWorkflowRunItems batch ${batchLabel}`,
                    );

                    if (response.ok) {
                        success = true;
                        itemsCreated += batch.length;
                        tcAILogger.info(`[tc-api-reporter] Successfully sent batch ${batchLabel}`);
                        break;
                    }

                    const errorText = await response.text().catch(() => 'Unknown error');

                    // Handle 403 Forbidden (WAF block) - don't retry with same content
                    if (response.status === 403) {
                        tcAILogger.warn(`[tc-api-reporter] Batch ${batchLabel} blocked by WAF (403), attempting content sanitization`);
                        tcAILogger.debug(`[tc-api-reporter] WAF response: ${errorText}`);

                        // Sanitize content and retry once
                        const sanitizedBatch = batch.map(item => ({
                            ...item,
                            content: sanitizeContentForWAF(item.content),
                        }));

                        tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} with sanitized content`);
                        const sanitizedResponse = await withTimeout(
                            createAIWorkflowRunItems(aiWorkflowId, sanitizedBatch),
                            API_OPERATION_TIMEOUT_MS,
                            `createAIWorkflowRunItems batch ${batchLabel} (sanitized)`,
                        );

                        if (sanitizedResponse.ok) {
                            success = true;
                            itemsCreated += batch.length;
                            tcAILogger.info(`[tc-api-reporter] Successfully sent batch ${batchLabel} after sanitization`);
                            break;
                        }

                        // If sanitized batch still fails, try sending items one by one
                        tcAILogger.warn(`[tc-api-reporter] Sanitized batch ${batchLabel} still blocked, trying individual items`);
                        let individualSuccess = 0;
                        for (const item of sanitizedBatch) {
                            try {
                                const singleResponse = await withTimeout(
                                    createAIWorkflowRunItems(aiWorkflowId, [item]),
                                    API_OPERATION_TIMEOUT_MS,
                                    `createAIWorkflowRunItems single item ${item.scorecardQuestionId}`,
                                );
                                if (singleResponse.ok) {
                                    individualSuccess++;
                                } else {
                                    tcAILogger.warn(`[tc-api-reporter] Failed to send item ${item.scorecardQuestionId}: HTTP ${singleResponse.status}`);
                                }
                            } catch (singleError) {
                                tcAILogger.warn(`[tc-api-reporter] Failed to send item ${item.scorecardQuestionId}: ${singleError instanceof Error ? singleError.message : String(singleError)}`);
                            }
                        }
                        itemsCreated += individualSuccess;
                        tcAILogger.info(`[tc-api-reporter] Batch ${batchLabel}: sent ${individualSuccess}/${batch.length} items individually`);
                        success = true; // Mark as handled (even if partial)
                        break;
                    }

                    // For other errors, log and retry
                    tcAILogger.error(`[tc-api-reporter] API Error Response: ${errorText}`);
                    lastError = new Error(`HTTP ${response.status}: ${errorText}`);

                    if (attempt < MAX_RETRIES) {
                        const delay = RETRY_DELAY_MS * attempt;
                        tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} in ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    tcAILogger.warn(
                        `[tc-api-reporter] Batch ${batchLabel} attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`,
                    );

                    if (attempt < MAX_RETRIES) {
                        const delay = RETRY_DELAY_MS * attempt;
                        tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} in ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            if (!success && lastError) {
                throw lastError;
            }
        }

        result.runItemsCreated = itemsCreated;
        tcAILogger.info(`[tc-api-reporter] Successfully created ${itemsCreated} run items in ${batches.length} batch(es)`);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to create run items: ${errorMsg}`);
        tcAILogger.error(`[tc-api-reporter] Failed to create run items: ${errorMsg}`);
        return result;
    }

    // Update workflow run with final score and usage
    const updateData: UpdateAIWorkflowRun = {
        score: report.totalScore,
        usage: {
            input: report.tokenUsage.summary.inputTokens,
            output: report.tokenUsage.summary.outputTokens,
        },
    };

    try {
        await withRetry(
            async () => {
                const response = await updateAIWorkflowRun(aiWorkflowId, updateData);
                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'Unknown error');
                    tcAILogger.error(`[tc-api-reporter] API Error Response: ${errorText}`);
                    tcAILogger.error(`[tc-api-reporter] Response status: ${response.status}`);
                    tcAILogger.error(`[tc-api-reporter] Request body: ${JSON.stringify(updateData)}`);
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }
                return response;
            },
            'Update AI Workflow Run',
        );

        result.runUpdated = true;
        tcAILogger.info(
            `[tc-api-reporter] Successfully updated workflow run with score=${report.totalScore}, ` +
            `usage=(input=${updateData.usage.input}, output=${updateData.usage.output})`,
        );
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to update workflow run: ${errorMsg}`);
        tcAILogger.error(`[tc-api-reporter] Failed to update workflow run: ${errorMsg}`);
        return result;
    }

    result.success = true;
    tcAILogger.info(
        `[tc-api-reporter] TC API report completed successfully: ` +
        `${result.runItemsCreated} items created, run updated with score ${report.totalScore}`,
    );

    return result;
}

export async function postReviewResultsFromFile(
    reportPath: string,
    aiWorkflowId: string,
): Promise<TCApiReportResult> {
    const { readFileSync } = await import('node:fs');

    tcAILogger.info(`[tc-api-reporter] Loading report from ${reportPath}`);

    try {
        const reportContent = readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(reportContent) as { result?: ScorecardReport };

        // Handle both direct report and wrapped result format
        const scorecardReport = report.result ?? report as unknown as ScorecardReport;

        if (!scorecardReport.groups || scorecardReport.totalScore === undefined) {
            throw new Error('Invalid report format: missing required fields (groups, totalScore)');
        }

        return postReviewResultsToTCApi(scorecardReport, aiWorkflowId);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        tcAILogger.error(`[tc-api-reporter] Failed to load or parse report: ${errorMsg}`);
        return {
            success: false,
            runItemsCreated: 0,
            runUpdated: false,
            errors: [`Failed to load report: ${errorMsg}`],
        };
    }
}
