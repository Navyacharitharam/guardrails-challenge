/**
 * Output template for the Requirement Analyzer agent.
 * This defines the structured format that the agent should use when generating its analysis report for a given requirement.
 */

export const REQUIREMENT_ANALYZER_OUTPUT = `# Requirement **ID:** [requirement ID or "N/A"] -Analysis Report

## 1. Requirement Summary

**ID:** [requirement ID or "N/A"]

**Title:** [requirement title]

**Constraints:** [list any constraints from the requirement, or "None specified"]
- [constraint 1]
- [etc.]

## 2. Implementation Evidence

### Core Implementation
[Describe the main code that implements this requirement]
- **File:** [path]
- **Symbol:** [function/class name]
- **How it covers the requirement:** [brief explanation]

### Dependencies & Integrations
- [List key dependencies used: Prisma, Kafka, etc.]
- [List external services or APIs called]
- [List database tables/models accessed]

## 3. Constraint Verification

| Constraint | Status | Evidence |
|------------|--------|----------|
| [constraint text] | ✅ Verified / ⚠️ Partial / ❌ Not Found | [specific evidence - keep it short] |

## 4. Coverage Assessment

**Overall Coverage Score:** [0.0 - 1.0]

**Verdict:** [COVERED / PARTIAL / MISSING]

**Justification:**
[1-2 sentences explaining the verdict with specific references to evidence]

### What's Missing or Unclear:
- [bullet point for each gap, or "None identified" if fully covered]

## 5. Quality Observations

**Code Quality Indicators:**
- Complexity: [low/medium/high] - [brief note]
- Error Handling: [present/missing] - [brief note]
- Test Coverage: [observed/not observed]

**Potential Concerns:**
- [Any broken imports, missing dependencies, or risks observed]
- [Or "No concerns identified"]`;