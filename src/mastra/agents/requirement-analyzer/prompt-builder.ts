import { z } from 'zod';
import { unifiedContextSchema } from '../../../utils/schema/challenge-context';

type UnifiedChallengeContext = z.infer<typeof unifiedContextSchema>;
type Requirement = UnifiedChallengeContext['requirements'][number];

/**
 * Builds a comprehensive analysis prompt for a single requirement.
 * Uses the unified challenge context to provide rich context for the analyzer.
 */
export function buildRequirementAnalysisPrompt(
    context: UnifiedChallengeContext,
    requirement: Requirement,
): string {
    const constraintsSection = requirement.constraints.length > 0
        ? requirement.constraints.map((c, i) => `  ${i + 1}. [${c.id}] ${c.text}`).join('\n')
        : '  None specified';

    return `**Requirement ID:** ${requirement.id}
**Title:** ${requirement.title}
**Priority:** ${requirement.priority.toUpperCase()}

### Description
${requirement.description}

### Constraints to Verify
${constraintsSection}`;
}

/**
 * Builds a prompt for analyzing all requirements in a challenge.
 * Returns an array of prompts, one per requirement.
 */
export function buildAllRequirementPrompts(
    context: UnifiedChallengeContext,
): { requirement: Requirement; prompt: string }[] {
    return context.requirements.map(requirement => ({
        requirement,
        prompt: buildRequirementAnalysisPrompt(context, requirement),
    }));
}
