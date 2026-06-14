import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FalseNegativeGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/false-negative-guardrail';
import { FalsePositiveGuardrail, NO_OP_AST_INDEXER } from '../src/mastra/agents/requirement-analyzer/guardrails/false-positive-guardrail';
import {
    ResultConsistencyGuardrail,
    InMemoryConsistencyStore,
} from '../src/mastra/agents/requirement-analyzer/guardrails/result-consistency-guardrail';

/**
 * Regression tests for cross-requirement state isolation.
 *
 * In the real `requirementsAnalyzerWorkflow`, ONE agent instance (with ONE
 * set of guardrail instances) processes MANY requirements sequentially, each
 * with its own `threadId` (`${challengeId}-req-${requirement.id}-...`).
 * Without per-thread isolation, accumulated state from REQ_01 (search/read
 * history, verified paths, inventory) would leak into REQ_02's validation -
 * e.g. REQ_02 could be granted a MISSING verdict "for free" because REQ_01
 * already satisfied `minSearchAttempts`, or REQ_02's COVERED claim could be
 * "verified" against a file that was actually read while investigating
 * REQ_01.
 *
 * These tests run TWO requirements through SHARED guardrail instances using
 * DIFFERENT threadIds and assert each requirement's validation only sees its
 * own tool-call history.
 */

function fakeMessageList(messages: unknown[]) {
    return { get: { all: { db: () => messages } } } as never;
}

function userMessage(text: string) {
    return { role: 'user', content: { parts: [{ type: 'text', text }] } };
}

function searchToolMessage(query: string, files: unknown[] = [{ filePath: 'x' }]) {
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
                    result: { files, documents: [] },
                },
            }],
        },
    };
}

function readFileMessage(filePath: string, content: string) {
    return {
        role: 'assistant',
        content: {
            parts: [{
                type: 'tool-invocation',
                toolInvocation: {
                    toolCallId: `read-${filePath}`,
                    toolName: 'submission_read',
                    state: 'result',
                    args: { path: filePath },
                    result: { filePath, type: 'file', size: content.length, totalLines: 1, content, truncated: false },
                },
            }],
        },
    };
}

function fakeOutputArgs(text: string, retryCount: number, messageList: unknown, threadId: string) {
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
            requestContext: { threadId },
            abort: (reason: string, opts: unknown) => { aborted = { reason, opts }; },
        },
        getAborted: () => aborted,
    };
}

function fakeInputArgs(messageList: unknown, threadId: string, systemMessages: unknown[] = []) {
    return {
        messageList,
        stepNumber: 1,
        systemMessages,
        requestContext: { threadId },
    };
}

describe('Cross-requirement state isolation', () => {
    test('FalseNegativeGuardrail: REQ_02 with 0 searches is rejected even though REQ_01 (different thread) did 3', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 3, minReadAttempts: 0, maxRetries: 2 });

        // --- REQ_01: thread A, performs 3 distinct searches, concludes MISSING ---
        const messagesA = [
            userMessage('**Requirement ID:** REQ_01\n**Title:** Caching\nImplement caching.'),
            searchToolMessage('cache'),
            searchToolMessage('redis'),
            searchToolMessage('lru_cache'),
        ];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesA), 'thread-A') as never);

        const reportA = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_01
