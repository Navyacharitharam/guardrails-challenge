/**
 * Documentation and clarity analysis for function-like symbols.
 * Analyzes comment density, API documentation quality, and naming conventions.
 */

import type { Documentation } from './output-schema';

/**
 * Common English words used in programming (expanded dictionary)
 */
const COMMON_WORDS = new Set([
    // Verbs
    'get', 'set', 'add', 'remove', 'delete', 'create', 'update', 'find', 'search',
    'fetch', 'load', 'save', 'store', 'read', 'write', 'parse', 'format', 'convert',
    'transform', 'map', 'filter', 'reduce', 'sort', 'merge', 'split', 'join', 'trim',
    'validate', 'check', 'verify', 'test', 'assert', 'ensure', 'require', 'expect',
    'handle', 'process', 'execute', 'run', 'start', 'stop', 'init', 'initialize',
    'setup', 'configure', 'build', 'compile', 'render', 'display', 'show', 'hide',
    'enable', 'disable', 'toggle', 'switch', 'change', 'modify', 'reset', 'clear',
    'open', 'close', 'connect', 'disconnect', 'send', 'receive', 'emit', 'listen',
    'subscribe', 'unsubscribe', 'publish', 'dispatch', 'notify', 'trigger', 'fire',
    'log', 'debug', 'info', 'warn', 'error', 'throw', 'catch', 'try', 'retry',
    'wait', 'delay', 'timeout', 'cancel', 'abort', 'resolve', 'reject', 'promise',
    'async', 'await', 'sync', 'lock', 'unlock', 'acquire', 'release',
    'clone', 'copy', 'move', 'swap', 'replace', 'insert', 'append', 'prepend',
    'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'flatten',
    'group', 'chunk', 'batch', 'queue', 'dequeue', 'enqueue', 'stack',
    'encode', 'decode', 'encrypt', 'decrypt', 'hash', 'sign', 'verify',
    'serialize', 'deserialize', 'stringify', 'parse', 'marshal', 'unmarshal',
    'import', 'export', 'include', 'exclude', 'inject', 'extract', 'embed',
    'mount', 'unmount', 'attach', 'detach', 'bind', 'unbind', 'wrap', 'unwrap',
    'apply', 'call', 'invoke', 'evaluate', 'compute', 'calculate', 'derive',
    'compare', 'diff', 'match', 'equals', 'contains', 'includes', 'exists',
    'is', 'has', 'can', 'should', 'will', 'must', 'may', 'might',

    // Nouns
    'data', 'value', 'result', 'output', 'input', 'response', 'request', 'query',
    'item', 'element', 'node', 'child', 'parent', 'sibling', 'root', 'leaf',
    'list', 'array', 'object', 'map', 'set', 'queue', 'stack', 'tree', 'graph',
    'key', 'index', 'id', 'name', 'label', 'title', 'text', 'content', 'body',
    'type', 'kind', 'class', 'interface', 'struct', 'enum', 'union', 'tuple',
    'function', 'method', 'callback', 'handler', 'listener', 'observer', 'hook',
    'event', 'action', 'state', 'status', 'mode', 'flag', 'option', 'config',
    'setting', 'preference', 'property', 'attribute', 'field', 'member', 'slot',
    'path', 'url', 'uri', 'file', 'folder', 'directory', 'route', 'endpoint',
    'user', 'account', 'profile', 'session', 'token', 'auth', 'permission', 'role',
    'message', 'notification', 'alert', 'warning', 'error', 'exception', 'fault',
    'context', 'scope', 'environment', 'runtime', 'instance', 'factory', 'builder',
    'service', 'client', 'server', 'worker', 'manager', 'controller', 'provider',
    'repository', 'store', 'cache', 'buffer', 'pool', 'registry', 'container',
    'schema', 'model', 'entity', 'record', 'row', 'column', 'table', 'database',
    'connection', 'socket', 'stream', 'channel', 'pipe', 'bridge', 'adapter',
    'source', 'target', 'destination', 'origin', 'base', 'default', 'fallback',
    'count', 'size', 'length', 'width', 'height', 'depth', 'level', 'degree',
    'min', 'max', 'sum', 'avg', 'total', 'limit', 'offset', 'range', 'bounds',
    'start', 'end', 'begin', 'finish', 'first', 'last', 'next', 'prev', 'current',
    'old', 'new', 'temp', 'tmp', 'local', 'global', 'public', 'private', 'internal',

    // Adjectives/Modifiers
    'valid', 'invalid', 'active', 'inactive', 'enabled', 'disabled', 'visible', 'hidden',
    'empty', 'full', 'null', 'undefined', 'true', 'false', 'yes', 'no', 'ok', 'fail',
    'success', 'failure', 'pending', 'complete', 'done', 'ready', 'loading', 'loaded',
    'async', 'sync', 'lazy', 'eager', 'static', 'dynamic', 'mutable', 'immutable',
    'optional', 'required', 'default', 'custom', 'native', 'external', 'internal',
    'primary', 'secondary', 'main', 'sub', 'meta', 'raw', 'parsed', 'formatted',

    // Common abbreviations that are acceptable
    'str', 'num', 'int', 'bool', 'arr', 'obj', 'fn', 'func', 'cb', 'err', 'res', 'req',
    'src', 'dest', 'dst', 'opts', 'args', 'params', 'props', 'attrs', 'ctx', 'env',
    'db', 'api', 'http', 'https', 'tcp', 'udp', 'ws', 'wss', 'ssh', 'ftp',
    'json', 'xml', 'html', 'css', 'sql', 'jwt', 'uuid', 'guid', 'md5', 'sha',
    'utf', 'ascii', 'base64', 'gzip', 'zip', 'tar',
    'dom', 'ui', 'ux', 'io', 'fs', 'os', 'cpu', 'gpu', 'ram', 'rom',
    'ref', 'refs', 'el', 'elem', 'doc', 'docs', 'spec', 'specs', 'impl',
    'info', 'meta', 'desc', 'msg', 'txt', 'cfg', 'conf',
]);

