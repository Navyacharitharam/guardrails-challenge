import { Workspace } from '@mastra/core/workspace';
import { FilteredLocalFilesystem } from '../../utils/filtered-filesystem';
import { startBackgroundIndexing, type IndexingStats } from '../../utils/workspace-indexer';
import { getReviewEmbedder, type EmbedderConfig } from '../../utils/embedder-service';
import { ASTIndexerService, type IndexingResult as ASTIndexingResult, formatSymbolAsJSONPretty, SCHEMA_HINTS } from '../../utils/ast/indexer';
import { LibSQLVector } from "@mastra/libsql";
import { tcAILogger } from '../../utils/logger';

// Inline embedder config to avoid circular dependency with DEFAULT_EMBEDDER_CONFIG
// Must match the values in embedder-service.ts DEFAULT_EMBEDDER_CONFIG
const EMBEDDER_CONFIG: EmbedderConfig = {
    model: 'nomic-embed-text-v2-moe:latest',
    dimensions: 768,
};

const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
tcAILogger.info(`[ReviewWorkspace] Initializing workspace at: ${workspacePath}`);

// Initialize embedder service with token tracking
export const embedderService = getReviewEmbedder(EMBEDDER_CONFIG);

// Initialize AST indexer service
export const astIndexerService = new ASTIndexerService();

// Vector store setup
const vectorStore = new LibSQLVector({
    id: 'review-workspace-vector-store',
    url: 'file:./review-workspace-vector-store.db',
});
const REVIEW_VECTOR_STORE_INDEX_NAME = 'review_vector_index';

// Delete existing vector store if it exists to start fresh
tcAILogger.info(`[ReviewWorkspace] Deleting existing vector index: ${REVIEW_VECTOR_STORE_INDEX_NAME}`);
await vectorStore.deleteIndex({
    indexName: REVIEW_VECTOR_STORE_INDEX_NAME,
});
tcAILogger.info(`[ReviewWorkspace] Vector index deleted`);

// Create a new vector store index
tcAILogger.info(`[ReviewWorkspace] Creating vector index: ${REVIEW_VECTOR_STORE_INDEX_NAME} (dimension: ${EMBEDDER_CONFIG.dimensions})`);
await vectorStore.createIndex({
    indexName: REVIEW_VECTOR_STORE_INDEX_NAME,
    dimension: EMBEDDER_CONFIG.dimensions,
});
tcAILogger.info(`[ReviewWorkspace] Vector index created`);

// Create filesystem instance to allow setting symbol resolver later
const reviewFilesystem = new FilteredLocalFilesystem({
    basePath: workspacePath,
    readOnly: true,
    // Set to false to allow paths outside basePath if needed for cross-directory access
    // Set to true (default) to restrict all access within basePath for security
    contained: process.env.FILESYSTEM_CONTAINED !== 'false'
});

export const reviewWorkspace = new Workspace({
    filesystem: reviewFilesystem,
    bm25: true,
    // skills: ['skills'], // Relative path without leading slash
    vectorStore,
    embedder: embedderService.getEmbedder(),
    tools: {
        enabled: false,
    }
});

tcAILogger.info(`[ReviewWorkspace] Initializing workspace...`);
await reviewWorkspace.init();
tcAILogger.info(`[ReviewWorkspace] Workspace initialized successfully`);

// Trigger text-based indexing immediately on module load (non-blocking)
tcAILogger.info(`[ReviewWorkspace] Starting background text indexing...`);
export const textIndexingPromise: Promise<IndexingStats> = startBackgroundIndexing(
    reviewWorkspace,
    { basePath: workspacePath }
).then(async (stats) => {
    tcAILogger.info(`[ReviewWorkspace] Text indexing completed: ${stats.indexedFiles} files indexed`);

    // Ensure BM25 search table exists even if no files were indexed
    // This prevents "no such table" errors when search is called
    if (stats.indexedFiles === 0) {
        tcAILogger.warn(`[ReviewWorkspace] No files indexed - creating placeholder to initialize BM25 table`);
        try {
            await reviewWorkspace.index('__placeholder__', 'Placeholder document to initialize search index', {
                type: 'text',
                metadata: { placeholder: true },
            });
            tcAILogger.info(`[ReviewWorkspace] BM25 search table initialized with placeholder`);
        } catch (placeholderErr) {
            tcAILogger.error(`[ReviewWorkspace] Failed to create placeholder index entry`, { error: placeholderErr });
        }
    }

    return stats;
}).catch((err) => {
    tcAILogger.error(`[ReviewWorkspace] Text indexing failed`, { error: err });
    throw err;
});

