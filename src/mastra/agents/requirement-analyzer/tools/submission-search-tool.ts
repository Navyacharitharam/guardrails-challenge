/**
 * Submission search tool that returns properly formatted JSON results
 * grouped by file for clear agent consumption.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { reviewWorkspace } from '../../../workspaces';
import { astIndexerService } from '../../../workspaces/review';
import { formatSymbolAsJSON } from '../../../../utils/ast/indexer';
import { tcAILogger } from '../../../../utils/logger';

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
 * Compact symbol summary for search results - just enough info to decide if worth reading
 * Note: loc, complexity, risk, calls, calledBy are omitted for declarative/container symbol kinds
 * (property, constant, type_alias, abstract_class, interface, class)
 */
interface SymbolSummary {
    symbolPath: string;
    kind: string;
    signature?: string;
    loc?: number;
    complexity?: number;
    risk?: string;
    /** Functions/methods this symbol calls (outgoing edges) */
    calls?: string[];
    /** Functions/methods that call this symbol (incoming edges) - helps trace implementation chains */
    calledBy?: string[];
    exported: boolean;
    /** Line number where the symbol is defined */
    line?: number;
    /** Whether the symbol has logging statements */
    hasLogging?: boolean;
    /** Whether the symbol has error handling */
    hasErrorHandling?: boolean;
}

/** Internal symbol with score for sorting (not exposed in response) */
interface SymbolSummaryWithScore extends SymbolSummary {
    score: number;
}

/**
 * Internal search results with scores for sorting
 */
interface FileSearchResultsInternal {
    filePath: string;
    language: string;
    symbols: SymbolSummaryWithScore[];
}

/**
 * Search results grouped by file - compact format (output)
 */
interface FileSearchResults {
    filePath: string;
    language: string;
    symbols: SymbolSummary[];
}

/**
 * Document match for non-code files (configs, docs, etc.)
 */
interface DocumentMatch {
    filePath: string;
    snippet: string;
    /** Line range where the match was found (1-indexed) */
    lineRange?: { start: number; end: number };
}

/** Internal document with score for sorting (not exposed in response) */
interface DocumentMatchWithScore extends DocumentMatch {
    score: number;
}

/**
 * Optimized search response - minimal data for LLM decision making
 */
interface SubmissionSearchResponse {
    files: FileSearchResults[];
    documents: DocumentMatch[];
}

/**
 * Extract a useful snippet from document content around relevant lines
 */
function extractSnippet(content: string, lineRange?: { start: number; end: number }, maxLength = 100): string {
    const lines = content.split('\n');

    if (lineRange) {
        // Extract around the matching lines (0-indexed in result, convert to 0-indexed array)
        const start = Math.max(0, lineRange.start - 1);
        const end = Math.min(lines.length, lineRange.end);
        const relevantLines = lines.slice(start, end).join('\n');

        if (relevantLines.length <= maxLength) {
            return relevantLines.trim();
        }
        return relevantLines.slice(0, maxLength).trim() + '...';
    }

    // No line range - take first meaningful lines
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    let snippet = '';
    for (const line of nonEmptyLines) {
        if (snippet.length + line.length + 1 > maxLength) break;
        snippet += (snippet ? '\n' : '') + line;
    }
    return snippet || content.slice(0, maxLength).trim() + '...';
}

/**
 * Extract symbol path parts from a search result ID
 * Format: "path/to/file.ts:symbolName" or "path/to/file.ts:symbolName:1-15"
 */
function parseSymbolPath(id: string): { filePath: string; symbolName: string; lineRange?: string } | null {
    const colonIndex = id.lastIndexOf(':');
    if (colonIndex === -1) return null;

    // Check if last part is a line range (e.g., "1-15")
    const lastPart = id.slice(colonIndex + 1);
    const isLineRange = /^\d+-\d+$/.test(lastPart);

    if (isLineRange) {
        // Format: "path/file.ts:symbolName:1-15"
        const beforeLineRange = id.slice(0, colonIndex);
        const secondColonIndex = beforeLineRange.lastIndexOf(':');
        if (secondColonIndex === -1) return null;

        return {
            filePath: beforeLineRange.slice(0, secondColonIndex),
            symbolName: beforeLineRange.slice(secondColonIndex + 1),
            lineRange: lastPart,
        };
    }

    // Format: "path/file.ts:symbolName"
    return {
        filePath: id.slice(0, colonIndex),
        symbolName: lastPart,
    };
}

