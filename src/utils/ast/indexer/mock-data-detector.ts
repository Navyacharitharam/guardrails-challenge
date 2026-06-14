/**
 * Mock Data Detector
 * 
 * Detects hardcoded mock/sample data in function bodies and constant initializers.
 * Used to distinguish real implementations from placeholder/demo code.
 */

import type { MockData } from './output-schema';

/**
 * Result of mock data analysis
 */
export interface MockDataAnalysis {
    hasMockData: boolean;
    confidence: number;
    role: 'produces' | 'consumes' | 'both' | 'none';
    indicators: string[];
    dataSource: 'hardcoded' | 'computed' | 'external' | 'unknown';
}

// Patterns indicating mock/sample data
const MOCK_NAME_PATTERNS = [
    /\b(mock|fake|dummy|sample|test|stub|fixture|placeholder)\w*/i,
];

const LOREM_PATTERN = /lorem\s+ipsum|dolor\s+sit\s+amet/i;

const TEST_EMAIL_PATTERN = /['"`](test|example|sample|fake|dummy|mock)\S*@(example|test|mock|fake)\.(com|org|net)['"`]/i;

const GENERIC_EMAIL_PATTERN = /['"`]\w+@example\.(com|org|net)['"`]/i;

const TEST_NAME_PATTERNS = [
    /['"`](John|Jane|Bob|Alice|Test|Sample|Example)\s+(Doe|Smith|User|Person|Customer)['"`]/i,
    /['"`](User|Customer|Admin|Test)\s*\d*['"`]/i,
];

const PLACEHOLDER_URL_PATTERNS = [
    /['"`]https?:\/\/(www\.)?(example\.com|placeholder\.com|test\.com|localhost)/i,
    /['"`]https?:\/\/github\.com['"`]\s*[,}]/i, // Generic github.com without specific path
    /['"`]https?:\/\/api\.example/i,
    /['"`]#['"`]/,  // Placeholder href
];

const HARDCODED_DATE_PATTERNS = [
    /new\s+Date\s*\(\s*['"`]\d{4}-\d{2}-\d{2}/,
    /['"`]\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,  // ISO date strings
    /['"`](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}['"`]/i,
];

const MOCK_COMMENT_PATTERNS = [
    /\/\/\s*(mock|fake|dummy|sample|test|placeholder|todo:\s*replace)/i,
    /\/\*\s*(mock|fake|dummy|sample|test|placeholder)/i,
    /\/\/\s*for\s+(demo|poc|testing|development)/i,
];

// Patterns indicating real data sources (reduce mock confidence)
const EXTERNAL_DATA_PATTERNS = [
    /\bfetch\s*\(/,
    /\baxios\s*\./,
    /\.\s*(get|post|put|delete|patch)\s*\(/,
    /\bawait\s+\w+\.(query|find|select|fetch|get|load)/,
    /\bprisma\s*\./,
    /\bdb\s*\./,
    /\bapi\s*\./i,
    /process\.env\./,
    /\bgetenv\s*\(/,
    /\bos\.environ/,
];

const COMPUTED_DATA_PATTERNS = [
    /\breturn\s+\w+\s*\(/,  // Return function call result
    /\breturn\s+await\s+/,
    /\.map\s*\(\s*\(/,
    /\.filter\s*\(\s*\(/,
    /\.reduce\s*\(\s*\(/,
];

/**
 * Count object literals in an array initializer.
 * Uses a simple counting approach to avoid regex catastrophic backtracking.
 */
function countObjectsInArray(content: string): number {
    // Simple heuristic: count patterns like `{ "key"` or `{ key:` that indicate object starts in arrays
    // This avoids complex nested regex that can cause catastrophic backtracking
    const objectStartPattern = /\[\s*\{|\},?\s*\{/g;
    const matches = content.match(objectStartPattern);
    return matches ? matches.length : 0;
}

/**
 * Check if content has sequential IDs like id: "1", id: "2", etc.
 */
function hasSequentialIds(content: string): boolean {
    const idMatches = content.match(/['"`]?(?:id|key)['"`]?\s*:\s*['"`]?(\d+|[a-z]\d*)['"`]?/gi);
    if (!idMatches || idMatches.length < 2) return false;
    
    // Extract the ID values
    const ids: number[] = [];
    for (const match of idMatches) {
        const numMatch = match.match(/(\d+)/);
        if (numMatch) {
            ids.push(parseInt(numMatch[1], 10));
        }
    }
    
    // Check for sequential pattern
    if (ids.length >= 2) {
        const sorted = [...ids].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] - sorted[i - 1] === 1) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Check if a variable name suggests mock data
 */
function isMockVariableName(name: string): boolean {
    return MOCK_NAME_PATTERNS.some(p => p.test(name));
}

// Maximum body size to analyze (prevent regex catastrophic backtracking)
const MAX_BODY_SIZE_FOR_ANALYSIS = 10000;

/**
 * Analyze content for mock data patterns
 */
export function analyzeMockData(
    bodyText: string,
    symbolName: string,
    callTargets: string[] = [],
    _language = 'typescript'
): MockDataAnalysis {
    const indicators: string[] = [];
    let confidence = 0;
    let role: MockDataAnalysis['role'] = 'none';
    let dataSource: MockDataAnalysis['dataSource'] = 'unknown';
    
    // Truncate large bodies to prevent regex catastrophic backtracking
    // Most mock data patterns appear early in the body anyway
    const normalizedBody = bodyText && bodyText.length > MAX_BODY_SIZE_FOR_ANALYSIS
        ? bodyText.slice(0, MAX_BODY_SIZE_FOR_ANALYSIS)
        : (bodyText || '');
    
    // Check symbol name
    if (isMockVariableName(symbolName)) {
        indicators.push(`mock-like name: ${symbolName}`);
        confidence += 0.25;
        role = 'produces';
    }
    
    // Check for lorem ipsum
    if (LOREM_PATTERN.test(normalizedBody)) {
        indicators.push('lorem ipsum placeholder text');
        confidence += 0.35;
        role = 'produces';
    }
    
    // Check for test emails
    if (TEST_EMAIL_PATTERN.test(normalizedBody)) {
        indicators.push('test email pattern (test@example.com)');
        confidence += 0.25;
        role = role === 'none' ? 'produces' : role;
    } else if (GENERIC_EMAIL_PATTERN.test(normalizedBody)) {
        indicators.push('generic example email');
        confidence += 0.15;
        role = role === 'none' ? 'produces' : role;
    }
    
    // Check for test names
    for (const pattern of TEST_NAME_PATTERNS) {
        if (pattern.test(normalizedBody)) {
            indicators.push('test-like person name (John Doe, Test User)');
            confidence += 0.20;
            role = role === 'none' ? 'produces' : role;
            break;
        }
    }
    
    // Check for placeholder URLs
    for (const pattern of PLACEHOLDER_URL_PATTERNS) {
        if (pattern.test(normalizedBody)) {
            indicators.push('placeholder URL (example.com, localhost)');
            confidence += 0.15;
            role = role === 'none' ? 'produces' : role;
            break;
        }
    }
    
    // Check for sequential IDs
    if (hasSequentialIds(normalizedBody)) {
        indicators.push('sequential IDs (1, 2, 3...)');
        confidence += 0.20;
        role = role === 'none' ? 'produces' : role;
    }
    
    // Check for hardcoded object arrays
    const objectCount = countObjectsInArray(normalizedBody);
    if (objectCount >= 3) {
        indicators.push(`hardcoded object array (${objectCount} items)`);
        confidence += 0.25;
        role = role === 'none' ? 'produces' : role;
        dataSource = 'hardcoded';
    } else if (objectCount >= 2) {
        indicators.push(`small object array (${objectCount} items)`);
        confidence += 0.10;
    }
    
    // Check for hardcoded dates
    for (const pattern of HARDCODED_DATE_PATTERNS) {
        if (pattern.test(normalizedBody)) {
            indicators.push('hardcoded date literals');
            confidence += 0.10;
            role = role === 'none' ? 'produces' : role;
            break;
        }
    }
    
    // Check for mock comments
    for (const pattern of MOCK_COMMENT_PATTERNS) {
        if (pattern.test(normalizedBody)) {
            indicators.push('mock/placeholder comment');
            confidence += 0.20;
            role = role === 'none' ? 'produces' : role;
            break;
        }
    }
    
    // Check for consuming mock variables
    const mockVarUsage = normalizedBody.match(/\b(mock|fake|dummy|sample|test)\w*\s*[=(.]/gi);
    if (mockVarUsage && mockVarUsage.length > 0) {
        indicators.push(`uses mock-named variables (${mockVarUsage.length} occurrences)`);
        confidence += 0.15;
        role = role === 'produces' ? 'both' : 'consumes';
    }
    
    // Negative indicators: real data sources
    let hasExternalSource = false;
    for (const pattern of EXTERNAL_DATA_PATTERNS) {
        if (pattern.test(normalizedBody)) {
            hasExternalSource = true;
            dataSource = 'external';
            confidence -= 0.30;
            break;
        }
    }
    
    // Check call targets for API/fetch calls
    const externalCallTargets = callTargets.filter(t => 
        /fetch|axios|api|service|repository|client/i.test(t)
    );
    if (externalCallTargets.length > 0) {
        hasExternalSource = true;
        dataSource = 'external';
        confidence -= 0.25;
    }
    
    // Check for computed data patterns
    if (!hasExternalSource) {
        for (const pattern of COMPUTED_DATA_PATTERNS) {
            if (pattern.test(normalizedBody)) {
                if (dataSource === 'unknown') {
                    dataSource = 'computed';
                }
                confidence -= 0.15;
                break;
            }
        }
    }
    
    // Determine final data source
    if (dataSource === 'unknown' && indicators.length > 0) {
        dataSource = 'hardcoded';
    }
    
    // Clamp confidence
    confidence = Math.max(0, Math.min(1, confidence));
    
    // Determine if it has mock data
    const hasMockData = confidence > 0.3 && indicators.length > 0;
    
    // Reset role if no mock data
    if (!hasMockData) {
        role = 'none';
    }
    
    return {
        hasMockData,
        confidence: Math.round(confidence * 100) / 100,
        role,
        indicators,
        dataSource,
    };
}

/**
 * Convert analysis result to schema-compatible MockData
 */
export function toMockDataSchema(analysis: MockDataAnalysis): MockData {
    return {
        hasMockData: analysis.hasMockData,
        mockDataConfidence: analysis.confidence,
        mockDataRole: analysis.role,
        mockIndicators: analysis.indicators,
        dataSource: analysis.dataSource,
    };
}

/**
 * Quick check if mock data detection should run for a symbol kind
 */
export function shouldAnalyzeMockData(kind: string): boolean {
    const analyzableKinds = new Set([
        'function',
        'async_function',
        'arrow_function',
        'method',
        'constant',
        'variable',
        'property',
    ]);
    return analyzableKinds.has(kind);
}
