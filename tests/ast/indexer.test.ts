import test from 'node:test';
import assert from 'node:assert/strict';
import {
    // Schema and types
    symbolDocumentSchema,
    locationSchema,
    metricsSchema,
    flagsSchema,
    reviewHintsSchema,
    referenceSchema,
    referencesSummarySchema,
    callGraphSchema,
    type SymbolDocument,
    type IndexedSymbol,
    type SymbolReference,

    // Formatter functions
    formatSymbolAsJSON,
    formatSymbolAsJSONString,
    formatSymbolAsJSONPretty,
    formatSymbolsAsJSON,

    // Other indexer exports
    generateSymbolId,
} from '../../src/utils/ast/indexer/index.ts';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a minimal valid IndexedSymbol for testing
 */
function createMockSymbol(overrides: Partial<IndexedSymbol> = {}): IndexedSymbol {
    return {
        id: 'sym_test_1',
        filePath: 'src/example.ts',
        language: 'typescript',
        symbolName: 'testFunction',
        kind: 'function',
        span: {
            startLine: 10,
            endLine: 25,
            startCol: 0,
            endCol: 1,
            startByte: 100,
            endByte: 500,
        },
        metrics: {
            complexity: 5,
            nesting: 2,
            linesOfCode: 15,
            parameterCount: 2,
            hasLogging: true,
            hasErrorHandling: true,
        },
        indexedAt: Date.now(),
        ...overrides,
    };
}

/**
 * Create a mock reference for testing
 */
function createMockReference(overrides: Partial<SymbolReference> = {}): SymbolReference {
    return {
        filePath: 'src/caller.ts',
        line: 50,
        column: 10,
        callSignature: 'const result = testFunction(a, b);',
        containingSymbol: 'callerFunction',
        ...overrides,
    };
}

// ============================================================================
// Schema Validation Tests
// ============================================================================

test('locationSchema validates correct location object', () => {
    const validLocation = {
        file: 'src/example.ts',
        line: 10,
        endLine: 25,
        column: 0,
    };

    const result = locationSchema.safeParse(validLocation);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.file, 'src/example.ts');
        assert.equal(result.data.line, 10);
    }
});

test('locationSchema rejects invalid line numbers', () => {
    const invalidLocation = {
        file: 'src/example.ts',
        line: 0, // Invalid: must be positive
    };

    const result = locationSchema.safeParse(invalidLocation);
    assert.equal(result.success, false);
});

test('metricsSchema validates correct metrics object', () => {
    const validMetrics = {
        complexity: 8,
        loc: 25,
        nesting: 3,
        params: 4,
    };

    const result = metricsSchema.safeParse(validMetrics);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.complexity, 8);
        assert.equal(result.data.loc, 25);
    }
});

test('metricsSchema rejects negative values', () => {
    const invalidMetrics = {
        complexity: -1,
        loc: 25,
        nesting: 3,
        params: 4,
    };

    const result = metricsSchema.safeParse(invalidMetrics);
    assert.equal(result.success, false);
});

test('flagsSchema validates correct flags object', () => {
    const validFlags = {
        hasLogging: true,
        hasErrorHandling: false,
        isExported: true,
        isAsync: true,
        isStatic: false,
    };

    const result = flagsSchema.safeParse(validFlags);
    assert.equal(result.success, true);
});

test('reviewHintsSchema validates all risk levels', () => {
    const riskLevels = ['low', 'medium', 'high', 'critical'] as const;

    for (const level of riskLevels) {
        const hints = {
            riskLevel: level,
            riskFactors: ['test factor'],
        };

        const result = reviewHintsSchema.safeParse(hints);
        assert.equal(result.success, true, `Failed for risk level: ${level}`);
    }
});

test('reviewHintsSchema validates optional fields', () => {
    const hintsWithOptionals = {
        riskLevel: 'high',
        riskFactors: ['high complexity (15)', 'no error handling'],
        suggestions: ['Add try/catch', 'Consider refactoring'],
        testCoverage: 'partial',
        isDeadCode: false,
        isEntryPoint: true,
    };

    const result = reviewHintsSchema.safeParse(hintsWithOptionals);
    assert.equal(result.success, true);
    if (result.success) {
        assert.deepEqual(result.data.suggestions, ['Add try/catch', 'Consider refactoring']);
        assert.equal(result.data.testCoverage, 'partial');
    }
});

test('referenceSchema validates correct reference object', () => {
    const validReference = {
        file: 'src/caller.ts',
        line: 50,
        caller: 'handleRequest',
        context: 'await testFunction(id)',
        isTest: false,
        isTypeOnly: false,
    };

    const result = referenceSchema.safeParse(validReference);
    assert.equal(result.success, true);
});

test('referenceSchema validates test file reference', () => {
    const testReference = {
        file: 'src/__tests__/example.test.ts',
        line: 25,
        caller: 'testExample',
        context: 'expect(testFunction()).toBe(true)',
        isTest: true,
    };

    const result = referenceSchema.safeParse(testReference);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.isTest, true);
    }
});

