// Indexed symbol types
export {
    type Span,
    type SymbolMetrics,
    type SymbolReference,
    type IndexedSymbol,
    type IndexedFile,
    type IndexStats,
    generateSymbolId,
} from './indexed-symbol';

// Reference finder
export {
    findAllReferences,
    attachReferencesToSymbols,
    formatReferences,
} from './reference-finder';

// Logging detection
export {
    detectLogging,
    detectErrorHandling,
    countLoggingStatements,
    getLoggingPatterns,
    getErrorHandlingPatterns,
} from './logging-detector';

// Structured index store
export {
    StructuredIndexStore,
    type SymbolQuery,
} from './structured-index-store';

// Dependency tracking
export {
    DependencyTracker,
    resolveImportPath,
} from './dependency-tracker';

// Main indexer service
export {
    ASTIndexerService,
    type ASTIndexOptions,
    type IndexingResult,
} from './ast-indexer-service';

// JSON output schema and formatter
export {
    symbolDocumentSchema,
    locationSchema,
    metricsSchema,
    flagsSchema,
    reviewHintsSchema,
    documentationSchema,
    mockDataSchema,
    brokenImportSchema,
    referenceSchema,
    referencesSummarySchema,
    callGraphSchema,
    SCHEMA_HINTS,
    type SymbolDocument,
    type Location,
    type Metrics,
    type Flags,
    type ReviewHints,
    type Documentation,
    type MockData,
    type BrokenImport,
    type Reference,
    type ReferencesSummary,
    type CallGraph,
} from './output-schema';

export {
    formatSymbolAsJSON,
    formatSymbolAsJSONString,
    formatSymbolAsJSONPretty,
    formatSymbolsAsJSON,
} from './output-formatter';

// Import validation
export {
    validateAllImports,
    validateFileImports,
    getSymbolsUsingBrokenImports,
    isLocalImport,
    resolveImportToWorkspacePath,
    findImportedFile,
    type BrokenImport as BrokenImportInfo,
    type ImportValidationResult,
} from './import-validator';

// Documentation analysis
export {
    analyzeDocumentation,
    calculateCommentDensity,
    analyzeApiDoc,
    countInlineComments,
    countTodoComments,
    analyzeNamingQuality,
    splitIdentifier,
    extractLocalVariables,
    toDocumentationSchema,
    type DocumentationAnalysis,
} from './documentation-analyzer';

// Mock data detection
export {
    analyzeMockData,
    shouldAnalyzeMockData,
    toMockDataSchema,
    type MockDataAnalysis,
} from './mock-data-detector';
