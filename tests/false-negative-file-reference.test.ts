import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FalseNegativeGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/false-negative-guardrail';

function fakeMessageList(messages: unknown[]) {
    return { get: { all: { db: () => messages } } } as never;
}

function userMessage(text: string) {
    return { role: 'user', content: { parts: [{ type: 'text', text }] } };
}

function readToolMessage(path: string, opts: { truncated?: boolean; filePath?: string; error?: string } = {}) {
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
                    result: opts.error
                        ? { error: opts.error, path }
                        : { filePath: opts.filePath || path, type: 'file', content: 'content', truncated: !!opts.truncated, totalLines: 100, size: 1000 },
                },
            }],
        },
    };
}

function searchToolMessage(query: string, files: unknown[] = [{ filePath: 'x' }], documents: unknown[] = []) {
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

describe('FalseNegativeGuardrail - requirement-referenced file checks', () => {
    test('rejects MISSING when a file explicitly named in the requirement was never read', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 1, minReadAttempts: 0, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_15\n**Title:** Agent Documentation\nThe file docs/agents.md must document the actual prompts used.'),
            searchToolMessage('agents'),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), stepNumber: 1, systemMessages: [] } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.2
**Verdict:** MISSING
**Justification:** No prompt documentation found.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should abort - docs/agents.md was never read');
        assert.match(aborted!.reason, /NOT YET READ.*docs\/agents\.md/s);
    });

    test('rejects PARTIAL when a referenced file was read but truncated', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 1, minReadAttempts: 0, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_15\n**Title:** Agent Documentation\nSee docs/agents.md for the actual prompts and cost data.'),
            searchToolMessage('agents'),
            readToolMessage('docs/agents.md', { truncated: true, filePath: 'docs/agents.md' }),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), stepNumber: 1, systemMessages: [] } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.5
**Verdict:** PARTIAL
**Justification:** Some prompt info found but cost/latency data not visible in the truncated content.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should abort - docs/agents.md was truncated');
        assert.match(aborted!.reason, /READ BUT TRUNCATED.*docs\/agents\.md/s);
    });

    test('accepts MISSING when referenced file was read fully (not truncated)', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 1, minReadAttempts: 0, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_99\n**Title:** Architecture doc\nSee docs/architecture.md for framework justification.'),
            searchToolMessage('architecture'),
            readToolMessage('docs/architecture.md', { truncated: false, filePath: 'docs/architecture.md' }),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), stepNumber: 1, systemMessages: [] } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No framework justification found in docs/architecture.md.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'file was fully read - file-mention check should not fire');
    });

    test('does not fire for COVERED verdicts', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 1, minReadAttempts: 0, maxRetries: 2 });

        const messages = [
            userMessage('**Requirement ID:** REQ_20\n**Title:** Prospect UI\nSee RunStatus.tsx for the pipeline stages.'),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), stepNumber: 1, systemMessages: [] } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** RunStatus.tsx shows all stages.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'COVERED verdicts are not subject to the file-mention check');
    });

    test('respects retry limit - does not loop forever on truncated files', async () => {
        const guardrail = new FalseNegativeGuardrail({ minSearchAttempts: 1, minReadAttempts: 0, maxRetries: 1 });

        const messages = [
            userMessage('**Requirement ID:** REQ_15\n**Title:** Agent Documentation\nSee docs/agents.md.'),
            searchToolMessage('agents'),
            readToolMessage('docs/agents.md', { truncated: true, filePath: 'docs/agents.md' }),
        ];

        await guardrail.processInputStep({ messageList: fakeMessageList(messages), stepNumber: 1, systemMessages: [] } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.4
**Verdict:** PARTIAL
**Justification:** Still missing some data after re-read.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 1, fakeMessageList(messages)); // retryCount === maxRetries
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'retry limit reached -> accept despite truncation');
    });
});