test('referencesSummarySchema validates complete summary', () => {
    const summary = {
        total: 5,
        inTests: 2,
        inProduction: 3,
        locations: [
            {
                file: 'src/caller.ts',
                line: 50,
                context: 'testFunction()',
                isTest: false,
            },
            {
                file: 'tests/example.test.ts',
                line: 10,
                context: 'testFunction()',
                isTest: true,
            },
        ],
    };

    const result = referencesSummarySchema.safeParse(summary);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.total, 5);
        assert.equal(result.data.locations.length, 2);
    }
});

test('callGraphSchema validates call graph', () => {
    const callGraph = {
        calls: ['helperFunction', 'logger.info', 'db.query'],
        calledBy: ['mainHandler', 'processRequest'],
    };

    const result = callGraphSchema.safeParse(callGraph);
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.calls?.length, 3);
        assert.equal(result.data.calledBy?.length, 2);
    }
});

// ============================================================================
// Full Document Schema Tests
// ============================================================================

test('symbolDocumentSchema validates minimal document', () => {
    const minimalDoc: SymbolDocument = {
        symbol: 'testFunc',
        kind: 'function',
        language: 'typescript',
        location: {
            file: 'src/example.ts',
            line: 1,
        },
        metrics: {
            complexity: 1,
            loc: 5,
            nesting: 1,
            params: 0,
        },
        flags: {
            hasLogging: false,
            hasErrorHandling: false,
            isExported: false,
        },
        review: {
            riskLevel: 'low',
            riskFactors: [],
        },
        references: {
            total: 0,
            inTests: 0,
            inProduction: 0,
            locations: [],
        },
    };

    const result = symbolDocumentSchema.safeParse(minimalDoc);
    assert.equal(result.success, true);
});

test('symbolDocumentSchema validates complete document', () => {
    const completeDoc: SymbolDocument = {
        symbol: 'UserService',
        kind: 'class',
        language: 'typescript',
        location: {
            file: 'src/services/user.service.ts',
            line: 15,
            endLine: 150,
            column: 0,
        },
        signature: 'export class UserService implements IUserService',
        modifiers: ['export', 'public'],
        visibility: 'public',
        extends: 'BaseService',
        implements: ['IUserService', 'IDisposable'],
        decorators: ['@Injectable', '@Singleton'],
        metrics: {
            complexity: 12,
            loc: 135,
            nesting: 4,
            params: 0,
        },
        flags: {
            hasLogging: true,
            hasErrorHandling: true,
            isExported: true,
            isAsync: false,
            isStatic: false,
            isAbstract: false,
        },
        review: {
            riskLevel: 'high',
            riskFactors: ['high complexity (12)', 'deeply nested (4)'],
            suggestions: ['Consider breaking into smaller classes'],
            testCoverage: 'good',
            isDeadCode: false,
            isEntryPoint: true,
        },
        callGraph: {
            calls: ['validateUser', 'db.query', 'logger.info'],
            calledBy: ['UserController', 'AuthMiddleware'],
        },
        references: {
            total: 15,
            inTests: 8,
            inProduction: 7,
            locations: [
                {
                    file: 'src/controllers/user.controller.ts',
                    line: 25,
                    caller: 'UserController',
                    context: 'new UserService(db)',
                    isTest: false,
                },
            ],
        },
        docComment: '/**\n * Service for user management operations.\n */',
        body: 'export class UserService { /* ... */ }',
        bodyTruncated: true,
    };

    const result = symbolDocumentSchema.safeParse(completeDoc);
    assert.equal(result.success, true);
});

// ============================================================================
// Formatter Function Tests
// ============================================================================

test('formatSymbolAsJSON produces valid schema-compliant output', () => {
    const symbol = createMockSymbol({
        signature: 'function testFunction(a: string, b: number): boolean',
        isExported: true,
        isAsync: false,
        bodyText: 'function testFunction(a: string, b: number): boolean { return true; }',
    });

    const result = formatSymbolAsJSON(symbol);

    // Validate against schema
    const validation = symbolDocumentSchema.safeParse(result);
    assert.equal(validation.success, true, `Schema validation failed: ${JSON.stringify(validation)}`);

    // Check key fields
    assert.equal(result.symbol, 'testFunction');
    assert.equal(result.kind, 'function');
    assert.equal(result.language, 'typescript');
    assert.equal(result.location.file, 'src/example.ts');
    assert.equal(result.location.line, 10);
    assert.equal(result.metrics.complexity, 5);
    assert.equal(result.flags.hasLogging, true);
});

test('formatSymbolAsJSON includes references when present', () => {
    const symbol = createMockSymbol({
        references: [
            createMockReference({ filePath: 'src/caller1.ts', line: 10 }),
            createMockReference({ filePath: 'tests/example.test.ts', line: 20 }),
        ],
    });

    const result = formatSymbolAsJSON(symbol);

    assert.equal(result.references.total, 2);
    assert.equal(result.references.inTests, 1);
    assert.equal(result.references.inProduction, 1);
    assert.equal(result.references.locations.length, 2);
});

