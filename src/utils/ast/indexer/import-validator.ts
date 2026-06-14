/**
 * Import validator for detecting broken/missing imports.
 * Only validates local imports (not node_modules).
 */

import * as path from 'path';
import type { IndexedFile, IndexedSymbol } from './indexed-symbol';
import type { StructuredIndexStore } from './structured-index-store';

/**
 * A broken import that references non-existent file or symbol
 */
export interface BrokenImport {
    /** The import path as written in code */
    importPath: string;
    /** Resolved path (relative to workspace) */
    resolvedPath: string;
    /** Symbols imported from this path */
    importedSymbols: string[];
    /** Type of issue */
    issue: 'file_not_found' | 'symbol_not_exported';
    /** Symbols in this file that use the broken import */
    usedBySymbols: string[];
}

/**
 * Result of validating imports for a file
 */
export interface ImportValidationResult {
    filePath: string;
    brokenImports: BrokenImport[];
    totalImportsChecked: number;
}

/**
 * Check if an import path is a local import (not node_modules/external)
 */
export function isLocalImport(importPath: string): boolean {
    // Local imports start with . or /
    return importPath.startsWith('.') || importPath.startsWith('/');
}

/**
 * Resolve an import path to a workspace-relative path.
 * Note: fromFile is already workspace-relative, so we resolve the import
 * relative to its directory without using basePath in the resolution.
 */
export function resolveImportToWorkspacePath(
    importPath: string,
    fromFile: string,
    _basePath: string
): string {
    const fromDir = path.dirname(fromFile);
    // Use path.join for relative resolution, then normalize
    // This handles ../ and ./ correctly within workspace-relative paths
    const joined = path.join(fromDir, importPath);
    // Normalize to remove any .. or . segments
    return path.normalize(joined);
}

/**
 * Try to find the actual file for an import (handles extensions)
 */
export function findImportedFile(
    resolvedPath: string,
    indexedFiles: Set<string>
): string | null {
    // Try exact match first
    if (indexedFiles.has(resolvedPath)) {
        return resolvedPath;
    }

    // Common extensions to try
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    // If the path already has an extension, try swapping it
    // This handles cases like importing './foo.js' when actual file is './foo.ts'
    const existingExt = path.extname(resolvedPath);
    if (existingExt && extensions.includes(existingExt)) {
        const basePath = resolvedPath.slice(0, -existingExt.length);
        for (const ext of extensions) {
            const withExt = basePath + ext;
            if (indexedFiles.has(withExt)) {
                return withExt;
            }
        }
    }

    // Try adding extensions (for extensionless imports)
    for (const ext of extensions) {
        const withExt = resolvedPath + ext;
        if (indexedFiles.has(withExt)) {
            return withExt;
        }
    }

    // Try index files
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
    for (const indexFile of indexFiles) {
        const indexPath = path.join(resolvedPath, indexFile);
        if (indexedFiles.has(indexPath)) {
            return indexPath;
        }
    }

    return null;
}

/**
 * Parse import statement to extract imported symbols
 * Handles: import { a, b } from '...', import x from '...', import * as x from '...'
 */
export function parseImportedSymbols(importStatement: string): string[] {
    const symbols: string[] = [];

    // Named imports: import { a, b, c as d } from '...'
    const namedMatch = importStatement.match(/\{([^}]+)\}/);
    if (namedMatch) {
        const names = namedMatch[1].split(',').map(s => s.trim());
        for (const name of names) {
            // Handle "x as y" - we want the original name x
            const asMatch = name.match(/^(\w+)\s+as\s+\w+$/);
            if (asMatch) {
                symbols.push(asMatch[1]);
            } else if (name && /^\w+$/.test(name)) {
                symbols.push(name);
            }
        }
    }

    // Default import: import x from '...'
    const defaultMatch = importStatement.match(/import\s+(\w+)\s+from/);
    if (defaultMatch && !importStatement.includes('{')) {
        symbols.push('default');
    }

    // Namespace import: import * as x from '...'
    if (importStatement.includes('* as')) {
        symbols.push('*');
    }

    return symbols;
}

/**
 * Check which imported symbols are actually used by symbols in the file
 */
function findUsedImportedSymbols(
    importedSymbols: string[],
    fileSymbols: IndexedSymbol[]
): Map<string, string[]> {
    const usageMap = new Map<string, string[]>(); // importedSymbol -> [usedBySymbols]

    for (const importedSymbol of importedSymbols) {
        const usedBy: string[] = [];

        for (const fileSymbol of fileSymbols) {
            // Check if this symbol calls the imported symbol
            if (fileSymbol.callTargets?.includes(importedSymbol)) {
                usedBy.push(fileSymbol.symbolName);
            }

            // Also check body text for usage (covers non-function usage)
            if (fileSymbol.bodyText?.includes(importedSymbol)) {
                if (!usedBy.includes(fileSymbol.symbolName)) {
                    usedBy.push(fileSymbol.symbolName);
                }
            }
        }

        if (usedBy.length > 0) {
            usageMap.set(importedSymbol, usedBy);
        }
    }

    return usageMap;
}

