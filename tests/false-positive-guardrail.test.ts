import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FalsePositiveGuardrail, NO_OP_AST_INDEXER } from '../src/mastra/agents/requirement-analyzer/guardrails/false-positive-guardrail';

function fakeMessageList(messages: unknown[]) {
    return {
        get: {
            all: {
                db: () => messages,
            },
        },
    } as never;
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
                    result: { filePath, type: 'file', size: content.length, totalLines: content.split('\n').length, content, truncated: false },
                },
            }],
        },
    };
}

function readSymbolMessage(symbolPath: string, bodyText: string) {
    return {
        role: 'assistant',
        content: {
            parts: [{
                type: 'tool-invocation',
                toolInvocation: {
                    toolCallId: `read-${symbolPath}`,
                    toolName: 'submission_read',
                    state: 'result',
                    args: { path: symbolPath },
                    result: { symbolPath, symbol: { bodyText, kind: 'function' } },
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

describe('FalsePositiveGuardrail', () => {
    test('rejects COVERED report citing a file that was never read', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, NO_OP_AST_INDEXER);

        const messages: unknown[] = []; // nothing read
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/auth/session.ts\`
- **Symbol:** createSession
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Session creation is implemented in src/auth/session.ts.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should abort - file never read');
        assert.match(aborted!.reason, /src\/auth\/session\.ts/);
    });

    test('accepts COVERED report citing a file that WAS read', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, NO_OP_AST_INDEXER);

        const messages = [
            readSymbolMessage('src/auth/session.ts:createSession', 'export function createSession(userId: string) { return { token: sign(userId) }; }'),
        ];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/auth/session.ts\`
- **Symbol:** createSession
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Session creation is implemented in src/auth/session.ts:createSession.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'should accept - file was read');
    });

    test('rejects COVERED verdict with zero reads at all', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, NO_OP_AST_INDEXER);

        const messages: unknown[] = [];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.85
**Verdict:** COVERED
**Justification:** Looks implemented based on file names.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted, 'should abort - no reads performed for COVERED verdict');
    });

    test('does not block MISSING verdicts (handled by false-negative guardrail)', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, NO_OP_AST_INDEXER);

        const messages: unknown[] = [];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 4. Coverage Assessment
**Overall Coverage Score:** 0.1
**Verdict:** MISSING
**Justification:** No evidence found.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null);
    });

    test('accepts at retry limit even with unverified path (logs warning)', async () => {
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 1 }, NO_OP_AST_INDEXER);

        const messages: unknown[] = [];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
- **File:** \`src/missing.ts\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.8
**Verdict:** COVERED
**Justification:** implemented`;

        const { args, getAborted } = fakeOutputArgs(reportText, 1, fakeMessageList(messages));
        guardrail.processOutputStep(args as never);

        assert.equal(getAborted(), null, 'retry limit reached -> accept');
    });

    // ------------------------------------------------------------------
    // AST symbol validation (blocking) — challenge requires "AST symbol
    // references must match indexed data from astIndexerService"
    // ------------------------------------------------------------------

    test('rejects COVERED when cited path:symbol reference is NOT in the AST index', async () => {
        // Inject a fake AST indexer whose store has the FILE indexed but
        // WITHOUT the claimed symbol — simulating a hallucinated/renamed symbol.
        const fakeIndexer = async () => ({
            getStore: () => ({
                getSymbolsForFile: (filePath: string) =>
                    filePath === 'src/auth/session.ts'
                        ? [{ name: 'destroySession' }, { name: 'refreshToken' }]
                        : [],
            }),
        });
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, fakeIndexer);

        const messages = [
            readSymbolMessage('src/auth/session.ts:createSession', 'export function createSession(userId: string) { return { token: sign(userId) }; }'),
        ];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        // Report cites a path:symbol reference inline that does NOT exist in the AST index
        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/auth/session.ts\`
- Symbol reference: \`src/auth/session.ts:createSession\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Session creation is implemented in src/auth/session.ts:createSession.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        const result = guardrail.processOutputStep(args as never);
        await result; // AST check is async — must await before inspecting abort

        const aborted = getAborted();
        assert.ok(aborted, 'should abort - cited symbol not found in AST index');
        assert.match(aborted!.reason, /createSession/);
        assert.match(aborted!.reason, /AST index/i);
    });

    test('accepts COVERED when cited path:symbol reference IS in the AST index', async () => {
        const fakeIndexer = async () => ({
            getStore: () => ({
                getSymbolsForFile: (filePath: string) =>
                    filePath === 'src/auth/session.ts'
                        ? [{ name: 'createSession' }, { name: 'destroySession' }]
                        : [],
            }),
        });
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, fakeIndexer);

        const messages = [
            readSymbolMessage('src/auth/session.ts:createSession', 'export function createSession(userId: string) { return { token: sign(userId) }; }'),
        ];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/auth/session.ts\`
- Symbol reference: \`src/auth/session.ts:createSession\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Session creation is implemented in src/auth/session.ts:createSession.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        const result = guardrail.processOutputStep(args as never);
        await result;

        assert.equal(getAborted(), null, 'should accept - cited symbol exists in AST index');
    });

    test('does not block when AST indexer is unavailable (infra failure)', async () => {
        // Simulate the real lazy-import failing (e.g. workspace not initialized)
        const failingIndexer = async () => { throw new Error('workspace not available'); };
        const guardrail = new FalsePositiveGuardrail({ maxRetries: 2 }, failingIndexer);

        const messages = [
            readSymbolMessage('src/auth/session.ts:createSession', 'export function createSession(userId: string) { return { token: sign(userId) }; }'),
        ];
        await guardrail.processInputStep({ messageList: fakeMessageList(messages) } as never);

        const reportText = `# Requirement Analysis Report
## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/auth/session.ts\`
- Symbol reference: \`src/auth/session.ts:createSession\`
## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** Session creation is implemented in src/auth/session.ts:createSession.`;

        const { args, getAborted } = fakeOutputArgs(reportText, 0, fakeMessageList(messages));
        const result = guardrail.processOutputStep(args as never);
        await result;

        assert.equal(getAborted(), null, 'AST infra failure should not block the verdict');
    });
});