// Trigger AST-based indexing for source code files (non-blocking)
// Pass workspace to enable vector store indexing for symbol search
tcAILogger.info(`[ReviewWorkspace] Starting background AST indexing...`);
export const astIndexingPromise: Promise<ASTIndexingResult> = astIndexerService.indexWorkspace({
    basePath: workspacePath,
    workspace: reviewWorkspace,
    includeBody: true,
    concurrency: 8,
}).then((result) => {
    tcAILogger.info(`[ReviewWorkspace] AST indexing completed: ${result.symbolsIndexed} symbols from ${result.filesIndexed} files`);

    // Register symbol resolver for virtual symbol paths (e.g., "file.ts:symbolName")
    // Returns comprehensive JSON format for AI code review
    reviewFilesystem.setSymbolResolver((filePath, symbolName) => {
        const store = astIndexerService.getStore();
        const symbols = store.getSymbolsForFile(filePath);
        const symbol = symbols.find(s => s.symbolName === symbolName);
        if (!symbol) return null;

        // Return JSON format with schema hints for AI consumption
        return formatSymbolAsJSONPretty(symbol);
    });

    // Log schema hints once for debugging
    tcAILogger.debug(`[ReviewWorkspace] Symbol JSON schema:\n${SCHEMA_HINTS}`);

    return result;
}).catch((err) => {
    tcAILogger.error(`[ReviewWorkspace] AST indexing failed`, { error: err });
    throw err;
});

// Global flag to indicate workspace indexing completion
export let workspaceIndexingComplete = false;

// Store indexed document paths (non-code files) for path suggestions
export let indexedDocumentPaths: string[] = [];

// Combined promise for both indexing operations
export const indexingPromise: Promise<{ text: IndexingStats; ast: ASTIndexingResult }> = Promise.all([
    textIndexingPromise,
    astIndexingPromise,
]).then(([text, ast]) => {
    tcAILogger.info(`[ReviewWorkspace] ========== All Indexing Completed ==========`);
    tcAILogger.info(`[ReviewWorkspace] Text indexer: ${text.indexedFiles} files indexed`);
    tcAILogger.info(`[ReviewWorkspace] AST indexer: ${ast.symbolsIndexed} symbols from ${ast.filesIndexed} files`);
    tcAILogger.info(`[ReviewWorkspace] Total duration: text=${(text.durationMs / 1000).toFixed(2)}s, ast=${(ast.durationMs / 1000).toFixed(2)}s`);
    // Log embedder usage (tracks text indexer, AST embedSymbols is disabled)
    embedderService.logUsageSummary();
    tcAILogger.info(`[ReviewWorkspace] =============================================`);

    // Set global flag to indicate indexing is complete
    workspaceIndexingComplete = true;
    tcAILogger.info(`[ReviewWorkspace] workspaceIndexingComplete = true`);
    
    // Store indexed document paths for path suggestions in tools
    indexedDocumentPaths = text.indexedFilesList;
    tcAILogger.info(`[ReviewWorkspace] Stored ${indexedDocumentPaths.length} document paths for suggestions`);

    return { text, ast };
});

/**
 * Waits for workspace indexing to complete.
 * Returns immediately if already complete, otherwise awaits the indexing promise.
 */
export async function waitForWorkspaceIndexing(): Promise<void> {
    if (workspaceIndexingComplete) {
        tcAILogger.info(`[ReviewWorkspace] Workspace indexing already complete`);
        return;
    }
    tcAILogger.info(`[ReviewWorkspace] Waiting for workspace indexing to complete...`);
    await indexingPromise;
}

