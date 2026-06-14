import { LocalFilesystem, type FileStat } from '@mastra/core/workspace';
import * as path from 'path';
import { tcAILogger } from './logger';

// ============================================================================
// Encoding Detection and Conversion
// ============================================================================

/**
 * Detect if content appears to be UTF-16 encoded (has null bytes between chars).
 */
export function isUtf16Encoded(content: string): boolean {
    const sample = content.slice(0, 200);
    let nullCount = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample.charCodeAt(i) === 0) {
            nullCount++;
        }
    }
    return nullCount > sample.length * 0.2;
}

/**
 * Convert UTF-16 LE encoded string to proper UTF-8.
 * Also removes BOM markers and replacement characters.
 */
export function convertUtf16ToUtf8(content: string): string {
    let result = content.replace(/\0/g, '');
    result = result.replace(/^[\uFFFE\uFEFF\uFFFD]+/, '');
    return result;
}

/**
 * Normalize file content encoding.
 * Detects and converts UTF-16 to UTF-8, removes BOMs.
 */
export function normalizeEncoding(content: string): string {
    if (isUtf16Encoded(content)) {
        return convertUtf16ToUtf8(content);
    }
    // Remove UTF-8 BOM if present
    if (content.charCodeAt(0) === 0xFEFF) {
        return content.slice(1);
    }
    return content;
}

/**
 * Check if content appears to be a patch/diff file based on content.
 */
export function isPatchContent(content: string): boolean {
    return content.startsWith('diff --git ') ||
        content.startsWith('--- ') ||
        content.includes('\ndiff --git ') ||
        content.includes('\n--- a/');
}

/**
 * Clean patch file content by removing binary data sections.
 */
export function cleanPatchBinaryData(content: string): string {
    const lines = content.split('\n');
    const cleanedLines: string[] = [];
    let inBinarySection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('GIT binary patch')) {
            inBinarySection = true;
            cleanedLines.push('[Binary file patch omitted]');
            continue;
        }

        if (inBinarySection) {
            if (line.startsWith('diff --git ') || line.startsWith('-- ') || line === '') {
                if (line === '' && i + 1 < lines.length && lines[i + 1].startsWith('diff --git ')) {
                    inBinarySection = false;
                    cleanedLines.push(line);
                } else if (line.startsWith('diff --git ')) {
                    inBinarySection = false;
                    cleanedLines.push(line);
                }
                continue;
            }
            continue;
        }

        cleanedLines.push(line);
    }

    return cleanedLines.join('\n');
}

/**
 * Preprocess file content: normalize encoding and handle special file types.
 */
export function preprocessFileContent(filePath: string, content: string): string {
    // First normalize encoding (UTF-16 -> UTF-8, remove BOMs)
    let processed = normalizeEncoding(content);

    // For patch/diff files, also clean binary sections
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.patch' || ext === '.diff' || isPatchContent(processed)) {
        processed = cleanPatchBinaryData(processed);
    }

    return processed;
}

/**
 * Callback type for resolving virtual symbol paths (e.g., "file.ts:symbolName")
 * Returns the symbol content or null if not found.
 */
export type SymbolResolver = (filePath: string, symbolName: string) => string | null;

