import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

/**
 * Custom working memory template for the Requirement Analyzer Agent.
 * 
 * This template is designed to keep the agent focused on the CURRENT requirement
 * being analyzed, preventing context pollution from previous analyses.
 * 
 * The template uses thread-scoped memory so each requirement analysis
 * session starts fresh without interference from other threads.
 */
export const REQUIREMENT_ANALYZER_WORKING_MEMORY_TEMPLATE = `# Current Requirement Analysis

## Active Requirement
- **Requirement ID**: [The ID of the requirement being analyzed]
- **Requirement Text**: [The exact text of the requirement to analyze]
- **Analysis Status**: [not_started | in_progress | completed]

## Search Progress
- **Queries Executed**: [List of search queries performed]
- **Total Matches Found**: [Number of relevant matches]
- **Files Examined**: [List of files containing matches]

## Key Findings
- **Primary Implementation**: [Main symbol/function that implements the requirement]
- **Supporting Code**: [Related symbols that support the implementation]
- **Missing Elements**: [What's missing or not found]

## Constraints Verification
- **Verified Constraints**: [List of constraints that have evidence]
- **Unverified Constraints**: [Constraints lacking evidence]
- **Constraint Evidence**: [Brief notes on evidence found]

## Analysis Notes
- **Current Step**: [What the agent is currently doing]
- **Next Action**: [What needs to be done next]
- **Blockers**: [Any issues preventing progress]

## Output Draft
- **Coverage Score**: [0.0-1.0]
- **Coverage Verdict**: [missing | partial | covered]
- **Confidence Level**: [low | medium | high]
`;

/**
 * Memory configuration for the Requirement Analyzer Agent
 * 
 * Uses thread-scoped working memory to ensure each requirement analysis
 * is isolated and doesn't get contaminated by previous analyses.
 */
export const requirementAnalyzerAgentMemory = new Memory({
    storage: new LibSQLStore({
        id: 'requirement-analyzer-memory',
        url: 'file:./requirement-analyzer-memory.db',
    }),
    // Disabled persistent long-term memory to prevent context pollution
    // options: {
    //     workingMemory: {
    //         enabled: true,
    //         scope: 'thread',
    //         template: REQUIREMENT_ANALYZER_WORKING_MEMORY_TEMPLATE,
    //     },
    // },
});