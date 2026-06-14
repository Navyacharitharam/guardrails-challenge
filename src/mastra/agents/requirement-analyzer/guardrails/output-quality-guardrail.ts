/**
 * Output Quality Verification Guardrail
 *
 * Validates the agent's FINAL report against the REQUIRED template defined
 * in instructions-output.ts (REQUIREMENT_ANALYZER_OUTPUT), and against a
 * zod schema for the structurally-extractable fields (verdict, score,
 * constraints table). On failure, aborts with retry feedback that lists the
 * exact missing sections / fields and a suggested fix.
 *
 * This processor is additive to (not a replacement for) OutputQualityProcessor:
 * - OutputQualityProcessor: catches EMPTY responses (no text, no tool calls).
 * - OutputQualityGuardrail (this): catches NON-EMPTY but STRUCTURALLY INVALID
 *   final reports (missing sections, no verdict, no constraints table, score
 *   out of range, score/verdict mismatch).
 *
 * Only runs validation on text that "looks like" a final report attempt
 * (i.e. contains the report header or a Verdict line) - intermediate
 * planning/reasoning text from earlier steps is left untouched.
 */

import type {
    ProcessOutputStepArgs,
    ProcessInputStepArgs,
    Processor,
    ProcessorMessageResult,
} from '@mastra/core/processors';
import { z } from 'zod';
import { tcAILogger } from '../../../../utils/logger';
import { RunStateStore, getRunKey } from './run-state';

// ============================================================================
// Config
// ============================================================================

export interface OutputQualityGuardrailConfig {
    /** Required top-level sections (## headers) from the template. */
    requiredSections: string[];
    /** Minimum number of constraint-verification rows expected (0 = skip check). */
    minConstraintRows: number;
    /** Max retries for structural-validation feedback loops. */
    maxRetries: number;
}

const DEFAULT_REQUIRED_SECTIONS = [
    '1. Requirement Summary',
    '2. Implementation Evidence',
    '3. Constraint Verification',
    '4. Coverage Assessment',
    '5. Quality Observations',
];

const DEFAULT_CONFIG: OutputQualityGuardrailConfig = {
    requiredSections: DEFAULT_REQUIRED_SECTIONS,
    minConstraintRows: 0, // dynamically derived from the requirement when possible
    maxRetries: 2,
};

// ============================================================================
// Output schema - the structurally-extractable parts of the report
// ============================================================================

export const reportFieldsSchema = z.object({
    requirementId: z.string().min(1),
    title: z.string().min(1),
    verdict: z.enum(['COVERED', 'PARTIAL', 'MISSING']),
    coverageScore: z.number().min(0).max(1),
    constraintRows: z.array(z.object({
        constraint: z.string(),
        status: z.enum(['verified', 'partial', 'not-found']),
        evidence: z.string(),
    })),
    justification: z.string().min(10),
});

export type ReportFields = z.infer<typeof reportFieldsSchema>;

// ============================================================================
// Extraction helpers
// ============================================================================

function looksLikeFinalReport(text: string): boolean {
    return /#\s*Requirement.*Analysis Report/i.test(text)
        || /##\s*4\.\s*Coverage Assessment/i.test(text)
        || /\*\*?Verdict:?\*\*?/i.test(text);
}

function extractSectionsPresent(text: string, requiredSections: string[]): { present: string[]; missing: string[] } {
    const present: string[] = [];
    const missing: string[] = [];

    for (const section of requiredSections) {
        // Match "## 1. Requirement Summary" or "## Requirement Summary" etc.
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`##\\s*${escaped}`, 'i');
        // Also try matching just the descriptive part without the number prefix
        const descPart = section.replace(/^\d+\.\s*/, '');
        const escapedDesc = descPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reDesc = new RegExp(`##\\s*(?:\\d+\\.\\s*)?${escapedDesc}`, 'i');

        if (re.test(text) || reDesc.test(text)) {
            present.push(section);
        } else {
            missing.push(section);
        }
    }

    return { present, missing };
}

/**
 * Check whether a section that IS present has meaningful (non-placeholder) content.
 * Placeholder content is e.g. "[Describe the main code...]" left unfilled,
 * or a section that's immediately followed by the next "##" with nothing in between.
 */
