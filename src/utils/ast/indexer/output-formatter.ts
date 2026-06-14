/**
 * Formats IndexedSymbol into JSON document for AI code review.
 */

import type { IndexedSymbol, SymbolReference } from './indexed-symbol';
import type {
    SymbolDocument,
    Metrics,
    Flags,
    ReviewHints,
    Reference,
    ReferencesSummary,
    CallGraph,
    Documentation,
    MockData,
} from './output-schema';
import { toMockDataSchema } from './mock-data-detector';
import {
    analyzeDocumentation,
    extractLocalVariables,
    toDocumentationSchema,
} from './documentation-analyzer';

/**
 * Body size limits by symbol kind (in characters)
 */
const BODY_LIMITS: Record<string, number> = {
    function: 3000,
    async_function: 3000,
    arrow_function: 2000,
    method: 3000,
    constructor: 2000,
    getter: 1000,
    setter: 1000,
    class: 1000,          // Just signature/outline, not full body
    interface: 2000,      // Type definitions are important
    type_alias: 1500,
    constant: 500,
    variable: 500,
    property: 300,
    enum: 1000,
    default: 2000,
};

/**
 * Check if a file path is a test file
 */
function isTestFile(filePath: string): boolean {
    const testPatterns = [
        /\.test\./i,
        /\.spec\./i,
        /_test\./i,
        /_spec\./i,
        /__tests__[/\\]/i,
        /(^|[/\\])tests?[/\\]/i,   // test/ or tests/ at start or after separator
        /\.stories\./i,            // Storybook
    ];
    return testPatterns.some(p => p.test(filePath));
}

/**
 * Check if a reference is type-only (type annotation, not runtime)
 */
function isTypeOnlyReference(context: string): boolean {
    const typePatterns = [
        /^:\s*\w/,           // : Type
        /^<\w/,              // <Generic>
        /\bas\s+\w/,         // as Type
        /extends\s+\w/,      // extends Type
        /implements\s+\w/,   // implements Type
    ];
    return typePatterns.some(p => p.test(context.trim()));
}

/**
 * Calculate risk level based on metrics, flags, and broken imports
 */
function calculateRiskLevel(
    metrics: Metrics,
    flags: Flags,
    refSummary: ReferencesSummary,
    hasBrokenImports: boolean
): 'low' | 'medium' | 'high' | 'critical' {
    const { complexity, nesting, params } = metrics;
    const { hasErrorHandling, hasLogging, isExported } = flags;

    // Critical: Uses missing dependencies (broken imports)
    if (hasBrokenImports) {
        return 'critical';
    }

    // Critical: Very complex with no safeguards
    if (complexity > 20 && !hasErrorHandling) {
        return 'critical';
    }

    // High: Complex or missing safeguards on public API
    if (complexity > 10) {
        return 'high';
    }
    if (!hasErrorHandling && !hasLogging && isExported && complexity > 3) {
        return 'high';
    }

    // Medium: Moderate complexity or code smells
    if (complexity > 5 || params > 4 || nesting > 3) {
        return 'medium';
    }

    // Low: Simple, well-structured code
    return 'low';
}

/**
 * Broken import info from IndexedSymbol
 */
interface BrokenImportInfo {
    importPath: string;
    resolvedPath: string;
    importedSymbols: string[];
    issue: 'file_not_found' | 'symbol_not_exported';
}

/**
 * Generate risk factors list
 */
function generateRiskFactors(
    metrics: Metrics,
    flags: Flags,
    refSummary: ReferencesSummary,
    brokenImports?: BrokenImportInfo[]
): string[] {
    const factors: string[] = [];

    // Broken imports are the most critical
    if (brokenImports && brokenImports.length > 0) {
        for (const broken of brokenImports) {
            const symbols = broken.importedSymbols.join(', ');
            const issueDesc = broken.issue === 'file_not_found'
                ? 'file not found'
                : 'symbol not exported';
            factors.push(`uses missing dependency: ${symbols} from '${broken.importPath}' (${issueDesc})`);
        }
    }

    if (metrics.complexity > 20) {
        factors.push(`very high complexity (${metrics.complexity})`);
    } else if (metrics.complexity > 10) {
        factors.push(`high complexity (${metrics.complexity})`);
    } else if (metrics.complexity > 5) {
        factors.push(`moderate complexity (${metrics.complexity})`);
    }

    if (metrics.nesting > 4) {
        factors.push(`deeply nested (depth ${metrics.nesting})`);
    } else if (metrics.nesting > 3) {
        factors.push(`nested code (depth ${metrics.nesting})`);
    }

    if (metrics.params > 6) {
        factors.push(`too many parameters (${metrics.params})`);
    } else if (metrics.params > 4) {
        factors.push(`many parameters (${metrics.params})`);
    }

    if (!flags.hasErrorHandling && metrics.complexity > 1) {
        factors.push('no error handling');
    }

    if (!flags.hasLogging && flags.isExported) {
        factors.push('no logging in public API');
    }

    if (refSummary.inTests === 0 && refSummary.total > 0) {
        factors.push('no test coverage');
    }

    if (metrics.loc > 100) {
        factors.push(`long function (${metrics.loc} lines)`);
    } else if (metrics.loc > 50) {
        factors.push(`consider splitting (${metrics.loc} lines)`);
    }

    return factors;
}

