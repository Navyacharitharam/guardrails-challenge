/**
 * Default options for the Requirement Analyzer Agent
 */

import type { Agent, StreamIsTaskCompleteConfig } from '@mastra/core/agent';
import { MAX_STEPS } from './utils';
import { onIterationComplete, onFinish } from './callbacks';
import { tcAILogger } from '../../../utils';
import { taskCompletionScorer } from './scorers';

/**
 * Configuration for determining when the requirement ANALYSIS task is complete.
 * 
 * IMPORTANT: This evaluates whether the ANALYSIS is complete, NOT whether the
 * requirement is implemented in the submission. Finding that a requirement is
 * MISSING is a valid and complete analysis result!
 * 
 * The scorer evaluates:
 * - Search Strategy: Did the agent execute appropriate search queries?
 * - Report Completeness: Does the report have all required sections?
 * - Verdict Clarity: Is the coverage verdict clear and justified?
 * - Constraint Analysis: Were constraints properly analyzed?
 * 
 * Task is COMPLETE when:
 * - A report with a clear verdict (COVERED, PARTIAL, or MISSING) is generated
 * - OR max iterations ({@link MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}) is reached
 * 
 * Returns: 1 (complete) or 0 (incomplete)
 */
const isTaskComplete: StreamIsTaskCompleteConfig = {
    scorers: [taskCompletionScorer],
    strategy: 'all',
    timeout: 120000, // 2 minutes for scorer evaluation
    suppressFeedback: false, // Include feedback for debugging
    onComplete: (results) => {
        tcAILogger.info('[isTaskComplete] Completion check finished', {
            complete: results.complete,
            completionReason: results.completionReason ?? 'none',
            totalDuration: `${results.totalDuration}ms`,
            timedOut: results.timedOut,
            scorerCount: results.scorers.length,
        });

        for (const scorer of results.scorers) {
            tcAILogger.info('[isTaskComplete] Scorer result', {
                scorerId: scorer.scorerId,
                scorerName: scorer.scorerName,
                score: scorer.score,
                passed: scorer.passed,
                duration: `${scorer.duration}ms`,
                reason: scorer.reason?.slice(0, 200) ?? 'none',
            });
        }

        if (!results.complete) {
            tcAILogger.warn('[isTaskComplete] Task incomplete - agent will continue', {
                failedScorers: results.scorers
                    .filter(s => !s.passed)
                    .map(s => s.scorerId),
            });
        } else {
            tcAILogger.info('[isTaskComplete] Task marked as COMPLETE');
        }
    },
};

export const defaultOptions: NonNullable<ConstructorParameters<typeof Agent>[0]['defaultOptions']> = {
    activeTools: ['submission_search', 'submission_read'],
    maxSteps: MAX_STEPS,
    onIterationComplete,
    onFinish,
    // isTaskComplete,
};