function sectionHasContent(text: string, sectionHeaderFragment: string): boolean {
    const escaped = sectionHeaderFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`##\\s*(?:\\d+\\.\\s*)?${escaped}([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
    const m = text.match(re);
    if (!m) return false;
    const body = m[1].trim();
    if (body.length < 5) return false;
    // Detect unfilled template placeholders like "[Describe the main code...]"
    const placeholderOnly = /^\[[^\]]*\]$/.test(body) || /^[\s\-*\[\]A-Za-z]*\[.*\]\s*$/.test(body.split('\n')[0] || '');
    return !placeholderOnly || body.length > 60; // long body likely has real content even with bracket text
}

function extractVerdict(text: string): 'COVERED' | 'PARTIAL' | 'MISSING' | null {
    const m = text.match(/\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING)/i);
    if (!m) return null;
    return m[1].toUpperCase() as 'COVERED' | 'PARTIAL' | 'MISSING';
}

function extractCoverageScore(text: string): number | null {
    const m = text.match(/\*\*?Overall Coverage Score:?\*\*?\s*([0-9](?:\.[0-9]+)?)/i)
        || text.match(/Coverage Score:?\s*([0-9](?:\.[0-9]+)?)/i);
    if (!m) return null;
    const val = parseFloat(m[1]);
    if (Number.isNaN(val)) return null;
    return val;
}

interface ConstraintRow {
    constraint: string;
    status: 'verified' | 'partial' | 'not-found';
    evidence: string;
}

function extractConstraintRows(text: string): ConstraintRow[] {
    // Find the "## 3. Constraint Verification" section and parse markdown table rows.
    const sectionMatch = text.match(/##\s*(?:\d+\.\s*)?Constraint Verification([\s\S]*?)(?=\n##\s|$)/i);
    if (!sectionMatch) return [];

    const rows: ConstraintRow[] = [];
    const lines = sectionMatch[1].split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Match markdown table data rows: | constraint | status | evidence |
        if (!trimmed.startsWith('|')) continue;
        const cells = trimmed.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
        if (cells.length < 3) continue;

        const [constraint, statusRaw, evidence] = cells;
        // Skip header/separator rows
        if (/^-+$/.test(constraint) || /constraint/i.test(constraint) && /status/i.test(statusRaw)) continue;
        if (!constraint || constraint.toLowerCase() === 'constraint') continue;

        let status: ConstraintRow['status'] = 'not-found';
        if (/✅|verified/i.test(statusRaw)) status = 'verified';
        else if (/⚠️|partial/i.test(statusRaw)) status = 'partial';
        else if (/❌|not found/i.test(statusRaw)) status = 'not-found';

        rows.push({ constraint, status, evidence: evidence || '' });
    }

    return rows;
}

function extractJustification(text: string): string {
    const m = text.match(/\*\*?Justification:?\*\*?\s*\n?([\s\S]*?)(?=\n###|\n##|$)/i);
    return m ? m[1].trim() : '';
}

function extractRequirementId(text: string): string {
    // Match "**ID:** REQ_1" only when it's the whole rest of the line (avoids
    // matching the document title "# Requirement **ID:** [...] -Analysis Report").
    const m = text.match(/^\*\*ID:\*\*\s*([^\n*]+?)\s*$/im);
    return m ? m[1].trim().replace(/[`[\]"]/g, '') : '';
}

function extractTitle(text: string): string {
    const m = text.match(/^\*\*Title:\*\*\s*([^\n*]+?)\s*$/im);
    return m ? m[1].trim() : '';
}

/**
 * Extract the number of constraints from the requirement prompt text.
 * The prompt builder formats constraints as:
 *   "  1. [CON_01] ..."
 *   "  2. [CON_02] ..."
 * We count lines matching this pattern. Falls back to 0 if not found.
 */
