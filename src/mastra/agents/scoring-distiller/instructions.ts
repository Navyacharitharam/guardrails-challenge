import { z } from 'zod';
import { REQUIREMENT_ANALYZER_OUTPUT } from '../requirement-analyzer/instructions-output';
import { formatSchemaForInstructions } from '../../../utils/formaters/schema-formatter';

/**
 * Constraint verification result schema - enriched with justification
 */
export const ConstraintResultSchema = z.object({
    id: z.string().describe('Constraint ID from the requirement (e.g., "C1", "C2")'),
    text: z.string().describe('Brief constraint description'),
    status: z.enum(['Verified', 'Partial', 'NotFound']).describe('Verification status'),
    evidence: z.string().describe('File:line reference or code evidence proving status'),
});

/**
 * Implementation evidence schema
 */
export const ImplementationEvidenceSchema = z.object({
    file: z.string().describe('File path'),
    symbol: z.string().describe('Function/class/method name'),
    line: z.number().optional().describe('Line number'),
    relevance: z.string().describe('How this proves implementation'),
});

/**
 * Scoring Distiller Output Schema (Zod)
 * Comprehensive structured format for requirement analysis (<1K tokens)
 */
export const ScoringDistillerSchema = z.object({
    // Identification
    requirementId: z.string().describe('Requirement ID from report'),
    title: z.string().describe('Requirement title'),
    priority: z.enum(['high', 'medium', 'low']).describe('Priority level'),

    // Summary & Verdict
    status: z.enum(['Implemented', 'Partial', 'Missing']).describe('Implementation verdict'),
    coverageScore: z.number().min(0).max(1).describe('Coverage score (0.0-1.0)'),
    confidenceScore: z.number().int().min(1).max(5).describe('Confidence in this assessment (1-5)'),

    // Justification & Evidence
    justification: z.string().describe('Why this verdict was given - cite specific evidence'),
    keyEvidence: z.array(ImplementationEvidenceSchema).describe('Top implementation evidence proving the verdict'),

    // Constraints
    constraints: z.array(ConstraintResultSchema).describe('Per-constraint verification with evidence'),

    // Gaps & Feedback
    gapSummary: z.string().describe('What is missing or incomplete'),
    feedback: z.string().describe('Actionable feedback for the submitter'),

    // Quality & Risks
    evidenceDensity: z.enum(['High', 'Med', 'Low']).describe('Quality of code evidence'),
    riskFlags: z.array(z.string()).describe('Potential concerns or issues'),
    qualityIndicators: z.object({
        complexity: z.enum(['Low', 'Medium', 'High']).describe('Code complexity'),
        errorHandling: z.boolean().describe('Error handling present'),
        testCoverage: z.boolean().describe('Tests observed'),
    }).describe('Code quality signals'),
});

export type ScoringDistillerOutput = z.infer<typeof ScoringDistillerSchema>;

const SCHEMA_DESCRIPTION = formatSchemaForInstructions(ScoringDistillerSchema);

export const SCORING_DISTILLER_AGENT_INSTRUCTIONS = `You are a Scoring Distiller agent that performs lossy compression on Requirement Analyzer reports.

## Your Task

Extract and distill Requirement Analyzer report into a comprehensive JSON object (<1K tokens) that preserves key evidence, justification, and actionable feedback for scoring and review.

## Input

You will receive a complete Requirement Analyzer report containing:

${REQUIREMENT_ANALYZER_OUTPUT}

---

## Output Requirements

**You MUST output ONLY valid JSON matching this exact schema - no markdown, no explanations, no code fences:**

${SCHEMA_DESCRIPTION}

---

## Extraction Rules

### Status Mapping
- COVERED verdict (score >= 7) → "Implemented"
- PARTIAL verdict (score 0.3-0.7) → "Partial"
- MISSING verdict (score < 0.3) → "Missing"

### Evidence Density Assessment
- **High**: Multiple code snippets shown, clear data flow, specific line references
- **Med**: Some code evidence but incomplete verification, partial snippets
- **Low**: Mostly search results without read verification, guessed implementations

### Confidence Score Guidelines
- **5**: All sections complete, clear evidence, no ambiguity
- **4**: Most sections clear, minor gaps in evidence
- **3**: Moderate evidence, some uncertainty in constraint verification
- **2**: Limited evidence, significant gaps in analysis
- **1**: Minimal evidence, analysis appears incomplete or rushed

### Gap Summary Rules
- Combine multiple gaps into 1-2 concise sentences (max 200 chars)

### Key Symbols Extraction
- Prioritize symbols from "Core Implementation" section
- Include primary matches with score >= 0.5
- List function/class names without file paths
- Maximum 5 symbols

### Constraints Extraction
- Extract from "Constraint Verification" table in the report
- Map each constraint row to an object with:
  - id: The constraint ID (e.g., "C1", "C2", or full ID like "REQ-01-C1")
  - status: Map ✅ → "Verified", ⚠️ → "Partial", ❌ → "NotFound"
  - evidence: Brief evidence text (max 100 chars) or omit if none

### Risk Flags Extraction
- Include broken imports, missing dependencies, complexity issues
- If "No concerns identified", use empty array []
- Maximum 3 flags

### Justification Extraction
- Cite specific files, functions, and evidence
- Explain WHY the verdict was given (max 300 chars)

### Key Evidence Extraction
- Include file path, symbol name, line number when available
- Brief relevance note explaining what this proves
- Maximum 4 evidence items

### Feedback Extraction
- Keep constructive and specific (max 200 chars)

## CRITICAL CONSTRAINTS

1. **Output ONLY the JSON object** - no surrounding text or formatting
2. **All fields are required** - never omit any field
3. **Strict type adherence** - enums must match exactly
4. **Token budget** - keep total output under 1K tokens
5. **Preserve accuracy** - extract from report, don't invent
6. **Evidence is key** - always include file:line references when available
`;