**Title:** Caching
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No caching found after searching cache, redis, lru_cache.`;

        const outA = fakeOutputArgs(reportA, 0, fakeMessageList(messagesA), 'thread-A');
        guardrail.processOutputStep(outA.args as never);
        assert.equal(outA.getAborted(), null, 'REQ_01 with sufficient search should pass');

        // --- REQ_02: thread B, performs ZERO searches, concludes MISSING ---
        const messagesB = [
            userMessage('**Requirement ID:** REQ_02\n**Title:** Rate limiting\nImplement rate limiting.'),
        ];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesB), 'thread-B') as never);

        const reportB = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_02
**Title:** Rate limiting
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No rate limiting found.`;

        const outB = fakeOutputArgs(reportB, 0, fakeMessageList(messagesB), 'thread-B');
        guardrail.processOutputStep(outB.args as never);

        const aborted = outB.getAborted();
        assert.ok(aborted, 'REQ_02 (thread-B) should be rejected on its own merits - 0 searches performed, ' +
            'must NOT inherit thread-A\'s search count');
        assert.match(aborted!.reason, /more DIFFERENT submission_search queries/);
    });

    test('FalsePositiveGuardrail: REQ_02 citing a file read only during REQ_01 is rejected', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, NO_OP_AST_INDEXER);

        // --- REQ_01: thread A, reads src/cache.ts ---
        const messagesA = [readFileMessage('src/cache.ts', 'export function getCache() {}')];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesA), 'thread-A') as never);

        const reportA = `# Requirement Analysis Report
## 2. Implementation Evidence
- **File:** \`src/cache.ts\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Caching is implemented in src/cache.ts.`;

        const outA = fakeOutputArgs(reportA, 0, fakeMessageList(messagesA), 'thread-A');
        guardrail.processOutputStep(outA.args as never);
        assert.equal(outA.getAborted(), null, 'REQ_01 citing a file it read should pass');

        // --- REQ_02: thread B, reads NOTHING, but cites src/cache.ts (read only in thread A) ---
        const messagesB: unknown[] = [];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesB), 'thread-B') as never);

        const reportB = `# Requirement Analysis Report
## 2. Implementation Evidence
- **File:** \`src/cache.ts\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Caching is implemented in src/cache.ts.`;

        const outB = fakeOutputArgs(reportB, 0, fakeMessageList(messagesB), 'thread-B');
        guardrail.processOutputStep(outB.args as never);

        const aborted = outB.getAborted();
        assert.ok(aborted, 'REQ_02 (thread-B) must NOT be able to cite src/cache.ts as verified - ' +
            'it was only read while analyzing REQ_01 (thread-A)');
        assert.match(aborted!.reason, /never actually read/);
    });

    test('ResultConsistencyGuardrail: REQ_01 and REQ_02 (different requirementIds, never run before) both get baseline treatment, no false cross-comparison', async () => {
        const store = new InMemoryConsistencyStore();
        const guardrail = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);

        // REQ_01: thread A
        const messagesA = [
            userMessage('**Requirement ID:** REQ_01\n**Title:** Caching'),
            readFileMessage('src/cache.ts', 'export function getCache() {}'),
        ];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesA), 'thread-A') as never);

        const reportA = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_01
**Title:** Caching
## 3. Constraint Verification
| Constraint | Status | Evidence |
|------------|--------|----------|
| Must use Redis | ✅ Verified | src/cache.ts |
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Caching is fully implemented with sufficient detail to pass validation checks.`;

        const outA = fakeOutputArgs(reportA, 0, fakeMessageList(messagesA), 'thread-A');
        await guardrail.processOutputStep(outA.args as never);
        assert.equal(outA.getAborted(), null);

        // REQ_02: thread B - different requirement, reads a DIFFERENT file,
        // concludes MISSING. Must be treated as a fresh baseline (different
        // fingerprint: different requirementId AND different reads), NOT
        // compared against REQ_01's COVERED/0.9 result.
        const messagesB = [
            userMessage('**Requirement ID:** REQ_02\n**Title:** Rate limiting'),
            readFileMessage('src/ratelimit.ts', 'export function noop() {}'),
        ];
        await guardrail.processInputStep(fakeInputArgs(fakeMessageList(messagesB), 'thread-B') as never);

        const reportB = `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_02
**Title:** Rate limiting
## 3. Constraint Verification
| Constraint | Status | Evidence |
|------------|--------|----------|
| Must throttle requests | ❌ Not Found | none |
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** Rate limiting is not implemented anywhere in the codebase based on searches performed.`;

        const outB = fakeOutputArgs(reportB, 0, fakeMessageList(messagesB), 'thread-B');
        await guardrail.processOutputStep(outB.args as never);

        assert.equal(outB.getAborted(), null, 'REQ_02 (MISSING/0.1) must NOT be compared against REQ_01 (COVERED/0.9) - ' +
            'different requirementId + different fingerprint = fresh baseline, not a consistency violation');
    });
});
