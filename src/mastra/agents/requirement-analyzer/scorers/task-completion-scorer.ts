/**
 * Task Completion Scorer for isTaskComplete
 * 
 * This scorer evaluates whether the ANALYSIS TASK is complete, NOT whether
 * the requirement is implemented in the submission.
 * 
 * The agent's job is to analyze requirement coverage. A complete analysis:
 * 1. Has executed search queries
 * 2. Has generated a structured report with a clear verdict
 * 3. The verdict can be COVERED, PARTIAL, or MISSING - all are valid completions!
 * 
 * Finding that a requirement is MISSING is a valid and complete analysis result.
 * The scorer should NOT penalize the agent for correctly identifying a
 * low-quality submission that doesn't implement the required features.
 */

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import { ollama, tcAILogger } from '../../../../utils';

// ============================================================================
// Constants
// ============================================================================

/** Maximum iterations before forcing completion to prevent dead loops */
export const MAX_ITERATIONS_BEFORE_FORCE_COMPLETE = 10;

/** Minimum search queries required for a valid analysis */
export const MIN_SEARCH_QUERIES = 1;

// ============================================================================
// Types
// ============================================================================

interface Requirement {
    id: string;
    title: string;
    description?: string;
    constraints?: { id: string; text: string }[];
}

interface CompletionContext {
    iteration: number;
    maxIterations?: number;
    messages: MastraDBMessage[];
    originalTask: string;
    selectedPrimitive: { id: string; type: string };
    primitivePrompt: string;
    primitiveResult: string;
    networkName: string;
    runId: string;
    threadId?: string;
    resourceId?: string;
    customContext?: Record<string, unknown>;
}

interface MastraDBMessage {
    id: string;
    role: string;
    content: MessageContent | string;
    createdAt?: string;
}

interface MessageContent {
    format?: number;
    parts?: MessagePart[];
}

interface MessagePart {
    type: string;
    toolInvocation?: ToolInvocation;
    text?: string;
}

interface ToolInvocation {
    state: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

function isCompletionContext(input: unknown): input is CompletionContext {
    if (!input || typeof input !== 'object') return false;
    const ctx = input as Record<string, unknown>;
    return (
        typeof ctx.primitiveResult === 'string' &&
        typeof ctx.originalTask === 'string' &&
        Array.isArray(ctx.messages)
    );
}

function extractToolInvocationsFromContext(ctx: CompletionContext): ToolInvocation[] {
    const invocations: ToolInvocation[] = [];
    for (const msg of ctx.messages) {
        if (!msg || typeof msg !== 'object') continue;
        const content = msg.content;
        if (content && typeof content === 'object' && 'parts' in content) {
            const parts = (content as MessageContent).parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.type === 'tool-invocation' && part.toolInvocation) {
                        invocations.push(part.toolInvocation);
                    }
                }
            }
        }
    }
    return invocations;
}

function extractSearchQueries(invocations: ToolInvocation[]): string[] {
    const queries: string[] = [];
    const seen = new Set<string>();
    for (const inv of invocations) {
        if (inv.toolName === 'submission_search' && inv.args?.query) {
            const query = String(inv.args.query);
            if (!seen.has(query)) {
                seen.add(query);
                queries.push(query);
            }
        }
    }
    return queries;
}

function extractFinalReport(ctx: CompletionContext): string | null {
    // Check primitiveResult first
    if (ctx.primitiveResult?.includes('# Requirement Analysis Report')) {
        return ctx.primitiveResult;
    }
    // Then check messages
    for (const msg of ctx.messages) {
        if (msg.role !== 'assistant') continue;
        const content = msg.content;
        if (typeof content === 'string' && content.includes('# Requirement Analysis Report')) {
            return content;
        }
        if (content && typeof content === 'object' && 'parts' in content) {
            const parts = (content as MessageContent).parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.type === 'text' && part.text?.includes('# Requirement Analysis Report')) {
                        return part.text;
                    }
                }
            }
        }
    }
    return null;
}

