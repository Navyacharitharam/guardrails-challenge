/**
 * Tool Result Cache
 * 
 * Provides thread-scoped caching for tool execution results based on parameter hashing.
 * Each thread/conversation has its own isolated cache that is automatically cleaned up.
 * Includes invocation limiting to prevent runaway tool usage.
 */

import { createHash } from 'crypto';
import { tcAILogger } from '../../../../utils/logger';

/**
 * Default maximum number of tool invocations allowed per thread.
 * Can be overridden per-tool via wrapToolWithCache options.
 */
export const DEFAULT_MAX_TOOL_INVOCATIONS = 50;

export interface ToolCacheOptions {
    /** Maximum invocations allowed for this tool per thread (default: DEFAULT_MAX_TOOL_INVOCATIONS) */
    maxInvocations?: number;
    /** Whether to enable caching for duplicate detection (default: true) */
    enableCache?: boolean;
}

interface CacheEntry<T = unknown> {
    result: T;
    timestamp: number;
    hash: string;
}

interface ThreadCache {
    cache: Map<string, CacheEntry>;
    /** @deprecated Use toolInvocationCounts instead */
    invocationCount: number;
    /** Per-tool invocation counts */
    toolInvocationCounts: Map<string, number>;
    createdAt: number;
    lastAccessedAt: number;
}

/**
 * Thread-scoped tool caches. Each thread has its own isolated cache.
 * Key: threadId, Value: ThreadCache
 */
const threadCaches = new Map<string, ThreadCache>();

/**
 * Default thread ID for when no thread context is available
 */
const DEFAULT_THREAD_ID = '__default__';

/**
 * Cache TTL in milliseconds (30 minutes) - caches older than this are cleaned up
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Get or create the cache for a specific thread
 */
function getThreadCache(threadId: string = DEFAULT_THREAD_ID): ThreadCache {
    let threadCache = threadCaches.get(threadId);

    if (!threadCache) {
        threadCache = {
            cache: new Map(),
            invocationCount: 0,
            toolInvocationCounts: new Map(),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
        };
        threadCaches.set(threadId, threadCache);
        tcAILogger.debug(`[ToolCache] Created new cache for thread: ${threadId}`);
    } else {
        threadCache.lastAccessedAt = Date.now();
    }

    return threadCache;
}

/**
 * Increment and return the invocation count for a specific tool in a thread
 */
function incrementToolInvocationCount(toolId: string, threadId: string = DEFAULT_THREAD_ID): number {
    const threadCache = getThreadCache(threadId);
    const currentCount = threadCache.toolInvocationCounts.get(toolId) ?? 0;
    const newCount = currentCount + 1;
    threadCache.toolInvocationCounts.set(toolId, newCount);
    // Also increment legacy total count for backwards compatibility
    threadCache.invocationCount++;
    return newCount;
}

/**
 * Get the current invocation count for a specific tool in a thread
 */
export function getToolInvocationCount(toolId: string, threadId?: string): number {
    const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
    return tc?.toolInvocationCounts.get(toolId) ?? 0;
}

/**
 * Get the total invocation count across all tools for a thread (legacy)
 */
export function getInvocationCount(threadId?: string): number {
    const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
    return tc?.invocationCount ?? 0;
}

/**
 * Check if any tool limit was exceeded for a thread.
 * Returns info about which tool exceeded and when, or null if no limit exceeded.
 */
export function getLimitExceededInfo(threadId?: string): { tool: string; timestamp: number } | null {
    const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
    if (!tc) return null;

    const tcAny = tc as unknown as Record<string, unknown>;
    if (tcAny.limitExceededAt && tcAny.limitExceededTool) {
        return {
            tool: tcAny.limitExceededTool as string,
            timestamp: tcAny.limitExceededAt as number,
        };
    }
    return null;
}

/**
 * Get all tool invocation counts for a thread.
 */
export function getAllToolInvocationCounts(threadId?: string): Record<string, number> {
    const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
    if (!tc) return {};

    const result: Record<string, number> = {};
    for (const [toolId, count] of tc.toolInvocationCounts.entries()) {
        result[toolId] = count;
    }
    return result;
}

/**
 * Check if a specific tool has exceeded the invocation limit in a thread
 */
function isToolInvocationLimitExceeded(toolId: string, threadId: string = DEFAULT_THREAD_ID, maxInvocations: number = DEFAULT_MAX_TOOL_INVOCATIONS): boolean {
    const count = getToolInvocationCount(toolId, threadId);
    return count >= maxInvocations;
}

