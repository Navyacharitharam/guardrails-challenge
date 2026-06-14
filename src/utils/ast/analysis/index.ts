// Stub detection exports
export {
    detectStubInContent,
    extractFunctionBody,
    analyzeFileForStubs,
    analyzeWorkspaceForStubs,
    formatStubAnalysisSummary,
    type StubPattern,
    type StubDetectionResult,
    type StubAnalysisSummary,
} from './stub-detection';

// Complexity analysis exports
export {
    calculateCyclomaticComplexity,
    calculateLinesOfCode,
    calculateNestingDepth,
    analyzeSymbolComplexity,
    analyzeFileComplexity,
    analyzeWorkspaceComplexity,
    formatComplexitySummary,
    COMPLEXITY_THRESHOLDS,
    type FunctionComplexity,
    type ComplexitySummary,
} from './complexity';

// Dead code analysis exports
export {
    buildCallGraph,
    analyzeDeadCode,
    formatDeadCodeSummary,
    type DeadCodeResult,
    type DeadCodeSummary,
} from './dead-code';
