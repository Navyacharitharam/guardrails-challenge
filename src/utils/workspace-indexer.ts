import { Workspace } from '@mastra/core/workspace';
import * as path from 'path';
import * as fs from 'fs/promises';
import pLimit from 'p-limit';
import { tcAILogger } from './logger';
import {
    autoIndexPatterns,
    isExcludedFile,
    EXCLUDED_FILE_PATTERNS,
    // Re-export encoding utilities for use in tests and other modules
    isUtf16Encoded,
    convertUtf16ToUtf8,
    normalizeEncoding,
    isPatchContent,
    cleanPatchBinaryData,
    preprocessFileContent,
} from './filtered-filesystem';
import { getReviewEmbedder } from './embedder-service';

// Re-export for backward compatibility and testing
export {
    isUtf16Encoded,
    convertUtf16ToUtf8,
    isPatchContent,
};

/**
 * Clean patch file content by removing binary data sections.
 * Also handles UTF-16 encoded patch files.
 * @deprecated Use preprocessFileContent from filtered-filesystem instead
 */
export function cleanPatchContent(content: string): string {
    const normalized = normalizeEncoding(content);
    return cleanPatchBinaryData(normalized);
}

/**
 * Preprocess file content based on file type.
 * @deprecated Use preprocessFileContent from filtered-filesystem instead
 */
export function preprocessContent(relativePath: string, content: string): string {
    return preprocessFileContent(relativePath, content);
}

export interface IndexingStats {
    totalFilesFound: number;
    indexedFiles: number;
    skippedFiles: number;
    errorFiles: number;
    totalBytes: number;
    durationMs: number;
    skippedReasons: Record<string, number>;
    errors: { file: string; error: string }[];
    indexedFilesList: string[];
    skippedFilesList: { file: string; reason: string }[];
}

export interface IndexingOptions {
    basePath: string;
    patterns?: string[];
    concurrency?: number;
}

// Convert glob patterns to extension sets for fast matching
function extractExtensionsFromPatterns(patterns: string[]): Set<string> {
    const extensions = new Set<string>();
    for (const pattern of patterns) {
        // Match patterns like **/*.ts, *.tsx, etc.
        const match = pattern.match(/\*\.([a-zA-Z0-9]+)$/);
        if (match) {
            extensions.add(`.${match[1]}`);
        }
    }
    return extensions;
}

// Check if a filename matches any of the specific file patterns (e.g., Dockerfile, package.json)
function matchesSpecificFilePattern(filename: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        // Handle patterns like **/package.json, **/Dockerfile, **/Dockerfile.*
        const filePattern = pattern.replace(/^\*\*\//, '').replace(/\*/g, '.*');
        if (new RegExp(`^${filePattern}$`).test(filename)) {
            return true;
        }
    }
    return false;
}

/**
 * Recursively collect files from a directory, filtering by patterns.
 */
async function collectFiles(
    basePath: string,
    extensions: Set<string>,
    specificPatterns: string[]
): Promise<string[]> {
    const files: string[] = [];

    async function walkDir(currentPath: string, relativePath: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch {
            return; // Skip inaccessible directories
        }

        for (const entry of entries) {
            const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                // Skip excluded directories
                if (EXCLUDED_FILE_PATTERNS.directories.includes(entry.name)) {
                    continue;
                }
                // Skip hidden directories except .github
                if (entry.name.startsWith('.') && entry.name !== '.github') {
                    continue;
                }
                await walkDir(path.join(currentPath, entry.name), entryRelPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                // Check if file matches extension patterns or specific file patterns
                if (extensions.has(ext) || matchesSpecificFilePattern(entry.name, specificPatterns)) {
                    files.push(entryRelPath);
                }
            }
        }
    }

    await walkDir(basePath, '');
    return files;
}

/**
 * Index workspace files using glob patterns with comprehensive logging.
 * Returns a promise that resolves when indexing is complete.
 */
