/**
 * verify_constraint - "Smart" verification tool for false-positive prevention.
 *
 * Given a constraint description and a candidate symbolPath the agent
 * believes satisfies it, this tool:
 *   1. Confirms the symbol/file actually exists in the AST index (catches
 *      hallucinated paths immediately, cheaper than a full submission_read).
 *   2. Returns objective signals from the AST metadata that help judge
 *      whether the symbol plausibly implements the constraint: call graph
 *      (calls/calledBy), hasErrorHandling/hasLogging flags, complexity,
 *      and a keyword-overlap score between the constraint text and the
 *      symbol's signature + body (when available).
 *   3. If the path doesn't exist, returns suggestions for similar indexed
 *      paths (reusing the same fuzzy-matching as submission_read), so the
 *      agent can self-correct without burning a submission_read budget unit
 *      on a bad path.
 *
 * This tool does NOT replace submission_read for evidence collection - the
 * agent still must submission_read the symbol to quote it in the report
 * (enforced by the False-Positive Prevention Guardrail). Its purpose is to
 * let the agent cheaply sanity-check candidate matches BEFORE committing to
 * them in the final report, reducing both false positives (hallucinated
 * matches) and false negatives (the agent dismissing a real match because it
 * "didn't look right" without checking the call graph).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as path from 'path';
import { astIndexerService, indexedDocumentPaths } from '../../../workspaces/review';
import { formatSymbolAsJSON } from '../../../../utils/ast/indexer';
import { tcAILogger } from '../../../../utils/logger';

function normalizeSubmissionPath(filePath: string): string {
    if (filePath.startsWith('submission/')) {
        return filePath.slice('submission/'.length);
    }
    return filePath;
}

/** Reuse the same similarity heuristic as submission_read for suggestions. */
function findSimilarPaths(requestedPath: string, indexedPaths: string[], maxSuggestions = 3): string[] {
    const requestedFileName = path.basename(requestedPath.split(':')[0]);
    const requestedSegments = requestedPath.split(':')[0].split('/').filter(Boolean);

    const scored: { path: string; score: number }[] = [];

    for (const indexedPath of indexedPaths) {
        const indexedFileName = path.basename(indexedPath);
        const indexedSegments = indexedPath.split('/').filter(Boolean);

        let score = 0;
        if (indexedFileName === requestedFileName) score += 10;
        else if (indexedFileName.toLowerCase() === requestedFileName.toLowerCase()) score += 8;
        else if (indexedFileName.includes(requestedFileName) || requestedFileName.includes(indexedFileName)) score += 5;

        for (const segment of requestedSegments) {
            if (indexedSegments.includes(segment)) score += 2;
        }

        const lengthDiff = Math.abs(indexedSegments.length - requestedSegments.length);
        score -= lengthDiff * 0.5;

        if (score > 0) scored.push({ path: indexedPath, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxSuggestions).map(s => normalizeSubmissionPath(s.path));
}

/** Tokenize text into lowercase word tokens, dropping short/common stopwords. */
function tokenize(text: string): Set<string> {
    const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'is', 'in', 'for', 'on', 'with', 'must', 'should', 'be', 'this', 'that']);
    return new Set(
        text.toLowerCase()
            .split(/[^a-z0-9_]+/)
            .filter(t => t.length > 2 && !STOPWORDS.has(t))
    );
}

