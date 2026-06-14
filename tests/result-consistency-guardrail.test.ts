import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    ResultConsistencyGuardrail,
    InMemoryConsistencyStore,
} from '../src/mastra/agents/requirement-analyzer/guardrails/result-consistency-guardrail';

function fakeMessageList(messages: unknown[] = []) {
    return { get: { all: { db: () => messages } } } as never;
}

function userMessage(text: string) {
    return { role: 'user', content: { parts: [{ type: 'text', text }] } };
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

function report(verdict: string, score: number, status: string) {
    return `# Requirement Analysis Report
## 1. Requirement Summary
**ID:** REQ_1
**Title:** Authentication
## 3. Constraint Verification
| Constraint | Status | Evidence |
|------------|--------|----------|
| Must use JWT | ${status} | src/auth/session.ts |
## 4. Coverage Assessment
**Overall Coverage Score:** ${score}
**Verdict:** ${verdict}
**Justification:** Consistent test justification with enough length to pass validation.`;
}

describe('ResultConsistencyGuardrail', () => {
    test('stores baseline on first run, no abort', async () => {
        const store = new InMemoryConsistencyStore();
        const guardrail = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);

        const messages = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), systemMessages: [] } as never);

        const { args, getAborted } = fakeOutputArgs(report('COVERED', 0.9, '✅ Verified'), 0, fakeMessageList(messages));
        await guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null);
    });

    test('accepts second run within tolerance', async () => {
        const store = new InMemoryConsistencyStore();

        // First run
        const g1 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages1 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g1.processInputStep({ messageList: fakeMessageList(messages1), systemMessages: [] } as never);
        const out1 = fakeOutputArgs(report('COVERED', 0.85, '✅ Verified'), 0, fakeMessageList(messages1));
        await g1.processOutputStep(out1.args as never);

        // Second run, same fingerprint (same requirement, same inventory, same reads), score slightly different
        const g2 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages2 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g2.processInputStep({ messageList: fakeMessageList(messages2), systemMessages: [] } as never);
        const out2 = fakeOutputArgs(report('COVERED', 0.9, '✅ Verified'), 0, fakeMessageList(messages2));
        await g2.processOutputStep(out2.args as never);

        assert.equal(out2.getAborted(), null, 'within tolerance (0.05 < 0.15) should not abort');
    });

    test('rejects second run with diverging verdict (same fingerprint)', async () => {
        const store = new InMemoryConsistencyStore();

        const g1 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages1 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g1.processInputStep({ messageList: fakeMessageList(messages1), systemMessages: [] } as never);
        const out1 = fakeOutputArgs(report('COVERED', 0.9, '✅ Verified'), 0, fakeMessageList(messages1));
        await g1.processOutputStep(out1.args as never);

        const g2 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages2 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g2.processInputStep({ messageList: fakeMessageList(messages2), systemMessages: [] } as never);
        const out2 = fakeOutputArgs(report('MISSING', 0.1, '❌ Not Found'), 0, fakeMessageList(messages2));
        await g2.processOutputStep(out2.args as never);

        const aborted = out2.getAborted();
        assert.ok(aborted, 'diverging verdict on identical fingerprint should trigger re-verification');
        assert.match(aborted!.reason, /previous analysis of this SAME requirement/);
    });

    test('accepts diverging result at retry limit', async () => {
        const store = new InMemoryConsistencyStore();

        const g1 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages1 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g1.processInputStep({ messageList: fakeMessageList(messages1), systemMessages: [] } as never);
        const out1 = fakeOutputArgs(report('COVERED', 0.9, '✅ Verified'), 0, fakeMessageList(messages1));
        await g1.processOutputStep(out1.args as never);

        const g2 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages2 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g2.processInputStep({ messageList: fakeMessageList(messages2), systemMessages: [] } as never);
        const out2 = fakeOutputArgs(report('MISSING', 0.1, '❌ Not Found'), 1, fakeMessageList(messages2)); // retryCount = maxRetries
        await g2.processOutputStep(out2.args as never);

        assert.equal(out2.getAborted(), null, 'retry limit reached -> accept despite divergence');
    });

    test('different read-set produces different fingerprint -> treated as fresh baseline', async () => {
        const store = new InMemoryConsistencyStore();

        const g1 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages1 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/session.ts', 'export function createSession() {}'),
        ];
        await g1.processInputStep({ messageList: fakeMessageList(messages1), systemMessages: [] } as never);
        const out1 = fakeOutputArgs(report('COVERED', 0.9, '✅ Verified'), 0, fakeMessageList(messages1));
        await g1.processOutputStep(out1.args as never);

        // Second run reads a DIFFERENT file -> different fingerprint -> no comparison, no abort
        const g2 = new ResultConsistencyGuardrail({ scoreTolerance: 0.15, maxRetries: 1 }, store);
        const messages2 = [
            userMessage('**Requirement ID:** REQ_1\n**Title:** Authentication'),
            readFileMessage('src/auth/other.ts', 'export function other() {}'),
        ];
        await g2.processInputStep({ messageList: fakeMessageList(messages2), systemMessages: [] } as never);
        const out2 = fakeOutputArgs(report('MISSING', 0.1, '❌ Not Found'), 0, fakeMessageList(messages2));
        await g2.processOutputStep(out2.args as never);

        assert.equal(out2.getAborted(), null, 'different fingerprint -> no comparison made');
    });
});
