/**
 * Submission workspace tools for the requirement analyzer agent.
 */

export { submissionSearchTool } from './submission-search-tool';
export { submissionReadTool } from './submission-read-tool';
export {
    resetToolCache,
    getToolCacheStats,
    getCachedResult,
    cacheResult,
    cachedExecute,
    getToolCacheKey,
    wrapToolWithCache,
    wrapToolsWithCache,
    getInvocationCount,
    getToolInvocationCount,
    getLimitExceededInfo,
    getAllToolInvocationCounts,
    DEFAULT_MAX_TOOL_INVOCATIONS,
} from './with-cache';
export type { ToolCacheOptions } from './with-cache';

import { submissionSearchTool } from './submission-search-tool';
import { submissionReadTool } from './submission-read-tool';
import { wrapToolWithCache } from './with-cache';

// Raw tools without caching (for testing or when cache is not desired)
export const submissionToolsRaw = {
    submission_search: submissionSearchTool,
    submission_read: submissionReadTool,
};

// Limit invocations per tool to prevent abuse and manage context tokens
export const submissionTools = {
    submission_search: wrapToolWithCache(submissionSearchTool, { maxInvocations: 20 }),
    submission_read: wrapToolWithCache(submissionReadTool, { maxInvocations: 20 }),
};