/**
 * Patterns that indicate poor naming
 */
const POOR_NAMING_PATTERNS = [
    /^[a-z]$/,                          // Single lowercase letter
    /^[A-Z]$/,                          // Single uppercase letter
    /^[a-z]{1,2}\d*$/,                  // 1-2 letters optionally with numbers (x1, ab2)
    /^_+$/,                             // Just underscores
    /^temp\d*$/i,                       // temp, temp1, temp2
    /^foo|bar|baz|qux$/i,               // Placeholder names
    /^test\d*$/i,                       // test, test1 (when not in test file)
    /^xxx+$/i,                          // xxx, xxxx
    /^data\d+$/i,                       // data1, data2 (numbered data)
    /^var\d*$/i,                        // var, var1
    /^val\d*$/i,                        // val, val1
    /^tmp\d*$/i,                        // tmp, tmp1
];

/**
 * Exception patterns - these single/short names are acceptable
 */
const ACCEPTABLE_SHORT_NAMES = new Set([
    'i', 'j', 'k', 'n', 'm',           // Loop counters
    'x', 'y', 'z',                      // Coordinates
    'a', 'b',                           // Comparison callbacks
    'e', 'ev',                          // Event
    't',                                // Time or generic type
    'id',                               // Identifier
    'db',                               // Database
    'fs',                               // Filesystem
    'io',                               // Input/Output
    'os',                               // Operating system
    'ui',                               // User interface
    'el',                               // Element
    'fn',                               // Function
    'cb',                               // Callback
    '_',                                // Unused parameter
]);

/**
 * Result of documentation analysis
 */
export interface DocumentationAnalysis {
    commentDensity: number;
    hasApiDoc: boolean;
    apiDocQuality: 'none' | 'minimal' | 'partial' | 'complete';
    namingQuality: 'poor' | 'acceptable' | 'good';
    namingIssues: string[];
    inlineComments: number;
    todoCount: number;
}

/**
 * Analyze documentation and clarity of a function-like symbol
 */
export function analyzeDocumentation(
    bodyText: string | undefined,
    docComment: string | undefined,
    symbolName: string,
    parameterNames: string[],
    localVariables: string[],
    _isExported: boolean
): DocumentationAnalysis {
    const body = bodyText ?? '';
    const doc = docComment ?? '';

    // Calculate comment density
    const commentDensity = calculateCommentDensity(body);

    // Analyze API documentation
    const { hasApiDoc, apiDocQuality } = analyzeApiDoc(doc, parameterNames, _isExported);

    // Analyze inline comments
    const inlineComments = countInlineComments(body);

    // Count TODO/FIXME comments
    const todoCount = countTodoComments(body, doc);

    // Analyze naming quality
    const allIdentifiers = [symbolName, ...parameterNames, ...localVariables];
    const { quality: namingQuality, issues: namingIssues } = analyzeNamingQuality(allIdentifiers);

    return {
        commentDensity,
        hasApiDoc,
        apiDocQuality,
        namingQuality,
        namingIssues,
        inlineComments,
        todoCount,
    };
}

/**
 * Calculate the ratio of comment lines to total lines
 */