/**
 * Clean up stale thread caches that haven't been accessed recently
 */
function cleanupStaleCaches(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [threadId, threadCache] of threadCaches.entries()) {
        if (now - threadCache.lastAccessedAt > CACHE_TTL_MS) {
            threadCaches.delete(threadId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        tcAILogger.debug(`[ToolCache] Cleaned up ${cleanedCount} stale thread caches`);
    }
}

/**
 * Reset the cache for a specific thread
 */
export function resetToolCache(threadId?: string): void {
    if (threadId) {
        threadCaches.delete(threadId);
        tcAILogger.debug(`[ToolCache] Cache cleared for thread: ${threadId}`);
    } else {
        threadCaches.clear();
        tcAILogger.debug('[ToolCache] All caches cleared');
    }
}

/**
 * Get cache statistics
 */
export function getToolCacheStats(threadId?: string): {
    threadCount: number;
    totalEntries: number;
    totalInvocations: number;
    defaultMaxInvocations: number;
    threadStats: Record<string, { size: number; invocations: number; entries: string[] }>;
} {
    // Cleanup stale caches first
    cleanupStaleCaches();

    const threadStats: Record<string, { size: number; invocations: number; entries: string[] }> = {};
    let totalEntries = 0;
    let totalInvocations = 0;

    for (const [tid, threadCache] of threadCaches.entries()) {
        if (!threadId || tid === threadId) {
            threadStats[tid] = {
                size: threadCache.cache.size,
                invocations: threadCache.invocationCount,
                entries: Array.from(threadCache.cache.keys()),
            };
            totalEntries += threadCache.cache.size;
            totalInvocations += threadCache.invocationCount;
        }
    }

    return {
        threadCount: threadCaches.size,
        totalEntries,
        totalInvocations,
        defaultMaxInvocations: DEFAULT_MAX_TOOL_INVOCATIONS,
        threadStats,
    };
}

/**
 * Recursively sort object keys for consistent hashing
 */
function sortObject(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => sortObject(item));
    if (typeof obj !== 'object') return obj;

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = sortObject((obj as Record<string, unknown>)[key]);
    }
    return sorted;
}

/**
 * Generate a cache key for a tool call
 */
export function getToolCacheKey(toolId: string, params: unknown): string {
    const sortedParams = sortObject(params);
    const normalized = JSON.stringify({ tool: toolId, params: sortedParams });
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    return `${toolId}:${hash}`;
}

/**
 * Check if a cached result exists for the given tool call
 */
export function getCachedResult<T>(toolId: string, params: unknown, threadId?: string): T | undefined {
    const threadCache = getThreadCache(threadId);
    const key = getToolCacheKey(toolId, params);
    const entry = threadCache.cache.get(key);
    if (entry) {
        tcAILogger.info(`[ToolCache] Cache HIT for ${toolId} (thread: ${threadId || DEFAULT_THREAD_ID})`);
        return entry.result as T;
    }
    return undefined;
}

/**
 * Cache a tool result
 */
export function cacheResult<T>(toolId: string, params: unknown, result: T, threadId?: string): void {
    const threadCache = getThreadCache(threadId);
    const key = getToolCacheKey(toolId, params);
    const hash = key.split(':')[1];
    threadCache.cache.set(key, {
        result,
        timestamp: Date.now(),
        hash,
    });
    tcAILogger.debug(`[ToolCache] Cached result for ${toolId} (thread: ${threadId || DEFAULT_THREAD_ID})`);
}

/**
 * Extract threadId from Mastra tool execution context
 */
function extractThreadId(context: unknown): string | undefined {
    if (!context || typeof context !== 'object') return undefined;

    const ctx = context as Record<string, unknown>;

    // Try agent context first
    if (ctx.agent && typeof ctx.agent === 'object') {
        const agentCtx = ctx.agent as Record<string, unknown>;
        if (typeof agentCtx.threadId === 'string') {
            return agentCtx.threadId;
        }
    }

    // Try direct threadId
    if (typeof ctx.threadId === 'string') {
        return ctx.threadId;
    }

    return undefined;
}

/**
 * Create a cached execute wrapper for use inside tool execute functions.
 * 
 * Usage:
 * ```typescript
 * execute: cachedExecute('my_tool', async (params) => {
 *   // actual execution logic
 *   return result;
 * })
 * ```
 */
