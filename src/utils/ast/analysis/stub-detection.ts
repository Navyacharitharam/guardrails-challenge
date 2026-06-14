import type { Symbol, ASTMetadata } from '../schema';
import type { WorkspaceTreeWithAST } from '../file-tree-integration';
import { collectASTMetadata } from '../file-tree-integration';

/**
 * Stub pattern types that indicate incomplete implementations
 */
export type StubPattern = 
    | 'throw_todo'           // throw new Error('TODO') or throw new Error('Not implemented')
    | 'throw_not_impl'       // throw new Error('...')
    | 'return_undefined'     // return undefined as only statement
    | 'empty_body'           // function with empty body {}
    | 'pass_statement'       // Python: pass as only statement
    | 'todo_comment';        // TODO/FIXME comment with no implementation

/**
 * Result of stub detection for a single symbol
 */
export interface StubDetectionResult {
    filePath: string;
    symbolName: string;
    symbolKind: string;
    location: { line: number; column: number };
    isStub: boolean;
    stubPattern?: StubPattern;
    stubEvidence?: string;
    confidence: number; // 0.0 - 1.0
}

/**
 * Summary of stub detection across workspace
 */
export interface StubAnalysisSummary {
    totalFunctions: number;
    stubFunctions: number;
    stubRate: number;
    stubsByPattern: Record<StubPattern, number>;
    stubsByFile: Map<string, StubDetectionResult[]>;
}

/**
 * Patterns that indicate a stub function
 */
