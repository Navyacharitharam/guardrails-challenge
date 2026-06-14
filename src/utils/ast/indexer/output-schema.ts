/**
 * JSON output schema for AST-indexed symbols.
 * Designed for AI code review consumption with comprehensive metadata.
 */

import { z } from 'zod';

/**
 * Location information for a symbol or reference
 */
export const locationSchema = z.object({
    file: z.string().describe('Relative file path from workspace root'),
    line: z.number().int().positive().describe('1-based line number where symbol/reference starts'),
    endLine: z.number().int().positive().optional().describe('1-based line number where symbol ends'),
    column: z.number().int().min(0).optional().describe('0-based column offset'),
});

/**
 * Code metrics computed during AST analysis
 */
export const metricsSchema = z.object({
    complexity: z.number().int().min(0).describe(
        'Cyclomatic complexity: number of independent paths through code. ' +
        '1=linear, 2-5=simple, 6-10=moderate, 11-20=complex, >20=very complex. ' +
        'Counts: if/else, for, while, switch/case, catch, &&, ||, ?:, ??, ?.'
    ),
    loc: z.number().int().min(0).describe(
        'Lines of Code: non-empty, non-comment lines. Does not include blank lines or comment-only lines.'
    ),
    nesting: z.number().int().min(0).describe(
        'Maximum nesting depth of braces/parentheses. High nesting (>4) suggests refactoring needed.'
    ),
    params: z.number().int().min(0).describe(
        'Parameter count for functions/methods. >4 params may indicate need for parameter object.'
    ),
});

/**
 * Flags indicating code quality characteristics
 */
export const flagsSchema = z.object({
    hasLogging: z.boolean().describe(
        'Whether symbol contains logging statements (console.*, logger.*, log.*, print, etc.)'
    ),
    hasErrorHandling: z.boolean().describe(
        'Whether symbol contains try/catch, .catch(), or error handling patterns'
    ),
    isExported: z.boolean().describe(
        'Whether symbol is exported/public (accessible outside its module)'
    ),
    isAsync: z.boolean().optional().describe(
        'Whether function/method is async (returns Promise)'
    ),
    isStatic: z.boolean().optional().describe(
        'Whether method is static (belongs to class, not instance)'
    ),
    isAbstract: z.boolean().optional().describe(
        'Whether class/method is abstract (must be implemented by subclass)'
    ),
});

/**
 * Documentation and clarity metrics for function-like symbols
 */
export const documentationSchema = z.object({
    commentDensity: z.number().min(0).max(1).describe(
        'Ratio of comment lines to total lines (0-1). ' +
        '0=no comments, 0.1-0.2=sparse, 0.2-0.4=moderate, >0.4=heavily commented'
    ),
    hasApiDoc: z.boolean().describe(
        'Whether the symbol has JSDoc/docstring documentation (for exported symbols)'
    ),
    apiDocQuality: z.enum(['none', 'minimal', 'partial', 'complete']).optional().describe(
        'Quality of API documentation: none=no doc, minimal=description only, ' +
        'partial=has @param or @returns but not both, complete=has description + @param + @returns'
    ),
    namingQuality: z.enum(['poor', 'acceptable', 'good']).describe(
        'Quality of identifier naming: poor=mostly abbreviations/single chars, ' +
        'acceptable=mix of clear and unclear names, good=mostly dictionary words/clear names'
    ),
    namingIssues: z.array(z.string()).optional().describe(
        'List of problematic identifier names found (single chars, unclear abbreviations)'
    ),
    inlineComments: z.number().int().min(0).describe(
        'Count of inline comments within the function body'
    ),
    todoCount: z.number().int().min(0).describe(
        'Count of TODO/FIXME/HACK/XXX comments'
    ),
});

/**
 * Mock data detection for function-like symbols and constants.
 * Identifies hardcoded sample/test data vs real implementations.
 */
export const mockDataSchema = z.object({
    hasMockData: z.boolean().describe(
        'Whether the symbol contains or returns hardcoded mock/sample data'
    ),
    mockDataConfidence: z.number().min(0).max(1).describe(
        'Confidence score: 0=definitely real, 1=definitely mock. ' +
        '>0.7 high confidence mock, 0.3-0.7 uncertain, <0.3 likely real'
    ),
    mockDataRole: z.enum(['produces', 'consumes', 'both', 'none']).describe(
        'produces=returns/assigns mock data, consumes=uses mock variables, ' +
        'both=produces and consumes, none=no mock data detected'
    ),
    mockIndicators: z.array(z.string()).describe(
        'Evidence for mock classification. Examples: ' +
        '"hardcoded object array (3 items)", "test-like IDs (id: 1, 2, 3)", ' +
        '"sample names (John Doe, Jane)", "lorem ipsum text"'
    ),
    dataSource: z.enum(['hardcoded', 'computed', 'external', 'unknown']).optional().describe(
        'hardcoded=literals in code, computed=derived from inputs, ' +
        'external=fetched from API/DB, unknown=cannot determine'
    ),
});

