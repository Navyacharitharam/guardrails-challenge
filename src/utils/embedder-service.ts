import { embed } from 'ai';
import pLimit, { type LimitFunction } from 'p-limit';
import { ollama } from './providers/ollama';
import { tcAILogger } from './logger';

/** Default concurrency for parallel embedding requests */
export const DEFAULT_EMBED_CONCURRENCY = 8;

export interface TokenUsage {
    totalTokens: number;
    totalRequests: number;
    totalChars: number;
}

export interface EmbedderConfig {
    model: string;
    dimensions: number;
    /** Timeout in milliseconds for each embedding request (default: 30000) */
    timeoutMs?: number;
    /** Maximum concurrent embedding requests (default: 8) */
    concurrency?: number;
}

/** Default timeout for embedding requests (30 seconds) */
export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export class EmbedTimeoutError extends Error {
    constructor(timeoutMs: number, source?: string) {
        super(`Embedding request timed out after ${timeoutMs}ms${source ? ` (source: ${source})` : ''}`);
        this.name = 'EmbedTimeoutError';
    }
}

/**
 * Wraps a promise with a timeout.
 * Rejects with EmbedTimeoutError if the promise doesn't resolve within timeoutMs.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, source?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new EmbedTimeoutError(timeoutMs, source));
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
    });
}

/**
 * Embedder service with token usage tracking.
 * Wraps the AI SDK embed function to track usage metrics.
 */
export class EmbedderService {
    private readonly config: EmbedderConfig;
    private readonly timeoutMs: number;
    private readonly concurrencyLimit: LimitFunction;
    private readonly concurrency: number;
    private usage: TokenUsage = {
        totalTokens: 0,
        totalRequests: 0,
        totalChars: 0,
    };
    private timeoutCount = 0;

    constructor(config: EmbedderConfig) {
        this.config = config;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
        this.concurrency = config.concurrency ?? DEFAULT_EMBED_CONCURRENCY;
        this.concurrencyLimit = pLimit(this.concurrency);
        tcAILogger.info(`[EmbedderService] Initialized with model: ${config.model}, dimensions: ${config.dimensions}, timeout: ${this.timeoutMs}ms, concurrency: ${this.concurrency}`);
    }

    // Track the last source being embedded for error logging
    private lastEmbedSource: string | null = null;

    /**
     * Set the source context for the next embed call (for error logging).
     */
    setEmbedSource(source: string): void {
        this.lastEmbedSource = source;
    }

    /**
     * Generate embedding for the given text.
     * Tracks token usage internally.
     */
    async embed(text: string): Promise<number[]> {
        const charCount = text.length;
        // Estimate tokens (~4 chars per token for English text)
        const estimatedTokens = Math.ceil(charCount / 4);
        const source = this.lastEmbedSource;
        this.lastEmbedSource = null; // Clear after capturing

        try {
            const embedPromise = embed({
                model: ollama.embedding(this.config.model, {
                    dimensions: this.config.dimensions,
                }),
                value: text,
            });

            const { embedding, usage } = await withTimeout(embedPromise, this.timeoutMs, source ?? undefined);

            // Update usage tracking
            const actualTokens = usage?.tokens ?? estimatedTokens;
            this.usage.totalTokens += actualTokens;
            this.usage.totalRequests += 1;
            this.usage.totalChars += charCount;

            tcAILogger.debug(
                `[EmbedderService] Embedded ${charCount} chars (~${actualTokens} tokens), ` +
                `total: ${this.usage.totalTokens} tokens in ${this.usage.totalRequests} requests`
            );

            return embedding;
        } catch (err) {
            const textPreview = text.length > 200 ? text.substring(0, 200) + '...' : text;

            if (err instanceof EmbedTimeoutError) {
                this.timeoutCount++;
                tcAILogger.warn(`[EmbedderService] Embedding timed out (${this.timeoutCount} total timeouts)`, {
                    timeoutMs: this.timeoutMs,
                    charCount,
                    source: source ?? 'unknown',
                });
            } else {
                tcAILogger.error(`[EmbedderService] Embedding failed`, {
                    error: err,
                    charCount,
                    estimatedTokens,
                    source: source ?? 'unknown',
                    textPreview,
                });
            }
            throw err;
        }
    }