export async function indexWorkspace(
    workspace: Workspace,
    options: IndexingOptions
): Promise<IndexingStats> {
    const { basePath, patterns = autoIndexPatterns, concurrency = 10 } = options;
    const startTime = Date.now();

    const stats: IndexingStats = {
        totalFilesFound: 0,
        indexedFiles: 0,
        skippedFiles: 0,
        errorFiles: 0,
        totalBytes: 0,
        durationMs: 0,
        skippedReasons: {},
        errors: [],
        indexedFilesList: [],
        skippedFilesList: [],
    };

    tcAILogger.info(`[WorkspaceIndexer] Starting indexing of workspace: ${basePath}`);
    tcAILogger.info(`[WorkspaceIndexer] Using ${patterns.length} patterns`);

    // Extract extensions and specific patterns for efficient matching
    const extensions = extractExtensionsFromPatterns(patterns);
    const specificPatterns = patterns.filter(p => !p.match(/\*\.[a-zA-Z0-9]+$/));

    tcAILogger.debug(`[WorkspaceIndexer] Extensions: ${Array.from(extensions).join(', ')}`);
    tcAILogger.debug(`[WorkspaceIndexer] Specific patterns: ${specificPatterns.length}`);

    // Collect all files
    const allFiles = await collectFiles(basePath, extensions, specificPatterns);

    stats.totalFilesFound = allFiles.length;
    tcAILogger.info(`[WorkspaceIndexer] Found ${stats.totalFilesFound} files matching patterns`);
    tcAILogger.info(`[WorkspaceIndexer] Concurrency limit: ${concurrency}`);

    // Process files using streaming worker pool
    const limit = pLimit(concurrency);
    let processedCount = 0;

    const indexingPromises = allFiles.map((relativePath) =>
        limit(async () => {
            const fullPath = path.join(basePath, relativePath);

            // Check if file should be excluded
            if (isExcludedFile(relativePath)) {
                stats.skippedFiles++;
                const reason = 'excluded_pattern';
                stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
                stats.skippedFilesList.push({ file: relativePath, reason });
                processedCount++;
                return;
            }

            try {
                // Read file content
                const rawContent = await fs.readFile(fullPath, 'utf-8');

                // Preprocess content (handles patch files, binary cleanup, etc.)
                const content = preprocessContent(relativePath, rawContent);
                const fileSize = Buffer.byteLength(content, 'utf-8');

                // Skip empty files
                if (content.trim().length === 0) {
                    stats.skippedFiles++;
                    const reason = 'empty_file';
                    stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
                    stats.skippedFilesList.push({ file: relativePath, reason });
                    processedCount++;
                    return;
                }

                // Set source context for embedder error logging
                getReviewEmbedder().setEmbedSource(`file:${relativePath}`);

                // Index the file
                await workspace.index(relativePath, content, {
                    type: 'file',
                    metadata: {
                        relativePath,
                        size: fileSize,
                        preprocessed: rawContent !== content,
                    },
                });

                stats.indexedFiles++;
                stats.totalBytes += fileSize;
                stats.indexedFilesList.push(relativePath);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);

                // Check for binary file detection
                if (errorMessage.includes('binary') || errorMessage.includes('encoding')) {
                    stats.skippedFiles++;
                    const reason = 'binary_file';
                    stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
                    stats.skippedFilesList.push({ file: relativePath, reason });
                    processedCount++;
                    return;
                }

                stats.errorFiles++;
                stats.errors.push({ file: relativePath, error: errorMessage });
                tcAILogger.warn(`[WorkspaceIndexer] Error indexing: ${relativePath}`, { error: errorMessage });
            }

            processedCount++;
            if (processedCount % 100 === 0 || processedCount === allFiles.length) {
                tcAILogger.info(`[WorkspaceIndexer] Progress: ${processedCount}/${stats.totalFilesFound} files processed`);
            }
        })
    );

    await Promise.all(indexingPromises);

    stats.durationMs = Date.now() - startTime;

    // Log comprehensive summary
    tcAILogger.info(`[WorkspaceIndexer] ========== Indexing Complete ==========`);
    tcAILogger.info(`[WorkspaceIndexer] Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
    tcAILogger.info(`[WorkspaceIndexer] Total files found: ${stats.totalFilesFound}`);
    tcAILogger.info(`[WorkspaceIndexer] Successfully indexed: ${stats.indexedFiles}`);
    tcAILogger.info(`[WorkspaceIndexer] Skipped: ${stats.skippedFiles}`);
    tcAILogger.info(`[WorkspaceIndexer] Errors: ${stats.errorFiles}`);
    tcAILogger.info(`[WorkspaceIndexer] Total size indexed: ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);

    // Log indexed files list
    if (stats.indexedFilesList.length > 0) {
        tcAILogger.info(`[WorkspaceIndexer] Indexed files:`);
        for (const file of stats.indexedFilesList) {
            tcAILogger.info(`[WorkspaceIndexer]   + ${file}`);
        }
    }

    // Log skipped files list
    if (stats.skippedFilesList.length > 0) {
        tcAILogger.info(`[WorkspaceIndexer] Skipped files:`);
        for (const { file, reason } of stats.skippedFilesList) {
            tcAILogger.info(`[WorkspaceIndexer]   - ${file} (${reason})`);
        }
    }

    // Log skip reasons summary
    if (Object.keys(stats.skippedReasons).length > 0) {
        tcAILogger.info(`[WorkspaceIndexer] Skip reasons summary:`);
        for (const [reason, count] of Object.entries(stats.skippedReasons)) {
            tcAILogger.info(`[WorkspaceIndexer]   - ${reason}: ${count}`);
        }
    }

    // Log errors
    if (stats.errors.length > 0 && stats.errors.length <= 10) {
        tcAILogger.warn(`[WorkspaceIndexer] Error details:`);
        for (const { file, error } of stats.errors) {
            tcAILogger.warn(`[WorkspaceIndexer]   ! ${file}: ${error}`);
        }
    } else if (stats.errors.length > 10) {
        tcAILogger.warn(`[WorkspaceIndexer] ${stats.errors.length} errors occurred (showing first 10):`);
        for (const { file, error } of stats.errors.slice(0, 10)) {
            tcAILogger.warn(`[WorkspaceIndexer]   ! ${file}: ${error}`);
        }
    }

    tcAILogger.info(`[WorkspaceIndexer] =======================================`);

    return stats;
}

/**
 * Start workspace indexing in the background without blocking.
 * Returns a promise that can be awaited if needed.
 */
export function startBackgroundIndexing(
    workspace: Workspace,
    options: IndexingOptions
): Promise<IndexingStats> {
    tcAILogger.info(`[WorkspaceIndexer] Starting background indexing...`);

    const indexingPromise = indexWorkspace(workspace, options).catch((err) => {
        tcAILogger.error(`[WorkspaceIndexer] Background indexing failed`, { error: err });
        throw err;
    });

    // Don't await - let it run in background
    return indexingPromise;
}
