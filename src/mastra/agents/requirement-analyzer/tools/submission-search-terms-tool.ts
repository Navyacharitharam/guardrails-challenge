/**
 * submission_search_terms - "Smart" multi-query search tool.
 *
 * Wraps submission_search to run several related queries in ONE tool call,
 * merging and deduplicating the results. This directly supports the
 * False-Negative Minimization Guardrail's requirement that the agent try
 * multiple search-term variants (literal patterns, synonyms, domain terms)
 * before concluding "not implemented" - and makes it cheap (one tool call,
 * one budget unit) for the agent to do so.
 *
 * The agent is instructed (see updated AGENT_INSTRUCTIONS) to prefer this
 * tool over repeated single-query submission_search calls when investigating
 * a requirement that maps to a known domain concept (auth, caching,
 * multi-tenancy, etc.) - reducing total tool-invocation count while
 * increasing search breadth, which helps with both the false-negative
 * guardrail AND the < 90s per-requirement latency constraint.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { reviewWorkspace } from '../../../workspaces';
import { astIndexerService } from '../../../workspaces/review';
import { formatSymbolAsJSON } from '../../../../utils/ast/indexer';
import { tcAILogger } from '../../../../utils/logger';

function normalizeSubmissionPath(filePath: string): string {
    if (filePath.startsWith('submission/')) {
        return filePath.slice('submission/'.length);
    }
    return filePath;
}

function parseSymbolPath(id: string): { filePath: string; symbolName: string } | null {
    const colonIndex = id.lastIndexOf(':');
    if (colonIndex === -1) return null;

    const lastPart = id.slice(colonIndex + 1);
    const isLineRange = /^\d+-\d+$/.test(lastPart);

    if (isLineRange) {
        const beforeLineRange = id.slice(0, colonIndex);
        const secondColonIndex = beforeLineRange.lastIndexOf(':');
        if (secondColonIndex === -1) return null;
        return {
            filePath: beforeLineRange.slice(0, secondColonIndex),
            symbolName: beforeLineRange.slice(secondColonIndex + 1),
        };
    }

    return {
        filePath: id.slice(0, colonIndex),
        symbolName: lastPart,
    };
}

function extractSnippet(content: string, lineRange?: { start: number; end: number }, maxLength = 100): string {
    const lines = content.split('\n');
    if (lineRange) {
        const start = Math.max(0, lineRange.start - 1);
        const end = Math.min(lines.length, lineRange.end);
        const relevantLines = lines.slice(start, end).join('\n');
        if (relevantLines.length <= maxLength) return relevantLines.trim();
        return relevantLines.slice(0, maxLength).trim() + '...';
    }
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    let snippet = '';
    for (const line of nonEmptyLines) {
        if (snippet.length + line.length + 1 > maxLength) break;
        snippet += (snippet ? '\n' : '') + line;
    }
    return snippet || content.slice(0, maxLength).trim() + '...';
}

interface PerQueryResult {
    query: string;
    fileCount: number;
    symbolCount: number;
    documentCount: number;
}

interface MergedFile {
    filePath: string;
    language: string;
    symbols: Array<{
        symbolPath: string;
        kind: string;
        signature?: string;
        exported: boolean;
        line?: number;
        matchedQueries: string[];
    }>;
}

interface MergedDocument {
    filePath: string;
    snippet: string;
    matchedQueries: string[];
}

export const submissionSearchTermsTool = createTool({
    id: 'submission_search_terms',
    description: `Search the submission with MULTIPLE related terms in a single call and get MERGED, deduplicated results.

Use this when investigating a domain concept that has multiple naming conventions - e.g. for "authentication"
search ["auth", "login", "session", "jwt"] in one call instead of 4 separate submission_search calls.

Returns merged files/symbols/documents, each annotated with which query term(s) matched, plus a per-query
result-count summary so you can see which terms found nothing (helping you spot gaps before concluding
"not implemented").

**Use this INSTEAD OF multiple submission_search calls when:**
- The requirement maps to a well-known concept with synonyms (auth, cache, multi-tenant, rate limit, etc.)
- You want to verify a "not found" conclusion by trying several literal code patterns at once

Still use plain submission_search for a single specific symbol/file name lookup.`,
    inputSchema: z.object({
        queries: z.array(z.string()).min(2).max(6).describe('2-6 related search terms (e.g. ["auth", "login", "session", "jwt"])'),
    }),
    outputSchema: z.object({
        files: z.array(z.object({
            filePath: z.string(),
            language: z.string(),
            symbols: z.array(z.object({
                symbolPath: z.string(),
                kind: z.string(),
                signature: z.string().optional(),
                exported: z.boolean(),
                line: z.number().optional(),
                matchedQueries: z.array(z.string()),
            })),
        })),
        documents: z.array(z.object({
            filePath: z.string(),
            snippet: z.string(),
            matchedQueries: z.array(z.string()),
        })),
        perQuery: z.array(z.object({
            query: z.string(),
            fileCount: z.number(),
            symbolCount: z.number(),
            documentCount: z.number(),
        })),
        zeroResultQueries: z.array(z.string()),
    }),
    execute: async ({ queries }) => {
        const mode = 'hybrid';
        const topK = 5; // slightly lower per-query since we run multiple
        const minScore = 0.15;

        tcAILogger.info(`[submission_search_terms] Multi-query search: ${JSON.stringify(queries)}`);

        const store = astIndexerService.getStore();

        const fileMap = new Map<string, MergedFile>();
        const docMap = new Map<string, MergedDocument>();
        const perQuery: PerQueryResult[] = [];
        const zeroResultQueries: string[] = [];

        for (const query of queries) {
            let fileCount = 0;
            let symbolCount = 0;
            let documentCount = 0;

            try {
                const searchResults = await reviewWorkspace.search(query, { mode, topK, minScore });

                for (const result of searchResults) {
                    const parsed = parseSymbolPath(result.id);

                    if (!parsed) {
                        const normalizedPath = normalizeSubmissionPath(result.id);
                        documentCount++;
                        const existing = docMap.get(normalizedPath);
                        if (existing) {
                            if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
                        } else {
                            docMap.set(normalizedPath, {
                                filePath: normalizedPath,
                                snippet: extractSnippet(result.content, result.lineRange),
                                matchedQueries: [query],
                            });
                        }
                        continue;
                    }

                    const { filePath, symbolName } = parsed;
                    const normalizedFilePath = normalizeSubmissionPath(filePath);
                    const symbols = store.getSymbolsForFile(filePath);
                    const symbol = symbols.find(s => s.symbolName === symbolName);
                    if (!symbol) continue;

                    const symbolDoc = formatSymbolAsJSON(symbol);
                    const symbolPath = `${normalizedFilePath}:${symbolName}`;
                    symbolCount++;

                    let fileEntry = fileMap.get(normalizedFilePath);
                    if (!fileEntry) {
                        fileEntry = { filePath: normalizedFilePath, language: symbol.language || 'unknown', symbols: [] };
                        fileMap.set(normalizedFilePath, fileEntry);
                        fileCount++;
                    }

                    const existingSymbol = fileEntry.symbols.find(s => s.symbolPath === symbolPath);
                    if (existingSymbol) {
                        if (!existingSymbol.matchedQueries.includes(query)) existingSymbol.matchedQueries.push(query);
                    } else {
                        fileEntry.symbols.push({
                            symbolPath,
                            kind: symbolDoc.kind,
                            signature: symbolDoc.signature,
                            exported: symbolDoc.flags?.isExported || false,
                            line: symbolDoc.location?.line,
                            matchedQueries: [query],
                        });
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                tcAILogger.warn(`[submission_search_terms] Query "${query}" failed: ${errorMessage}`);
            }

            perQuery.push({ query, fileCount, symbolCount, documentCount });
            if (fileCount === 0 && symbolCount === 0 && documentCount === 0) {
                zeroResultQueries.push(query);
            }
        }

        const files = [...fileMap.values()];
        const documents = [...docMap.values()];

        tcAILogger.info(`[submission_search_terms] Merged results: ${files.length} files, ${documents.length} documents; zero-result queries: ${zeroResultQueries.join(', ') || 'none'}`);

        return { files, documents, perQuery, zeroResultQueries };
    },
});