test('formatSymbolAsJSON calculates risk level correctly', () => {
    // Low risk: simple function
    const lowRiskSymbol = createMockSymbol({
        metrics: {
            complexity: 2,
            nesting: 1,
            linesOfCode: 5,
            parameterCount: 1,
            hasLogging: true,
            hasErrorHandling: true,
        },
    });
    assert.equal(formatSymbolAsJSON(lowRiskSymbol).review.riskLevel, 'low');

    // Medium risk: moderate complexity
    const mediumRiskSymbol = createMockSymbol({
        metrics: {
            complexity: 7,
            nesting: 2,
            linesOfCode: 25,
            parameterCount: 3,
            hasLogging: true,
            hasErrorHandling: true,
        },
    });
    assert.equal(formatSymbolAsJSON(mediumRiskSymbol).review.riskLevel, 'medium');

    // High risk: high complexity
    const highRiskSymbol = createMockSymbol({
        metrics: {
            complexity: 15,
            nesting: 3,
            linesOfCode: 50,
            parameterCount: 2,
            hasLogging: true,
            hasErrorHandling: true,
        },
    });
    assert.equal(formatSymbolAsJSON(highRiskSymbol).review.riskLevel, 'high');

    // Critical risk: very high complexity without error handling
    const criticalRiskSymbol = createMockSymbol({
        metrics: {
            complexity: 25,
            nesting: 5,
            linesOfCode: 100,
            parameterCount: 6,
            hasLogging: false,
            hasErrorHandling: false,
        },
    });
    assert.equal(formatSymbolAsJSON(criticalRiskSymbol).review.riskLevel, 'critical');
});

test('formatSymbolAsJSON generates appropriate risk factors', () => {
    const symbol = createMockSymbol({
        metrics: {
            complexity: 15,
            nesting: 5,
            linesOfCode: 80,
            parameterCount: 7,
            hasLogging: false,
            hasErrorHandling: false,
        },
        isExported: true,
    });

    const result = formatSymbolAsJSON(symbol);
    const factors = result.review.riskFactors;

    assert.ok(factors.some(f => f.includes('complexity')), 'Should include complexity factor');
    assert.ok(factors.some(f => f.includes('nested')), 'Should include nesting factor');
    assert.ok(factors.some(f => f.includes('parameters')), 'Should include parameters factor');
    assert.ok(factors.some(f => f.includes('no error handling')), 'Should include error handling factor');
});

test('formatSymbolAsJSON detects dead code', () => {
    const deadCodeSymbol = createMockSymbol({
        isExported: false,
        references: [], // No references
    });

    const result = formatSymbolAsJSON(deadCodeSymbol);
    assert.equal(result.review.isDeadCode, true);
});

test('formatSymbolAsJSON detects entry points', () => {
    const entryPointSymbol = createMockSymbol({
        isExported: true,
        references: [], // Exported but no internal callers
    });

    const result = formatSymbolAsJSON(entryPointSymbol);
    assert.equal(result.review.isEntryPoint, true);
});

test('formatSymbolAsJSON extracts calledBy from references', () => {
    const symbol = createMockSymbol({
        references: [
            createMockReference({ containingSymbol: 'handler1' }),
            createMockReference({ containingSymbol: 'handler2' }),
            createMockReference({ containingSymbol: 'handler1' }), // Duplicate
        ],
    });

    const result = formatSymbolAsJSON(symbol);

    assert.ok(result.callGraph?.calledBy?.includes('handler1'));
    assert.ok(result.callGraph?.calledBy?.includes('handler2'));
    assert.equal(result.callGraph?.calledBy?.length, 2); // Deduplicated
});

test('formatSymbolAsJSON truncates large bodies', () => {
    const largeBody = 'function test() {\n' + '  console.log("line");\n'.repeat(500) + '}';
    const symbol = createMockSymbol({
        bodyText: largeBody,
    });

    const result = formatSymbolAsJSON(symbol);

    assert.ok(result.body!.length < largeBody.length, 'Body should be truncated');
    assert.ok(result.body!.includes('[truncated]'), 'Should include truncation marker');
    assert.equal(result.bodyTruncated, true);
});

test('formatSymbolAsJSON determines test coverage from references', () => {
    // No test coverage
    const noTestSymbol = createMockSymbol({
        references: [
            createMockReference({ filePath: 'src/caller.ts' }),
        ],
    });
    assert.equal(formatSymbolAsJSON(noTestSymbol).review.testCoverage, 'none');

    // Partial test coverage
    const partialTestSymbol = createMockSymbol({
        references: [
            createMockReference({ filePath: 'src/caller.ts' }),
            createMockReference({ filePath: 'src/caller2.ts' }),
            createMockReference({ filePath: 'tests/example.test.ts' }),
        ],
    });
    assert.equal(formatSymbolAsJSON(partialTestSymbol).review.testCoverage, 'partial');

    // Good test coverage
    const goodTestSymbol = createMockSymbol({
        references: [
            createMockReference({ filePath: 'tests/example.test.ts' }),
            createMockReference({ filePath: 'tests/integration.test.ts' }),
            createMockReference({ filePath: 'tests/unit.spec.ts' }),
        ],
    });
    assert.equal(formatSymbolAsJSON(goodTestSymbol).review.testCoverage, 'good');
});

// ============================================================================
// JSON String Output Tests
// ============================================================================