/**
 * A broken import that references non-existent file or symbol
 */
export const brokenImportSchema = z.object({
    importPath: z.string().describe('The import path as written in code'),
    resolvedPath: z.string().describe('Resolved path relative to workspace'),
    importedSymbols: z.array(z.string()).describe('Symbols imported that are missing/broken'),
    issue: z.enum(['file_not_found', 'symbol_not_exported']).describe(
        'Type of issue: file_not_found=import file does not exist, ' +
        'symbol_not_exported=file exists but symbol is not exported'
    ),
    usedBySymbols: z.array(z.string()).describe(
        'Symbols in current file that use this broken import'
    ),
});

/**
 * Review-focused risk indicators
 */
export const reviewHintsSchema = z.object({
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).describe(
        'Computed risk level based on complexity, error handling, and test coverage. ' +
        'low: simple with good practices, medium: moderate complexity, ' +
        'high: complex or missing safeguards, critical: very complex with no error handling, ' +
        'OR uses missing dependencies'
    ),
    riskFactors: z.array(z.string()).describe(
        'List of specific risk factors identified. Examples: "high complexity (15)", ' +
        '"no error handling", "no logging", "deeply nested (5)", "many parameters (7)", ' +
        '"uses missing dependency: X from Y"'
    ),
    suggestions: z.array(z.string()).optional().describe(
        'Actionable improvement suggestions based on detected issues'
    ),
    testCoverage: z.enum(['none', 'partial', 'good']).optional().describe(
        'Inferred test coverage: none=no refs from test files, partial=some test refs, good=multiple test refs'
    ),
    isDeadCode: z.boolean().optional().describe(
        'True if symbol has no references and is not exported (potentially unused code)'
    ),
    isEntryPoint: z.boolean().optional().describe(
        'True if symbol is exported but has no internal callers (API surface)'
    ),
    brokenImports: z.array(brokenImportSchema).optional().describe(
        'Broken imports used by this symbol (file not found or symbol not exported)'
    ),
    usesMissingDependency: z.boolean().optional().describe(
        'True if this symbol uses functionality from a broken import - automatically critical risk'
    ),
    documentation: documentationSchema.optional().describe(
        'Documentation and clarity metrics (only for function-like symbols)'
    ),
    mockData: mockDataSchema.optional().describe(
        'Mock data detection results (for function-like symbols and constants with initializers)'
    ),
});

/**
 * A reference to where a symbol is used
 */
export const referenceSchema = z.object({
    file: z.string().describe('File where reference occurs (relative path)'),
    line: z.number().int().positive().describe('Line number of the reference'),
    caller: z.string().optional().describe(
        'Name of the function/method containing this reference, if any'
    ),
    context: z.string().describe(
        'Code snippet showing how the symbol is used (truncated to ~100 chars)'
    ),
    isTest: z.boolean().describe(
        'Whether this reference is in a test file (*.test.*, *.spec.*, __tests__/*, test/*)'
    ),
    isTypeOnly: z.boolean().optional().describe(
        'Whether this is a type-only reference (type annotation, not runtime usage)'
    ),
});

/**
 * Grouped references for cleaner output
 */
export const referencesSummarySchema = z.object({
    total: z.number().int().min(0).describe('Total number of references found'),
    inTests: z.number().int().min(0).describe('Number of references in test files'),
    inProduction: z.number().int().min(0).describe('Number of references in non-test files'),
    locations: z.array(referenceSchema).describe('Individual reference locations'),
});

/**
 * Call graph information
 */
export const callGraphSchema = z.object({
    calls: z.array(z.string()).optional().describe(
        'Functions/methods this symbol calls (outgoing edges)'
    ),
    calledBy: z.array(z.string()).optional().describe(
        'Functions/methods that call this symbol (incoming edges, derived from references)'
    ),
});

/**
 * Complete symbol document for AI review
 */