export const submissionSearchTool = createTool({
    id: 'submission_search',
    description: `Search the submission for code symbols AND documents (configs, docs, etc.).

Returns:

**files[]** - Code symbols (functions, classes, methods):
- symbolPath: Use with submission_read for full details
- kind, signature, exported
- loc, complexity, risk (only for function/method kinds)
- calls: Functions this symbol calls (outgoing edges)
- calledBy: Functions that call this symbol (incoming edges) - USE THIS TO TRACE IMPLEMENTATION CHAINS
- line: Line number where symbol is defined
- hasLogging, hasErrorHandling: Quality indicators

**documents[]** - Non-code files (configs, docs, scripts):
- filePath: Path to the matched document
- snippet: ~100 chars of content around the match
- lineRange: { start, end } - Lines where match was found in the document

**DEDUPLICATION:** Results are deduplicated across steps to save context.
- _skippedSymbols: Symbols already shown - check _seeAlso for where (e.g., "search(query='auth') in step 0")
- _skippedDocuments: Documents already shown - check _seeAlso for where
- When you see _seeAlso, the full data is in a PREVIOUS tool result - don't re-search, use that context!

**IMPORTANT:** When investigating an implementation, check the 'calledBy' field to discover parent functions that orchestrate the found symbol.

Use submission_read(path) to read file contents or inspect code symbols in detail.`,
    inputSchema: z.object({
        query: z.string().describe('Search query - use symbol names, function names, technical terms'),
    }),
    outputSchema: z.object({
        files: z.array(z.object({
            filePath: z.string(),
            language: z.string(),
            symbols: z.array(z.object({
                symbolPath: z.string(),
                kind: z.string(),
                signature: z.string().optional(),
                loc: z.number().optional(),
                complexity: z.number().optional(),
                risk: z.string().optional(),
                calls: z.array(z.string()).optional(),
                calledBy: z.array(z.string()).optional(),
                exported: z.boolean(),
                line: z.number().optional(),
                hasLogging: z.boolean().optional(),
                hasErrorHandling: z.boolean().optional(),
            })),
        })),
        documents: z.array(z.object({
            filePath: z.string(),
            snippet: z.string(),
            lineRange: z.object({
                start: z.number(),
                end: z.number(),
            }).optional(),
        })),
    }),
    execute: async ({ query }): Promise<SubmissionSearchResponse> => {
        // Fixed defaults: hybrid mode, topK=7, minScore=0.15
        const mode = 'hybrid';
        const topK = 7;
        const minScore = 0.15;

        tcAILogger.info(`[submission_search] Searching: "${query}"`);

        try {
            // Perform workspace search
            const searchResults = await reviewWorkspace.search(query, {
                mode,
                topK,
                minScore,
            });

            tcAILogger.info(`[submission_search] Raw results: ${searchResults.length}`);

            // Get the AST store for symbol lookup
            const store = astIndexerService.getStore();

            // Group results by file (for symbols) and collect documents
            // Use internal types with scores for sorting
            const fileGroups = new Map<string, FileSearchResultsInternal>();
            const documents: DocumentMatchWithScore[] = [];

            for (const result of searchResults) {
                const parsed = parseSymbolPath(result.id);

                if (!parsed) {
                    // Non-symbol result - this is a document/config file
                    // Normalize the path to strip submission prefixes for cleaner display
                    const normalizedPath = normalizeSubmissionPath(result.id);
                    const docMatch: DocumentMatchWithScore = {
                        filePath: normalizedPath,
                        score: Math.round(result.score * 100) / 100,
                        snippet: extractSnippet(result.content, result.lineRange),
                        // Include line range if provided (indicates where the match was found)
                        ...(result.lineRange && { lineRange: result.lineRange }),
                    };
                    documents.push(docMatch);
                    tcAILogger.info(`[submission_search] Document match: ${result.id} -> ${normalizedPath}`, { lineRange: result.lineRange });
                    continue;
                }

                const { filePath, symbolName } = parsed;
                // Normalize the path for cleaner display (but keep original for store lookup)
                const normalizedFilePath = normalizeSubmissionPath(filePath);

                // Look up the full symbol from the AST store (use original path)
                const symbols = store.getSymbolsForFile(filePath);
                const symbol = symbols.find(s => s.symbolName === symbolName);

                if (!symbol) {
                    tcAILogger.info(`[submission_search] Symbol not found in store: ${filePath}:${symbolName}`);
                    continue;
                }

                // Format as full JSON to extract key fields
                const symbolDoc = formatSymbolAsJSON(symbol);
                // Extract metadata from search result (set during AST indexing)
                const metadata = result.metadata as Record<string, unknown> | undefined;

                // Create compact summary - just enough to decide if worth reading
                // Exclude loc, complexity, risk, calls, calledBy for declarative/container symbol kinds
                const excludeMetrics = ['property', 'constant', 'type_alias', 'abstract_class', 'interface', 'class'].includes(symbolDoc.kind);
                const summary: SymbolSummaryWithScore = {
                    // Use normalized path for cleaner display to agent
                    symbolPath: `${normalizedFilePath}:${symbolName}`,
                    score: Math.round(result.score * 100) / 100,
                    kind: symbolDoc.kind,
                    signature: symbolDoc.signature,
                    exported: symbolDoc.flags?.isExported || false,
                    // Include line number from metadata (falls back to symbolDoc.location.line)
                    line: (metadata?.line as number) ?? symbolDoc.location?.line,
                    ...(excludeMetrics ? {} : {
                        loc: symbolDoc.metrics?.loc || 0,
                        complexity: (metadata?.complexity as number) ?? symbolDoc.metrics?.complexity ?? 0,
                        risk: symbolDoc.review?.riskLevel || 'low',
                        calls: (symbolDoc.callGraph?.calls || []).slice(0, 10), // Top 10 calls - increased to capture diverse patterns
                        calledBy: (symbolDoc.callGraph?.calledBy || []).slice(0, 5), // Top 5 callers - helps trace implementation chains
                        // Include quality indicators from metadata (falls back to symbolDoc.flags)
                        hasLogging: (metadata?.hasLogging as boolean) ?? symbolDoc.flags?.hasLogging,
                        hasErrorHandling: (metadata?.hasErrorHandling as boolean) ?? symbolDoc.flags?.hasErrorHandling,
                    }),
                };

                // Get or create file group (use normalized path as key)
                if (!fileGroups.has(normalizedFilePath)) {
                    fileGroups.set(normalizedFilePath, {
                        filePath: normalizedFilePath,
                        language: symbol.language || 'unknown',
                        symbols: [],
                    });
                }

                fileGroups.get(normalizedFilePath)!.symbols.push(summary);
            }

            // Sort files by best symbol score
            const sortedFiles = Array.from(fileGroups.values()).sort((a, b) => {
                const bestA = Math.max(...a.symbols.map(s => s.score));
                const bestB = Math.max(...b.symbols.map(s => s.score));
                return bestB - bestA;
            });

            // Sort symbols within each file by score
            for (const file of sortedFiles) {
                file.symbols.sort((a, b) => b.score - a.score);
            }

            // Sort documents by score
            documents.sort((a, b) => b.score - a.score);

            const symbolCount = sortedFiles.reduce((sum, f) => sum + f.symbols.length, 0);

            // Strip scores from output - they're only used internally for sorting
            const stripSymbolScore = ({ score: _, ...rest }: SymbolSummaryWithScore): SymbolSummary => rest;
            const stripDocScore = ({ score: _, ...rest }: DocumentMatchWithScore): DocumentMatch => rest;

            const response: SubmissionSearchResponse = {
                files: sortedFiles.map(f => ({
                    ...f,
                    symbols: f.symbols.map(stripSymbolScore),
                })),
                documents: documents.map(stripDocScore),
            };

            tcAILogger.info(`[submission_search] Returning ${symbolCount} symbols from ${sortedFiles.length} files + ${documents.length} documents`);

            return response;
        } catch (error) {
            // Check for "no such table" error - indicates workspace wasn't indexed
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('no such table') && errorMessage.includes('_search')) {
                tcAILogger.error(`[submission_search] Search table not found - workspace may not have been indexed. Returning empty results.`);
                return { files: [], documents: [] };
            }

            tcAILogger.error(`[submission_search] Search failed`, { error });
            throw error;
        }
    },
});