const STUB_THROW_PATTERNS = [
    /throw\s+new\s+Error\s*\(\s*['"`](?:TODO|Not\s*implemented|FIXME|NYI|stub)/i,
    /throw\s+new\s+Error\s*\(\s*['"`].*(?:implement|todo|fixme)/i,
    /throw\s+['"`](?:TODO|Not\s*implemented)/i,
    /raise\s+NotImplementedError/i,  // Python
    /raise\s+Exception\s*\(\s*['"`](?:TODO|Not\s*implemented)/i,  // Python
];

const STUB_RETURN_PATTERNS = [
    /^\s*return\s*(?:undefined|null|None)?\s*;?\s*$/m,
    /^\s*return\s*['"`]['"`]\s*;?\s*$/m,  // return ""
    /^\s*return\s*\[\s*\]\s*;?\s*$/m,      // return []
    /^\s*return\s*\{\s*\}\s*;?\s*$/m,      // return {}
];

const STUB_COMMENT_PATTERNS = [
    /\/\/\s*TODO/i,
    /\/\*\s*TODO/i,
    /#\s*TODO/i,       // Python
    /\/\/\s*FIXME/i,
    /\/\*\s*FIXME/i,
    /#\s*FIXME/i,      // Python
    /\/\/\s*STUB/i,
    /#\s*STUB/i,
];

const PASS_PATTERN = /^\s*pass\s*$/m;  // Python pass statement

/**
 * Detect if a function body represents a stub implementation
 */
export function detectStubInContent(
    content: string,
    _symbolName: string,
    language: string
): { isStub: boolean; pattern?: StubPattern; evidence?: string; confidence: number } {
    // Normalize content
    const normalizedContent = content.trim();
    
    // Check for empty body
    if (!normalizedContent || normalizedContent === '{}' || normalizedContent === '{ }') {
        return { isStub: true, pattern: 'empty_body', evidence: 'Empty function body', confidence: 0.95 };
    }
    
    // Python pass statement
    if (language === 'python' && PASS_PATTERN.test(normalizedContent)) {
        return { isStub: true, pattern: 'pass_statement', evidence: 'Python pass statement', confidence: 0.95 };
    }
    
    // Check for throw patterns
    for (const pattern of STUB_THROW_PATTERNS) {
        const match = normalizedContent.match(pattern);
        if (match) {
            const isTodoPattern = /todo|not\s*implemented|nyi|stub/i.test(match[0]);
            return {
                isStub: true,
                pattern: isTodoPattern ? 'throw_todo' : 'throw_not_impl',
                evidence: match[0].slice(0, 100),
                confidence: isTodoPattern ? 0.98 : 0.85,
            };
        }
    }
    
    // Check for simple return patterns (only if function is very short)
    const lines = normalizedContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#'));
    if (lines.length <= 3) {
        for (const pattern of STUB_RETURN_PATTERNS) {
            const match = normalizedContent.match(pattern);
            if (match) {
                return {
                    isStub: true,
                    pattern: 'return_undefined',
                    evidence: match[0].trim(),
                    confidence: 0.75,
                };
            }
        }
    }
    
    // Check for TODO comments with minimal code
    const hasStubComment = STUB_COMMENT_PATTERNS.some(p => p.test(normalizedContent));
    if (hasStubComment && lines.length <= 5) {
        return {
            isStub: true,
            pattern: 'todo_comment',
            evidence: 'TODO/FIXME comment with minimal implementation',
            confidence: 0.65,
        };
    }
    
    return { isStub: false, confidence: 0.0 };
}

/**
 * Extract function body from source code given the function's location
 */
export function extractFunctionBody(
    sourceCode: string,
    startByte: number,
    endByte: number
): string {
    return sourceCode.slice(startByte, endByte);
}

/**
 * Analyze a single file for stub functions
 */
export function analyzeFileForStubs(
    filePath: string,
    ast: ASTMetadata,
    sourceCode?: string
): StubDetectionResult[] {
    const results: StubDetectionResult[] = [];
    
    const functionKinds = new Set([
        'function', 'async_function', 'arrow_function', 'generator_function',
        'method', 'constructor', 'lambda'
    ]);
    
    const analyzeSymbol = (symbol: Symbol) => {
        if (functionKinds.has(symbol.kind)) {
            let stubResult = { isStub: false, confidence: 0 } as ReturnType<typeof detectStubInContent>;
            
            // If we have source code, extract and analyze the function body
            if (sourceCode && symbol.location.startByte !== undefined && symbol.location.endByte !== undefined) {
                const body = extractFunctionBody(
                    sourceCode,
                    symbol.location.startByte,
                    symbol.location.endByte
                );
                stubResult = detectStubInContent(body, symbol.name, ast.language);
            }
            
            results.push({
                filePath,
                symbolName: symbol.name,
                symbolKind: symbol.kind,
                location: {
                    line: symbol.location.line,
                    column: symbol.location.column,
                },
                isStub: stubResult.isStub,
                stubPattern: stubResult.pattern,
                stubEvidence: stubResult.evidence,
                confidence: stubResult.confidence,
            });
        }
        
        // Recursively check class members
        if (symbol.members) {
            for (const member of symbol.members) {
                analyzeSymbol(member);
            }
        }
    };
    
    for (const symbol of ast.symbols) {
        analyzeSymbol(symbol);
    }
    
    return results;
}

/**
 * Analyze an entire workspace tree for stub functions
 */
export function analyzeWorkspaceForStubs(
    tree: WorkspaceTreeWithAST,
    getSourceCode?: (filePath: string) => string | undefined
): StubAnalysisSummary {
    const astFiles = collectASTMetadata(tree);
    const allResults: StubDetectionResult[] = [];
    const stubsByFile = new Map<string, StubDetectionResult[]>();
    const stubsByPattern: Record<StubPattern, number> = {
        throw_todo: 0,
        throw_not_impl: 0,
        return_undefined: 0,
        empty_body: 0,
        pass_statement: 0,
        todo_comment: 0,
    };
    
    for (const { filePath, ast } of astFiles) {
        const sourceCode = getSourceCode?.(filePath);
        const fileResults = analyzeFileForStubs(filePath, ast, sourceCode);
        
        allResults.push(...fileResults);
        
        const stubs = fileResults.filter(r => r.isStub);
        if (stubs.length > 0) {
            stubsByFile.set(filePath, stubs);
            for (const stub of stubs) {
                if (stub.stubPattern) {
                    stubsByPattern[stub.stubPattern]++;
                }
            }
        }
    }
    
    const totalFunctions = allResults.length;
    const stubFunctions = allResults.filter(r => r.isStub).length;
    
    return {
        totalFunctions,
        stubFunctions,
        stubRate: totalFunctions > 0 ? stubFunctions / totalFunctions : 0,
        stubsByPattern,
        stubsByFile,
    };
}

/**
 * Get a human-readable summary of stub analysis
 */
export function formatStubAnalysisSummary(summary: StubAnalysisSummary): string {
    const lines: string[] = [];
    
    lines.push(`Stub Analysis Summary:`);
    lines.push(`  Total functions analyzed: ${summary.totalFunctions}`);
    lines.push(`  Stub functions detected: ${summary.stubFunctions}`);
    lines.push(`  Stub rate: ${(summary.stubRate * 100).toFixed(1)}%`);
    
    if (summary.stubFunctions > 0) {
        lines.push(`\n  Stub patterns:`);
        for (const [pattern, count] of Object.entries(summary.stubsByPattern)) {
            if (count > 0) {
                lines.push(`    - ${pattern}: ${count}`);
            }
        }
        
        lines.push(`\n  Files with stubs:`);
        for (const [filePath, stubs] of summary.stubsByFile) {
            lines.push(`    ${filePath}: ${stubs.length} stub(s)`);
            for (const stub of stubs) {
                lines.push(`      - ${stub.symbolName} (${stub.stubPattern}, confidence: ${(stub.confidence * 100).toFixed(0)}%)`);
            }
        }
    }
    
    return lines.join('\n');
}