/**
 * Generate improvement suggestions based on risk factors
 */
function generateSuggestions(riskFactors: string[], kind: string, brokenImports?: BrokenImportInfo[]): string[] {
    const suggestions: string[] = [];

    // Broken import suggestions first (most critical)
    if (brokenImports && brokenImports.length > 0) {
        for (const broken of brokenImports) {
            if (broken.issue === 'file_not_found') {
                suggestions.push(`Create missing file: ${broken.resolvedPath}`);
                suggestions.push(`Or update import path '${broken.importPath}' to point to existing module`);
            } else {
                suggestions.push(`Export '${broken.importedSymbols.join(', ')}' from ${broken.resolvedPath}`);
                suggestions.push(`Or import from a module that exports these symbols`);
            }
        }
    }

    for (const factor of riskFactors) {
        if (factor.includes('complexity')) {
            suggestions.push('Consider breaking into smaller functions');
        }
        if (factor.includes('nested')) {
            suggestions.push('Consider early returns or extracting nested logic');
        }
        if (factor.includes('parameters')) {
            suggestions.push('Consider using a parameter object or builder pattern');
        }
        if (factor.includes('no error handling')) {
            suggestions.push('Add try/catch for error handling');
        }
        if (factor.includes('no logging')) {
            suggestions.push('Add logging for observability');
        }
        if (factor.includes('no test coverage')) {
            suggestions.push('Add unit tests');
        }
        if (factor.includes('long function')) {
            suggestions.push('Extract helper functions to improve readability');
        }
    }

    // Deduplicate
    return [...new Set(suggestions)];
}

/**
 * Determine test coverage level from references
 */
function determineTestCoverage(refSummary: ReferencesSummary): 'none' | 'partial' | 'good' {
    if (refSummary.inTests === 0) return 'none';
    if (refSummary.inTests >= 3 || refSummary.inTests >= refSummary.inProduction) return 'good';
    return 'partial';
}

/**
 * Convert SymbolReference to Reference format
 */
function formatReference(ref: SymbolReference): Reference {
    return {
        file: ref.filePath,
        line: ref.line,
        caller: ref.containingSymbol,
        context: ref.callSignature,
        isTest: isTestFile(ref.filePath),
        isTypeOnly: isTypeOnlyReference(ref.callSignature),
    };
}

/**
 * Build references summary
 */
function buildReferencesSummary(refs: SymbolReference[] | undefined): ReferencesSummary {
    const locations = (refs || []).map(formatReference);
    const inTests = locations.filter(r => r.isTest).length;

    return {
        total: locations.length,
        inTests,
        inProduction: locations.length - inTests,
        locations,
    };
}

/**
 * Truncate body text with smart line breaking
 */
function truncateBody(body: string | undefined, kind: string): { text: string; truncated: boolean } {
    if (!body) return { text: '', truncated: false };

    const limit = BODY_LIMITS[kind] || BODY_LIMITS.default;
    if (body.length <= limit) {
        return { text: body, truncated: false };
    }

    // Try to break at a line boundary
    let truncateAt = limit;
    const lastNewline = body.lastIndexOf('\n', limit);
    if (lastNewline > limit * 0.7) {
        truncateAt = lastNewline;
    }

    return {
        text: body.slice(0, truncateAt) + '\n// ... [truncated]',
        truncated: true,
    };
}

/**
 * Extract calledBy from references (unique caller names)
 */
function extractCalledBy(refs: SymbolReference[] | undefined): string[] {
    if (!refs) return [];

    const callers = new Set<string>();
    for (const ref of refs) {
        if (ref.containingSymbol) {
            callers.add(ref.containingSymbol);
        }
    }
    return Array.from(callers);
}

/**
 * Function-like symbol kinds that should have documentation analysis
 */
const FUNCTION_LIKE_KINDS = new Set([
    'function',
    'async_function',
    'arrow_function',
    'method',
    'async_method',
    'constructor',
    'getter',
    'setter',
    'generator',
    'async_generator',
]);

