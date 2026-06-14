import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OutputQualityGuardrail } from '../src/mastra/agents/requirement-analyzer/guardrails/output-quality-guardrail';

function fakeMessageList(userMessageText?: string) {
    const messages = userMessageText
        ? [{ role: 'user', content: { parts: [{ type: 'text', text: userMessageText }] } }]
        : [];
    return { get: { all: { db: () => messages } } } as never;
}

function fakeOutputArgs(text: string, retryCount: number, opts: { userMessageText?: string; threadId?: string } = {}) {
    let aborted: { reason: string; opts: unknown } | null = null;
    return {
        args: {
            text,
            retryCount,
            stepNumber: 1,
            finishReason: 'stop',
            usage: {},
            toolCalls: [],
            messageList: fakeMessageList(opts.userMessageText),
            requestContext: opts.threadId ? { threadId: opts.threadId } : undefined,
            abort: (reason: string, opts2: unknown) => { aborted = { reason, opts: opts2 }; },
        },
        getAborted: () => aborted,
    };
}

/** A requirement message declaring N constraints via [CON_XX] markers. */
function requirementMessageWithConstraints(n: number): string {
    const constraints = Array.from({ length: n }, (_, i) => `[CON_${i + 1}] Constraint number ${i + 1}.`).join('\n');
    return `Analyze this requirement.\n### Constraints to Verify\n${constraints}`;
}

/** A valid report with a constraint table containing exactly `rows` rows. */
function reportWithConstraintRows(rows: number): string {
    const tableRows = Array.from({ length: rows }, (_, i) => `| Constraint ${i + 1} | ✅ Verified | evidence ${i + 1} |`).join('\n');
    return `# Requirement Analysis Report

## 1. Requirement Summary
**ID:** REQ_X
**Title:** Test
**Constraints:** see table

## 2. Implementation Evidence
### Core Implementation
- **File:** \`src/feature.ts\`
- **Symbol:** doThing
- **How it covers the requirement:** Implements the feature.

## 3. Constraint Verification

| Constraint | Status | Evidence |
|------------|--------|----------|
${tableRows}

## 4. Coverage Assessment
**Overall Coverage Score:** 0.9
**Verdict:** COVERED
**Justification:** All constraints are satisfied by the implementation.

## 5. Quality Observations
**Code Quality Indicators:**
- Complexity: low
- Error Handling: present
- Test Coverage: observed
`;
}

const VALID_REPORT = `# Requirement **ID:** REQ_1 -Analysis Report

## 1. Requirement Summary

**ID:** REQ_1

**Title:** Authentication

**Constraints:**
- [CONSTR_1_1] Must use JWT.

## 2. Implementation Evidence

### Core Implementation
- **File:** \`src/auth/session.ts\`
- **Symbol:** createSession
- **How it covers the requirement:** Creates a signed JWT session token.

### Dependencies & Integrations
- jsonwebtoken

## 3. Constraint Verification

| Constraint | Status | Evidence |
|------------|--------|----------|
| Must use JWT | ✅ Verified | src/auth/session.ts uses jsonwebtoken.sign |

## 4. Coverage Assessment

**Overall Coverage Score:** 0.9

**Verdict:** COVERED

**Justification:**
The session module signs JWTs as required by the constraint.

### What's Missing or Unclear:
- None identified

## 5. Quality Observations

**Code Quality Indicators:**
- Complexity: low - simple function
- Error Handling: present - try/catch around sign
- Test Coverage: not observed

**Potential Concerns:**
- No concerns identified`;

