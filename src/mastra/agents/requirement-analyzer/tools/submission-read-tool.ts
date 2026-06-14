/**
 * Submission read tool for reading file/symbol details as properly formatted JSON.
 * 
 * Returns complete symbol information including body, metrics, and call graph.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { astIndexerService, indexedDocumentPaths } from '../../../workspaces/review';
import { formatSymbolAsJSON, formatSymbolsAsJSON, type SymbolDocument } from '../../../../utils/ast/indexer';
import { isExtensionSupported } from '../../../../utils/ast/parsers';
import { tcAILogger } from '../../../../utils/logger';
import { preprocessFileContent } from '../../../../utils/filtered-filesystem';
import * as fs from 'fs/promises';
import * as path from 'path';

const workspacePath = process.env.WORKSPACE_PATH || process.cwd();

/**
 * Normalize file paths by stripping the submission/ prefix.
 * This makes paths cleaner and more consistent with requirement references.
 * 
 * Examples:
 *   "submission/gtm-platform-fixed/docs/integrations.md" → "gtm-platform-fixed/docs/integrations.md"
 *   "submission/src/index.ts" → "src/index.ts"
 *   "src/index.ts" → "src/index.ts" (no change)
 */
function normalizeSubmissionPath(filePath: string): string {
    if (filePath.startsWith('submission/')) {
        return filePath.slice('submission/'.length);
    }
    return filePath;
}

/**
 * Resolve a path by trying the submission/ prefix if the path doesn't exist.
 * This allows the agent to use paths without the submission/ prefix.
 */
async function resolveSubmissionPath(inputPath: string): Promise<string> {
    // If path already exists as-is, use it
    const directPath = path.isAbsolute(inputPath) ? inputPath : path.join(workspacePath, inputPath);
    try {
        await fs.access(directPath);
        return inputPath;
    } catch {
        // Path doesn't exist directly, try with submission/ prefix
    }

    // Try with submission/ prefix
    const tryPath = 'submission/' + inputPath;
    const fullPath = path.join(workspacePath, tryPath);
    try {
        await fs.access(fullPath);
        tcAILogger.debug(`[submission_read] Resolved path: ${inputPath} -> ${tryPath}`);
        return tryPath;
    } catch {
        // Not found with prefix either
    }

    // Return original if no resolution found
    return inputPath;
}

/**
 * Read a file and preprocess its content (handle encoding, clean patch files, etc.)
 */
async function readAndPreprocessFile(filePath: string): Promise<string> {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    return preprocessFileContent(filePath, rawContent);
}

/**
 * Maximum characters for document reads.
 * Set high enough to capture most config/schema files in full.
 */
const MAX_DOCUMENT_CHARS = 20000;

/**
 * Find similar file paths from the index based on the requested path.
 * Uses filename matching and path segment similarity.
 */
function findSimilarPaths(requestedPath: string, indexedPaths: string[], maxSuggestions = 3): string[] {
    const requestedFileName = path.basename(requestedPath);
    const requestedSegments = requestedPath.split('/').filter(Boolean);

    const scored: { path: string; score: number }[] = [];

    for (const indexedPath of indexedPaths) {
        const indexedFileName = path.basename(indexedPath);
        const indexedSegments = indexedPath.split('/').filter(Boolean);

        let score = 0;

        // Exact filename match is a strong signal
        if (indexedFileName === requestedFileName) {
            score += 10;
        } else if (indexedFileName.toLowerCase() === requestedFileName.toLowerCase()) {
            score += 8;
        } else if (indexedFileName.includes(requestedFileName) || requestedFileName.includes(indexedFileName)) {
            score += 5;
        }

        // Count matching path segments (handles cases like backbone/db/prisma vs backbone/prisma)
        for (const segment of requestedSegments) {
            if (indexedSegments.includes(segment)) {
                score += 2;
            }
        }

        // Penalize very different path lengths
        const lengthDiff = Math.abs(indexedSegments.length - requestedSegments.length);
        score -= lengthDiff * 0.5;

        if (score > 0) {
            scored.push({ path: indexedPath, score });
        }
    }

    // Sort by score descending and return top matches
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxSuggestions).map(s => normalizeSubmissionPath(s.path));
}

