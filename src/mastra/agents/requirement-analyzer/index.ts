/**
 * Requirement Analyzer Agent
 * 
 * An AST-aware agent that maps software requirements to codebase implementations.
 */

// Main agent export
export { requirementAnalyzerAgent } from './agent';

// Tools
export { submissionTools, submissionSearchTool, submissionReadTool } from './tools';

// Types and utilities
export {
    type MaxStepsReachedResult,
    type ToolCallLog,
    type ToolResultLog,
    type StepLog,
    type AgentRunLog,
    MAX_STEPS,
    EARLY_WARNING_THRESHOLD,
    SUGGESTED_NEXT_STEPS,
} from './utils';

// Instructions (for reference/testing)
export { AGENT_INSTRUCTIONS } from './instructions';
export { REQUIREMENT_ANALYZER_OUTPUT } from './instructions-output';

// Memory configuration
export {
    requirementAnalyzerAgentMemory,
    REQUIREMENT_ANALYZER_WORKING_MEMORY_TEMPLATE,
} from './memory';

// Prompt builders
export {
    buildRequirementAnalysisPrompt,
} from './prompt-builder';