export function cachedExecute<TInput, TOutput>(
    toolId: string,
    executeFn: (params: TInput) => Promise<TOutput>
): (params: TInput) => Promise<TOutput> {
    return async (params: TInput): Promise<TOutput> => {
        // Check cache first
        const cached = getCachedResult<TOutput>(toolId, params);
        if (cached !== undefined) {
            // Add cache indicator if result is an object
            if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
                return {
                    ...cached,
                    _cached: true,
                    _cacheNote: 'Result from cache - tool was not re-executed.',
                } as TOutput;
            }
            return cached;
        }

        // Execute and cache
        const result = await executeFn(params);
        cacheResult(toolId, params, result);
        return result;
    };
}

/**
 * Wrap a tool's execute function with thread-scoped caching and invocation limiting.
 * 
 * Features:
 * - On duplicate calls (same params within same thread), returns an error message
 * - Tracks invocation count per thread and blocks when limit is exceeded
 * - Cache is automatically scoped to threadId from the Mastra execution context
 * - Different threads have isolated caches that don't interfere with each other
 * - Per-tool configurable invocation limits
 * 
 * @param tool - The tool to wrap
 * @param options - Optional configuration for caching behavior
 */
export function wrapToolWithCache<T extends { id: string; execute?: unknown }>(
    tool: T,
    options: ToolCacheOptions = {}
): T {
    if (!tool.execute || typeof tool.execute !== 'function') {
        return tool;
    }

    const {
        maxInvocations = DEFAULT_MAX_TOOL_INVOCATIONS,
        enableCache = true,
    } = options;

    const originalExecute = tool.execute as (params: unknown, context: unknown) => Promise<unknown>;
    const toolId = tool.id;

    const wrappedExecute = async (params: unknown, context: unknown): Promise<unknown> => {
        // Extract threadId from context for thread-scoped caching
        const threadId = extractThreadId(context);
        const threadLabel = threadId || DEFAULT_THREAD_ID;

        // Periodically cleanup stale caches
        cleanupStaleCaches();

        // Check invocation limit FIRST (per-tool limit)
        if (isToolInvocationLimitExceeded(toolId, threadId, maxInvocations)) {
            const currentCount = getToolInvocationCount(toolId, threadId);
            tcAILogger.error(
                `[ToolCache] INVOCATION LIMIT EXCEEDED: ${toolId} ` +
                `(thread: ${threadLabel}, count: ${currentCount}/${maxInvocations})`
            );

            // Track that we've hit a limit (used by fallback processor)
            const threadCache = getThreadCache(threadId);
            (threadCache as unknown as Record<string, unknown>).limitExceededAt = Date.now();
            (threadCache as unknown as Record<string, unknown>).limitExceededTool = toolId;

            return {
                error: `BUDGET_EXHAUSTED (${currentCount}/${maxInvocations}). Produce final report now.`,
            };
        }

        // Check cache (scoped to this thread) if caching is enabled
        if (enableCache) {
            const cached = getCachedResult(toolId, params, threadId);

            if (cached !== undefined) {
                // Don't increment counter for cached/duplicate calls
                tcAILogger.warn(
                    `[ToolCache] DUPLICATE CALL BLOCKED: ${toolId} ` +
                    `(thread: ${threadLabel}) - ` +
                    `tool was already called with these parameters`
                );

                return {
                    error: `DUPLICATE_CALL: ${toolId} already called with same params. Use previous result.`,
                };
            }
        }

        // Increment invocation counter (only for actual executions, not cache hits)
        const invocationNum = incrementToolInvocationCount(toolId, threadId);
        tcAILogger.debug(
            `[ToolCache] Executing ${toolId} ` +
            `(thread: ${threadLabel}, invocation: ${invocationNum}/${maxInvocations})`
        );

        // Execute and cache (scoped to this thread)
        const result = await originalExecute(params, context);

        if (enableCache) {
            cacheResult(toolId, params, result, threadId);
        }

        return result;
    };

    return {
        ...tool,
        execute: wrappedExecute,
    } as T;
}

/**
 * Wrap all tools in a record with caching
 * 
 * @param tools - Record of tools to wrap
 * @param options - Optional configuration (applied to all tools), or a function to get options per tool
 */
export function wrapToolsWithCache<T extends Record<string, { id: string; execute?: unknown }>>(
    tools: T,
    options?: ToolCacheOptions | ((toolId: string) => ToolCacheOptions)
): T {
    const result = {} as T;
    for (const [key, tool] of Object.entries(tools)) {
        const toolOptions = typeof options === 'function' ? options(tool.id) : options;
        (result as Record<string, unknown>)[key] = wrapToolWithCache(tool, toolOptions);
    }
    return result;
}