/**
 * Property-like symbol kinds (part of a type/class definition)
 * These are used implicitly via their parent type, so shouldn't be marked as dead code
 */
const PROPERTY_LIKE_KINDS = new Set([
    'property',
    'field',
    'property_signature',
    'public_field_definition',
    'class_property',
    'enum_member',
    'enum_variant',
]);

/**
 * Analyze documentation for function-like symbols
 */
function analyzeDocumentationIfApplicable(symbol: IndexedSymbol): Documentation | undefined {
    // Only analyze function-like symbols
    if (!FUNCTION_LIKE_KINDS.has(symbol.kind)) {
        return undefined;
    }

    // Extract parameter names from signature
    const parameterNames = extractParameterNames(symbol.signature ?? '');

    // Extract local variables from body
    const localVariables = extractLocalVariables(symbol.bodyText ?? '');

    // Perform analysis
    const analysis = analyzeDocumentation(
        symbol.bodyText,
        symbol.docComment,
        symbol.symbolName,
        parameterNames,
        localVariables,
        symbol.isExported ?? false
    );

    return toDocumentationSchema(analysis);
}

/**
 * Extract parameter names from a function signature
 */
function extractParameterNames(signature: string): string[] {
    // Match the parameters section between parentheses
    const match = signature.match(/\(([^)]*)\)/);
    if (!match) return [];

    const paramsStr = match[1].trim();
    if (!paramsStr) return [];

    // Split by comma, handling nested generics/objects
    const params: string[] = [];
    let depth = 0;
    let current = '';

    for (const char of paramsStr) {
        if (char === '<' || char === '{' || char === '[' || char === '(') {
            depth++;
            current += char;
        } else if (char === '>' || char === '}' || char === ']' || char === ')') {
            depth--;
            current += char;
        } else if (char === ',' && depth === 0) {
            if (current.trim()) {
                params.push(current.trim());
            }
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) {
        params.push(current.trim());
    }

    // Extract just the parameter name from each param
    return params.map(p => {
        // Handle destructuring
        if (p.startsWith('{') || p.startsWith('[')) {
            return p; // Return as-is for destructuring
        }
        // Handle rest params
        if (p.startsWith('...')) {
            p = p.slice(3);
        }
        // Remove type annotation
        const colonIndex = p.indexOf(':');
        if (colonIndex > 0) {
            p = p.slice(0, colonIndex);
        }
        // Remove default value
        const eqIndex = p.indexOf('=');
        if (eqIndex > 0) {
            p = p.slice(0, eqIndex);
        }
        // Remove optional marker
        p = p.replace('?', '');
        return p.trim();
    }).filter(p => p.length > 0);
}

/**
 * Convert IndexedSymbol to SymbolDocument JSON format
 */
