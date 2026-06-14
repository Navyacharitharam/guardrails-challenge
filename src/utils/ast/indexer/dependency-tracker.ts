import type { IndexedFile } from './indexed-symbol';
import { tcAILogger } from '../../logger';

/**
 * Tracks import/export dependencies between files for incremental updates.
 * When a file changes, identifies all dependent files that may need re-indexing.
 */
export class DependencyTracker {
    // file -> files it imports from
    private imports = new Map<string, Set<string>>();
    // file -> files that import it (reverse mapping)
    private dependents = new Map<string, Set<string>>();
    // file -> exported symbol names
    private exports = new Map<string, Set<string>>();

    /**
     * Register file dependencies from indexed file data
     */
    registerFile(file: IndexedFile, resolvedImports: string[]): void {
        const filePath = file.filePath;

        // Clear old dependencies
        this.clearFile(filePath);

        // Register imports
        const importSet = new Set(resolvedImports);
        this.imports.set(filePath, importSet);

        // Register reverse dependencies
        for (const importedFile of resolvedImports) {
            if (!this.dependents.has(importedFile)) {
                this.dependents.set(importedFile, new Set());
            }
            this.dependents.get(importedFile)!.add(filePath);
        }

        // Register exports
        const exportSet = new Set(file.exports);
        this.exports.set(filePath, exportSet);
    }

    /**
     * Clear all dependency info for a file
     */
    clearFile(filePath: string): void {
        // Remove from reverse dependencies
        const oldImports = this.imports.get(filePath);
        if (oldImports) {
            for (const importedFile of oldImports) {
                this.dependents.get(importedFile)?.delete(filePath);
            }
        }

        this.imports.delete(filePath);
        this.exports.delete(filePath);
    }

    /**
     * Get all files that depend on the given file (import from it)
     */
    getDependents(filePath: string): string[] {
        return Array.from(this.dependents.get(filePath) || []);
    }

    /**
     * Get all files that the given file imports from
     */
    getImports(filePath: string): string[] {
        return Array.from(this.imports.get(filePath) || []);
    }

    /**
     * Get exported symbols for a file
     */
    getExports(filePath: string): string[] {
        return Array.from(this.exports.get(filePath) || []);
    }

    /**
     * Get all files that need re-indexing when a file changes.
     * Returns the changed file plus all its dependents (recursively).
     */
    getAffectedFiles(changedFile: string, maxDepth = 3): string[] {
        const affected = new Set<string>();
        const visited = new Set<string>();

        const traverse = (file: string, depth: number) => {
            if (depth > maxDepth || visited.has(file)) return;
            visited.add(file);
            affected.add(file);

            const deps = this.dependents.get(file);
            if (deps) {
                for (const dep of deps) {
                    traverse(dep, depth + 1);
                }
            }
        };

        traverse(changedFile, 0);
        return Array.from(affected);
    }

    /**
     * Check if file A depends on file B (directly or indirectly)
     */
    dependsOn(fileA: string, fileB: string, maxDepth = 5): boolean {
        const visited = new Set<string>();

        const check = (current: string, depth: number): boolean => {
            if (depth > maxDepth || visited.has(current)) return false;
            if (current === fileB) return true;
            visited.add(current);

            const imports = this.imports.get(current);
            if (imports) {
                for (const imp of imports) {
                    if (check(imp, depth + 1)) return true;
                }
            }
            return false;
        };

        return check(fileA, 0);
    }

    /**
     * Get dependency statistics
     */
    getStats(): {
        totalFiles: number;
        avgImports: number;
        avgDependents: number;
        maxDependents: { file: string; count: number } | null;
    } {
        const totalFiles = this.imports.size;
        let totalImports = 0;
        let totalDependents = 0;
        let maxDeps = { file: '', count: 0 };

        for (const [, imports] of this.imports) {
            totalImports += imports.size;
        }

        for (const [file, deps] of this.dependents) {
            totalDependents += deps.size;
            if (deps.size > maxDeps.count) {
                maxDeps = { file, count: deps.size };
            }
        }

        return {
            totalFiles,
            avgImports: totalFiles > 0 ? totalImports / totalFiles : 0,
            avgDependents: totalFiles > 0 ? totalDependents / totalFiles : 0,
            maxDependents: maxDeps.count > 0 ? maxDeps : null,
        };
    }

    /**
     * Clear all tracked dependencies
     */
    clear(): void {
        this.imports.clear();
        this.dependents.clear();
        this.exports.clear();
    }

    /**
     * Export to JSON for persistence
     */
    exportToJSON(): string {
        const data = {
            imports: Object.fromEntries(
                Array.from(this.imports.entries()).map(([k, v]) => [k, Array.from(v)])
            ),
            exports: Object.fromEntries(
                Array.from(this.exports.entries()).map(([k, v]) => [k, Array.from(v)])
            ),
        };
        return JSON.stringify(data, null, 2);
    }

    /**
     * Import from JSON
     */
    importFromJSON(json: string): void {
        try {
            const data = JSON.parse(json);
            this.clear();

            // Restore imports and rebuild dependents
            for (const [file, imports] of Object.entries(data.imports || {})) {
                const importSet = new Set(imports as string[]);
                this.imports.set(file, importSet);

                for (const importedFile of importSet) {
                    if (!this.dependents.has(importedFile)) {
                        this.dependents.set(importedFile, new Set());
                    }
                    this.dependents.get(importedFile)!.add(file);
                }
            }

            // Restore exports
            for (const [file, exports] of Object.entries(data.exports || {})) {
                this.exports.set(file, new Set(exports as string[]));
            }

            tcAILogger.info(`[DependencyTracker] Imported dependencies for ${this.imports.size} files`);
        } catch (err) {
            tcAILogger.error(`[DependencyTracker] Failed to import dependencies`, { error: err });
            throw err;
        }
    }
}

/**
 * Resolve import path to actual file path.
 * Handles relative imports, node_modules, etc.
 */
export function resolveImportPath(
    importSource: string,
    fromFile: string,
    fileExists: (path: string) => boolean
): string | null {
    // Skip external packages (non-relative imports)
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
        return null;
    }

    // Get directory of the importing file
    const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));

    // Resolve relative path
    let resolved = importSource;
    if (importSource.startsWith('./')) {
        resolved = `${fromDir}/${importSource.slice(2)}`;
    } else if (importSource.startsWith('../')) {
        const parts = fromDir.split('/');
        const importParts = importSource.split('/');
        let upCount = 0;
        for (const part of importParts) {
            if (part === '..') upCount++;
            else break;
        }
        const baseParts = parts.slice(0, -upCount);
        const restParts = importParts.slice(upCount);
        resolved = [...baseParts, ...restParts].join('/');
    }

    // Try common extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];
    for (const ext of extensions) {
        const candidate = resolved + ext;
        if (fileExists(candidate)) {
            return candidate;
        }
    }

    return null;
}