export function calculateCommentDensity(code: string): number {
    if (!code || code.trim().length === 0) {
        return 0;
    }

    const lines = code.split('\n');
    let commentLines = 0;
    let codeLines = 0;
    let inBlockComment = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines
        if (trimmed.length === 0) {
            continue;
        }

        // Track block comments
        if (inBlockComment) {
            commentLines++;
            if (trimmed.includes('*/')) {
                inBlockComment = false;
            }
            continue;
        }

        // Check for block comment start
        if (trimmed.startsWith('/*')) {
            commentLines++;
            if (!trimmed.includes('*/')) {
                inBlockComment = true;
            }
            continue;
        }

        // Check for line comment
        if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
            commentLines++;
            continue;
        }

        // Check for inline comment (line has both code and comment)
        if (trimmed.includes('//') || trimmed.includes('/*')) {
            // Has code, count as code line
            codeLines++;
            continue;
        }

        codeLines++;
    }

    const total = commentLines + codeLines;
    if (total === 0) {
        return 0;
    }

    return Math.round((commentLines / total) * 100) / 100;
}

/**
 * Analyze API documentation quality
 */
export function analyzeApiDoc(
    docComment: string,
    parameterNames: string[],
    _isExported: boolean
): { hasApiDoc: boolean; apiDocQuality: 'none' | 'minimal' | 'partial' | 'complete' } {
    const doc = docComment.trim();

    // No documentation
    if (!doc || doc.length < 5) {
        return { hasApiDoc: false, apiDocQuality: 'none' };
    }

    // Check if it's a proper JSDoc/docstring
    const isJsDoc = doc.startsWith('/**') || doc.startsWith('/*');
    const isPythonDoc = doc.startsWith('"""') || doc.startsWith("'''");
    const isHashDoc = doc.startsWith('##') || doc.startsWith('# ');

    if (!isJsDoc && !isPythonDoc && !isHashDoc) {
        // Just a regular comment, not API doc
        return { hasApiDoc: false, apiDocQuality: 'none' };
    }

    // Has some documentation
    const hasDescription = doc.length > 20; // More than just tags
    const hasParamDoc = /@param|:param|\* @arg|Args:/i.test(doc);
    const hasReturnDoc = /@returns?|:returns?|Returns:/i.test(doc);
    // Future: could add bonus for @throws and @example
    // const hasThrowsDoc = /@throws|@exception|:raises|Raises:/i.test(doc);
    // const hasExampleDoc = /@example|Example:|>>>/.test(doc);

    // Check if all parameters are documented
    let allParamsDocumented = true;
    if (parameterNames.length > 0 && hasParamDoc) {
        for (const param of parameterNames) {
            // Skip 'this', 'self', destructured params
            if (param === 'this' || param === 'self' || param.startsWith('{')) {
                continue;
            }
            const paramPattern = new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${param}\\b|:param\\s+${param}\\b`, 'i');
            if (!paramPattern.test(doc)) {
                allParamsDocumented = false;
                break;
            }
        }
    }

    // Determine quality level
    if (hasDescription && hasParamDoc && hasReturnDoc && allParamsDocumented) {
        return { hasApiDoc: true, apiDocQuality: 'complete' };
    }

    if (hasDescription && (hasParamDoc || hasReturnDoc)) {
        return { hasApiDoc: true, apiDocQuality: 'partial' };
    }

    if (hasDescription) {
        return { hasApiDoc: true, apiDocQuality: 'minimal' };
    }

    return { hasApiDoc: true, apiDocQuality: 'minimal' };
}

/**
 * Count inline comments within code
 */
export function countInlineComments(code: string): number {
    if (!code) return 0;

    const lines = code.split('\n');
    let count = 0;
    let inBlockComment = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Track block comments
        if (inBlockComment) {
            if (trimmed.includes('*/')) {
                inBlockComment = false;
            }
            continue;
        }

        if (trimmed.startsWith('/*')) {
            if (!trimmed.includes('*/')) {
                inBlockComment = true;
            }
            continue;
        }

        // Skip pure comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
            continue;
        }

        // Count inline comments (code followed by comment)
        if (trimmed.includes('//') && !trimmed.startsWith('//')) {
            // Make sure it's not inside a string
            const beforeComment = trimmed.split('//')[0];
            const quoteCount = (beforeComment.match(/['"]/g) || []).length;
            if (quoteCount % 2 === 0) {
                count++;
            }
        }
    }

    return count;
}

/**
 * Count TODO/FIXME/HACK/XXX comments
 */
export function countTodoComments(code: string, docComment: string): number {
    const combined = `${code}\n${docComment}`;
    const todoPattern = /\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE|REFACTOR)[\s:]/gi;
    const matches = combined.match(todoPattern);
    return matches ? matches.length : 0;
}

/**
 * Analyze naming quality of identifiers
 */
export function analyzeNamingQuality(identifiers: string[]): {
    quality: 'poor' | 'acceptable' | 'good';
    issues: string[];
} {
    if (identifiers.length === 0) {
        return { quality: 'good', issues: [] };
    }

    const issues: string[] = [];
    let goodNames = 0;
    let poorNames = 0;

    for (const identifier of identifiers) {
        // Skip empty or destructuring patterns
        if (!identifier || identifier.startsWith('{') || identifier.startsWith('[')) {
            continue;
        }

        // Check if it's an acceptable short name
        if (ACCEPTABLE_SHORT_NAMES.has(identifier.toLowerCase())) {
            goodNames++;
            continue;
        }

        // Check against poor naming patterns
        let isPoor = false;
        for (const pattern of POOR_NAMING_PATTERNS) {
            if (pattern.test(identifier)) {
                isPoor = true;
                issues.push(identifier);
                poorNames++;
                break;
            }
        }

        if (isPoor) continue;

        // Split camelCase/snake_case into words
        const words = splitIdentifier(identifier);

        // Check if words are recognizable
        const recognizedWords = words.filter(w =>
            COMMON_WORDS.has(w.toLowerCase()) ||
            w.length >= 4 // Longer words are likely meaningful
        );

        if (recognizedWords.length >= words.length * 0.5) {
            goodNames++;
        } else if (words.length === 1 && words[0].length <= 3) {
            // Short single word that's not in dictionary
            issues.push(identifier);
            poorNames++;
        } else {
            // Partial recognition
            goodNames += 0.5;
        }
    }

    const total = goodNames + poorNames;
    if (total === 0) {
        return { quality: 'good', issues: [] };
    }

    const ratio = goodNames / total;

    if (ratio >= 0.8) {
        return { quality: 'good', issues };
    } else if (ratio >= 0.5) {
        return { quality: 'acceptable', issues };
    } else {
        return { quality: 'poor', issues };
    }
}

/**
 * Split an identifier into words (handles camelCase, PascalCase, snake_case, kebab-case)
 */
export function splitIdentifier(identifier: string): string[] {
    // Remove leading/trailing underscores
    let clean = identifier.replace(/^_+|_+$/g, '');

    // Replace separators with space
    clean = clean.replace(/[-_]/g, ' ');

    // Split camelCase/PascalCase
    clean = clean.replace(/([a-z])([A-Z])/g, '$1 $2');
    clean = clean.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

    // Split and filter
    return clean
        .split(/\s+/)
        .map(w => w.toLowerCase())
        .filter(w => w.length > 0);
}

/**
 * Extract local variable names from function body (simplified)
 */
export function extractLocalVariables(bodyText: string): string[] {
    if (!bodyText) return [];

    const variables: string[] = [];

    // Match variable declarations
    const patterns = [
        /\b(?:const|let|var)\s+(\w+)/g,                    // const x, let y, var z
        /\b(?:const|let|var)\s+\{([^}]+)\}/g,              // destructuring { a, b }
        /\bfor\s*\(\s*(?:const|let|var)?\s*(\w+)/g,        // for (let i ...)
        /\.forEach\s*\(\s*\(?(\w+)/g,                       // .forEach((item) ...)
        /\.map\s*\(\s*\(?(\w+)/g,                           // .map((x) ...)
        /\.filter\s*\(\s*\(?(\w+)/g,                        // .filter((x) ...)
        /\.reduce\s*\(\s*\(?(\w+)/g,                        // .reduce((acc) ...)
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(bodyText)) !== null) {
            const captured = match[1];
            if (captured.includes(',')) {
                // Destructuring - split by comma
                const parts = captured.split(',').map(p => p.trim().split(':')[0].trim());
                variables.push(...parts.filter(p => /^\w+$/.test(p)));
            } else if (/^\w+$/.test(captured)) {
                variables.push(captured);
            }
        }
    }

    return [...new Set(variables)];
}

/**
 * Convert DocumentationAnalysis to Documentation schema type
 */
export function toDocumentationSchema(analysis: DocumentationAnalysis): Documentation {
    return {
        commentDensity: analysis.commentDensity,
        hasApiDoc: analysis.hasApiDoc,
        apiDocQuality: analysis.apiDocQuality === 'none' ? undefined : analysis.apiDocQuality,
        namingQuality: analysis.namingQuality,
        namingIssues: analysis.namingIssues.length > 0 ? analysis.namingIssues : undefined,
        inlineComments: analysis.inlineComments,
        todoCount: analysis.todoCount,
    };
}