// Files to exclude from BOTH indexing AND direct reads
// These patterns are checked against the full path and filename
export const EXCLUDED_FILE_PATTERNS = {
    // Exact filenames to block (matched anywhere in path)
    filenames: [
        // JavaScript/Node lock files
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'npm-shrinkwrap.json',
        'bun.lockb',
        // Ruby
        'Gemfile.lock',
        // PHP
        'composer.lock',
        // Python
        'poetry.lock',
        'Pipfile.lock',
        'pdm.lock',
        'uv.lock',
        // Rust
        'Cargo.lock',
        // Go
        'go.sum',
        // .NET/NuGet
        'packages.lock.json',
        // Dart/Flutter
        'pubspec.lock',
        // Elixir
        'mix.lock',
        // Terraform
        '.terraform.lock.hcl',
        // Cocoapods
        'Podfile.lock',
        // Gradle
        'gradle.lockfile',
        // Custom
        'challenge-context.json',
        // Database dumps
        'dump.sql',
        'schema.sql',
        // IDE/Editor
        '.DS_Store',
        'Thumbs.db',
        'desktop.ini',
        // Migration lock files
        'migration_lock.toml',
    ],
    // File extensions to block
    extensions: [
        // Minified/bundled JavaScript
        '.min.js',
        '.min.css',
        '.bundle.js',
        '.chunk.js',
        // Source maps
        '.map',
        '.js.map',
        '.css.map',
        // Compiled/binary
        '.pyc',
        '.pyo',
        '.class',
        '.dll',
        '.exe',
        '.so',
        '.dylib',
        '.o',
        '.obj',
        '.wasm',
        // Archives
        '.zip',
        '.tar',
        '.gz',
        '.rar',
        '.7z',
        '.jar',
        '.war',
        '.ear',
        // Images (binary, not useful for code review)
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.ico',
        '.webp',
        '.bmp',
        '.svg',
        '.tiff',
        '.psd',
        // Fonts
        '.woff',
        '.woff2',
        '.ttf',
        '.otf',
        '.eot',
        // Audio/Video
        '.mp3',
        '.mp4',
        '.wav',
        '.avi',
        '.mov',
        '.webm',
        // Documents (binary)
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        // Logs
        '.log',
        // SQLite databases
        '.sqlite',
        '.sqlite3',
        '.db',
        // Coverage reports (generated)
        '.lcov',
    ],
    // Directory names that block all files within
    directories: [
        // Package managers
        'node_modules',
        'bower_components',
        'jspm_packages',
        // Build outputs
        'dist',
        'build',
        'out',
        'output',
        'target',
        'bin',
        'obj',
        // Framework-specific build
        '.next',
        '.nuxt',
        '.output',
        '.svelte-kit',
        '.vercel',
        '.netlify',
        '.turbo',
        // Python
        '__pycache__',
        '.venv',
        'venv',
        'env',
        '.tox',
        '.nox',
        '.pytest_cache',
        '.mypy_cache',
        'site-packages',
        '*.egg-info',
        // Ruby
        'vendor/bundle',
        // Coverage
        'coverage',
        '.nyc_output',
        'htmlcov',
        // IDE/Editor
        '.idea',
        '.vscode',
        '.vs',
        '.eclipse',
        // Version control
        '.git',
        '.svn',
        '.hg',
        // Terraform
        '.terraform',
        // macOS artifacts
        '__MACOSX',
        // Temporary
        'tmp',
        'temp',
        '.cache',
        '.parcel-cache',
        // Logs
        'logs',
    ],
};

/**
 * Check if a file path should be excluded from reading
 */
export function isExcludedFile(filePath: string): boolean {
    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop() || '';
    const pathSegments = normalizedPath.split('/');

    // Check exact filename matches
    if (EXCLUDED_FILE_PATTERNS.filenames.includes(fileName)) {
        return true;
    }

    // Check extension matches
    for (const ext of EXCLUDED_FILE_PATTERNS.extensions) {
        if (fileName.endsWith(ext)) {
            return true;
        }
    }

    // Check if path contains excluded directory
    for (const dir of EXCLUDED_FILE_PATTERNS.directories) {
        if (pathSegments.includes(dir)) {
            return true;
        }
    }

    return false;
}

// ---------------------------------------------------------------------------
// Token Optimization: File Content Truncation
// ---------------------------------------------------------------------------
// Large files (README.md at 13KB = ~3200 tokens) accumulate in conversation
// history with each tool call. Truncating to ~4000 chars (~1000 tokens) per
// file significantly reduces token consumption while preserving useful context.
// ---------------------------------------------------------------------------

export const MAX_FILE_CONTENT_CHARS = 4000;  // ~1000 tokens per file read
export const TRUNCATION_NOTICE_TEMPLATE = (lineCount: number, charCount: number) =>
    `\n\n[...TRUNCATED: File has ${lineCount} total lines, ${charCount} chars. ` +
    `Use workspace_evidence_search tool to find specific sections if needed.]`;

/**
 * Truncates file content to reduce token consumption while preserving useful context.
 * Returns the original content if within limits, or truncated content with metadata.
 */
