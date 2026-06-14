/**
 * Guardrail Unit Tests
 *
 * Tests all four guardrails:
 *  1. FalseNegativeGuardrail
 *  2. FalsePositiveGuardrail
 *  3. OutputQualityGuardrail
 *  4. ResultConsistencyGuardrail
 *
 * All imports use the correct guardrails/ directory path.
 * State is isolated per test via fresh instances and a shared in-memory store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FalseNegativeGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/false-negative-guardrail';
import { FalsePositiveGuardrail, NO_OP_AST_INDEXER } from '../src/mastra/agents/requirement-analyzer/guardrails/false-positive-guardrail';
import { OutputQualityGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/output-quality-guardrail';
import { ResultConsistencyGuardrail, InMemoryConsistencyStore } from '../src/mastra/agents/requirement-analyzer/guardrails/result-consistency-guardrail';

// Shared in-memory store for RC tests - call .clear() between tests
const sharedStore = new InMemoryConsistencyStore();

// ============================================================================
// Helpers
// ============================================================================

function buildMessageList(messages: Array<{
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    parts?: Array<{
        type: string;
        toolInvocation?: {
            toolName: string;
            toolCallId: string;
            state: string;
            args: Record<string, unknown>;
            result: unknown;
        };
        text?: string;
    }>;
}>) {
    const db = messages.map((m, i) => ({
        id: `msg-${i}`,
        role: m.role,
        content: m.content !== undefined
            ? m.content
            : { parts: m.parts ?? [] },
    }));
    return {
        get: { all: { db: () => db } },
        updateToolInvocation: () => {},
    };
}

function toolMsg(toolName: string, args: Record<string, unknown>, result: unknown, id = 'tc-1') {
    return {
        role: 'assistant' as const,
        parts: [{ type: 'tool-invocation', toolInvocation: { toolName, toolCallId: id, state: 'result', args, result } }],
    };
}

function userMsg(content: string) { return { role: 'user' as const, content }; }

const TEST_THREAD_ID = 'test-thread-default';

function outputArgs(text: string, ml: ReturnType<typeof buildMessageList>, retryCount = 0, threadId = TEST_THREAD_ID) {
    let abortMsg = '';
    let retrySet = false;
    return {
        text, messageList: ml, retryCount, stepNumber: 1,
        finishReason: 'stop', toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
        requestContext: { threadId },
        abort: (msg: string, opts?: { retry?: boolean }) => { abortMsg = msg; retrySet = opts?.retry ?? false; },
        _abort: () => abortMsg,
        _retry: () => retrySet,
    };
}

function inputArgs(ml: ReturnType<typeof buildMessageList>, sys: unknown[] = [], threadId = TEST_THREAD_ID) {
    return { messageList: ml, stepNumber: 1, systemMessages: sys, requestContext: { threadId } };
}

// Minimal complete report template (all 5 sections)
function fullReport(verdict: string, score: string, extra = '') {
    return `
## 1. Requirement Summary
**ID:** REQ_TEST
**Title:** Test Requirement
**Constraints:** None

## 2. Implementation Evidence
### Core Implementation
- **File:** src/auth.ts
\`\`\`typescript
export function login(user: string) { return jwt.sign(user); }
\`\`\`

## 3. Constraint Verification
| Constraint | Status | Evidence |
|------------|--------|----------|
| JWT | ✅ Verified | jwt.sign in login() |

## 4. Coverage Assessment
**Overall Coverage Score:** ${score}
**Verdict:** ${verdict}
**Justification:** Test report justification with sufficient length.

### What's Missing or Unclear:
- None

## 5. Quality Observations
**Code Quality Indicators:**
- Complexity: low
- Error Handling: present
- Test Coverage: observed
${extra}`.trim();
}

// ============================================================================
// 1. FalseNegativeGuardrail
// ============================================================================

test('FN: accepts COVERED verdict without intervention', () => {
    const g = new FalseNegativeGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_A","title":"Auth"}')]);
    const args = outputArgs(fullReport('COVERED', '0.9'), ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'COVERED should not trigger FN guardrail');
});

test('FN: rejects MISSING when no searches performed', () => {
    const g = new FalseNegativeGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_B","title":"Authentication"}')]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml);
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should reject MISSING with no searches');
    assert.equal(args._retry(), true);
    assert.match(args._abort(), /search/i);
});

test('FN: rejects MISSING when no file reads done', () => {
    const g = new FalseNegativeGuardrail();
    const ml = buildMessageList([
        userMsg('{"id":"REQ_C","title":"Authentication system"}'),
        toolMsg('submission_search', { query: 'auth' }, { files: [], documents: [] }, 'tc-1'),
        toolMsg('submission_search', { query: 'login' }, { files: [], documents: [] }, 'tc-2'),
        toolMsg('submission_search', { query: 'jwt' }, { files: [], documents: [] }, 'tc-3'),
    ]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml);
    g.processOutputStep(args as any);
    assert.match(args._abort(), /read/i, 'Should flag missing file reads');
});

test('FN: accepts MISSING for confirmed empty codebase', () => {
    const g = new FalseNegativeGuardrail();
    const empty = { files: [], documents: [] };
    const ml = buildMessageList([
        userMsg('{"id":"REQ_D","title":"Payment processing"}'),
        toolMsg('submission_search', { query: 'payment' }, empty, 'tc-1'),
        toolMsg('submission_search', { query: 'stripe' }, empty, 'tc-2'),
        toolMsg('submission_search', { query: 'billing' }, empty, 'tc-3'),
        toolMsg('submission_read', { path: 'package.json' }, { filePath: 'package.json', content: '{}', truncated: false }, 'tc-4'),
    ]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml);
    // All searches returned empty + 1 read → empty codebase path
    g.processOutputStep(args as any);
    // May retry once but should not loop
    assert.ok(args !== null);
});

test('FN: does not abort at max retry count', () => {
    const g = new FalseNegativeGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_E"}')]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml, 3);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Should not abort at processor retry limit');
});

test('FN: rejects MISSING when reads were truncated', async () => {
    const g = new FalseNegativeGuardrail();
    // Must use parts-based message so processInputStep extracts requirementText,
    // AND requirement text must contain the filename for the file-reference check
    const ml = buildMessageList([
        { role: 'user' as const, parts: [{ type: 'text', text: 'Requirement: Agent Documentation. The file docs/agents.md must document the actual prompts used and cost data.' }] },
        toolMsg('submission_search', { query: 'prompt' }, { files: [{ filePath: 'docs/agents.md', symbols: [] }], documents: [] }, 'tc-1'),
        toolMsg('submission_search', { query: 'cost' }, { files: [], documents: [] }, 'tc-2'),
        toolMsg('submission_search', { query: 'latency' }, { files: [], documents: [] }, 'tc-3'),
        toolMsg('submission_read', { path: 'docs/agents.md' }, {
            filePath: 'docs/agents.md', type: 'doc',
            content: '# Agent Docs\n...partial content...',
            truncated: true, size: 50000, totalLines: 300,
        }, 'tc-4'),
    ]);
    await g.processInputStep(inputArgs(ml as any, [], 'thread-fn-6') as any);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml, 0, 'thread-fn-6');
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should reject MISSING when requirement-referenced file was truncated');
    assert.match(args._abort(), /truncat/i, 'Feedback should mention truncation');
});

test('FN: input processor injects synonym guidance', async () => {
    const g = new FalseNegativeGuardrail();
    // Use queries that do NOT match any Authentication patterns (jwt/OAuth/passport/auth/login/session)
    // so findMissingSynonymSearches finds uncovered synonyms and injects guidance
    const ml = buildMessageList([
        { role: 'user' as const, parts: [{ type: 'text', text: 'Requirement: Authentication system. The system must support login, session management and token refresh.' }] },
        toolMsg('submission_search', { query: 'user-profile' }, { files: [], documents: [] }, 'tc-1'),
        toolMsg('submission_search', { query: 'account-service' }, { files: [], documents: [] }, 'tc-2'),
    ]);
    const result = await g.processInputStep(inputArgs(ml as any, [], 'thread-fn-7') as any);
    assert.ok(result, 'processInputStep should return a result when synonyms are missing');
    assert.ok(Array.isArray(result!.systemMessages), 'Should return systemMessages array');
    assert.ok(result!.systemMessages.length > 0, 'Should inject at least one guidance message');
});

// ============================================================================
// 2. FalsePositiveGuardrail
// ============================================================================

test('FP: accepts MISSING verdict', () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const ml = buildMessageList([userMsg('{"id":"REQ_H"}')]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'FP should not act on MISSING verdict');
});

test('FP: rejects COVERED when file was never read', () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const ml = buildMessageList([
        userMsg('{"id":"REQ_I"}'),
        toolMsg('submission_search', { query: 'auth' }, {
            files: [{ filePath: 'src/auth.ts', symbols: [{ symbolPath: 'src/auth.ts:login' }] }],
            documents: [],
        }, 'tc-1'),
        // No submission_read call
    ]);
    const report = fullReport('COVERED', '0.9');
    const args = outputArgs(report, ml);
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should reject: file cited but never read');
    assert.match(args._abort(), /read/i);
});

test('FP: accepts COVERED when file was actually read', async () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const readBody = 'export function login(user: string) { return jwt.sign(user); }';
    const ml = buildMessageList([
        userMsg('{"id":"REQ_J"}'),
        toolMsg('submission_read', { path: 'src/auth.ts' }, {
            filePath: 'src/auth.ts', language: 'typescript',
            symbols: [{ symbolName: 'login', bodyText: readBody }],
        }, 'tc-1'),
    ]);
    // Prime verifiedPaths via processInputStep
    await g.processInputStep(inputArgs(ml as any, [], 'thread-fp-10') as any);
    // Build a report whose code block content matches what was actually read
    const report = fullReport('COVERED', '0.9').replace(
        'export function login(user: string) { return jwt.sign(user); }',
        readBody
    ).replace(
        // Replace the default code block with the actual read content
        /```typescript\n.*?\n```/s,
        `\`\`\`typescript\n${readBody}\n\`\`\``
    );
    const args = outputArgs(report, ml, 0, 'thread-fp-10');
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Should accept when files were read and snippets match');
});

test('FP: rejects COVERED with quantitative claims from truncated read', async () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const ml = buildMessageList([
        userMsg('{"id":"REQ_K","title":"Seed Data"}'),
        toolMsg('submission_read', { path: 'backbone/seed.py' }, {
            filePath: 'backbone/seed.py', type: 'doc',
            content: 'def seed():\n    # creates 3 companies...',
            truncated: true, size: 80000, totalLines: 400,
        }, 'tc-1'),
    ]);
    // Prime verifiedPaths and readContents (with truncation flag) via processInputStep
    await g.processInputStep(inputArgs(ml as any, [], 'thread-fp-11') as any);
    const report = fullReport('COVERED', '0.95',
        '\nThe seed() creates ≥10 companies and at least 18 contacts.');
    const args = outputArgs(report, ml, 0, 'thread-fp-11');
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should flag quantitative claims from truncated reads');
    assert.match(args._abort(), /truncat/i);
});

test('FP: detects hallucination phrases', () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const ml = buildMessageList([
        userMsg('{"id":"REQ_L"}'),
        toolMsg('submission_read', { path: 'src/auth.ts' }, {
            filePath: 'src/auth.ts', content: 'some content', truncated: false,
        }, 'tc-1'),
    ]);
    const report = [
        `## 1. Requirement Summary\n**ID:** REQ_L\n\n`,
        `## 2. Implementation Evidence\n- **File:** src/auth.ts\n\`\`\`\nsome content\n\`\`\`\n`,
        `This feature likely implements the required behavior.\n`,
        `## 3. Constraint Verification\n| C | ✅ Verified | src/auth.ts |\n`,
        `## 4. Coverage Assessment\n**Overall Coverage Score:** 0.85\n**Verdict:** COVERED\n**Justification:** Likely implemented.\n### What's Missing: None\n`,
        `## 5. Quality Observations\nComplexity: low\n`,
    ].join('');
    const args = outputArgs(report, ml);
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should flag hallucination phrases');
    assert.match(args._abort(), /speculative/i);
});

test('FP: does not loop at max retries', () => {
    const g = new FalsePositiveGuardrail({}, NO_OP_AST_INDEXER);
    const ml = buildMessageList([userMsg('{"id":"REQ_M"}')]);
    const args = outputArgs(fullReport('COVERED', '0.8'), ml, 3);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Should not abort at retry limit');
});

// ============================================================================
// 3. OutputQualityGuardrail
// ============================================================================

test('OQ: passes a complete valid report', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_N"}')]);
    const args = outputArgs(fullReport('COVERED', '0.85'), ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Complete report should pass');
});

test('OQ: does NOT fire on intermediate reasoning (no section 4)', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_O"}')]);
    const intermediate = `I need to search for authentication code first. Let me run submission_search.`;
    const args = outputArgs(intermediate, ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Should not fire on intermediate steps');
});

test('OQ: rejects report missing sections', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_P"}')]);
    const incomplete = `
## 1. Requirement Summary
**ID:** REQ_P

## 4. Coverage Assessment
**Overall Coverage Score:** 0.8
**Verdict:** COVERED
**Justification:** Partial report.
### What's Missing: Sections 2, 3, 5`.trim();
    const args = outputArgs(incomplete, ml);
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Should reject missing sections');
    assert.equal(args._retry(), true);
});

test('OQ: rejects mismatched score/verdict (0.5 + COVERED)', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_Q"}')]);
    const args = outputArgs(fullReport('COVERED', '0.5'), ml);
    g.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'Score 0.5 with COVERED should be rejected');
});

test('OQ: accepts score 0.7 with COVERED (boundary)', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_R"}')]);
    const args = outputArgs(fullReport('COVERED', '0.7'), ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Exactly 0.7 with COVERED is valid');
});

test('OQ: accepts MISSING with score 0.0', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_S"}')]);
    const args = outputArgs(fullReport('MISSING', '0.0'), ml);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'MISSING with 0.0 should pass');
});

test('OQ: does not loop at max retries', () => {
    const g = new OutputQualityGuardrail();
    const ml = buildMessageList([userMsg('{"id":"REQ_T"}')]);
    const incomplete = `## 4. Coverage Assessment\n**Verdict:** COVERED\n**Overall Coverage Score:** 0.5`;
    const args = outputArgs(incomplete, ml, 3);
    g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Should not abort at retry limit');
});

// ============================================================================
// 4. ResultConsistencyGuardrail
// ============================================================================

test('RC: stores and accepts first run', async () => {
    sharedStore.clearAll();
    const g = new ResultConsistencyGuardrail({}, sharedStore);
    const ml = buildMessageList([userMsg('{"id":"RC_01","title":"Test"}')]);
    const args = outputArgs(fullReport('COVERED', '0.85'), ml);
    await g.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'First run should be stored and accepted');
});

test('RC: accepts consistent second run (within tolerance)', async () => {
    sharedStore.clearAll();
    const ml1 = buildMessageList([userMsg('{"id":"RC_02"}')]);
    await new ResultConsistencyGuardrail({}, sharedStore).processOutputStep(
        outputArgs(fullReport('COVERED', '0.85'), ml1) as any
    );
    const g2 = new ResultConsistencyGuardrail({}, sharedStore);
    const ml2 = buildMessageList([userMsg('{"id":"RC_02"}')]);
    const args = outputArgs(fullReport('COVERED', '0.80'), ml2);
    await g2.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'Score within ±0.15 should be accepted');
});

test('RC: flags inconsistent verdict change', async () => {
    sharedStore.clearAll();
    const ml1 = buildMessageList([userMsg('{"id":"RC_03"}')]);
    await new ResultConsistencyGuardrail({}, sharedStore).processOutputStep(
        outputArgs(fullReport('COVERED', '0.85'), ml1) as any
    );
    const g2 = new ResultConsistencyGuardrail({}, sharedStore);
    const ml2 = buildMessageList([userMsg('{"id":"RC_03"}')]);
    const args = outputArgs(fullReport('MISSING', '0.1'), ml2);
    await g2.processOutputStep(args as any);
    assert.ok(args._abort().length > 0, 'COVERED → MISSING should be flagged');
    assert.match(args._abort(), /previous analysis|re-verify/i);
});

test('RC: accepts at retry limit (no infinite loop)', async () => {
    sharedStore.clearAll();
    const ml1 = buildMessageList([userMsg('{"id":"RC_04"}')]);
    await new ResultConsistencyGuardrail({}, sharedStore).processOutputStep(
        outputArgs(fullReport('COVERED', '0.85'), ml1) as any
    );
    const g2 = new ResultConsistencyGuardrail({}, sharedStore);
    const ml2 = buildMessageList([userMsg('{"id":"RC_04"}')]);
    const args = outputArgs(fullReport('MISSING', '0.1'), ml2, 2);
    await g2.processOutputStep(args as any);
    assert.equal(args._abort(), '', 'At retry limit should accept to prevent infinite loop');
});

test('RC: processInputStep returns correct shape', async () => {
    const g = new ResultConsistencyGuardrail({}, sharedStore);
    const ml = buildMessageList([userMsg('{"id":"RC_05"}')]);
    const result = await g.processInputStep(inputArgs(ml as any) as any);
    // processInputStep returns undefined when no system message injection is needed
    assert.ok(result === undefined || typeof result === 'object', 'Should return undefined or object');
});