/**
 * Strip the references array from a symbol to reduce output size.
 * References are not needed for requirement analysis - they add significant bloat.
 */
function stripReferences(sym: SymbolDocument): SymbolDocument {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { references, ...rest } = sym;
    return rest as SymbolDocument;
}

/**
 * Response for reading a single symbol
 */
interface SymbolReadResponse {
    symbolPath: string;
    symbol: SymbolDocument;
}

/**
 * Response for reading all symbols in a file
 */
interface FileSymbolsResponse {
    filePath: string;
    language: string;
    symbols: SymbolDocument[];
}

/**
 * Response for reading a document (non-code file)
 */
interface DocumentReadResponse {
    filePath: string;
    type: string;
    size: number;
    totalLines: number;
    content: string;
    truncated: boolean;
}

/**
 * Error response with optional similar path suggestions
 */
interface ErrorResponse {
    error: string;
    path: string;
    suggestions?: string[];
}

type ReadResponse =
    | SymbolReadResponse
    | FileSymbolsResponse
    | DocumentReadResponse
    | ErrorResponse;

/**
 * Detect document type from file path
 */
function getDocumentType(filePath: string): string {
    const lowerPath = filePath.toLowerCase();
    const fileName = lowerPath.split('/').pop() || '';

    if (fileName.endsWith('.json') || fileName.endsWith('.yaml') || fileName.endsWith('.yml') || fileName.endsWith('.toml')) {
        return 'config';
    }
    if (fileName.startsWith('.') || fileName.includes('rc') || fileName.includes('config')) {
        return 'config';
    }
    if (['dockerfile', 'makefile', 'docker-compose'].some(n => fileName.includes(n))) {
        return 'config';
    }
    if (fileName.endsWith('.md') || fileName.endsWith('.txt') || fileName.endsWith('.rst')) {
        return 'doc';
    }
    if (['readme', 'changelog', 'contributing', 'license'].some(n => fileName.includes(n))) {
        return 'doc';
    }
    if (fileName.includes('.env') || fileName.includes('secret')) {
        return 'env';
    }
    if (fileName.endsWith('.sh') || fileName.endsWith('.bash') || fileName.endsWith('.zsh')) {
        return 'script';
    }
    return 'file';
}

/**
 * Check if path looks like a code file that would be indexed by the AST indexer.
 * Uses isExtensionSupported() from parser registry to ensure consistency with actual indexing behavior.
 * 
 * Code files: .ts, .tsx, .js, .jsx, .py, .java, etc. (whatever the AST indexer supports)
 * Non-code files: .json, .md, .yaml, .txt, etc. (read directly without AST lookup)
 */
function isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return false;
    // Use the parser registry to check if this extension is supported by AST indexer
    return isExtensionSupported(ext);
}