export function truncateFileContent(content: string, filePath: string): string {
    if (content.length <= MAX_FILE_CONTENT_CHARS) {
        return content;
    }

    const lines = content.split('\n');
    const lineCount = lines.length;
    const charCount = content.length;

    // Smart truncation: try to break at a line boundary
    let truncateAt = MAX_FILE_CONTENT_CHARS;
    const lastNewline = content.lastIndexOf('\n', MAX_FILE_CONTENT_CHARS);
    if (lastNewline > MAX_FILE_CONTENT_CHARS * 0.8) {
        // If there's a newline in the last 20% of the allowed content, break there
        truncateAt = lastNewline;
    }

    const truncated = content.slice(0, truncateAt);
    const notice = TRUNCATION_NOTICE_TEMPLATE(lineCount, charCount);

    tcAILogger.debug(
        `[FilteredLocalFilesystem] Truncated ${filePath}: ${charCount} → ${truncated.length} chars ` +
        `(${lineCount} lines, saved ~${Math.round((charCount - truncated.length) / 4)} tokens)`
    );

    return truncated + notice;
}

/**
 * Check if a path is a virtual symbol path (e.g., "file.ts:symbolName")
 */
export function isVirtualSymbolPath(path: string): boolean {
    // Check for colon that's not part of Windows drive letter (C:\)
    const colonIndex = path.lastIndexOf(':');
    if (colonIndex <= 0) return false;
    // Ensure it's not a Windows drive letter
    if (colonIndex === 1 && /^[A-Za-z]$/.test(path[0])) return false;
    // Check that there's a symbol name after the colon
    const symbolPart = path.slice(colonIndex + 1);
    return symbolPart.length > 0 && !symbolPart.includes('/') && !symbolPart.includes('\\');
}

/**
 * Parse a virtual symbol path into file path and symbol name
 */
export function parseVirtualSymbolPath(path: string): { filePath: string; symbolName: string } | null {
    if (!isVirtualSymbolPath(path)) return null;
    const colonIndex = path.lastIndexOf(':');
    return {
        filePath: path.slice(0, colonIndex),
        symbolName: path.slice(colonIndex + 1),
    };
}

/**
 * Wrapped LocalFilesystem that:
 * 1. Blocks reads of excluded files (lock files, minified bundles, etc.)
 * 2. Truncates large files to reduce token consumption
 * 3. Supports virtual symbol paths (file.ts:symbolName) via symbol resolver
 */
export class FilteredLocalFilesystem extends LocalFilesystem {
    private symbolResolver: SymbolResolver | null = null;

    /**
     * Set the symbol resolver for handling virtual symbol paths.
     * Call this after the AST indexer is initialized.
     */
    setSymbolResolver(resolver: SymbolResolver): void {
        this.symbolResolver = resolver;
        tcAILogger.info(`[FilteredLocalFilesystem] Symbol resolver registered`);
    }

    /**
     * Check if a path exists. For virtual symbol paths, check if the symbol exists.
     */
    async exists(path: string): Promise<boolean> {
        const virtualPath = parseVirtualSymbolPath(path);
        if (virtualPath) {
            // For virtual paths, check if we can resolve the symbol
            if (this.symbolResolver) {
                const content = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
                if (content !== null) {
                    return true;
                }
            }
            // Fall back to checking if the base file exists
            return super.exists(virtualPath.filePath);
        }
        return super.exists(path);
    }

    /**
     * Get file stats. For virtual symbol paths, return synthetic stats.
     */
    async stat(path: string): Promise<FileStat> {
        const virtualPath = parseVirtualSymbolPath(path);
        if (virtualPath) {
            // For virtual paths, check if we can resolve the symbol
            if (this.symbolResolver) {
                const content = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
                if (content !== null) {
                    // Return synthetic stat for virtual symbol
                    return {
                        name: virtualPath.symbolName,
                        path: path,
                        type: 'file',
                        size: content.length,
                        createdAt: new Date(),
                        modifiedAt: new Date(),
                        mimeType: 'text/plain',
                    };
                }
            }
            // Fall back to stat of the base file
            return super.stat(virtualPath.filePath);
        }
        return super.stat(path);
    }

