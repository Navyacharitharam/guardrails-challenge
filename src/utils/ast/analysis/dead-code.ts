import type { Symbol, ASTMetadata, CallSite } from '../schema';
import type { WorkspaceTreeWithAST } from '../file-tree-integration';
import { collectASTMetadata } from '../file-tree-integration';

/**
 * Information about a potentially dead function
 */
export interface DeadCodeResult {
    filePath: string;
    symbolName: string;
    symbolKind: string;
    location: { line: number; column: number };
    isExported: boolean;
    callCount: number;
    isEntryPoint: boolean;
    reason: string;
    confidence: number;
}

/**
 * Summary of dead code analysis
 */
export interface DeadCodeSummary {
    totalFunctions: number;
    deadFunctions: number;
    deadCodeRate: number;
    deadCodeByFile: Map<string, DeadCodeResult[]>;
    entryPoints: string[];
}

/**
 * Entry point patterns that should not be flagged as dead code
 */
const ENTRY_POINT_PATTERNS = [
    /^main$/i,
    /^index$/i,
    /^app$/i,
    /^handler$/i,
    /^run$/i,
    /^start$/i,
    /^initialize$/i,
    /^init$/i,
    /^setup$/i,
    /^bootstrap$/i,
    /^configure$/i,
    /^__init__$/,           // Python
    /^__main__$/,           // Python
    /^if\s*__name__/,       // Python main check
    /^test/i,               // Test functions
    /^spec/i,               // Spec functions
    /^describe$/i,          // Test suites
    /^it$/i,                // Test cases
    /^before/i,             // Test lifecycle
    /^after/i,              // Test lifecycle
];

/**
 * Build a call graph from AST metadata
 */
export function buildCallGraph(
    astFiles: { filePath: string; ast: ASTMetadata }[]
): {
    callers: Map<string, Set<string>>;  // function -> functions that call it
    callees: Map<string, Set<string>>;  // function -> functions it calls
    allFunctions: Map<string, { filePath: string; symbol: Symbol }>;
} {
    const callers = new Map<string, Set<string>>();
    const callees = new Map<string, Set<string>>();
    const allFunctions = new Map<string, { filePath: string; symbol: Symbol }>();
    
    // First pass: collect all function definitions
    for (const { filePath, ast } of astFiles) {
        const collectFunctions = (symbol: Symbol, parentName?: string) => {
            const functionKinds = new Set([
                'function', 'async_function', 'arrow_function', 'generator_function',
                'method', 'constructor'
            ]);
            
            if (functionKinds.has(symbol.kind)) {
                const fullName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
                const key = `${filePath}:${fullName}`;
                allFunctions.set(key, { filePath, symbol });
                callers.set(key, new Set());
                callees.set(key, new Set());
            }
            
            if (symbol.members) {
                for (const member of symbol.members) {
                    collectFunctions(member, symbol.name);
                }
            }
        };
        
        for (const symbol of ast.symbols) {
            collectFunctions(symbol);
        }
    }
    
    // Second pass: build call relationships from call sites
    for (const { filePath, ast } of astFiles) {
        if (!ast.callSites) continue;
        
        // Find the enclosing function for each call site
        for (const callSite of ast.callSites) {
            const calledName = callSite.callee;
            
            // Find all potential matches for the called function
            for (const [key, { symbol }] of allFunctions) {
                if (symbol.name === calledName) {
                    // Find the caller function (function containing this call site)
                    const callerKey = findEnclosingFunction(filePath, ast, callSite);
                    if (callerKey) {
                        callers.get(key)?.add(callerKey);
                        callees.get(callerKey)?.add(key);
                    }
                }
            }
        }
    }
    
    return { callers, callees, allFunctions };
}

/**
 * Find the enclosing function for a call site
 */
