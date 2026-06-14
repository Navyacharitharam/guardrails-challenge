/**
 * Exclusion pattern matcher for workspace file tree filtering.
 *
 * Supports glob-like patterns:
 * - Exact match: 'node_modules' matches only 'node_modules'
 * - Directory wildcard: 'node_modules/**' matches 'node_modules' and all descendants
 * - Prefix wildcard: '._*' matches files starting with '._'
 * - Extension wildcard: '*.pyc' matches files ending with '.pyc'
 * - Single segment wildcard: 'test-*' matches 'test-foo', 'test-bar'
 *
 * Note: This is a lightweight implementation that doesn't require external
 * dependencies like minimatch or picomatch. For complex glob patterns,
 * consider upgrading to a full glob library.
 */

export interface ExclusionMatcher {
    /** Test if a path should be excluded */
    shouldExclude: (path: string) => boolean;
    /** Test if a path should be excluded, with include overrides */
    shouldExcludeWithOverrides: (path: string) => boolean;
    /** Get the patterns being used */
    patterns: string[];
    /** Get the include override patterns */
    includeOverrides: string[];
}

export interface ExclusionMatcherOptions {
    /** Patterns to exclude */
    patterns: string[];
    /** Patterns that override exclusion (force include) */
    includeOverrides?: string[];
    /** If true, match case-insensitively (default: false) */
    caseInsensitive?: boolean;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: *, **, ?, and character classes [abc].
 */
function patternToRegex(pattern: string, caseInsensitive: boolean): RegExp {
    // Escape special regex characters except our glob characters
    let regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
        .replace(/\*\*/g, '{{GLOBSTAR}}') // Placeholder for **
        .replace(/\*/g, '[^/]*') // * matches anything except /
        .replace(/\?/g, '[^/]') // ? matches single char except /
        .replace(/{{GLOBSTAR}}/g, '.*'); // ** matches anything including /

    // Handle patterns that should match a directory and all its contents
    // e.g., 'node_modules' should match 'node_modules', 'node_modules/', 'node_modules/foo'
    if (!pattern.includes('/') && !pattern.includes('*')) {
        // Simple name pattern - match as directory or exact file
        regexStr = `(^|/)${regexStr}($|/)`;
    } else if (pattern.endsWith('/**')) {
        // Already handles subdirectories via .*
    } else if (!pattern.includes('*') && !pattern.endsWith('/')) {
        // Exact path without wildcards - match exactly or as prefix
        regexStr = `(^|/)${regexStr}($|/)`;
    } else {
        // Pattern with wildcards - anchor to start or after /
        regexStr = `(^|/)${regexStr}($|/)`;
    }

    const flags = caseInsensitive ? 'i' : '';
    return new RegExp(regexStr, flags);
}

/**
 * Check if a path matches a single pattern.
 */
function matchesPattern(
    path: string,
    pattern: string,
    caseInsensitive: boolean,
): boolean {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, '/');

    // Handle prefix patterns like '._*'
    if (pattern.startsWith('._') || pattern.match(/^\.\w+\*/)) {
        const prefix = pattern.replace(/\*$/, '');
        const fileName = normalizedPath.split('/').pop() || '';
        if (caseInsensitive) {
            return fileName.toLowerCase().startsWith(prefix.toLowerCase());
        }
        return fileName.startsWith(prefix);
    }

    // Handle extension patterns like '*.pyc'
    if (pattern.startsWith('*.') && !pattern.includes('/')) {
        const extension = pattern.slice(1); // Remove leading *
        if (caseInsensitive) {
            return normalizedPath.toLowerCase().endsWith(extension.toLowerCase());
        }
        return normalizedPath.endsWith(extension);
    }

    // Handle simple name patterns (no wildcards, no slashes)
    if (!pattern.includes('*') && !pattern.includes('/') && !pattern.includes('?')) {
        const pathParts = normalizedPath.split('/');
        if (caseInsensitive) {
            const lowerPattern = pattern.toLowerCase();
            return pathParts.some(part => part.toLowerCase() === lowerPattern);
        }
        return pathParts.includes(pattern);
    }

    // Use regex for complex patterns
    const regex = patternToRegex(pattern, caseInsensitive);
    return regex.test(normalizedPath);
}

/**
 * Create an exclusion matcher from a list of patterns.
 */
export function createExclusionMatcher(options: ExclusionMatcherOptions): ExclusionMatcher {
    const {
        patterns,
        includeOverrides = [],
        caseInsensitive = false,
    } = options;

    // Dedupe and filter empty patterns
    const uniquePatterns = [...new Set(patterns)].filter(p => p.trim().length > 0);
    const uniqueOverrides = [...new Set(includeOverrides)].filter(p => p.trim().length > 0);

    function shouldExclude(path: string): boolean {
        for (const pattern of uniquePatterns) {
            if (matchesPattern(path, pattern, caseInsensitive)) {
                return true;
            }
        }
        return false;
    }

    function shouldInclude(path: string): boolean {
        for (const pattern of uniqueOverrides) {
            if (matchesPattern(path, pattern, caseInsensitive)) {
                return true;
            }
        }
        return false;
    }

    function shouldExcludeWithOverrides(path: string): boolean {
        // If explicitly included, don't exclude
        if (shouldInclude(path)) {
            return false;
        }
        return shouldExclude(path);
    }

    return {
        shouldExclude,
        shouldExcludeWithOverrides,
        patterns: uniquePatterns,
        includeOverrides: uniqueOverrides,
    };
}

/**
 * Quick check if a path should be excluded without creating a full matcher.
 * Useful for one-off checks.
 */
export function isPathExcluded(
    path: string,
    patterns: string[],
    caseInsensitive = false,
): boolean {
    for (const pattern of patterns) {
        if (matchesPattern(path, pattern, caseInsensitive)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a file/directory name (not full path) matches common exclusion patterns.
 * This is a fast check for the most common cases.
 */
export function isCommonExcludedName(name: string): boolean {
    // macOS metadata
    if (name === '__MACOSX' || name.startsWith('._') || name === '.DS_Store') {
        return true;
    }

    // Version control
    if (name === '.git' || name === '.svn' || name === '.hg') {
        return true;
    }

    // Dependencies
    if (name === 'node_modules' || name === '__pycache__' || name === '.venv' || name === 'venv') {
        return true;
    }

    // IDE
    if (name === '.idea' || name === '.vscode' || name === '.vs') {
        return true;
    }

    // Common build outputs
    if (name === 'dist' || name === 'build' || name === '.next' || name === '.nuxt') {
        return true;
    }

    return false;
}

/**
 * Check if a path is under a commonly excluded directory.
 * This is a fast check without pattern matching.
 */
export function isUnderExcludedDirectory(path: string): boolean {
    const normalizedPath = path.replace(/\\/g, '/');
    const excludedDirs = [
        '__MACOSX/',
        'node_modules/',
        '.git/',
        '.svn/',
        '.hg/',
        '__pycache__/',
        '.venv/',
        'venv/',
        '.idea/',
        '.vscode/',
        '.vs/',
        'dist/',
        'build/',
        '.next/',
        '.nuxt/',
        'coverage/',
        '.nyc_output/',
        'target/',
    ];

    for (const dir of excludedDirs) {
        if (normalizedPath.includes(`/${dir}`) || normalizedPath.startsWith(dir)) {
            return true;
        }
    }

    return false;
}