function extractConstraintCountFromRequirement(messageList: ProcessInputStepArgs['messageList']): number {
    for (const msg of messageList.get.all.db()) {
        if (msg.role !== 'user') continue;
        let text = '';
        const parts = (msg.content as { parts?: { type: string; text?: string }[] })?.parts;
        if (Array.isArray(parts)) {
            for (const p of parts) {
                if (p.type === 'text' && typeof p.text === 'string') text += p.text;
            }
        } else if (typeof msg.content === 'string') {
            text = msg.content;
        }
        if (!text) continue;

        // Match "### Constraints to Verify" section and count numbered items
        const sectionMatch = text.match(/###\s*Constraints to Verify([\s\S]*?)(?=\n###|\n##|$)/i);
        if (sectionMatch) {
            const lines = sectionMatch[1].split('\n');
            const constraintLines = lines.filter(l => /^\s*\d+\.\s*\[/.test(l));
            if (constraintLines.length > 0) return constraintLines.length;
        }

        // Fallback: count "[CON_XX]" occurrences in constraints section
        const allConstraintIds = (text.match(/\[CON_\w+\]/g) || []);
        if (allConstraintIds.length > 0) return allConstraintIds.length;
    }
    return 0;
}

// ============================================================================
// Processor
// ============================================================================

export class OutputQualityGuardrail implements Processor {
    id = 'output-quality-guardrail';

    private config: OutputQualityGuardrailConfig;

    /**
     * Number of constraints declared in the requirement, keyed by threadId.
     *
     * This guardrail is instantiated ONCE at module load and shared across
     * every requirement thread for the lifetime of the server process (see
     * run-state.ts for why per-thread isolation matters). Storing this as a
     * plain instance field would mean the FIRST requirement's constraint
     * count silently "sticks" for every subsequent requirement with a
     * different number of constraints - this directly undermines the
     * "Constraint Verification" row-count check and violates the
     * "one requirement per agent thread" isolation guarantee.
     *
     * Optional `defaultExpectedConstraintCount` constructor arg is used as a
     * fallback when dynamic extraction from the requirement message fails
     * (e.g. ad-hoc studio chat sessions without a structured requirement JSON).
     */
    private expectedConstraintCounts = new RunStateStore<{ count: number | null }>(() => ({ count: null }));
    private readonly defaultExpectedConstraintCount: number | null;

    constructor(config: Partial<OutputQualityGuardrailConfig> = {}, defaultExpectedConstraintCount: number | null = null) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.defaultExpectedConstraintCount = defaultExpectedConstraintCount;
    }

    processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult {
        const text = args.text?.trim() ?? '';

        if (!looksLikeFinalReport(text)) {
            return args.messageList;
        }

        const retryLimitReached = args.retryCount >= this.config.maxRetries;
        const issues: string[] = [];

        // Dynamically extract expected constraint count from the actual requirement
        // message, scoped to THIS thread so it can't leak into other requirements
        // processed by this same long-lived guardrail instance.
        const threadState = this.expectedConstraintCounts.get(getRunKey(args));
        if (threadState.count === null) {
            const dynamicConstraintCount = extractConstraintCountFromRequirement(
                args.messageList as unknown as ProcessInputStepArgs['messageList']
            );
            threadState.count = dynamicConstraintCount > 0
                ? dynamicConstraintCount
                : this.defaultExpectedConstraintCount;
        }
        const expectedConstraintCount = threadState.count;

        // --------------------------------------------------------------
        // 1. Required sections present + non-empty
        // --------------------------------------------------------------
        const { present, missing } = extractSectionsPresent(text, this.config.requiredSections);

        if (missing.length > 0) {
            issues.push(`Missing required section(s): ${missing.join(', ')}.`);
        }

        for (const section of present) {
            const desc = section.replace(/^\d+\.\s*/, '');
            if (!sectionHasContent(text, desc)) {
                issues.push(`Section "${section}" is present but appears empty or left as a placeholder (e.g. still contains "[...]"). Fill it with real content or "None"/"N/A" as appropriate.`);
            }
        }

        // --------------------------------------------------------------
        // 2. Verdict + score present, valid, and consistent
        // --------------------------------------------------------------
        const verdict = extractVerdict(text);
        const score = extractCoverageScore(text);

        if (!verdict) {
            issues.push('No valid Verdict found. The report must include "**Verdict:** COVERED" / "PARTIAL" / "MISSING" in section 4.');
        }

        if (score === null) {
            issues.push('No valid "Overall Coverage Score" (0.0-1.0) found in section 4.');
        } else if (score < 0 || score > 1) {
            issues.push(`Coverage Score (${score}) is out of the valid 0.0-1.0 range.`);
        }

        if (verdict && score !== null) {
            const expectedRange: [number, number] =
                verdict === 'COVERED' ? [0.7, 1.0]
                    : verdict === 'PARTIAL' ? [0.3, 0.7]
                        : [0.0, 0.3];
            // Allow exact boundary values (0.7, 0.3)
            const [lo, hi] = expectedRange;
            const inRange = verdict === 'PARTIAL' ? (score >= lo && score <= hi) : (score >= lo && score <= hi);
            if (!inRange) {
                issues.push(
                    `Verdict "${verdict}" is inconsistent with Coverage Score ${score}. ` +
                    `Per the guidelines: COVERED >= 0.7, PARTIAL 0.3-0.7, MISSING < 0.3. ` +
                    `Adjust either the verdict or the score so they agree.`
                );
            }
        }

        // --------------------------------------------------------------
        // 3. Justification present and non-trivial
        // --------------------------------------------------------------
        const justification = extractJustification(text);
        if (justification.length < 10 || /^\[.*\]$/.test(justification)) {
            issues.push('The "Justification" under Coverage Assessment is missing or is still a placeholder. Provide 1-2 sentences referencing specific evidence.');
        }

        // --------------------------------------------------------------
        // 4. Constraint verification table present with rows
        // --------------------------------------------------------------
        const constraintRows = extractConstraintRows(text);
        const requiredRows = expectedConstraintCount ?? this.config.minConstraintRows;

        if (constraintRows.length === 0 && requiredRows > 0) {
            issues.push('Section "3. Constraint Verification" has no table rows. Add one row per constraint with Status and Evidence.');
        } else if (requiredRows > 0 && constraintRows.length < requiredRows) {
            issues.push(`Section "3. Constraint Verification" has ${constraintRows.length} row(s) but the requirement defines ${requiredRows} constraint(s). Add a row for each constraint.`);
        }

        // --------------------------------------------------------------
        // 5. Requirement ID / Title present
        // --------------------------------------------------------------
        if (!extractRequirementId(text)) {
            issues.push('Missing "**ID:**" in section 1 (Requirement Summary).');
        }
        if (!extractTitle(text)) {
            issues.push('Missing "**Title:**" in section 1 (Requirement Summary).');
        }

        // --------------------------------------------------------------
        // Decide outcome
        // --------------------------------------------------------------
        if (issues.length === 0) {
            tcAILogger.info(`[${this.id}] Report passed quality validation`, {
                verdict,
                score,
                sectionsPresent: present.length,
                constraintRows: constraintRows.length,
            });
            return args.messageList;
        }

        if (retryLimitReached) {
            tcAILogger.warn(`[${this.id}] Report has quality issues but retry limit reached - accepting as-is`, {
                issues,
                retryCount: args.retryCount,
            });
            return args.messageList;
        }

        const reason = [
            'Your final report does not meet the required output quality standard. Fix the following issue(s) and regenerate the COMPLETE report (do not omit any section):',
            ...issues.map(i => `- ${i}`),
        ].join('\n');

        tcAILogger.warn(`[${this.id}] Report failed quality validation - requesting retry`, {
            issues,
            retryCount: args.retryCount,
        });

        args.abort(reason, { retry: true });

        return args.messageList;
    }

    /**
     * Parse a final report's structurally-extractable fields. Returns null if
     * the text doesn't look like a final report or fails schema validation.
     * Exposed for use by the scoring-distiller / result-consistency guardrail.
     */
    static parseReportFields(text: string): ReportFields | null {
        if (!looksLikeFinalReport(text)) return null;

        const verdict = extractVerdict(text);
        const score = extractCoverageScore(text);
        const requirementId = extractRequirementId(text);
        const title = extractTitle(text);
        const constraintRows = extractConstraintRows(text);
        const justification = extractJustification(text);

        const candidate = {
            requirementId,
            title,
            verdict,
            coverageScore: score,
            constraintRows,
            justification,
        };

        const parsed = reportFieldsSchema.safeParse(candidate);
        return parsed.success ? parsed.data : null;
    }
}
