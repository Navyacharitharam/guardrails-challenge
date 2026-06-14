import type { Symbol, ASTMetadata } from '../schema';
import type { WorkspaceTreeWithAST } from '../file-tree-integration';
import { collectASTMetadata } from '../file-tree-integration';

/**
 * Complexity metrics for a single function
 */
export interface FunctionComplexity {
    filePath: string;
    symbolName: string;
    symbolKind: string;
    location: { line: number; column: number };
    cyclomaticComplexity: number;
    linesOfCode: number;
    parameterCount: number;
    nestingDepth: number;
    isHighComplexity: boolean;
}

/**
 * Summary of complexity metrics across workspace
 */
export interface ComplexitySummary {
    totalFunctions: number;
    averageCyclomaticComplexity: number;
    maxCyclomaticComplexity: number;
    highComplexityFunctions: number;
    highComplexityRate: number;
    functionsByComplexity: FunctionComplexity[];
    complexityDistribution: {
        low: number;      // 1-5
        medium: number;   // 6-10
        high: number;     // 11-20
        veryHigh: number; // 20+
    };
}

/**
 * Thresholds for complexity classification
 */
export const COMPLEXITY_THRESHOLDS = {
    LOW: 5,
    MEDIUM: 10,
    HIGH: 20,
};

/**
 * Control flow keywords/patterns that increase cyclomatic complexity
 */