test('formatSymbolAsJSONString produces valid JSON', () => {
    const symbol = createMockSymbol();
    const jsonString = formatSymbolAsJSONString(symbol);

    // Should not throw
    const parsed = JSON.parse(jsonString);
    assert.ok(parsed, 'Should produce parseable JSON');
    assert.equal(parsed.symbol, 'testFunction');
});

test('formatSymbolAsJSONPretty produces formatted valid JSON', () => {
    const symbol = createMockSymbol();
    const jsonString = formatSymbolAsJSONPretty(symbol);

    // Should not throw
    const parsed = JSON.parse(jsonString);
    assert.ok(parsed, 'Should produce parseable JSON');

    // Should be formatted (contains newlines and indentation)
    assert.ok(jsonString.includes('\n'), 'Should contain newlines');
    assert.ok(jsonString.includes('  '), 'Should contain indentation');
});

test('formatSymbolsAsJSON processes multiple symbols', () => {
    const symbols = [
        createMockSymbol({ symbolName: 'func1', id: 'sym_1' }),
        createMockSymbol({ symbolName: 'func2', id: 'sym_2' }),
        createMockSymbol({ symbolName: 'func3', id: 'sym_3' }),
    ];

    const results = formatSymbolsAsJSON(symbols);

    assert.equal(results.length, 3);
    assert.equal(results[0].symbol, 'func1');
    assert.equal(results[1].symbol, 'func2');
    assert.equal(results[2].symbol, 'func3');

    // Each should be schema-valid
    for (const doc of results) {
        const validation = symbolDocumentSchema.safeParse(doc);
        assert.equal(validation.success, true);
    }
});

// ============================================================================
// generateSymbolId Tests
// ============================================================================

test('generateSymbolId produces consistent IDs', () => {
    const id1 = generateSymbolId('src/file.ts', 'myFunc', 'function', 10);
    const id2 = generateSymbolId('src/file.ts', 'myFunc', 'function', 10);

    assert.equal(id1, id2, 'Same inputs should produce same ID');
});

test('generateSymbolId produces different IDs for different inputs', () => {
    const id1 = generateSymbolId('src/file.ts', 'myFunc', 'function', 10);
    const id2 = generateSymbolId('src/file.ts', 'myFunc', 'function', 20);
    const id3 = generateSymbolId('src/other.ts', 'myFunc', 'function', 10);

    assert.notEqual(id1, id2, 'Different lines should produce different IDs');
    assert.notEqual(id1, id3, 'Different files should produce different IDs');
});

