// Schema exports
export {
    locationSchema,
    visibilitySchema,
    symbolKindSchema,
    parameterSchema,
    symbolBodySchema,
    classBodySchema,
    symbolSchema,
    importSchema,
    exportSchema,
    callSiteSchema,
    parseErrorSchema,
    languageSchema,
    astMetadataSchema,
    validateASTMetadata,
    safeValidateASTMetadata,
    type Location,
    type Visibility,
    type SymbolKind,
    type Parameter,
    type SymbolBody,
    type ClassBody,
    type Symbol,
    type Import,
    type Export,
    type CallSite,
    type ParseError,
    type Language,
    type ASTMetadata,
} from './schema';

// Parser exports
export {
    BaseParser,
    TreeSitterRuntime,
    getTreeSitterRuntime,
    ParserRegistry,
    getParserRegistry,
    TypeScriptParser,
    JavaScriptParser,
    PythonParser,
    JavaParser,
    initializeASTSystem,
    isASTSystemInitialized,
    resetASTSystem,
    parseFile,
    parseSource,
    isExtensionSupported,
    getSupportedExtensions,
} from './parsers';

// File-tree integration exports
export {
    fileNodeWithASTSchema,
    workspaceTreeWithASTSchema,
    enrichFileNodeWithAST,
    enrichWorkspaceTreeWithAST,
    collectASTMetadata,
    getWorkspaceSymbols,
    getWorkspaceImports,
    type FileNodeWithAST,
    type WorkspaceTreeWithAST,
    type ASTParseOptions,
} from './file-tree-integration';

// Analysis exports
export {
    // Stub detection
    detectStubInContent,
    extractFunctionBody,
    analyzeFileForStubs,
    analyzeWorkspaceForStubs,
    formatStubAnalysisSummary,
    type StubPattern,
    type StubDetectionResult,
    type StubAnalysisSummary,
    // Complexity
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
    // Dead code
    buildCallGraph,
    analyzeDeadCode,
    formatDeadCodeSummary,
    type DeadCodeResult,
    type DeadCodeSummary,
} from './analysis';

// Indexer exports
export {
    // Types
    type Span,
    type SymbolMetrics,
    type IndexedSymbol,
    type IndexedFile,
    type IndexStats,
    generateSymbolId,
    // Logging detection
    detectLogging,
    detectErrorHandling,
    countLoggingStatements,
    // Structured store
    StructuredIndexStore,
    type SymbolQuery,
    // Dependency tracking
    DependencyTracker,
    resolveImportPath,
    // Main service
    ASTIndexerService,
    type ASTIndexOptions,
    type IndexingResult,
} from './indexer';