export function formatSymbolAsJSON(symbol: IndexedSymbol, sourceCode?: string): SymbolDocument {
    // Build metrics
    const metrics: Metrics = {
        complexity: symbol.metrics.complexity,
        loc: symbol.metrics.linesOfCode,
        nesting: symbol.metrics.nesting,
        params: symbol.metrics.parameterCount,
    };

    // Build flags
    const flags: Flags = {
        hasLogging: symbol.metrics.hasLogging,
        hasErrorHandling: symbol.metrics.hasErrorHandling,
        isExported: symbol.isExported ?? false,
        isAsync: symbol.isAsync,
        isStatic: symbol.isStatic,
        isAbstract: symbol.isAbstract,
    };

    // Build references summary
    const refSummary = buildReferencesSummary(symbol.references);

    // Build call graph
    const callGraph: CallGraph = {
        calls: symbol.callTargets,
        calledBy: extractCalledBy(symbol.references),
    };

    // Check for broken imports
    const hasBrokenImports = (symbol.brokenImports?.length ?? 0) > 0;
    const brokenImportsList = symbol.brokenImports as BrokenImportInfo[] | undefined;

    // Calculate review hints
    const riskLevel = calculateRiskLevel(metrics, flags, refSummary, hasBrokenImports);
    const riskFactors = generateRiskFactors(metrics, flags, refSummary, brokenImportsList);

    // Convert mock data analysis to schema format if present
    let mockData: MockData | undefined;
    if (symbol.mockData) {
        mockData = toMockDataSchema(symbol.mockData);
        // Add risk factor for mock data in non-test files
        if (symbol.mockData.hasMockData && !isTestFile(symbol.filePath)) {
            riskFactors.push(`uses mock/hardcoded data (confidence: ${Math.round(symbol.mockData.confidence * 100)}%)`);
        }
    }

    const suggestions = generateSuggestions(riskFactors, symbol.kind, brokenImportsList);

    // Analyze documentation for function-like symbols
    const documentation = analyzeDocumentationIfApplicable(symbol);

    // For properties/fields, don't mark as dead code - they're used implicitly via parent type
    const isPropertyLike = PROPERTY_LIKE_KINDS.has(symbol.kind);
    const isDeadCode = isPropertyLike
        ? undefined  // Properties are used implicitly when parent type is used
        : (!symbol.isExported && refSummary.total === 0 ? true : undefined);

    const review: ReviewHints = {
        riskLevel,
        riskFactors,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        testCoverage: isPropertyLike ? undefined : determineTestCoverage(refSummary),
        isDeadCode,
        isEntryPoint: symbol.isExported && callGraph.calledBy?.length === 0 ? true : undefined,
        brokenImports: brokenImportsList?.map(bi => ({
            importPath: bi.importPath,
            resolvedPath: bi.resolvedPath,
            importedSymbols: bi.importedSymbols,
            issue: bi.issue,
            usedBySymbols: [symbol.symbolName],
        })),
        usesMissingDependency: hasBrokenImports || undefined,
        documentation,
        mockData,
    };

    // Build modifiers list
    const modifiers: string[] = [];
    if (symbol.visibility) modifiers.push(symbol.visibility);
    if (symbol.isExported) modifiers.push('export');
    if (symbol.isAsync) modifiers.push('async');
    if (symbol.isStatic) modifiers.push('static');
    if (symbol.isAbstract) modifiers.push('abstract');

    // Get body text
    let bodyText = symbol.bodyText;
    if (!bodyText && sourceCode) {
        bodyText = sourceCode.slice(symbol.span.startByte, symbol.span.endByte);
    }
    const { text: body, truncated: bodyTruncated } = truncateBody(bodyText, symbol.kind);

    // Parse extends/implements from implementsOrExtends
    let extendsClass: string | undefined;
    const implementsList: string[] = [];
    if (symbol.implementsOrExtends) {
        for (const item of symbol.implementsOrExtends) {
            // Heuristic: classes usually extend one thing
            if (!extendsClass && symbol.kind === 'class') {
                extendsClass = item;
            } else {
                implementsList.push(item);
            }
        }
    }

    // Build the document
    const doc: SymbolDocument = {
        symbol: symbol.symbolName,
        kind: symbol.kind,
        language: symbol.language,
        location: {
            file: symbol.filePath,
            line: symbol.span.startLine,
            endLine: symbol.span.endLine,
            column: symbol.span.startCol,
        },
        // Parent context (for properties/methods)
        parentSymbol: symbol.parentSymbolName,
        parentKind: symbol.parentSymbolKind,
        // Property-specific fields
        propertyType: isPropertyLike ? symbol.propertyType : undefined,
        isOptional: isPropertyLike ? symbol.isOptional : undefined,
        isReadonly: isPropertyLike ? symbol.isReadonly : undefined,
        hasInitializer: isPropertyLike ? symbol.hasInitializer : undefined,
        // Signature and modifiers
        signature: symbol.signature,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        visibility: symbol.visibility as 'public' | 'private' | 'protected' | 'internal' | undefined,
        extends: extendsClass,
        implements: implementsList.length > 0 ? implementsList : undefined,
        decorators: symbol.decorators,
        metrics,
        flags,
        review,
        callGraph: (callGraph.calls?.length || callGraph.calledBy?.length) ? callGraph : undefined,
        references: refSummary,
        docComment: symbol.docComment,
        body: body || undefined,
        bodyTruncated: bodyTruncated || undefined,
    };

    return doc;
}

/**
 * Format symbol as compact JSON string (minified)
 */
export function formatSymbolAsJSONString(symbol: IndexedSymbol, sourceCode?: string): string {
    const doc = formatSymbolAsJSON(symbol, sourceCode);
    return JSON.stringify(doc);
}

/**
 * Format symbol as pretty-printed JSON string
 */
export function formatSymbolAsJSONPretty(symbol: IndexedSymbol, sourceCode?: string): string {
    const doc = formatSymbolAsJSON(symbol, sourceCode);
    return JSON.stringify(doc, null, 2);
}

/**
 * Format multiple symbols as a JSON array
 */
export function formatSymbolsAsJSON(
    symbols: IndexedSymbol[],
    sourceCodeMap?: Map<string, string>
): SymbolDocument[] {
    return symbols.map(s => formatSymbolAsJSON(s, sourceCodeMap?.get(s.filePath)));
}