test('generateSymbolId format is valid', () => {
    const id = generateSymbolId('src/file.ts', 'myFunc', 'function', 10);

    assert.ok(id.startsWith('sym_'), 'ID should start with sym_');
    assert.ok(id.includes('_10'), 'ID should include line number');
    assert.ok(!/\s/.test(id), 'ID should not contain whitespace');
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

test('formatSymbolAsJSON handles symbol with no optional fields', () => {
    const minimalSymbol: IndexedSymbol = {
        id: 'sym_minimal',
        filePath: 'src/minimal.ts',
        language: 'typescript',
        symbolName: 'minimal',
        kind: 'variable',
        span: {
            startLine: 1,
            endLine: 1,
            startCol: 0,
            endCol: 20,
            startByte: 0,
            endByte: 20,
        },
        metrics: {
            complexity: 0,
            nesting: 0,
            linesOfCode: 1,
            parameterCount: 0,
            hasLogging: false,
            hasErrorHandling: false,
        },
        indexedAt: Date.now(),
    };

    const result = formatSymbolAsJSON(minimalSymbol);
    const validation = symbolDocumentSchema.safeParse(result);

    assert.equal(validation.success, true);
    assert.equal(result.symbol, 'minimal');
});

test('formatSymbolAsJSON handles empty references array', () => {
    const symbol = createMockSymbol({ references: [] });
    const result = formatSymbolAsJSON(symbol);

    assert.equal(result.references.total, 0);
    assert.equal(result.references.locations.length, 0);
});

test('formatSymbolAsJSON handles undefined bodyText', () => {
    const symbol = createMockSymbol({ bodyText: undefined });
    const result = formatSymbolAsJSON(symbol);

    // Should not throw, body may be undefined
    const validation = symbolDocumentSchema.safeParse(result);
    assert.equal(validation.success, true);
});

test('formatSymbolAsJSON handles special characters in symbol names', () => {
    const symbol = createMockSymbol({
        symbolName: '$special_name$',
        signature: 'function $special_name$(): void',
    });

    const jsonString = formatSymbolAsJSONString(symbol);

    // Should produce valid JSON
    const parsed = JSON.parse(jsonString);
    assert.equal(parsed.symbol, '$special_name$');
});

test('formatSymbolAsJSON handles unicode in body text', () => {
    const symbol = createMockSymbol({
        bodyText: 'function test() { return "Hello 世界 🌍"; }',
        docComment: '/** Returns greeting in multiple languages 日本語 *//',
    });

    const jsonString = formatSymbolAsJSONString(symbol);

    // Should produce valid JSON with unicode preserved
    const parsed = JSON.parse(jsonString);
    assert.ok(parsed.body?.includes('世界'));
    assert.ok(parsed.docComment?.includes('日本語'));
});

// ============================================================================
// Test File Detection Tests
// ============================================================================

test('formatSymbolAsJSON correctly identifies test file references', () => {
    const symbol = createMockSymbol({
        references: [
            createMockReference({ filePath: 'src/utils.ts' }),
            createMockReference({ filePath: 'src/utils.test.ts' }),
            createMockReference({ filePath: 'src/utils.spec.ts' }),
            createMockReference({ filePath: 'src/__tests__/utils.ts' }),
            createMockReference({ filePath: 'test/utils.ts' }),
            createMockReference({ filePath: 'tests/integration/utils.ts' }),
            createMockReference({ filePath: 'src/utils.stories.tsx' }),
        ],
    });

    const result = formatSymbolAsJSON(symbol);

    // Production: src/utils.ts (1)
    // Tests: .test.ts, .spec.ts, __tests__, test/, tests/, .stories. (6)
    assert.equal(result.references.inProduction, 1);
    assert.equal(result.references.inTests, 6);
});

// ============================================================================
// Import Validation Tests
// ============================================================================

import {
    isLocalImport,
    resolveImportToWorkspacePath,
    findImportedFile,
    brokenImportSchema,
} from '../../src/utils/ast/indexer/index.ts';

test('isLocalImport correctly identifies local imports', () => {
    // Local imports
    assert.equal(isLocalImport('./utils'), true);
    assert.equal(isLocalImport('../shared/types'), true);
    assert.equal(isLocalImport('/absolute/path'), true);
    assert.equal(isLocalImport('./index'), true);

    // Non-local imports (node_modules, built-in, etc.)
    assert.equal(isLocalImport('lodash'), false);
    assert.equal(isLocalImport('react'), false);
    assert.equal(isLocalImport('@types/node'), false);
    assert.equal(isLocalImport('fs'), false);
    assert.equal(isLocalImport('path'), false);
});

test('resolveImportToWorkspacePath resolves relative imports', () => {
    const basePath = '/workspace';

    // Same directory
    const result1 = resolveImportToWorkspacePath('./utils', 'src/services/user.ts', basePath);
    assert.equal(result1, 'src/services/utils');

    // Parent directory
    const result2 = resolveImportToWorkspacePath('../types', 'src/services/user.ts', basePath);
    assert.equal(result2, 'src/types');

    // Multiple parent directories
    const result3 = resolveImportToWorkspacePath('../../shared/utils', 'src/services/user.ts', basePath);
    assert.equal(result3, 'shared/utils');
});

test('findImportedFile finds file with extensions', () => {
    const indexedFiles = new Set([
        'src/utils.ts',
        'src/helpers.tsx',
        'src/lib/index.ts',
        'src/data.js',
    ]);

    // Exact match
    assert.equal(findImportedFile('src/utils.ts', indexedFiles), 'src/utils.ts');

    // With extension resolution
    assert.equal(findImportedFile('src/utils', indexedFiles), 'src/utils.ts');
    assert.equal(findImportedFile('src/helpers', indexedFiles), 'src/helpers.tsx');
    assert.equal(findImportedFile('src/data', indexedFiles), 'src/data.js');

    // Index file resolution
    assert.equal(findImportedFile('src/lib', indexedFiles), 'src/lib/index.ts');

    // Not found
    assert.equal(findImportedFile('src/missing', indexedFiles), null);
    assert.equal(findImportedFile('other/file', indexedFiles), null);
});

test('findImportedFile swaps .js extension to .ts when needed', () => {
    const indexedFiles = new Set([
        'src/config/index.ts',
        'src/utils/logger.ts',
        'src/auth/types.ts',
    ]);

    // Import with .js extension should find .ts file
    assert.equal(findImportedFile('src/config/index.js', indexedFiles), 'src/config/index.ts');
    assert.equal(findImportedFile('src/utils/logger.js', indexedFiles), 'src/utils/logger.ts');
    assert.equal(findImportedFile('src/auth/types.js', indexedFiles), 'src/auth/types.ts');

    // Import without extension should still work
    assert.equal(findImportedFile('src/config/index', indexedFiles), 'src/config/index.ts');
});

test('brokenImportSchema validates file_not_found issue', () => {
    const brokenImport = {
        importPath: '../utils/missing',
        resolvedPath: 'src/utils/missing.ts',
        importedSymbols: ['helperFunction'],
        issue: 'file_not_found',
        usedBySymbols: ['myFunction'],
    };

    const result = brokenImportSchema.safeParse(brokenImport);
    assert.equal(result.success, true);
});

test('brokenImportSchema validates symbol_not_exported issue', () => {
    const brokenImport = {
        importPath: '../utils/helpers',
        resolvedPath: 'src/utils/helpers.ts',
        importedSymbols: ['privateHelper'],
        issue: 'symbol_not_exported',
        usedBySymbols: ['myFunction', 'otherFunction'],
    };

    const result = brokenImportSchema.safeParse(brokenImport);
    assert.equal(result.success, true);
});

test('formatSymbolAsJSON elevates risk to critical for broken imports', () => {
    const symbolWithBrokenImport = createMockSymbol({
        metrics: {
            complexity: 2, // Low complexity
            nesting: 1,
            linesOfCode: 10,
            parameterCount: 1,
            hasLogging: true,
            hasErrorHandling: true,
        },
        brokenImports: [{
            importPath: '../utils/missing',
            resolvedPath: 'src/utils/missing.ts',
            importedSymbols: ['helperFunction'],
            issue: 'file_not_found',
        }],
    });

    const result = formatSymbolAsJSON(symbolWithBrokenImport);

    // Should be critical despite low complexity
    assert.equal(result.review.riskLevel, 'critical');
    assert.equal(result.review.usesMissingDependency, true);
    assert.ok(result.review.brokenImports);
    assert.equal(result.review.brokenImports.length, 1);
    assert.equal(result.review.brokenImports[0].issue, 'file_not_found');
});

test('formatSymbolAsJSON includes broken import suggestions', () => {
    const symbolWithBrokenImport = createMockSymbol({
        brokenImports: [{
            importPath: '../utils/string-utils',
            resolvedPath: 'src/utils/string-utils.ts',
            importedSymbols: ['isWholeWordMatch'],
            issue: 'file_not_found',
        }],
    });

    const result = formatSymbolAsJSON(symbolWithBrokenImport);

    // Should include suggestions for fixing
    assert.ok(result.review.suggestions);
    assert.ok(result.review.suggestions.some(s => s.includes('Create missing file')));
    assert.ok(result.review.suggestions.some(s => s.includes('update import path')));
});

test('formatSymbolAsJSON handles symbol_not_exported with suggestions', () => {
    const symbolWithMissingExport = createMockSymbol({
        brokenImports: [{
            importPath: '../utils/helpers',
            resolvedPath: 'src/utils/helpers.ts',
            importedSymbols: ['privateHelper'],
            issue: 'symbol_not_exported',
        }],
    });

    const result = formatSymbolAsJSON(symbolWithMissingExport);

    assert.equal(result.review.riskLevel, 'critical');
    assert.ok(result.review.suggestions);
    assert.ok(result.review.suggestions.some(s => s.includes('Export')));
});

test('formatSymbolAsJSON includes broken imports in risk factors', () => {
    const symbol = createMockSymbol({
        brokenImports: [{
            importPath: '../missing/module',
            resolvedPath: 'src/missing/module.ts',
            importedSymbols: ['foo', 'bar'],
            issue: 'file_not_found',
        }],
    });

    const result = formatSymbolAsJSON(symbol);

    assert.ok(result.review.riskFactors.some(f =>
        f.includes('uses missing dependency') &&
        f.includes('foo') &&
        f.includes('bar') &&
        f.includes('file not found')
    ));
});

test('formatSymbolAsJSON handles multiple broken imports', () => {
    const symbol = createMockSymbol({
        brokenImports: [
            {
                importPath: '../utils/missing1',
                resolvedPath: 'src/utils/missing1.ts',
                importedSymbols: ['func1'],
                issue: 'file_not_found',
            },
            {
                importPath: '../utils/existing',
                resolvedPath: 'src/utils/existing.ts',
                importedSymbols: ['notExported'],
                issue: 'symbol_not_exported',
            },
        ],
    });

    const result = formatSymbolAsJSON(symbol);

    assert.equal(result.review.riskLevel, 'critical');
    assert.ok(result.review.brokenImports);
    assert.equal(result.review.brokenImports.length, 2);
    assert.equal(result.review.brokenImports[0].issue, 'file_not_found');
    assert.equal(result.review.brokenImports[1].issue, 'symbol_not_exported');
});

// ============================================================================
// Documentation Analysis Tests
// ============================================================================

import {
    calculateCommentDensity,
    analyzeApiDoc,
    countInlineComments,
    countTodoComments,
    analyzeNamingQuality,
    splitIdentifier,
    extractLocalVariables,
    documentationSchema,
} from '../../src/utils/ast/indexer/index.ts';

test('calculateCommentDensity returns 0 for empty code', () => {
    assert.equal(calculateCommentDensity(''), 0);
    assert.equal(calculateCommentDensity('   '), 0);
});

test('calculateCommentDensity calculates correct ratio', () => {
    // 1 comment, 2 code lines = 0.33
    const code1 = `
// This is a comment
const x = 1;
const y = 2;
`;
    const density1 = calculateCommentDensity(code1);
    assert.ok(density1 >= 0.3 && density1 <= 0.35);

    // All comments
    const code2 = `// comment 1
// comment 2`;
    assert.equal(calculateCommentDensity(code2), 1);

    // No comments
    const code3 = `const x = 1;
const y = 2;`;
    assert.equal(calculateCommentDensity(code3), 0);
});

test('calculateCommentDensity handles block comments', () => {
    const code = `
/* This is
   a block
   comment */
const x = 1;
`;
    const density = calculateCommentDensity(code);
    assert.ok(density >= 0.7); // 3 comment lines, 1 code line
});

test('analyzeApiDoc detects no documentation', () => {
    const result = analyzeApiDoc('', [], false);
    assert.equal(result.hasApiDoc, false);
    assert.equal(result.apiDocQuality, 'none');
});

test('analyzeApiDoc detects minimal JSDoc', () => {
    const doc = `/** Simple description of the function */`;
    const result = analyzeApiDoc(doc, [], true);
    assert.equal(result.hasApiDoc, true);
    assert.equal(result.apiDocQuality, 'minimal');
});

test('analyzeApiDoc detects partial JSDoc', () => {
    const doc = `/**
 * Process user data and return results.
 * @param userId The user ID to process
 */`;
    const result = analyzeApiDoc(doc, ['userId'], true);
    assert.equal(result.hasApiDoc, true);
    assert.equal(result.apiDocQuality, 'partial');
});

test('analyzeApiDoc detects complete JSDoc', () => {
    const doc = `/**
 * Process user data and return results.
 * @param userId The user ID to process
 * @param options Configuration options
 * @returns The processed user data
 */`;
    const result = analyzeApiDoc(doc, ['userId', 'options'], true);
    assert.equal(result.hasApiDoc, true);
    assert.equal(result.apiDocQuality, 'complete');
});

test('countInlineComments counts correctly', () => {
    const code = `
const x = 1; // first inline
const y = 2;
const z = 3; // second inline
// This is not inline
/* block */ const a = 4;
`;
    assert.equal(countInlineComments(code), 2);
});

test('countTodoComments finds TODO/FIXME', () => {
    const code = `
// TODO: implement this
const x = 1;
// FIXME: broken
/* HACK: temporary solution */
// XXX: needs review
`;
    assert.equal(countTodoComments(code, ''), 4);
});

test('analyzeNamingQuality identifies good naming', () => {
    const identifiers = ['getUserById', 'processData', 'validateInput', 'result'];
    const result = analyzeNamingQuality(identifiers);
    assert.equal(result.quality, 'good');
    assert.equal(result.issues.length, 0);
});

test('analyzeNamingQuality identifies poor naming', () => {
    const identifiers = ['x', 'y', 'a1', 'b2', 'temp1', 'foo'];
    const result = analyzeNamingQuality(identifiers);
    assert.equal(result.quality, 'poor');
    assert.ok(result.issues.length > 0);
});

test('analyzeNamingQuality allows loop counters', () => {
    const identifiers = ['i', 'j', 'k', 'processItems'];
    const result = analyzeNamingQuality(identifiers);
    assert.equal(result.quality, 'good');
});

test('analyzeNamingQuality handles mixed quality', () => {
    const identifiers = ['getUserById', 'x', 'processData', 'temp1'];
    const result = analyzeNamingQuality(identifiers);
    assert.ok(result.quality === 'acceptable' || result.quality === 'good');
});

test('splitIdentifier handles camelCase', () => {
    assert.deepEqual(splitIdentifier('getUserById'), ['get', 'user', 'by', 'id']);
    assert.deepEqual(splitIdentifier('parseJSON'), ['parse', 'json']);
});

test('splitIdentifier handles snake_case', () => {
    assert.deepEqual(splitIdentifier('get_user_by_id'), ['get', 'user', 'by', 'id']);
});

test('splitIdentifier handles PascalCase', () => {
    assert.deepEqual(splitIdentifier('UserService'), ['user', 'service']);
    assert.deepEqual(splitIdentifier('HTTPClient'), ['http', 'client']);
});

test('splitIdentifier handles mixed case', () => {
    assert.deepEqual(splitIdentifier('XMLHttpRequest'), ['xml', 'http', 'request']);
});

test('extractLocalVariables finds const/let/var', () => {
    const code = `
const x = 1;
let y = 2;
var z = 3;
`;
    const vars = extractLocalVariables(code);
    assert.ok(vars.includes('x'));
    assert.ok(vars.includes('y'));
    assert.ok(vars.includes('z'));
});

test('extractLocalVariables finds loop variables', () => {
    const code = `
for (let i = 0; i < 10; i++) {}
for (const item of items) {}
items.forEach((element) => {});
`;
    const vars = extractLocalVariables(code);
    assert.ok(vars.includes('i'));
    assert.ok(vars.includes('item'));
    assert.ok(vars.includes('element'));
});

test('documentationSchema validates complete documentation', () => {
    const doc = {
        commentDensity: 0.25,
        hasApiDoc: true,
        apiDocQuality: 'complete',
        namingQuality: 'good',
        namingIssues: [],
        inlineComments: 3,
        todoCount: 1,
    };
    const result = documentationSchema.safeParse(doc);
    assert.equal(result.success, true);
});

test('documentationSchema rejects invalid values', () => {
    const doc = {
        commentDensity: 1.5, // Invalid: > 1
        hasApiDoc: true,
        namingQuality: 'excellent', // Invalid enum value
        inlineComments: -1, // Invalid: negative
        todoCount: 0,
    };
    const result = documentationSchema.safeParse(doc);
    assert.equal(result.success, false);
});

test('formatSymbolAsJSON includes documentation for function', () => {
    const functionSymbol = createMockSymbol({
        kind: 'function',
        bodyText: `
// Calculate the total price
const subtotal = items.reduce((sum, item) => sum + item.price, 0);
const tax = subtotal * 0.1; // 10% tax
return subtotal + tax;
`,
        docComment: `/**
 * Calculate total price including tax.
 * @param items Array of items
 * @returns Total price with tax
 */`,
    });

    const result = formatSymbolAsJSON(functionSymbol);

    assert.ok(result.review.documentation);
    assert.ok(result.review.documentation.commentDensity >= 0);
    assert.equal(result.review.documentation.hasApiDoc, true);
    assert.ok(['partial', 'complete'].includes(result.review.documentation.apiDocQuality!));
});

test('formatSymbolAsJSON does not include documentation for class', () => {
    const classSymbol = createMockSymbol({
        kind: 'class',
        bodyText: 'class MyClass {}',
    });

    const result = formatSymbolAsJSON(classSymbol);

    // Documentation analysis only for function-like symbols
    assert.equal(result.review.documentation, undefined);
});

test('formatSymbolAsJSON detects poor naming in function', () => {
    const functionSymbol = createMockSymbol({
        kind: 'function',
        signature: 'function calc(a, b, x, y)',
        bodyText: `
const t = a + b;
const r = x * y;
return t + r;
`,
    });

    const result = formatSymbolAsJSON(functionSymbol);

    assert.ok(result.review.documentation);
    assert.ok(result.review.documentation.namingIssues);
    assert.ok(result.review.documentation.namingIssues.length > 0);
});

test('formatSymbolAsJSON detects TODO comments', () => {
    const functionSymbol = createMockSymbol({
        kind: 'method',
        bodyText: `
// TODO: Add validation
// FIXME: Handle edge case
const result = process(data);
return result;
`,
    });

    const result = formatSymbolAsJSON(functionSymbol);

    assert.ok(result.review.documentation);
    assert.equal(result.review.documentation.todoCount, 2);
});

// ============================================================================
// Property Symbol Handling Tests
// ============================================================================

test('formatSymbolAsJSON includes parentSymbol for property', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'username',
        parentSymbolName: 'UserProfile',
        parentSymbolKind: 'interface',
        propertyType: 'string',
        signature: 'username: string',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    assert.equal(result.parentSymbol, 'UserProfile');
    assert.equal(result.parentKind, 'interface');
    assert.equal(result.propertyType, 'string');
});

test('formatSymbolAsJSON detects optional property', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'nickname',
        parentSymbolName: 'UserProfile',
        parentSymbolKind: 'interface',
        propertyType: 'string',
        isOptional: true,
        signature: 'nickname?: string',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    assert.equal(result.isOptional, true);
});

