/**
 * API Error Processor
 * 
 * Captures and handles LLM API errors with retry logic.
 */

import type {
    Processor,
    ProcessAPIErrorArgs,
    ProcessAPIErrorResult,
} from '@mastra/core/processors';
import { tcAILogger } from '../logger';

export interface APIErrorProcessorOptions {
    /** Maximum number of retries for recoverable errors */
    maxRetries?: number;
    /** Error codes/messages that should trigger a retry */
    retryablePatterns?: (string | RegExp)[];
}

export class APIErrorProcessor implements Processor<'api-error-handler'> {
    readonly id = 'api-error-handler';
    readonly name = 'API Error Handler';
    readonly description = 'Captures LLM API errors and handles retries';

    private options: Required<APIErrorProcessorOptions>;

    constructor(options: APIErrorProcessorOptions = {}) {
        this.options = {
            maxRetries: options.maxRetries ?? 2,
            retryablePatterns: options.retryablePatterns ?? [
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
        };
    }

    async processAPIError({
        error,
        stepNumber,
        steps,
        retryCount,
        state,
    }: ProcessAPIErrorArgs): Promise<ProcessAPIErrorResult | void> {
        const errorMessage = this.extractErrorMessage(error);
        const errorCode = this.extractErrorCode(error);

        // Store error details for later analysis
        const errorLog = {
            timestamp: new Date().toISOString(),
            stepNumber,
            stepsCompleted: steps.length,
            retryCount,
            errorMessage,
            errorCode,
            errorStack: error instanceof Error ? error.stack : undefined,
        };

        // Persist to state for callback access
        state.lastError = errorLog;
        state.errorHistory = state.errorHistory || [];
        (state.errorHistory as typeof errorLog[]).push(errorLog);

        tcAILogger.error('[APIErrorProcessor] LLM API error occurred', errorLog);

        // Check if we should retry
        const isRetryable = this.isRetryableError(errorMessage, errorCode);
        const canRetry = retryCount < this.options.maxRetries;

        if (isRetryable && canRetry) {
            tcAILogger.info('[APIErrorProcessor] Scheduling retry', {
                retryCount: retryCount + 1,
                maxRetries: this.options.maxRetries,
                errorMessage,
            });

            return { retry: true };
        }

        if (!canRetry) {
            tcAILogger.warn('[APIErrorProcessor] Max retries exceeded', {
                retryCount,
                maxRetries: this.options.maxRetries,
            });
        }

        if (!isRetryable) {
            tcAILogger.warn('[APIErrorProcessor] Error is not retryable', {
                errorMessage,
                errorCode,
            });
        }

        // Don't retry - let the error propagate
        return undefined;
    }

    private extractErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string') {
            return error;
        }
        if (error && typeof error === 'object') {
            const obj = error as Record<string, unknown>;
            if (obj.message) return String(obj.message);
            if (obj.error) return String(obj.error);
            if (obj.reason) return String(obj.reason);
        }
        return 'Unknown error';
    }

    private extractErrorCode(error: unknown): string | undefined {
        if (error && typeof error === 'object') {
            const obj = error as Record<string, unknown>;
            if (obj.code) return String(obj.code);
            if (obj.status) return String(obj.status);
            if (obj.statusCode) return String(obj.statusCode);
        }
        return undefined;
    }

    private isRetryableError(message: string, code?: string): boolean {
        const searchText = `${message} ${code || ''}`.toLowerCase();

        for (const pattern of this.options.retryablePatterns) {
            if (typeof pattern === 'string') {
                if (searchText.includes(pattern.toLowerCase())) {
                    return true;
                }
            } else if (pattern instanceof RegExp) {
                if (pattern.test(searchText)) {
                    return true;
                }
            }
        }

        return false;
    }
}