describe('OutputQualityGuardrail', () => {
    test('accepts a fully-formed report', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 1);
        const { args, getAborted } = fakeOutputArgs(VALID_REPORT, 0);
        guardrail.processOutputStep(args as never);
        assert.equal(getAborted(), null);
    });

    test('rejects report missing the Constraint Verification section', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 1);
        const broken = VALID_REPORT.replace(/## 3\. Constraint Verification[\s\S]*?(?=## 4\.)/, '');
        const { args, getAborted } = fakeOutputArgs(broken, 0);
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted);
        assert.match(aborted!.reason, /Constraint Verification/);
    });

    test('rejects report with verdict/score mismatch', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 1);
        const broken = VALID_REPORT.replace('**Overall Coverage Score:** 0.9', '**Overall Coverage Score:** 0.2');
        const { args, getAborted } = fakeOutputArgs(broken, 0);
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted);
        assert.match(aborted!.reason, /inconsistent with Coverage Score/);
    });

    test('rejects report missing a verdict entirely', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 1);
        const broken = VALID_REPORT.replace('**Verdict:** COVERED', '**Verdict:**');
        const { args, getAborted } = fakeOutputArgs(broken, 0);
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted);
        assert.match(aborted!.reason, /No valid Verdict/);
    });

    test('rejects when constraint table has fewer rows than expected constraints', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 2); // expects 2 constraints, report has 1
        const { args, getAborted } = fakeOutputArgs(VALID_REPORT, 0);
        guardrail.processOutputStep(args as never);

        const aborted = getAborted();
        assert.ok(aborted);
        assert.match(aborted!.reason, /1 row\(s\) but the requirement defines 2/);
    });

    test('accepts at retry limit even with issues', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 1 }, 1);
        const broken = VALID_REPORT.replace('**Verdict:** COVERED', '**Verdict:**');
        const { args, getAborted } = fakeOutputArgs(broken, 1);
        guardrail.processOutputStep(args as never);
        assert.equal(getAborted(), null);
    });

    test('parseReportFields extracts structured fields from a valid report', () => {
        const fields = OutputQualityGuardrail.parseReportFields(VALID_REPORT);
        assert.ok(fields);
        assert.equal(fields!.verdict, 'COVERED');
        assert.equal(fields!.coverageScore, 0.9);
        assert.equal(fields!.requirementId, 'REQ_1');
        assert.equal(fields!.constraintRows.length, 1);
        assert.equal(fields!.constraintRows[0].status, 'verified');
    });

    test('parseReportFields returns null for non-report text', () => {
        const fields = OutputQualityGuardrail.parseReportFields('I am still thinking about this requirement...');
        assert.equal(fields, null);
    });

    test('ignores intermediate (non-final-report) text entirely', () => {
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 }, 1);
        const { args, getAborted } = fakeOutputArgs('Let me search for the authentication implementation first.', 0);
        guardrail.processOutputStep(args as never);
        assert.equal(getAborted(), null);
    });

    // ------------------------------------------------------------------
    // Cross-thread isolation of expectedConstraintCount.
    //
    // The agent registers ONE guardrail instance at module load and reuses
    // it across every requirement thread for the server's lifetime. If the
    // dynamically-derived constraint count were stored as a plain instance
    // field (the original implementation), the FIRST requirement's count
    // would "stick" for every subsequent requirement - silently breaking
    // the "Constraint Verification" row-count check for thread B onward,
    // and violating the "one requirement per agent thread" isolation
    // guarantee. This test proves the fix: each threadId gets its own
    // expected-constraint-count derived from ITS OWN requirement message.
    // ------------------------------------------------------------------

    test('expectedConstraintCount does not leak across threads on a shared guardrail instance', () => {
        // ONE shared instance, as agent.ts does (module-level singleton).
        const guardrail = new OutputQualityGuardrail({ maxRetries: 2 });

        // --- Thread A: requirement with 3 constraints, report has all 3 rows ---
        const reqA = requirementMessageWithConstraints(3);
        const reportA = reportWithConstraintRows(3);
        const { args: argsA, getAborted: abortedA } = fakeOutputArgs(reportA, 0, {
            userMessageText: reqA,
            threadId: 'thread-A',
        });
        guardrail.processOutputStep(argsA as never);
        assert.equal(abortedA(), null, 'Thread A: 3 constraints / 3 rows should pass');

        // --- Thread B: DIFFERENT requirement with 1 constraint, report has 1 row ---
        // With the old buggy implementation, this.expectedConstraintCount would
        // already be locked at 3 from thread A, and thread B's 1-row report
        // would be incorrectly rejected for "too few constraint rows".
        const reqB = requirementMessageWithConstraints(1);
        const reportB = reportWithConstraintRows(1);
        const { args: argsB, getAborted: abortedB } = fakeOutputArgs(reportB, 0, {
            userMessageText: reqB,
            threadId: 'thread-B',
        });
        guardrail.processOutputStep(argsB as never);
        assert.equal(abortedB(), null, 'Thread B: 1 constraint / 1 row should pass independently of thread A');

        // --- Thread A again: a SECOND report for thread A with only 1 row ---
        // should now correctly be REJECTED for missing 2 constraint rows,
        // proving thread A's own count (3) is still tracked correctly and
        // wasn't overwritten by thread B's count (1).
        const reportA_incomplete = reportWithConstraintRows(1);
        const { args: argsA2, getAborted: abortedA2 } = fakeOutputArgs(reportA_incomplete, 0, {
            userMessageText: reqA,
            threadId: 'thread-A',
        });
        guardrail.processOutputStep(argsA2 as never);
        const aborted = abortedA2();
        assert.ok(aborted, 'Thread A retry: 1 row but 3 constraints expected should be rejected');
        assert.match(aborted!.reason, /3 constraint/);
    });
});