test('formatSymbolAsJSON detects readonly property', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'id',
        parentSymbolName: 'Entity',
        parentSymbolKind: 'class',
        propertyType: 'string',
        isReadonly: true,
        signature: 'readonly id: string',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    assert.equal(result.isReadonly, true);
});

test('formatSymbolAsJSON detects class property with initializer', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'count',
        parentSymbolName: 'Counter',
        parentSymbolKind: 'class',
        propertyType: 'number',
        hasInitializer: true,
        signature: 'count: number = 0',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    assert.equal(result.hasInitializer, true);
});

test('formatSymbolAsJSON does not mark property as dead code', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'skills',
        parentSymbolName: 'GithubProfile',
        parentSymbolKind: 'interface',
        propertyType: 'string[]',
        isExported: false,
        references: [], // No direct references
    });

    const result = formatSymbolAsJSON(propertySymbol);

    // Properties should not be marked as dead code since they're used implicitly
    assert.equal(result.review.isDeadCode, undefined);
});

test('formatSymbolAsJSON does not include testCoverage for property', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'value',
        parentSymbolName: 'Config',
        parentSymbolKind: 'type_alias',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    // Test coverage is not meaningful for properties
    assert.equal(result.review.testCoverage, undefined);
});

test('formatSymbolAsJSON handles method with parent context', () => {
    const methodSymbol = createMockSymbol({
        kind: 'method',
        symbolName: 'validate',
        parentSymbolName: 'UserService',
        parentSymbolKind: 'class',
        signature: 'validate(user: User): boolean',
    });

    const result = formatSymbolAsJSON(methodSymbol);

    assert.equal(result.parentSymbol, 'UserService');
    assert.equal(result.parentKind, 'class');
    // Methods should still have testCoverage
    assert.ok(result.review.testCoverage !== undefined || result.review.testCoverage === 'none');
});

test('formatSymbolAsJSON handles enum member', () => {
    const enumMember = createMockSymbol({
        kind: 'enum_member',
        symbolName: 'Active',
        parentSymbolName: 'Status',
        parentSymbolKind: 'enum',
    });

    const result = formatSymbolAsJSON(enumMember);

    assert.equal(result.parentSymbol, 'Status');
    assert.equal(result.parentKind, 'enum');
    // Enum members should not be marked as dead code
    assert.equal(result.review.isDeadCode, undefined);
});

test('formatSymbolAsJSON includes complex property type', () => {
    const propertySymbol = createMockSymbol({
        kind: 'property',
        symbolName: 'handlers',
        parentSymbolName: 'EventEmitter',
        parentSymbolKind: 'class',
        propertyType: 'Map<string, (event: Event) => void>',
        signature: 'handlers: Map<string, (event: Event) => void>',
    });

    const result = formatSymbolAsJSON(propertySymbol);

    assert.equal(result.propertyType, 'Map<string, (event: Event) => void>');
});