    /**
     * Embed multiple texts in parallel with concurrency control.
     * Returns embeddings in the same order as input texts.
     */
    async embedBatch(items: { text: string; source?: string }[]): Promise<(number[] | null)[]> {
        if (items.length === 0) return [];

        tcAILogger.info(`[EmbedderService] Starting batch embed of ${items.length} items (concurrency: ${this.concurrency})`);
        let completed = 0;

        const results = await Promise.all(
            items.map((item) =>
                this.concurrencyLimit(async () => {
                    try {
                        if (item.source) {
                            this.setEmbedSource(item.source);
                        }
                        const embedding = await this.embed(item.text);
                        completed++;
                        if (completed % 50 === 0 || completed === items.length) {
                            tcAILogger.info(`[EmbedderService] Batch progress: ${completed}/${items.length}`);
                        }
                        return embedding;
                    } catch {
                        completed++;
                        return null;
                    }
                })
            )
        );

        const successCount = results.filter(r => r !== null).length;
        tcAILogger.info(`[EmbedderService] Batch complete: ${successCount}/${items.length} successful`);

        return results;
    }

    /**
     * Get current token usage statistics.
     */
    getUsage(): TokenUsage {
        return { ...this.usage };
    }

    /**
     * Set token usage values (useful for restoring state).
     */
    setUsage(usage: Partial<TokenUsage>): void {
        if (usage.totalTokens !== undefined) {
            this.usage.totalTokens = usage.totalTokens;
        }
        if (usage.totalRequests !== undefined) {
            this.usage.totalRequests = usage.totalRequests;
        }
        if (usage.totalChars !== undefined) {
            this.usage.totalChars = usage.totalChars;
        }
        tcAILogger.debug(`[EmbedderService] Usage updated`, this.usage);
    }

    /**
     * Reset token usage counters.
     */
    resetUsage(): void {
        this.usage = {
            totalTokens: 0,
            totalRequests: 0,
            totalChars: 0,
        };
        tcAILogger.info(`[EmbedderService] Usage counters reset`);
    }

    /**
     * Get the embedder function compatible with Mastra Workspace.
     * The returned function includes source tracking for error diagnostics.
     */
    getEmbedder(): (text: string) => Promise<number[]> {
        return (text: string) => this.embed(text);
    }

    /**
     * Get an embedder function that tracks the source for error logging.
     * Use this when you know the source context (e.g., file path).
     */
    getEmbedderWithSource(source: string): (text: string) => Promise<number[]> {
        return (text: string) => {
            this.setEmbedSource(source);
            return this.embed(text);
        };
    }

    /**
     * Get the number of timeouts that have occurred.
     */
    getTimeoutCount(): number {
        return this.timeoutCount;
    }

    /**
     * Log current usage summary.
     */
    logUsageSummary(): void {
        const avgTokensPerRequest = this.usage.totalRequests > 0
            ? (this.usage.totalTokens / this.usage.totalRequests).toFixed(1)
            : '0';
        const avgCharsPerRequest = this.usage.totalRequests > 0
            ? (this.usage.totalChars / this.usage.totalRequests).toFixed(0)
            : '0';

        tcAILogger.info(`[EmbedderService] ========== Usage Summary ==========`);
        tcAILogger.info(`[EmbedderService] Total requests: ${this.usage.totalRequests}`);
        tcAILogger.info(`[EmbedderService] Total tokens: ${this.usage.totalTokens}`);
        tcAILogger.info(`[EmbedderService] Total chars: ${this.usage.totalChars}`);
        tcAILogger.info(`[EmbedderService] Avg tokens/request: ${avgTokensPerRequest}`);
        tcAILogger.info(`[EmbedderService] Avg chars/request: ${avgCharsPerRequest}`);
        if (this.timeoutCount > 0) {
            tcAILogger.warn(`[EmbedderService] Timeouts: ${this.timeoutCount}`);
        }
        tcAILogger.info(`[EmbedderService] ===================================`);
    }
}

// Default embedder configuration
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
    model: 'nomic-embed-text-v2-moe:latest',
    dimensions: 768,
};

// Singleton instance for the review workspace
let reviewEmbedderInstance: EmbedderService | null = null;

/**
 * Get the singleton embedder service instance for the review workspace.
 */
export function getReviewEmbedder(config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): EmbedderService {
    if (!reviewEmbedderInstance) {
        reviewEmbedderInstance = new EmbedderService(config);
    }
    return reviewEmbedderInstance;
}
