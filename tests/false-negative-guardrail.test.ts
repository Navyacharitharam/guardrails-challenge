import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FalseNegativeGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/false-negative-guardrail';

/** Minimal fake messageList that satisfies `get.all.db()`. */
function fakeMessageList(messages: unknown[]) {
    return {
        get: {
            all: {
                db: () => messages,
            },
        },
    } as never;
}

function userMessage(text: string) {
    return {
        role: 'user',
        content: { parts: [{ type: 'text', text }] },
    };
}

function searchToolMessage(query: string, files: unknown[] = [], documents: unknown[] = []) {
    return {
        role: 'assistant',
        content: {
            parts: [{
                type: 'tool-invocation',
                toolInvocation: {
                    toolCallId: `call-${query}`,
                    toolName: 'submission_search',
                    state: 'result',
                    args: { query },
                    result: { files, documents },
                },
            }],
        },
    };
}

function readToolMessage(path: string, error?: string) {
    return {
        role: 'assistant',
        content: {
            parts: [{
                type: 'tool-invocation',
                toolInvocation: {
                    toolCallId: `read-${path}`,
                    toolName: 'submission_read',
                    state: 'result',
                    args: { path },
                    result: error ? { error, path } : { filePath: path, content: 'export function foo() {}', type: 'file', size: 10, totalLines: 1, truncated: false },
                },
            }],
        },
    };
}

function fakeOutputArgs(text: string, retryCount: number, messageList: unknown) {
    let aborted: { reason: string; opts: unknown } | null = null;
    return {
        args: {
            text,
            retryCount,
            stepNumber: 1,
            finishReason: 'stop',
            usage: {},
            toolCalls: [],
            messageList,
            abort: (reason: string, opts: unknown) => { aborted = { reason, opts }; },
        },
        getAborted: () => aborted,
    };
}

function searchTermsToolMessage(
    queries: string[],
    perQueryResults: { fileCount?: number; symbolCount?: number; documentCount?: number }[] = []
) {
    const perQuery = queries.map((query, i) => ({
        query,
        fileCount: perQueryResults[i]?.fileCount ?? 0,
        symbolCount: perQueryResults[i]?.symbolCount ?? 0,
        documentCount: perQueryResults[i]?.documentCount ?? 0,
    }));
    const zeroResultQueries = perQuery.filter(pq => pq.fileCount + pq.symbolCount + pq.documentCount === 0).map(pq => pq.query);

    return {
        role: 'assistant',
        content: {
            parts: [{
                type: 'tool-invocation',
                toolInvocation: {
                    toolCallId: `call-search-terms-${queries.join('-')}`,
                    toolName: 'submission_search_terms',
                    state: 'result',
                    args: { queries },
                    result: { files: [], documents: [], perQuery, zeroResultQueries },
                },
            }],
        },
    };
}

describe('FalseNegativeGuardrail', () => {
    test('rejects MISSING verdict with insufficient search attempts', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 1, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication\nImplement authentication for the API.'),
            searchToolMessage('auth'),
        ];

        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            systemMessages: [],
        } as never);

        const reportText = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Authentication
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** Not found.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should abort due to insufficient search');
        assert.match(aborted!.reason, /more DIFFERENT submission_search queries/);
    });

    test('accepts MISSING verdict with sufficient diverse search + read', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 1, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Caching\nImplement caching for the API responses.'),
            searchToolMessage('cache'),
            searchToolMessage('redis'),
            searchToolMessage('lru_cache'),
            readToolMessage('src/cache.ts'),
        ];

        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            systemMessages: [],
        } as never);

        const reportText = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Caching
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No caching implementation found after searching cache, redis, lru_cache and reading src/cache.ts.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'should not abort - search effort is sufficient');
    });

    test('accepts MISSING immediately for empty/junk submission without looping', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 1, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication\nImplement authentication.'),
            searchToolMessage('auth', [], []),
            searchToolMessage('login', [], []),
            searchToolMessage('session', [], []),
        ];

        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            // Simulate an empty inventory (just the header line, 0 files)
            systemMessages: [{ role: 'system', content: 'The following files are available for requirement review. Read them using submission_read tool when needed:\n\n' }],
        } as never);

        const reportText = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Authentication
## 4. Coverage Assessment
**Overall Coverage Score:** 0.0
**Verdict:** MISSING
**Justification:** Codebase appears empty - no files contain auth-related code.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'should accept MISSING immediately for empty codebase');
    });

    test('accepts MISSING verdict when sufficient search effort comes from ONE submission_search_terms call', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 1, maxRetries: 2 });

        // Agent follows its instructions: prefers ONE submission_search_terms
        // call with multiple domain-synonym queries, instead of 3 separate
        // submission_search calls. Each sub-query must still count toward
        // minSearchAttempts and synonym coverage.
        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication\nImplement authentication for the API.'),
            searchTermsToolMessage(['auth', 'login', 'session', 'jwt'], [
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
            ]),
            readToolMessage('src/index.ts'),
        ];

        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            systemMessages: [],
        } as never);

        const reportText = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Authentication
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No authentication implementation found after searching auth, login, session, jwt.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(
            getAborted(),
            null,
            'submission_search_terms sub-queries must count toward minSearchAttempts and domain-synonym coverage - ' +
            'the agent already searched auth/login/session/jwt in one call and should not be asked to redo this work'
        );
    });

    test('still rejects MISSING when submission_search_terms sub-queries do not cover required synonyms', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 1, maxRetries: 2 });

        // Only 2 sub-queries, neither related to the "authentication" domain
        // concept's synonyms (auth/login/session/jwt/etc.) - should still be
        // flagged for missing synonym coverage even though
        // submission_search_terms was used.
        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication\nImplement authentication for the API.'),
            searchTermsToolMessage(['foo', 'bar'], [
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
                { fileCount: 0, symbolCount: 0, documentCount: 0 },
            ]),
            readToolMessage('src/index.ts'),
        ];

        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            systemMessages: [],
        } as never);

        const reportText = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Authentication
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No authentication implementation found.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should still flag missing domain-synonym coverage even when using submission_search_terms');
        assert.match(aborted!.reason, /domain-specific code patterns/);
    });

    test('does not interfere with COVERED/PARTIAL verdicts', async () => {
        const guardrail = new FalseNegativeGuardrail();

        const messages = [userMessage('**Requirement ID:** REQ_1\n**Title:** Logging')];
        await guardrail.processInputStep({
            messageList: fakeMessageList(messages),
            stepNumber: 1,
            systemMessages: [],
        } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Fully implemented.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null);
    });
});