function extractVerdictFromReport(report: string | null): { verdict: string; score: number } | null {
    if (!report) return null;
    
    // Look for verdict patterns - try many formats agents might use
    const verdictPatterns = [
        // Standard formats
        /\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED|IMPLEMENTED|NOT IMPLEMENTED)/i,
        /VERDICT:\s*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED|IMPLEMENTED|NOT IMPLEMENTED)/i,
        /Coverage Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED)/i,
        // Alternative section headers
        /#+\s*(?:Final\s+)?Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY|PARTIALLY|NOT)/i,
        /#+\s*(?:Coverage\s+)?(?:Assessment|Conclusion)[:\s\S]{0,50}(COVERED|PARTIAL|MISSING|FULLY|PARTIALLY)/i,
        // Inline mentions
        /(?:overall|final|coverage)\s+(?:verdict|assessment|conclusion)[:\s]*(COVERED|PARTIAL|MISSING)/i,
        /requirement\s+is\s+(COVERED|PARTIAL(?:LY)?|MISSING|NOT\s+(?:COVERED|IMPLEMENTED))/i,
        /implementation\s+is\s+(COMPLETE|PARTIAL|MISSING|INCOMPLETE)/i,
        // Score-based verdicts
        /coverage[:\s]+(\d+(?:\.\d+)?)\s*%/i,
        // Risk-level based verdicts (for quality/risk analysis reports)
        /Overall Risk Level[:\s]*(Low|Medium|High|Critical)/i,
        /Risk (?:Level|Assessment)[:\s]*(Low|Medium|High|Critical)/i,
        // Conclusion section verdicts
        /#+\s*\d*\.?\s*Conclusion[\s\S]{0,200}(?:Overall|Final|Risk)[:\s]*(Low|Medium|High|Critical|COVERED|PARTIAL|MISSING)/i,
    ];

    for (const pattern of verdictPatterns) {
        const match = report.match(pattern);
        if (match) {
            let verdict = match[1].toLowerCase().trim();
            // Normalize verdict values
            if (verdict.includes('fully') || verdict === 'complete' || verdict === 'implemented') verdict = 'covered';
            if (verdict.includes('partial') || verdict === 'incomplete') verdict = 'partial';
            if (verdict.includes('not') || verdict.includes('missing')) verdict = 'missing';
            // Handle risk levels (Low=covered, Medium=partial, High/Critical=missing)
            if (verdict === 'low') verdict = 'covered';
            if (verdict === 'medium') verdict = 'partial';
            if (verdict === 'high' || verdict === 'critical') verdict = 'partial'; // Still valid analysis, just high risk
            // Handle percentage scores
            if (/^\d+/.test(verdict)) {
                const pct = parseFloat(verdict);
                verdict = pct >= 80 ? 'covered' : pct >= 40 ? 'partial' : 'missing';
            }
            
            const scoreMatch = report.match(/(?:Overall\s+)?(?:Coverage\s+)?Score:?\s*([0-9.]+)/i) ||
                report.match(/SCORE:\s*([0-9.]+)/i) ||
                report.match(/coverage[:\s]+(\d+(?:\.\d+)?)\s*%/i);
            const score = scoreMatch ? parseFloat(scoreMatch[1]) / (scoreMatch[1].includes('.') || parseFloat(scoreMatch[1]) <= 1 ? 1 : 100) :
                verdict === 'covered' ? 0.85 : verdict === 'partial' ? 0.5 : 0.0;
            
            return { verdict, score };
        }
    }
    return null;
}

