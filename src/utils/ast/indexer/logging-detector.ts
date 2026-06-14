import type { Language } from '../schema';

/**
 * Language-specific logging patterns for detection.
 * Includes both console/print statements and logger framework calls.
 */
const LOGGING_PATTERNS: Record<Language, RegExp[]> = {
    typescript: [
        // Console methods
        /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table|group|groupEnd|time|timeEnd|assert)\s*\(/g,
        // Common logger frameworks
        /\blogger\s*\.\s*(log|info|warn|error|debug|trace|verbose|silly)\s*\(/g,
        /\bwinston\s*\.\s*(log|info|warn|error|debug)\s*\(/g,
        /\bpino\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        /\bbunyan\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        /\blog4js\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        // Debug module
        /\bdebug\s*\(/g,
    ],
    javascript: [
        // Console methods
        /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table|group|groupEnd|time|timeEnd|assert)\s*\(/g,
        // Common logger frameworks
        /\blogger\s*\.\s*(log|info|warn|error|debug|trace|verbose|silly)\s*\(/g,
        /\bwinston\s*\.\s*(log|info|warn|error|debug)\s*\(/g,
        /\bpino\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        /\bbunyan\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        /\blog4js\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        // Debug module
        /\bdebug\s*\(/g,
    ],
    python: [
        // Built-in print
        /\bprint\s*\(/g,
        // Logging module
        /\blogging\s*\.\s*(info|warning|error|debug|critical|exception|log)\s*\(/g,
        /\blogger\s*\.\s*(info|warning|error|debug|critical|exception|log)\s*\(/g,
        // Common frameworks
        /\bloguru\s*\.\s*(info|warning|error|debug|critical|trace|success)\s*\(/g,
        /\bstructlog\s*\.\s*(info|warning|error|debug|critical)\s*\(/g,
    ],
    java: [
        // System.out/err
        /\bSystem\s*\.\s*(out|err)\s*\.\s*(print|println|printf)\s*\(/g,
        // SLF4J / Log4j / java.util.logging
        /\blogger\s*\.\s*(info|warn|error|debug|trace|fatal|log|fine|finer|finest|severe|warning)\s*\(/g,
        /\bLOGGER\s*\.\s*(info|warn|error|debug|trace|fatal|log)\s*\(/g,
        /\blog\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
        // Log4j2
        /\bLogManager\s*\.\s*getLogger\s*\(/g,
    ],
};

/**
 * Language-specific error handling patterns
 */
const ERROR_HANDLING_PATTERNS: Record<Language, RegExp[]> = {
    typescript: [
        /\btry\s*\{/g,
        /\bcatch\s*\(/g,
        /\bfinally\s*\{/g,
        /\.catch\s*\(/g,
        /\bonError\s*[=:]/g,
    ],
    javascript: [
        /\btry\s*\{/g,
        /\bcatch\s*\(/g,
        /\bfinally\s*\{/g,
        /\.catch\s*\(/g,
        /\bonError\s*[=:]/g,
    ],
    python: [
        /\btry\s*:/g,
        /\bexcept\s*/g,
        /\bfinally\s*:/g,
        /\braise\s+/g,
    ],
    java: [
        /\btry\s*\{/g,
        /\bcatch\s*\(/g,
        /\bfinally\s*\{/g,
        /\bthrows\s+/g,
    ],
};

/**
 * Detect if code contains logging statements
 */
export function detectLogging(code: string, language: Language): boolean {
    const patterns = LOGGING_PATTERNS[language];
    if (!patterns) {
        return false;
    }

    // Remove string literals and comments to avoid false positives
    const cleanedCode = removeStringsAndComments(code, language);

    for (const pattern of patterns) {
        // Reset regex state
        pattern.lastIndex = 0;
        if (pattern.test(cleanedCode)) {
            return true;
        }
    }

    return false;
}

/**
 * Detect if code contains error handling
 */
export function detectErrorHandling(code: string, language: Language): boolean {
    const patterns = ERROR_HANDLING_PATTERNS[language];
    if (!patterns) {
        return false;
    }

    const cleanedCode = removeStringsAndComments(code, language);

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(cleanedCode)) {
            return true;
        }
    }

    return false;
}

/**
 * Count logging statements in code
 */
export function countLoggingStatements(code: string, language: Language): number {
    const patterns = LOGGING_PATTERNS[language];
    if (!patterns) {
        return 0;
    }

    const cleanedCode = removeStringsAndComments(code, language);
    let count = 0;

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        const matches = cleanedCode.match(pattern);
        if (matches) {
            count += matches.length;
        }
    }

    return count;
}

/**
 * Remove string literals and comments from code to avoid false positives
 */
function removeStringsAndComments(code: string, language: Language): string {
    let cleaned = code;

    // Remove single-line comments
    if (language === 'python') {
        cleaned = cleaned.replace(/#[^\n]*/g, '');
        // Remove Python docstrings
        cleaned = cleaned.replace(/'''[\s\S]*?'''/g, '');
        cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '');
    } else {
        cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
    }

    // Remove multi-line comments (C-style)
    if (language !== 'python') {
        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    }

    // Remove string literals (simplified - may not handle all edge cases)
    cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, '``');

    return cleaned;
}

/**
 * Get logging patterns for a language (for external use/testing)
 */
export function getLoggingPatterns(language: Language): RegExp[] {
    return LOGGING_PATTERNS[language] || [];
}

/**
 * Get error handling patterns for a language
 */
export function getErrorHandlingPatterns(language: Language): RegExp[] {
    return ERROR_HANDLING_PATTERNS[language] || [];
}