/**
 * Check if a symbol is exported from a file
 */
function isSymbolExported(
    symbolName: string,
    targetFile: IndexedFile,
    store: StructuredIndexStore
): boolean {
    // Check exports list
    if (targetFile.exports.includes(symbolName)) {
        return true;
    }

    // Check if symbol exists and is marked as exported
    const symbols = store.getSymbolsForFile(targetFile.filePath);
    const symbol = symbols.find(s => s.symbolName === symbolName);

    if (symbol?.isExported) {
        return true;
    }

    // Handle default export
    if (symbolName === 'default') {
        return targetFile.exports.some(e =>
            e.includes('default') || e === '' // Empty string often means default export
        );
    }

    // Handle namespace import - always valid if file exists
    if (symbolName === '*') {
        return true;
    }

    return false;
}

/**
 * Validate imports for a single file
 */
export function validateFileImports(
    filePath: string,
    imports: { source: string; statement?: string }[],
    store: StructuredIndexStore,
    basePath: string
): ImportValidationResult {
    const brokenImports: BrokenImport[] = [];
    const indexedFiles = new Set(store.getFilePaths());
    const fileSymbols = store.getSymbolsForFile(filePath);
    let totalChecked = 0;

    for (const imp of imports) {
        // Skip non-local imports (node_modules, etc.)
        if (!isLocalImport(imp.source)) {
            continue;
        }

        totalChecked++;
        const resolvedPath = resolveImportToWorkspacePath(imp.source, filePath, basePath);
        const actualFile = findImportedFile(resolvedPath, indexedFiles);

        // Parse what symbols are imported
        const importedSymbols = imp.statement
            ? parseImportedSymbols(imp.statement)
            : ['*']; // If no statement, assume namespace

        // Find which imported symbols are actually used
        const usageMap = findUsedImportedSymbols(importedSymbols, fileSymbols);

        // Only care about imports that are actually used
        if (usageMap.size === 0) {
            continue;
        }

        const usedSymbols = Array.from(usageMap.keys());
        const usedBySymbols = Array.from(new Set(
            Array.from(usageMap.values()).flat()
        ));

        // Check if file exists
        if (!actualFile) {
            brokenImports.push({
                importPath: imp.source,
                resolvedPath,
                importedSymbols: usedSymbols,
                issue: 'file_not_found',
                usedBySymbols,
            });
            continue;
        }

        // File exists - check if symbols are exported
        const targetFile = store.getFile(actualFile);
        if (!targetFile) {
            continue;
        }

        const missingSymbols: string[] = [];
        for (const sym of usedSymbols) {
            if (!isSymbolExported(sym, targetFile, store)) {
                missingSymbols.push(sym);
            }
        }

        if (missingSymbols.length > 0) {
            brokenImports.push({
                importPath: imp.source,
                resolvedPath: actualFile,
                importedSymbols: missingSymbols,
                issue: 'symbol_not_exported',
                usedBySymbols,
            });
        }
    }

    return {
        filePath,
        brokenImports,
        totalImportsChecked: totalChecked,
    };
}

/**
 * Validate all imports in the indexed workspace
 */
export function validateAllImports(
    store: StructuredIndexStore,
    basePath: string
): {
    results: ImportValidationResult[];
    totalBroken: number;
    filesWithBrokenImports: number;
} {
    const results: ImportValidationResult[] = [];
    let totalBroken = 0;
    let filesWithBrokenImports = 0;

    for (const filePath of store.getFilePaths()) {
        const file = store.getFile(filePath);
        if (!file) continue;

        // Build imports array with source paths
        const imports = file.imports.map(source => ({ source }));

        const result = validateFileImports(filePath, imports, store, basePath);

        if (result.brokenImports.length > 0) {
            results.push(result);
            totalBroken += result.brokenImports.length;
            filesWithBrokenImports++;
        }
    }

    return {
        results,
        totalBroken,
        filesWithBrokenImports,
    };
}

/**
 * Get symbols that use broken imports
 */
export function getSymbolsUsingBrokenImports(
    validationResults: ImportValidationResult[]
): Map<string, BrokenImport[]> {
    const symbolToBrokenImports = new Map<string, BrokenImport[]>();

    for (const result of validationResults) {
        for (const broken of result.brokenImports) {
            for (const symbolName of broken.usedBySymbols) {
                const key = `${result.filePath}:${symbolName}`;
                const existing = symbolToBrokenImports.get(key) || [];
                existing.push(broken);
                symbolToBrokenImports.set(key, existing);
            }
        }
    }

    return symbolToBrokenImports;
}