    async readFile(filePath: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<string | Buffer> {
        // Check for virtual symbol path (e.g., "file.ts:symbolName")
        const virtualPath = parseVirtualSymbolPath(filePath);
        if (virtualPath) {
            tcAILogger.debug(`[FilteredLocalFilesystem] Virtual symbol path detected: ${filePath}`);

            if (this.symbolResolver) {
                const symbolContent = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
                if (symbolContent) {
                    tcAILogger.debug(`[FilteredLocalFilesystem] Symbol resolved: ${virtualPath.symbolName}`);
                    return symbolContent;
                }
            }

            // Symbol not found or no resolver, fall back to reading the actual file
            tcAILogger.debug(`[FilteredLocalFilesystem] Symbol not found, reading file: ${virtualPath.filePath}`);
            return this.readFile(virtualPath.filePath, options);
        }

        if (isExcludedFile(filePath)) {
            tcAILogger.warn(`[FilteredLocalFilesystem] Blocked read of excluded file: ${filePath}`);
            throw new Error(
                `File "${filePath}" is excluded from reading. ` +
                `Lock files, minified bundles, and large generated files are not useful for code review. ` +
                `For dependency info, read package.json instead.`
            );
        }

        const content = await super.readFile(filePath, options);

        // Only process string content (text files), not binary
        if (typeof content === 'string') {
            // Preprocess: normalize encoding (UTF-16 -> UTF-8) and handle special files (patch binary cleanup)
            const processed = preprocessFileContent(filePath, content);
            return truncateFileContent(processed, filePath);
        }

        return content;
    }
}

// Build glob patterns that include source files but exclude lock files and large generated files
// IMPORTANT: We do NOT use **/*.json because it would match package-lock.json (6000+ lines)
// Instead, we whitelist specific JSON config files that are useful for code review
export const autoIndexPatterns = [
    // Source code files handled by special AST based indexer.
    // 
    // '**/*.ts',
    // '**/*.tsx',
    // '**/*.js',
    // '**/*.jsx',
    // '**/*.mjs',
    // '**/*.cjs',
    // '**/*.py',
    // '**/*.java',
    // '**/*.go',
    // '**/*.rs',
    // '**/*.rb',
    // '**/*.php',
    // '**/*.cs',
    // '**/*.cpp',
    // '**/*.c',
    // '**/*.h',
    // '**/*.hpp',
    // '**/*.swift',
    // '**/*.kt',
    // '**/*.scala',
    // JSON config files - explicit whitelist (NO **/*.json to avoid lock files!)
    '**/package.json',
    '**/tsconfig.json',
    '**/jsconfig.json',
    '**/jest.config.json',
    '**/babel.config.json',
    '**/.eslintrc.json',
    '**/.prettierrc.json',
    '**/.babelrc.json',
    '**/nest-cli.json',
    '**/angular.json',
    // YAML config (exclude lock files via specific patterns)
    '**/*.yaml',
    '**/*.yml',
    // XML
    '**/*.xml',
    '**/pom.xml',
    // TOML (exclude lock files)
    '**/Cargo.toml',
    '**/pyproject.toml',
    '**/*.toml',
    // Database schema files
    '**/*.prisma',
    '**/*.sql',
    '**/*.dbml',
    '**/*.graphql',
    '**/*.gql',
    // Documentation
    '**/*.md',
    '**/*.txt',
    '**/*.rst',
    '**/*.adoc',
    // Patch/Diff files
    '**/*.patch',
    '**/*.diff',
    // Shell scripts
    '**/*.sh',
    '**/*.bash',
    '**/*.zsh',
    // Docker
    '**/Dockerfile',
    '**/Dockerfile.*',
    '**/docker-compose*.yml',
    '**/docker-compose*.yaml',
    // Env examples
    '**/*.env.example',
    '**/.env.example',
    '**/*.example',
    // Config JSON files in config directories
    '**/config/*.json',
    '**/constants.json',
    // Data and seed JSON files (common locations for seed/fixture data)
    '**/data/*.json',
    '**/seed/*.json',
    '**/seeds/*.json',
    '**/fixtures/*.json',
    '**/mock/*.json',
    '**/mocks/*.json',
    '**/testdata/*.json',
    // Git and CI files
    '**/.gitignore',
    '**/.gitattributes',
];