/** Jaccard-style overlap score between two token sets, 0-1. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const tok of a) {
        if (b.has(tok)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

export const verifyConstraintTool = createTool({
    id: 'verify_constraint',
    description: `Sanity-check a candidate symbol/file against a constraint BEFORE citing it as evidence in your report.

Given a constraint description (e.g. "Multi-tenant isolation enforced via row-level security policies") and a
candidatePath (e.g. "backbone/db/policies.sql" or "src/auth/session.ts:createSession"), this tool:
- Confirms the path EXISTS in the index (catches typos/hallucinated paths cheaply)
- Returns call-graph info (calls/calledBy), complexity, hasErrorHandling/hasLogging flags
- Returns a keywordOverlapScore (0-1) estimating how related the constraint text is to the symbol's
  signature/name - LOW scores (< 0.1) are a signal you may have the WRONG symbol
- If the path doesn't exist, returns "suggestions" of similar indexed paths

Use this to cheaply validate candidates from submission_search results before spending a submission_read call,
and before citing a path in your final report. Does NOT count toward the submission_read evidence requirement -
you still must submission_read the symbol to quote it.`,
    inputSchema: z.object({
        constraintText: z.string().describe('The constraint or requirement text being verified'),
        candidatePath: z.string().describe('Candidate path: "file.ext" or "file.ext:symbolName"'),
    }),
    outputSchema: z.object({
        exists: z.boolean(),
        normalizedPath: z.string(),
        kind: z.string().optional(),
        signature: z.string().optional(),
        complexity: z.number().optional(),
        hasErrorHandling: z.boolean().optional(),
        hasLogging: z.boolean().optional(),
        calls: z.array(z.string()).optional(),
        calledBy: z.array(z.string()).optional(),
        keywordOverlapScore: z.number().optional(),
        keywordOverlapNote: z.string().optional(),
        suggestions: z.array(z.string()).optional(),
    }),
    execute: async ({ constraintText, candidatePath }) => {
        tcAILogger.info(`[verify_constraint] Checking "${candidatePath}" against constraint`, { constraintText: constraintText.slice(0, 80) });

        const store = astIndexerService.getStore();

        const colonIndex = candidatePath.lastIndexOf(':');
        const hasSymbolName = colonIndex > 0 && !candidatePath.slice(colonIndex + 1).includes('/');

        if (hasSymbolName) {
            const rawFilePath = candidatePath.slice(0, colonIndex);
            const symbolName = candidatePath.slice(colonIndex + 1);

            // Try both with and without submission/ prefix
            const candidates = [rawFilePath, `submission/${rawFilePath}`, rawFilePath.replace(/^submission\//, '')];
            let foundFilePath: string | null = null;
            let symbol = null;

            for (const fp of candidates) {
                const symbols = store.getSymbolsForFile(fp);
                const found = symbols.find(s => s.symbolName === symbolName);
                if (found) {
                    foundFilePath = fp;
                    symbol = found;
                    break;
                }
            }

            if (!symbol || !foundFilePath) {
                const codeFilePaths = store.getFilePaths();
                const allIndexedPaths = [...new Set([...codeFilePaths, ...indexedDocumentPaths])];
                const suggestions = findSimilarPaths(candidatePath, allIndexedPaths);
                return {
                    exists: false,
                    normalizedPath: normalizeSubmissionPath(candidatePath),
                    suggestions: suggestions.length > 0 ? suggestions : undefined,
                };
            }

            const symbolDoc = formatSymbolAsJSON(symbol);
            const normalizedFilePath = normalizeSubmissionPath(foundFilePath);

            const constraintTokens = tokenize(constraintText);
            const symbolTokens = tokenize(`${symbolName} ${symbolDoc.signature || ''}`);
            const overlap = tokenOverlap(constraintTokens, symbolTokens);

            return {
                exists: true,
                normalizedPath: `${normalizedFilePath}:${symbolName}`,
                kind: symbolDoc.kind,
                signature: symbolDoc.signature,
                complexity: symbolDoc.metrics?.complexity,
                hasErrorHandling: symbolDoc.flags?.hasErrorHandling,
                hasLogging: symbolDoc.flags?.hasLogging,
                calls: (symbolDoc.callGraph?.calls || []).slice(0, 10),
                calledBy: (symbolDoc.callGraph?.calledBy || []).slice(0, 5),
                keywordOverlapScore: Math.round(overlap * 100) / 100,
                keywordOverlapNote: overlap < 0.1
                    ? 'LOW overlap between constraint text and symbol name/signature - double-check this is the right symbol before citing it.'
                    : undefined,
            };
        }

        // File-level check (no symbol name)
        const candidates = [candidatePath, `submission/${candidatePath}`, candidatePath.replace(/^submission\//, '')];
        for (const fp of candidates) {
            const symbols = store.getSymbolsForFile(fp);
            if (symbols.length > 0) {
                return {
                    exists: true,
                    normalizedPath: normalizeSubmissionPath(fp),
                    kind: 'file',
                };
            }
        }

        const codeFilePaths = store.getFilePaths();
        const allIndexedPaths = [...new Set([...codeFilePaths, ...indexedDocumentPaths])];

        if (allIndexedPaths.some(p => normalizeSubmissionPath(p) === normalizeSubmissionPath(candidatePath))) {
            return { exists: true, normalizedPath: normalizeSubmissionPath(candidatePath), kind: 'document' };
        }

        const suggestions = findSimilarPaths(candidatePath, allIndexedPaths);
        return {
            exists: false,
            normalizedPath: normalizeSubmissionPath(candidatePath),
            suggestions: suggestions.length > 0 ? suggestions : undefined,
        };
    },
});