export const submissionReadTool = createTool({
    id: 'submission_read',
    description: `Read content from the submission. Returns complete symbol data with body, metrics, and call graph.

**For a code symbol** (path:symbolName format):
- Returns full symbol details including body, metrics, and call graph

**For a code file** (just file path like "src/app.ts"):
- Returns all symbol details with full bodies

**For a document** (config, doc, script - like "package.json"):
- Returns entire file content (automatically truncated if exceeds limit)

**DEDUPLICATION:** Results are deduplicated across steps to save context.
- _seeAlso: Points to where full data was shown (e.g., "submission_read('src/db.ts') in step 1")
- _skippedSymbols: Array of symbols already read - each has _seeAlso pointer
- When you see _seeAlso, DON'T re-read! The full content is already in your context from the referenced step.
- Search snippets do NOT block reads - you'll always get full content on first read.`,
    inputSchema: z.object({
        path: z.string().describe('Symbol path ("file.ts:symbolName"), code file ("file.ts"), or document ("package.json")'),
    }),
    outputSchema: z.union([
        // Single symbol
        z.object({
            symbolPath: z.string(),
            symbol: z.any(),
        }),
        // File symbols
        z.object({
            filePath: z.string(),
            language: z.string(),
            symbols: z.array(z.any()),
        }),
        // Document
        z.object({
            filePath: z.string(),
            type: z.string(),
            size: z.number(),
            totalLines: z.number(),
            content: z.string(),
            truncated: z.boolean(),
        }),
        // Error with optional suggestions
        z.object({
            error: z.string(),
            path: z.string(),
            suggestions: z.array(z.string()).optional(),
        }),
    ]),
    execute: async ({ path: inputPath }): Promise<ReadResponse> => {
        tcAILogger.info(`[submission_read] Reading: "${inputPath}"`);

        try {
            const store = astIndexerService.getStore();

            // Check if this is a symbol path (contains :) or just a file path
            // Do this BEFORE path resolution since symbol paths need special handling
            const colonIndex = inputPath.lastIndexOf(':');
            const hasSymbolName = colonIndex > 0 && !inputPath.slice(colonIndex + 1).includes('/');

            if (hasSymbolName) {
                // Reading a specific symbol - extract file path and symbol name first
                const rawFilePath = inputPath.slice(0, colonIndex);
                const symbolName = inputPath.slice(colonIndex + 1);

                // Resolve the file path (handles submission/ prefix)
                const filePath = await resolveSubmissionPath(rawFilePath);
                if (filePath !== rawFilePath) {
                    tcAILogger.info(`[submission_read] File path resolved: "${rawFilePath}" -> "${filePath}"`);
                }
                // Normalized path for output (cleaner for agent)
                const normalizedFilePath = normalizeSubmissionPath(filePath);

                const symbols = store.getSymbolsForFile(filePath);
                const symbol = symbols.find(s => s.symbolName === symbolName);

                if (!symbol) {
                    tcAILogger.warn(`[submission_read] Symbol not found: ${filePath}:${symbolName}`);
                    return {
                        error: `Symbol "${symbolName}" not found in file "${normalizedFilePath}"`,
                        path: inputPath,
                    };
                }

                // Include body for single symbol reads
                let sourceCode: string | undefined;
                if (!symbol.bodyText) {
                    try {
                        const absolutePath = path.isAbsolute(filePath)
                            ? filePath
                            : path.join(workspacePath, filePath);
                        sourceCode = await readAndPreprocessFile(absolutePath);
                    } catch {
                        // Body will be empty
                    }
                }

                const symbolDoc = formatSymbolAsJSON(symbol, sourceCode);
                tcAILogger.info(`[submission_read] Found symbol: ${symbol.kind} ${symbolName}`);

                return {
                    // Return normalized path for cleaner output
                    symbolPath: `${normalizedFilePath}:${symbolName}`,
                    symbol: stripReferences(symbolDoc),
                };
            } else {
                // Reading a file - could be code file or document
                // FIX: Try direct file access FIRST before relying on AST index
                // This ensures files like data/seed-data.json are always readable
                // even if they're not in the semantic index.

                // Build candidate paths to try (in order of priority)
                const candidatePaths = [
                    path.join(workspacePath, 'submission', inputPath),  // submission/data/seed-data.json
                    path.join(workspacePath, inputPath),                 // data/seed-data.json (if already has prefix)
                ];

                // For non-code files, try direct read first (bypass AST index)
                const isCode = isCodeFile(inputPath);

                if (!isCode) {
                    // Non-code file: Try direct filesystem read first
                    for (const candidatePath of candidatePaths) {
                        try {
                            const fullContent = await readAndPreprocessFile(candidatePath);
                            const stats = await fs.stat(candidatePath);
                            const docType = getDocumentType(inputPath);
                            const normalizedFilePath = normalizeSubmissionPath(inputPath);

                            const totalLines = fullContent.split('\n').length;
                            const truncated = fullContent.length > MAX_DOCUMENT_CHARS;
                            const content = truncated ? fullContent.slice(0, MAX_DOCUMENT_CHARS) : fullContent;

                            tcAILogger.info(`[submission_read] Direct read success: ${candidatePath} (${docType}, ${totalLines} lines, truncated=${truncated})`);

                            return {
                                filePath: normalizedFilePath,
                                type: docType,
                                size: stats.size,
                                totalLines,
                                content,
                                truncated,
                            };
                        } catch {
                            // Try next candidate path
                            continue;
                        }
                    }
                    tcAILogger.debug(`[submission_read] Direct read failed for all candidates, falling back to index lookup`);
                }

                // Resolve the file path (handles submission/ prefix)
                const filePath = await resolveSubmissionPath(inputPath);
                if (filePath !== inputPath) {
                    tcAILogger.info(`[submission_read] File path resolved: "${inputPath}" -> "${filePath}"`);
                }
                // Normalized path for output (cleaner for agent)
                const normalizedFilePath = normalizeSubmissionPath(filePath);
                const symbols = store.getSymbolsForFile(filePath);

                if (symbols.length > 0) {
                    // Code file with symbols - return complete symbol details with full bodies
                    const language = symbols[0].language;
                    tcAILogger.info(`[submission_read] Found ${symbols.length} symbols in code file`);
                    let sourceCode: string | undefined;
                    try {
                        const absolutePath = path.isAbsolute(filePath)
                            ? filePath
                            : path.join(workspacePath, filePath);
                        sourceCode = await readAndPreprocessFile(absolutePath);
                    } catch {
                        // Bodies will be empty
                    }

                    const sourceCodeMap = sourceCode ? new Map([[filePath, sourceCode]]) : undefined;
                    const symbolDocs = formatSymbolsAsJSON(symbols, sourceCodeMap);

                    // Strip references from all symbols to reduce output size
                    const strippedSymbolDocs = symbolDocs.map(stripReferences);

                    return {
                        filePath: normalizedFilePath,
                        language,
                        symbols: strippedSymbolDocs,
                    };
                }

                // No symbols found in AST index - try direct file read as final fallback
                // This handles code files that weren't indexed AND non-code files that
                // failed the direct read above (shouldn't happen, but defensive)
                for (const candidatePath of candidatePaths) {
                    try {
                        const fullContent = await readAndPreprocessFile(candidatePath);
                        const stats = await fs.stat(candidatePath);
                        const docType = getDocumentType(inputPath);

                        const totalLines = fullContent.split('\n').length;
                        const truncated = fullContent.length > MAX_DOCUMENT_CHARS;
                        const content = truncated ? fullContent.slice(0, MAX_DOCUMENT_CHARS) : fullContent;

                        tcAILogger.info(`[submission_read] Fallback read success: ${candidatePath} (${docType}, ${totalLines} lines, truncated=${truncated})`);

                        return {
                            filePath: normalizedFilePath,
                            type: docType,
                            size: stats.size,
                            totalLines,
                            content,
                            truncated,
                        };
                    } catch {
                        // Try next candidate path
                        continue;
                    }
                }

                // All attempts failed - find similar paths to suggest
                const codeFilePaths = store.getFilePaths();
                const allIndexedPaths = [...new Set([...codeFilePaths, ...indexedDocumentPaths])];
                const suggestions = findSimilarPaths(inputPath, allIndexedPaths);

                let errorMsg = isCode
                    ? `No symbols found in file "${normalizedFilePath}". File may not be indexed or may not exist.`
                    : `Could not read file "${normalizedFilePath}". File may not exist.`;

                if (suggestions.length > 0) {
                    errorMsg += ` Did you mean: ${suggestions.join(', ')}?`;
                }

                tcAILogger.warn(`[submission_read] ${errorMsg}`, { suggestions });
                return {
                    error: errorMsg,
                    path: inputPath,
                    suggestions: suggestions.length > 0 ? suggestions : undefined,
                };
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            tcAILogger.error(`[submission_read] Read failed`, { error });
            return {
                error: errorMsg,
                path: inputPath,
            };
        }
    },
});