const CONTROL_FLOW_PATTERNS = {
    typescript: [
        /\bif\s*\(/g,
        /\belse\s+if\s*\(/g,
        /\bfor\s*\(/g,
        /\bwhile\s*\(/g,
        /\bdo\s*\{/g,
        /\bswitch\s*\(/g,
        /\bcase\s+[^:]+:/g,
        /\bcatch\s*\(/g,
        /\?\s*[^:]+\s*:/g,  // Ternary operator
        /&&/g,               // Logical AND
        /\|\|/g,             // Logical OR
        /\?\?/g,             // Nullish coalescing
        /\?\./g,             // Optional chaining (can branch)
    ],
    javascript: [
        /\bif\s*\(/g,
        /\belse\s+if\s*\(/g,
        /\bfor\s*\(/g,
        /\bwhile\s*\(/g,
        /\bdo\s*\{/g,
        /\bswitch\s*\(/g,
        /\bcase\s+[^:]+:/g,
        /\bcatch\s*\(/g,
        /\?\s*[^:]+\s*:/g,
        /&&/g,
        /\|\|/g,
        /\?\?/g,
        /\?\./g,
    ],
    python: [
        /\bif\s+/g,
        /\belif\s+/g,
        /\bfor\s+/g,
        /\bwhile\s+/g,
        /\bexcept\s*/g,
        /\band\b/g,
        /\bor\b/g,
        /\bif\b[^:]*\belse\b/g,  // Inline if-else expression
    ],
    java: [
        /\bif\s*\(/g,
        /\belse\s+if\s*\(/g,
        /\bfor\s*\(/g,
        /\bwhile\s*\(/g,
        /\bdo\s*\{/g,
        /\bswitch\s*\(/g,
        /\bcase\s+[^:]+:/g,
        /\bcatch\s*\(/g,
        /\?\s*[^:]+\s*:/g,
        /&&/g,
        /\|\|/g,
    ],
};

/**
 * Calculate cyclomatic complexity from function body text.
 * M = E - N + 2P where E = edges, N = nodes, P = connected components
 * Simplified: Count decision points + 1
 */
export function calculateCyclomaticComplexity(
    functionBody: string,
    language: string
): number {
    const patterns = CONTROL_FLOW_PATTERNS[language as keyof typeof CONTROL_FLOW_PATTERNS] 
        || CONTROL_FLOW_PATTERNS.javascript;
    
    // Remove strings and comments to avoid false positives
    const cleanedBody = removeStringsAndComments(functionBody, language);
    
    let complexity = 1; // Base complexity
    
    for (const pattern of patterns) {
        const matches = cleanedBody.match(pattern);
        if (matches) {
            complexity += matches.length;
        }
    }
    
    return complexity;
}

/**
 * Remove string literals and comments from code
 */
function removeStringsAndComments(code: string, language: string): string {
    // Remove single-line comments
    let cleaned = code.replace(/\/\/[^\n]*/g, '');
    
    // Remove multi-line comments
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Remove Python comments
    if (language === 'python') {
        cleaned = cleaned.replace(/#[^\n]*/g, '');
        // Remove Python docstrings
        cleaned = cleaned.replace(/'''[\s\S]*?'''/g, '');
        cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '');
    }
    
    // Remove string literals (simplified)
    cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, '``');
    
    return cleaned;
}

/**
 * Calculate lines of code (non-empty, non-comment lines)
 */
export function calculateLinesOfCode(functionBody: string, language: string): number {
    const lines = functionBody.split('\n');
    let loc = 0;
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
        if (language === 'python' && trimmed.startsWith('#')) continue;
        
        loc++;
    }
    
    return loc;
}

/**
 * Calculate maximum nesting depth
 */
export function calculateNestingDepth(functionBody: string): number {
    let maxDepth = 0;
    let currentDepth = 0;
    
    for (const char of functionBody) {
        if (char === '{' || char === '(') {
            currentDepth++;
            maxDepth = Math.max(maxDepth, currentDepth);
        } else if (char === '}' || char === ')') {
            currentDepth = Math.max(0, currentDepth - 1);
        }
    }
    
    // For Python, estimate depth from indentation
    if (!functionBody.includes('{')) {
        const lines = functionBody.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const indent = line.match(/^(\s*)/)?.[1].length || 0;
            const depth = Math.floor(indent / 4);
            maxDepth = Math.max(maxDepth, depth);
        }
    }
    
    return maxDepth;
}

/**
 * Analyze complexity of a single function
 */
export function analyzeSymbolComplexity(
    filePath: string,
    symbol: Symbol,
    sourceCode: string,
    language: string
): FunctionComplexity {
    const functionBody = sourceCode.slice(
        symbol.location.startByte,
        symbol.location.endByte
    );
    
    const cyclomaticComplexity = calculateCyclomaticComplexity(functionBody, language);
    const linesOfCode = calculateLinesOfCode(functionBody, language);
    const nestingDepth = calculateNestingDepth(functionBody);
    const parameterCount = symbol.parameters?.length || 0;
    
    return {
        filePath,
        symbolName: symbol.name,
        symbolKind: symbol.kind,
        location: {
            line: symbol.location.line,
            column: symbol.location.column,
        },
        cyclomaticComplexity,
        linesOfCode,
        parameterCount,
        nestingDepth,
        isHighComplexity: cyclomaticComplexity > COMPLEXITY_THRESHOLDS.MEDIUM,
    };
}

/**
 * Analyze complexity of all functions in a file
 */
export function analyzeFileComplexity(
    filePath: string,
    ast: ASTMetadata,
    sourceCode: string
): FunctionComplexity[] {
    const results: FunctionComplexity[] = [];
    
    const functionKinds = new Set([
        'function', 'async_function', 'arrow_function', 'generator_function',
        'method', 'constructor'
    ]);
    
    const analyzeSymbol = (symbol: Symbol) => {
        if (functionKinds.has(symbol.kind)) {
            const complexity = analyzeSymbolComplexity(filePath, symbol, sourceCode, ast.language);
            results.push(complexity);
        }
        
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
 * Analyze complexity across entire workspace
 */
export function analyzeWorkspaceComplexity(
    tree: WorkspaceTreeWithAST,
    getSourceCode: (filePath: string) => string | undefined
): ComplexitySummary {
    const astFiles = collectASTMetadata(tree);
    const allResults: FunctionComplexity[] = [];
    
    for (const { filePath, ast } of astFiles) {
        const sourceCode = getSourceCode(filePath);
        if (!sourceCode) continue;
        
        const fileResults = analyzeFileComplexity(filePath, ast, sourceCode);
        allResults.push(...fileResults);
    }
    
    if (allResults.length === 0) {
        return {
            totalFunctions: 0,
            averageCyclomaticComplexity: 0,
            maxCyclomaticComplexity: 0,
            highComplexityFunctions: 0,
            highComplexityRate: 0,
            functionsByComplexity: [],
            complexityDistribution: { low: 0, medium: 0, high: 0, veryHigh: 0 },
        };
    }
    
    const complexities = allResults.map(r => r.cyclomaticComplexity);
    const totalComplexity = complexities.reduce((sum, c) => sum + c, 0);
    const maxComplexity = Math.max(...complexities);
    const highComplexityFunctions = allResults.filter(r => r.isHighComplexity).length;
    
    // Sort by complexity descending
    const sorted = [...allResults].sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);
    
    // Calculate distribution
    const distribution = {
        low: allResults.filter(r => r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.LOW).length,
        medium: allResults.filter(r => 
            r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.LOW && 
            r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.MEDIUM
        ).length,
        high: allResults.filter(r => 
            r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.MEDIUM && 
            r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.HIGH
        ).length,
        veryHigh: allResults.filter(r => r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.HIGH).length,
    };
    
    return {
        totalFunctions: allResults.length,
        averageCyclomaticComplexity: totalComplexity / allResults.length,
        maxCyclomaticComplexity: maxComplexity,
        highComplexityFunctions,
        highComplexityRate: highComplexityFunctions / allResults.length,
        functionsByComplexity: sorted,
        complexityDistribution: distribution,
    };
}

/**
 * Format complexity summary for reporting
 */
export function formatComplexitySummary(summary: ComplexitySummary): string {
    const lines: string[] = [];
    
    lines.push(`Complexity Analysis Summary:`);
    lines.push(`  Total functions: ${summary.totalFunctions}`);
    lines.push(`  Average cyclomatic complexity: ${summary.averageCyclomaticComplexity.toFixed(2)}`);
    lines.push(`  Max cyclomatic complexity: ${summary.maxCyclomaticComplexity}`);
    lines.push(`  High complexity functions: ${summary.highComplexityFunctions} (${(summary.highComplexityRate * 100).toFixed(1)}%)`);
    
    lines.push(`\n  Complexity distribution:`);
    lines.push(`    Low (1-${COMPLEXITY_THRESHOLDS.LOW}): ${summary.complexityDistribution.low}`);
    lines.push(`    Medium (${COMPLEXITY_THRESHOLDS.LOW + 1}-${COMPLEXITY_THRESHOLDS.MEDIUM}): ${summary.complexityDistribution.medium}`);
    lines.push(`    High (${COMPLEXITY_THRESHOLDS.MEDIUM + 1}-${COMPLEXITY_THRESHOLDS.HIGH}): ${summary.complexityDistribution.high}`);
    lines.push(`    Very High (>${COMPLEXITY_THRESHOLDS.HIGH}): ${summary.complexityDistribution.veryHigh}`);
    
    if (summary.functionsByComplexity.length > 0) {
        const topComplex = summary.functionsByComplexity.slice(0, 10);
        lines.push(`\n  Top complex functions:`);
        for (const func of topComplex) {
            lines.push(`    ${func.symbolName} (${func.filePath}:${func.location.line}): CC=${func.cyclomaticComplexity}, LOC=${func.linesOfCode}`);
        }
    }
    
    return lines.join('\n');
}