function extractRequirementFromContext(ctx: CompletionContext): Requirement {
    // Try JSON in originalTask
    const jsonMatch = ctx.originalTask.match(/\{[\s\S]*"id"[\s\S]*"title"[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const req = JSON.parse(jsonMatch[0]) as Requirement;
            if (req.id && req.title) {
                return { id: req.id, title: req.title, description: req.description, constraints: req.constraints || [] };
            }
        } catch { /* ignore */ }
    }
    // Try from report
    const report = extractFinalReport(ctx);
    if (report) {
        const idMatch = report.match(/\*\*ID:\*\*\s*([^\n*]+)/i);
        const titleMatch = report.match(/\*\*Title:\*\*\s*([^\n*]+)/i);
        if (idMatch || titleMatch) {
            return {
                id: idMatch ? idMatch[1].trim().replace(/[`[\]"]/g, '') : 'from-report',
                title: titleMatch ? titleMatch[1].trim() : 'Unknown Requirement',
                constraints: [],
            };
        }
    }
    return { id: 'from-task', title: ctx.originalTask.slice(0, 100), constraints: [] };
}

/**
 * Check if the report has key sections that indicate a complete analysis
 */
function checkReportCompleteness(report: string | null): {
    hasRequirementSummary: boolean;
    hasSearchStrategy: boolean;
    hasCodeMatches: boolean;
    hasConstraintVerification: boolean;
    hasCoverageAssessment: boolean;
    hasVerdict: boolean;
} {
    if (!report) {
        return {
            hasRequirementSummary: false,
            hasSearchStrategy: false,
            hasCodeMatches: false,
            hasConstraintVerification: false,
            hasCoverageAssessment: false,
            hasVerdict: false,
        };
    }

    // Check for verdict using multiple patterns
    const hasVerdict = /Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY|NOT)/i.test(report) ||
        /(?:overall|final|coverage)\s+(?:verdict|assessment|conclusion)/i.test(report) ||
        /requirement\s+is\s+(COVERED|PARTIAL|MISSING|NOT)/i.test(report) ||
        /implementation\s+is\s+(COMPLETE|PARTIAL|MISSING|INCOMPLETE)/i.test(report) ||
        /#+\s*(?:Final\s+)?(?:Verdict|Conclusion|Assessment)/i.test(report) ||
        /Overall Risk Level[:\s]*(Low|Medium|High|Critical)/i.test(report) ||
        /#+\s*\d*\.?\s*Conclusion/i.test(report);

    return {
        hasRequirementSummary: /Requirement Summary|## 1\./i.test(report),
        hasSearchStrategy: /Search Strategy|Queries Executed|## 2\./i.test(report),
        hasCodeMatches: /Code Matches|Primary Matches|## 3\./i.test(report),
        hasConstraintVerification: /Constraint Verification|## 5\./i.test(report),
        hasCoverageAssessment: /Coverage Assessment|## 6\./i.test(report),
        hasVerdict,
    };
}

// ============================================================================
// Preprocess Result
// ============================================================================

interface PreprocessResult {
    iteration: number;
    maxIterations: number;
    requirement: Requirement;
    searchQueriesCount: number;
    hasReport: boolean;
    reportVerdict: { verdict: string; score: number } | null;
    reportCompleteness: ReturnType<typeof checkReportCompleteness>;
    shouldForceComplete: boolean;
    forceCompleteReason: string | null;
}

// ============================================================================
// Scorer Logic
// ============================================================================

function preprocessFn(run: { input: unknown; output: unknown }): PreprocessResult {
    tcAILogger.debug('[TaskCompletionScorer] Starting preprocess step');

    if (!isCompletionContext(run.input)) {
        tcAILogger.warn('[TaskCompletionScorer] Input is not CompletionContext format');
        return {
            iteration: 0,
            maxIterations: 10,
            requirement: { id: 'unknown', title: 'Unknown', constraints: [] },
            searchQueriesCount: 0,
            hasReport: false,
            reportVerdict: null,
            reportCompleteness: checkReportCompleteness(null),
            shouldForceComplete: false,
            forceCompleteReason: null,
        };
    }

    const ctx = run.input;
    const invocations = extractToolInvocationsFromContext(ctx);
    const searchQueries = extractSearchQueries(invocations);
    const report = extractFinalReport(ctx);
    const reportVerdict = extractVerdictFromReport(report);
    const requirement = extractRequirementFromContext(ctx);
    const reportCompleteness = checkReportCompleteness(report);
    const maxIterations = ctx.maxIterations ?? 10;

    // Determine if we should force completion
    let shouldForceComplete = false;
    let forceCompleteReason: string | null = null;

    // Force complete if we have a valid report with a verdict
    if (report && reportVerdict) {
        shouldForceComplete = true;
        forceCompleteReason = `Report generated with verdict: ${reportVerdict.verdict.toUpperCase()}`;
    }
    // Force complete if max iterations exceeded
    else if (ctx.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE) {
        shouldForceComplete = true;
        forceCompleteReason = `Max iterations (${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}) reached`;
    }
    // Force complete if we have a report with most key sections
    else if (report && reportCompleteness.hasVerdict && reportCompleteness.hasCoverageAssessment) {
        shouldForceComplete = true;
        forceCompleteReason = 'Report has verdict and coverage assessment';
    }

    tcAILogger.info('[TaskCompletionScorer] Preprocess complete', {
        iteration: ctx.iteration,
        maxIterations,
        requirementId: requirement.id,
        searchQueriesCount: searchQueries.length,
        hasReport: !!report,
        reportVerdict: reportVerdict?.verdict ?? 'none',
        reportVerdictScore: reportVerdict?.score?.toFixed(2) ?? 'N/A',
        shouldForceComplete,
        forceCompleteReason,
        reportCompleteness: JSON.stringify(reportCompleteness),
    });

    return {
        iteration: ctx.iteration,
        maxIterations,
        requirement,
        searchQueriesCount: searchQueries.length,
        hasReport: !!report,
        reportVerdict,
        reportCompleteness,
        shouldForceComplete,
        forceCompleteReason,
    };
}

// ============================================================================
// Analyze Schema - Focus on ANALYSIS completeness, not implementation coverage
// ============================================================================

const analyzeOutputSchema = z.object({
    searchStrategyScore: z.number().min(0).max(1).describe('Did the agent use appropriate search queries? (0-1)'),
    reportCompletenessScore: z.number().min(0).max(1).describe('Does the report have all required sections? (0-1)'),
    verdictClarityScore: z.number().min(0).max(1).describe('Is the coverage verdict clear and justified? (0-1)'),
    constraintAnalysisScore: z.number().min(0).max(1).describe('Were constraints properly analyzed (verified or noted as unverifiable)? (0-1)'),
    analysisComplete: z.boolean().describe('Is the analysis task complete regardless of the verdict?'),
    reasoning: z.string().describe('Brief explanation of the analysis completeness'),
});

type AnalyzeResult = z.infer<typeof analyzeOutputSchema>;

const SCORER_INSTRUCTIONS = `You evaluate whether a requirement ANALYSIS task is complete.

IMPORTANT: The agent's task is to ANALYZE requirement coverage in a codebase, NOT to implement features.
Finding that a requirement is MISSING is a VALID and COMPLETE analysis result!

A task is COMPLETE when:
1. The agent executed search queries to investigate the codebase
2. The agent generated a structured report with a clear verdict (COVERED, PARTIAL, or MISSING)
3. The verdict is justified with evidence or clear explanation of what's missing
4. Constraints were analyzed (verified or explicitly noted as not found)

A MISSING verdict with good justification = COMPLETE TASK
A COVERED verdict with evidence = COMPLETE TASK
A PARTIAL verdict with gaps identified = COMPLETE TASK

The task is INCOMPLETE only if:
- No search queries were executed
- No report was generated
- The report lacks a clear verdict
- The analysis is obviously unfinished`;

function analyzePromptFn(prep: PreprocessResult): string {
    const completeness = prep.reportCompleteness;

    return `Evaluate if this requirement analysis task is COMPLETE (iteration ${prep.iteration}/${prep.maxIterations}):

REQUIREMENT BEING ANALYZED:
- ID: ${prep.requirement.id}
- Title: ${prep.requirement.title}

ANALYSIS ACTIVITY:
- Search queries executed: ${prep.searchQueriesCount}
- Report generated: ${prep.hasReport ? 'YES' : 'NO'}
- Report verdict: ${prep.reportVerdict?.verdict?.toUpperCase() ?? 'NONE'}
- Verdict score: ${prep.reportVerdict?.score?.toFixed(2) ?? 'N/A'}

REPORT SECTIONS PRESENT:
- Requirement Summary: ${completeness.hasRequirementSummary ? '✓' : '✗'}
- Search Strategy: ${completeness.hasSearchStrategy ? '✓' : '✗'}
- Code Matches: ${completeness.hasCodeMatches ? '✓' : '✗'}
- Constraint Verification: ${completeness.hasConstraintVerification ? '✓' : '✗'}
- Coverage Assessment: ${completeness.hasCoverageAssessment ? '✓' : '✗'}
- Clear Verdict: ${completeness.hasVerdict ? '✓' : '✗'}

FORCE COMPLETION CHECK:
- Should force complete: ${prep.shouldForceComplete ? 'YES' : 'NO'}
- Reason: ${prep.forceCompleteReason ?? 'N/A'}

REMEMBER: A MISSING verdict is a valid analysis result! The task is complete if the agent properly investigated and concluded that the requirement is not implemented.

Score each dimension from 0 to 1:
- searchStrategyScore: Were search queries executed and appropriate?
- reportCompletenessScore: Does the report have the key sections?
- verdictClarityScore: Is the verdict clear and justified?
- constraintAnalysisScore: Were constraints analyzed?
- analysisComplete: true if the analysis task is done (regardless of verdict)
- reasoning: Brief explanation`;
}

function generateScoreFn(analysis: AnalyzeResult, prep: PreprocessResult): number {
    // A "valid" report must have a verdict - check BOTH sources since they may disagree
    // - prep.reportVerdict: extracted by extractVerdictFromReport() (more reliable)
    // - prep.reportCompleteness.hasVerdict: regex check in checkReportCompleteness()
    const hasExtractedVerdict = prep.reportVerdict !== null && prep.reportVerdict.verdict !== '';
    
    // Count how many completeness checks pass - if most pass, the report is likely complete
    const completenessScore = [
        prep.reportCompleteness.hasRequirementSummary,
        prep.reportCompleteness.hasSearchStrategy,
        prep.reportCompleteness.hasCodeMatches,
        prep.reportCompleteness.hasConstraintVerification,
        prep.reportCompleteness.hasCoverageAssessment,
        prep.reportCompleteness.hasVerdict,
    ].filter(Boolean).length;
    
    // Report is valid if: (has extracted verdict) OR (has verdict in completeness) OR (has 5+ sections)
    const hasValidReport = prep.hasReport && (
        hasExtractedVerdict || 
        prep.reportCompleteness.hasVerdict || 
        completenessScore >= 5
    );
    const hasMinimalReport = prep.hasReport && (
        hasExtractedVerdict ||
        prep.reportCompleteness.hasVerdict ||
        prep.reportCompleteness.hasCoverageAssessment ||
        completenessScore >= 4
    );

    // =========================================================================
    // HARD STOP: Max iterations reached - ALWAYS return 1 to stop the loop
    // =========================================================================
    if (prep.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE) {
        if (hasValidReport) {
            tcAILogger.info('[TaskCompletionScorer] Max iterations reached WITH valid report - completing successfully', {
                iteration: prep.iteration,
                maxIterations: MAX_ITERATIONS_BEFORE_FORCE_COMPLETE,
                verdict: prep.reportVerdict?.verdict ?? 'none',
                hasExtractedVerdict,
                completenessScore,
                hasValidReport,
            });
        } else {
            tcAILogger.error('[TaskCompletionScorer] FORCED TERMINATION: Max iterations reached WITHOUT valid report', {
                iteration: prep.iteration,
                maxIterations: MAX_ITERATIONS_BEFORE_FORCE_COMPLETE,
                hasReport: prep.hasReport,
                hasExtractedVerdict,
                completenessScore,
                reportVerdictValue: prep.reportVerdict?.verdict ?? 'null',
                hasCompletenessVerdict: prep.reportCompleteness.hasVerdict,
            });
        }
        // Return 1 to STOP the agent loop - the reason will indicate success/failure
        return 1;
    }

    // =========================================================================
    // Normal completion checks (iterations < MAX)
    // =========================================================================

    // Force complete ONLY if we have a valid report with a verdict
    if (prep.shouldForceComplete && hasValidReport) {
        tcAILogger.info('[TaskCompletionScorer] Force completing task with valid report', {
            reason: prep.forceCompleteReason,
            verdict: prep.reportVerdict?.verdict ?? 'none',
            analysisComplete: analysis.analysisComplete,
        });
        return 1;
    }

    // If the LLM determined analysis is complete AND we have a valid report, return 1
    if (analysis.analysisComplete && hasValidReport) {
        tcAILogger.info('[TaskCompletionScorer] LLM determined analysis is complete', {
            searchStrategyScore: analysis.searchStrategyScore.toFixed(3),
            reportCompletenessScore: analysis.reportCompletenessScore.toFixed(3),
            verdictClarityScore: analysis.verdictClarityScore.toFixed(3),
            reasoning: analysis.reasoning,
        });
        return 1;
    }

    // Calculate weighted score for partial completion
    const weightedScore = (
        analysis.searchStrategyScore * 0.25 +
        analysis.reportCompletenessScore * 0.35 +
        analysis.verdictClarityScore * 0.25 +
        analysis.constraintAnalysisScore * 0.15
    );

    // Complete only if weighted score is high AND we have at least a minimal report
    const isComplete = (weightedScore >= 0.7 && hasMinimalReport) ? 1 : 0;

    tcAILogger.info('[TaskCompletionScorer] Generated score', {
        searchStrategyScore: analysis.searchStrategyScore.toFixed(3),
        reportCompletenessScore: analysis.reportCompletenessScore.toFixed(3),
        verdictClarityScore: analysis.verdictClarityScore.toFixed(3),
        constraintAnalysisScore: analysis.constraintAnalysisScore.toFixed(3),
        weightedScore: weightedScore.toFixed(3),
        analysisComplete: analysis.analysisComplete,
        hasReport: prep.hasReport,
        hasValidReport,
        hasMinimalReport,
        binaryScore: isComplete,
        iteration: prep.iteration,
    });

    return isComplete;
}

// ============================================================================
// Scorer Definition
// ============================================================================

export const taskCompletionScorer = createScorer({
    id: 'task-completion',
    description: 'Determines if the requirement ANALYSIS task is complete (not implementation coverage)',
    judge: {
        model: ollama('qwen3.5:latest'),
        instructions: SCORER_INSTRUCTIONS,
    },
})
    .preprocess(({ run }) => preprocessFn({ input: run.input, output: run.output }))
    .analyze({
        description: 'Analyze if the requirement analysis task is complete',
        outputSchema: analyzeOutputSchema,
        createPrompt: ({ results }) => analyzePromptFn(results.preprocessStepResult),
    })
    .generateScore(({ results }) => generateScoreFn(
        results.analyzeStepResult,
        results.preprocessStepResult
    ))
    .generateReason({
        description: 'Explain why the analysis task is complete or incomplete',
        createPrompt: ({ results, score }) => {
            const _analysis = results.analyzeStepResult as AnalyzeResult;
            const prep = results.preprocessStepResult as PreprocessResult;
            const isComplete = score === 1;

            // Check if this is a forced termination due to max iterations without valid report
            // Use same logic as generateScoreFn - check BOTH verdict sources AND completeness score
            const hasExtractedVerdict = prep.reportVerdict !== null && prep.reportVerdict.verdict !== '';
            const completenessScore = [
                prep.reportCompleteness.hasRequirementSummary,
                prep.reportCompleteness.hasSearchStrategy,
                prep.reportCompleteness.hasCodeMatches,
                prep.reportCompleteness.hasConstraintVerification,
                prep.reportCompleteness.hasCoverageAssessment,
                prep.reportCompleteness.hasVerdict,
            ].filter(Boolean).length;
            const hasValidReport = prep.hasReport && (
                hasExtractedVerdict || 
                prep.reportCompleteness.hasVerdict || 
                completenessScore >= 5
            );
            const isForcedTermination = prep.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE && !hasValidReport;

            if (isForcedTermination) {
                // Build detailed failure diagnostics
                const missingElements: string[] = [];
                if (!prep.hasReport) {
                    missingElements.push('No analysis report was generated');
                } else {
                    if (!prep.reportCompleteness.hasVerdict) missingElements.push('Report missing verdict (COVERED/PARTIAL/MISSING)');
                    if (!prep.reportCompleteness.hasRequirementSummary) missingElements.push('Report missing requirement summary section');
                    if (!prep.reportCompleteness.hasCoverageAssessment) missingElements.push('Report missing coverage assessment');
                    if (!prep.reportCompleteness.hasCodeMatches) missingElements.push('Report missing code matches section');
                }
                if (prep.searchQueriesCount === 0) {
                    missingElements.push('No search queries were executed');
                }

                // Detect likely cause
                const likelyCause = prep.searchQueriesCount >= 3 && !prep.hasReport
                    ? 'Context overflow - agent likely ran out of context window before generating report'
                    : prep.searchQueriesCount === 0
                        ? 'Agent failed to start analysis - no searches executed'
                        : prep.hasReport && !prep.reportCompleteness.hasVerdict
                            ? 'Report generated but missing required verdict declaration'
                            : 'Agent iteration loop exhausted without completing analysis';

                // FORCED TERMINATION - max iterations reached without valid report
                return `⚠️ FORCED TERMINATION - ANALYSIS INCOMPLETE

The analysis task was TERMINATED after reaching the maximum iteration limit (${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}) without producing a valid report.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 EXECUTION SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Iterations completed: ${prep.iteration}/${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}
• Search queries executed: ${prep.searchQueriesCount}
• Report generated: ${prep.hasReport ? 'Yes (incomplete)' : 'No'}
• Valid verdict found: No

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ FAILURE DIAGNOSTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${missingElements.map(e => `• ${e}`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 LIKELY CAUSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${likelyCause}

Write exactly: "⚠️ ANALYSIS TERMINATED: Failed to produce valid report after ${prep.iteration} iterations. ${likelyCause}."`;
            }

            // Generate a clear, unambiguous reason based on the score
            if (isComplete) {
                const verdict = prep.reportVerdict?.verdict?.toUpperCase() ?? 'DETERMINED';
                const verdictEmoji = verdict === 'COVERED' ? '✅' : verdict === 'PARTIAL' ? '⚠️' : verdict === 'MISSING' ? '❌' : '📋';
                const reason = prep.shouldForceComplete
                    ? prep.forceCompleteReason
                    : 'Agent completed the analysis with a structured report';

                // Count completed report sections
                const sectionsPresent = [
                    prep.reportCompleteness.hasRequirementSummary,
                    prep.reportCompleteness.hasSearchStrategy,
                    prep.reportCompleteness.hasCodeMatches,
                    prep.reportCompleteness.hasConstraintVerification,
                    prep.reportCompleteness.hasCoverageAssessment,
                    prep.reportCompleteness.hasVerdict,
                ].filter(Boolean).length;

                return `✅ ANALYSIS COMPLETE

The requirement analysis task finished successfully with a valid report.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 ANALYSIS RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Verdict: ${verdictEmoji} ${verdict}
• Coverage Score: ${prep.reportVerdict?.score !== undefined ? (prep.reportVerdict.score * 100).toFixed(0) + '%' : 'N/A'}
• Iterations used: ${prep.iteration}
• Search queries: ${prep.searchQueriesCount}
• Report sections: ${sectionsPresent}/6

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 COMPLETION REASON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${reason}

Write exactly: "✅ Analysis complete. Verdict: ${verdict}${prep.reportVerdict?.score !== undefined ? ` (${(prep.reportVerdict.score * 100).toFixed(0)}% coverage)` : ''}."`;
            } else {
                // Detect likely context overflow (many searches but no report)
                const likelyContextOverflow = prep.searchQueriesCount >= 3 && !prep.hasReport && prep.iteration >= 3;

                const contextManagementTip = likelyContextOverflow
                    ? `\n\nCONTEXT MANAGEMENT TIP: The agent made ${prep.searchQueriesCount} searches but did not generate a report. This may indicate context overflow from large tool outputs. On retry:
1. Use submission_search to identify relevant files first
2. Read specific symbols: submission_read(path="file.ts:symbolName") for targeted analysis
3. Generate the report EARLY before context fills up`
                    : '';

                return `The analysis task is INCOMPLETE.

FACTS:
- Report generated: ${prep.hasReport ? 'YES' : 'NO'}
- Report verdict: ${prep.reportVerdict?.verdict?.toUpperCase() ?? 'NONE'}
- Search queries: ${prep.searchQueriesCount}
- Iteration: ${prep.iteration}

Missing elements:
${!prep.hasReport ? '- NO REPORT GENERATED (critical failure)\n' : ''}${!prep.reportCompleteness.hasVerdict ? '- No clear verdict (COVERED/PARTIAL/MISSING)\n' : ''}${!prep.reportCompleteness.hasRequirementSummary ? '- No requirement summary section\n' : ''}${!prep.reportCompleteness.hasCoverageAssessment ? '- No coverage assessment\n' : ''}${prep.searchQueriesCount === 0 ? '- No search queries executed\n' : ''}${contextManagementTip}

Write a 1-2 sentence explanation of what the agent should do next.
${!prep.hasReport ? 'CRITICAL: The agent MUST generate a "# Requirement Analysis Report" with a verdict!' : ''}
Start your response with "The analysis task is incomplete."`;
            }
        },
    });