function findEnclosingFunction(
    filePath: string,
    ast: ASTMetadata,
    callSite: CallSite
): string | null {
    const callLine = callSite.location.line;
    
    const functionKinds = new Set([
        'function', 'async_function', 'arrow_function', 'generator_function',
        'method', 'constructor'
    ]);
    
    interface MatchInfo { name: string; startLine: number; endLine: number }
    let bestMatch: MatchInfo | null = null;
    
    const findInSymbol = (symbol: Symbol, parentName?: string): void => {
        if (functionKinds.has(symbol.kind)) {
            const startLine = symbol.location.line;
            // Estimate end line from next symbol or file end
            const endLine = startLine + 100; // Rough estimate
            
            if (callLine >= startLine && callLine <= endLine) {
                if (!bestMatch || startLine > bestMatch.startLine) {
                    const fullName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
                    bestMatch = { name: fullName, startLine, endLine };
                }
            }
        }
        
        if (symbol.members) {
            for (const member of symbol.members) {
                findInSymbol(member, symbol.name);
            }
        }
    };
    
    for (const symbol of ast.symbols) {
        findInSymbol(symbol);
    }
    
    return bestMatch !== null ? `${filePath}:${bestMatch.name}` : null;
}

/**
 * Check if a function is an entry point
 */
function isEntryPoint(symbol: Symbol, filePath: string): boolean {
    // Exported functions are potential entry points
    if (symbol.isExported) {
        return true;
    }
    
    // Check against entry point patterns
    for (const pattern of ENTRY_POINT_PATTERNS) {
        if (pattern.test(symbol.name)) {
            return true;
        }
    }
    
    // Main files are entry points
    if (filePath.includes('index.') || filePath.includes('main.') || filePath.includes('app.')) {
        return true;
    }
    
    return false;
}

/**
 * Analyze workspace for dead code
 */
export function analyzeDeadCode(tree: WorkspaceTreeWithAST): DeadCodeSummary {
    const astFiles = collectASTMetadata(tree);
    const { callers, allFunctions } = buildCallGraph(astFiles);
    
    const deadCodeByFile = new Map<string, DeadCodeResult[]>();
    const entryPoints: string[] = [];
    let totalFunctions = 0;
    let deadFunctions = 0;
    
    for (const [key, { filePath, symbol }] of allFunctions) {
        totalFunctions++;
        
        const callCount = callers.get(key)?.size || 0;
        const isEntry = isEntryPoint(symbol, filePath);
        
        if (isEntry) {
            entryPoints.push(key);
        }
        
        // A function is potentially dead if:
        // 1. It's not exported
        // 2. It's not an entry point
        // 3. It's not called by any other function
        const isDead = !symbol.isExported && !isEntry && callCount === 0;
        
        if (isDead) {
            deadFunctions++;
            
            const result: DeadCodeResult = {
                filePath,
                symbolName: symbol.name,
                symbolKind: symbol.kind,
                location: {
                    line: symbol.location.line,
                    column: symbol.location.column,
                },
                isExported: symbol.isExported || false,
                callCount,
                isEntryPoint: isEntry,
                reason: 'Function is not exported and has no callers',
                confidence: 0.7, // Conservative estimate
            };
            
            const existing = deadCodeByFile.get(filePath) || [];
            existing.push(result);
            deadCodeByFile.set(filePath, existing);
        }
    }
    
    return {
        totalFunctions,
        deadFunctions,
        deadCodeRate: totalFunctions > 0 ? deadFunctions / totalFunctions : 0,
        deadCodeByFile,
        entryPoints,
    };
}

/**
 * Format dead code summary for reporting
 */
export function formatDeadCodeSummary(summary: DeadCodeSummary): string {
    const lines: string[] = [];
    
    lines.push(`Dead Code Analysis Summary:`);
    lines.push(`  Total functions: ${summary.totalFunctions}`);
    lines.push(`  Potentially dead functions: ${summary.deadFunctions}`);
    lines.push(`  Dead code rate: ${(summary.deadCodeRate * 100).toFixed(1)}%`);
    lines.push(`  Entry points identified: ${summary.entryPoints.length}`);
    
    if (summary.deadFunctions > 0) {
        lines.push(`\n  Dead code by file:`);
        for (const [filePath, results] of summary.deadCodeByFile) {
            lines.push(`    ${filePath}: ${results.length} potentially dead function(s)`);
            for (const result of results) {
                lines.push(`      - ${result.symbolName} (line ${result.location.line})`);
            }
        }
    }
    
    return lines.join('\n');
}