export const symbolDocumentSchema = z.object({
    // Identity
    symbol: z.string().describe('Symbol name (function, class, variable, etc.)'),
    kind: z.string().describe(
        'Symbol type: function, method, class, interface, type_alias, constant, variable, property, enum, etc.'
    ),
    language: z.string().describe('Programming language: typescript, javascript, python, java, etc.'),

    // Location
    location: locationSchema.describe('Where the symbol is defined'),

    // Signature and modifiers
    signature: z.string().optional().describe(
        'Full signature including parameters, types, and return type. ' +
        'For functions: "async function name(param: Type): ReturnType". ' +
        'For classes: "class Name extends Base implements Interface".'
    ),
    modifiers: z.array(z.string()).optional().describe(
        'Access modifiers and keywords: public, private, protected, static, async, abstract, readonly, export, etc.'
    ),
    visibility: z.enum(['public', 'private', 'protected', 'internal']).optional().describe(
        'Access level of the symbol'
    ),

    // Hierarchy - for properties/methods, shows containing type
    parentSymbol: z.string().optional().describe(
        'Name of the containing symbol (class, interface, type for properties/methods)'
    ),
    parentKind: z.string().optional().describe(
        'Kind of the parent symbol: class, interface, type_alias, enum, etc.'
    ),

    // Property-specific fields
    propertyType: z.string().optional().describe(
        'Type annotation for properties/fields (e.g., "string[]", "number", "UserConfig")'
    ),
    isOptional: z.boolean().optional().describe(
        'Whether the property is optional (has ? modifier)'
    ),
    isReadonly: z.boolean().optional().describe(
        'Whether the property is readonly'
    ),
    hasInitializer: z.boolean().optional().describe(
        'Whether the property has an initializer/default value (class properties)'
    ),

    // Inheritance
    extends: z.string().optional().describe('Parent class this class extends'),
    implements: z.array(z.string()).optional().describe('Interfaces this class implements'),
    decorators: z.array(z.string()).optional().describe(
        'Decorators/annotations applied (@Injectable, @Component, etc.)'
    ),

    // Metrics and flags
    metrics: metricsSchema.describe('Computed code metrics'),
    flags: flagsSchema.describe('Boolean flags indicating code characteristics'),

    // Review-focused analysis
    review: reviewHintsSchema.describe('AI review hints and risk assessment'),

    // Dependencies
    callGraph: callGraphSchema.optional().describe('What this symbol calls and what calls it'),

    // References
    references: referencesSummarySchema.describe('Where this symbol is used across the codebase'),

    // Documentation
    docComment: z.string().optional().describe(
        'JSDoc/docstring comment extracted from source'
    ),

    // Source code
    body: z.string().optional().describe(
        'Full source code of the symbol (may be truncated for large symbols)'
    ),
    bodyTruncated: z.boolean().optional().describe(
        'True if body was truncated due to size limits'
    ),
});

export type SymbolDocument = z.infer<typeof symbolDocumentSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type Flags = z.infer<typeof flagsSchema>;
export type ReviewHints = z.infer<typeof reviewHintsSchema>;
export type Documentation = z.infer<typeof documentationSchema>;
export type MockData = z.infer<typeof mockDataSchema>;
export type BrokenImport = z.infer<typeof brokenImportSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type ReferencesSummary = z.infer<typeof referencesSummarySchema>;
export type CallGraph = z.infer<typeof callGraphSchema>;

/**
 * Schema hints for AI consumption - explains the schema structure
 */
export const SCHEMA_HINTS = `
## AST Symbol Document Schema

This JSON document describes a code symbol (function, class, variable, etc.) extracted via AST analysis.

### Key Fields:

**Identity & Location:**
- \`symbol\`: The name of the code element
- \`kind\`: What type of element (function, class, method, constant, etc.)
- \`location.file\`: Relative path from workspace root
- \`location.line\`: Starting line number (1-based)

**Metrics (for identifying complex/risky code):**
- \`metrics.complexity\`: Cyclomatic complexity (1=simple, >10=complex, >20=very complex)
- \`metrics.loc\`: Lines of code (non-blank, non-comment)
- \`metrics.nesting\`: Max bracket depth (>4 suggests refactoring)
- \`metrics.params\`: Parameter count (>4 may need parameter object)

**Flags (code quality indicators):**
- \`flags.hasLogging\`: Contains logging statements
- \`flags.hasErrorHandling\`: Has try/catch or .catch()
- \`flags.isExported\`: Publicly accessible

**Review Hints (AI-focused analysis):**
- \`review.riskLevel\`: Overall risk assessment (low/medium/high/critical)
- \`review.riskFactors\`: Specific issues found
- \`review.isDeadCode\`: Unused code candidate
- \`review.isEntryPoint\`: API surface (exported, no internal callers)
- \`review.testCoverage\`: Inferred from test file references
- \`review.mockData\`: Mock/sample data detection for requirement verification

**Mock Data Detection:**
- \`review.mockData.hasMockData\`: Whether symbol uses hardcoded test/sample data
- \`review.mockData.mockDataConfidence\`: 0-1 confidence (>0.7 = likely mock)
- \`review.mockData.mockDataRole\`: produces/consumes/both/none
- \`review.mockData.mockIndicators\`: Evidence list (e.g., "hardcoded array", "test IDs")
- \`review.mockData.dataSource\`: hardcoded/computed/external/unknown

**References (usage tracking):**
- \`references.total\`: How many places use this symbol
- \`references.inTests\`: References from test files
- \`references.locations\`: Specific usage locations with context

**Call Graph:**
- \`callGraph.calls\`: What this symbol calls
- \`callGraph.calledBy\`: What calls this symbol

### Risk Level Calculation:
- \`critical\`: complexity > 20 AND no error handling
- \`high\`: complexity > 10 OR (no error handling AND no logging AND exported)
- \`medium\`: complexity > 5 OR params > 4 OR nesting > 3
- \`low\`: Everything else
`.trim();
