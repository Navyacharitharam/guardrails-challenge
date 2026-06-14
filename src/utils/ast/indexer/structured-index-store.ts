import type { SymbolKind, Language } from '../schema';
import type { IndexedSymbol, IndexedFile, IndexStats } from './indexed-symbol';
import { tcAILogger } from '../../logger';

/**
 * Query options for symbol search
 */
export interface SymbolQuery {
    name?: string;
    namePattern?: RegExp;
    kind?: SymbolKind | SymbolKind[];
    filePath?: string;
    language?: Language;
    isExported?: boolean;
    hasLogging?: boolean;
    minComplexity?: number;
    maxComplexity?: number;
    implementsOrExtends?: string;
    limit?: number;
}

/**
 * In-memory structured index store for AST symbols.
 * Supports exact queries, filtering, and JSON export/import.
 */
export class StructuredIndexStore {
    private symbols = new Map<string, IndexedSymbol>();
    private files = new Map<string, IndexedFile>();

    // Secondary indexes for fast lookups
    private symbolsByFile = new Map<string, Set<string>>();
    private symbolsByName = new Map<string, Set<string>>();
    private symbolsByKind = new Map<string, Set<string>>();
    private symbolsByLanguage = new Map<string, Set<string>>();
    private exportedSymbols = new Set<string>();

    private stats: IndexStats = {
        totalFiles: 0,
        totalSymbols: 0,
        byLanguage: {},
        byKind: {},
        indexTimeMs: 0,
        lastUpdated: 0,
    };

    /**
     * Add or update a symbol in the index
     */
    addSymbol(symbol: IndexedSymbol): void {
        const existing = this.symbols.get(symbol.id);
        if (existing) {
            this.removeFromSecondaryIndexes(existing);
        }

        this.symbols.set(symbol.id, symbol);
        this.addToSecondaryIndexes(symbol);
    }

    /**
     * Add multiple symbols at once
     */
    addSymbols(symbols: IndexedSymbol[]): void {
        for (const symbol of symbols) {
            this.addSymbol(symbol);
        }
    }

    /**
     * Add or update a file entry
     */
    addFile(file: IndexedFile): void {
        this.files.set(file.filePath, file);
    }

    /**
     * Remove all symbols for a file
     */
    removeFile(filePath: string): void {
        const symbolIds = this.symbolsByFile.get(filePath);
        if (symbolIds) {
            for (const id of symbolIds) {
                const symbol = this.symbols.get(id);
                if (symbol) {
                    this.removeFromSecondaryIndexes(symbol);
                    this.symbols.delete(id);
                }
            }
        }
        this.symbolsByFile.delete(filePath);
        this.files.delete(filePath);
    }

    /**
     * Get a symbol by ID
     */
    getSymbol(id: string): IndexedSymbol | undefined {
        return this.symbols.get(id);
    }

    /**
     * Get all symbols for a file
     */
    getSymbolsForFile(filePath: string): IndexedSymbol[] {
        const symbolIds = this.symbolsByFile.get(filePath);
        if (!symbolIds) return [];

        const symbols: IndexedSymbol[] = [];
        for (const id of symbolIds) {
            const symbol = this.symbols.get(id);
            if (symbol) {
                symbols.push(symbol);
            }
        }
        return symbols;
    }

    /**
     * Get file entry
     */
    getFile(filePath: string): IndexedFile | undefined {
        return this.files.get(filePath);
    }

    /**
     * Query symbols with filters
     */
    query(options: SymbolQuery): IndexedSymbol[] {
        let candidates: Set<string> | undefined;

        // Use secondary indexes to narrow candidates
        if (options.name) {
            candidates = this.intersect(candidates, this.symbolsByName.get(options.name));
        }
        if (options.filePath) {
            candidates = this.intersect(candidates, this.symbolsByFile.get(options.filePath));
        }
        if (options.kind) {
            const kinds = Array.isArray(options.kind) ? options.kind : [options.kind];
            const kindCandidates = new Set<string>();
            for (const kind of kinds) {
                const ids = this.symbolsByKind.get(kind);
                if (ids) {
                    for (const id of ids) kindCandidates.add(id);
                }
            }
            candidates = this.intersect(candidates, kindCandidates);
        }
        if (options.language) {
            candidates = this.intersect(candidates, this.symbolsByLanguage.get(options.language));
        }
        if (options.isExported === true) {
            candidates = this.intersect(candidates, this.exportedSymbols);
        }

        // If no index narrowed, use all symbols
        const searchSet = candidates ?? new Set(this.symbols.keys());
        const results: IndexedSymbol[] = [];

        for (const id of searchSet) {
            const symbol = this.symbols.get(id);
            if (!symbol) continue;

            // Apply additional filters
            if (options.namePattern && !options.namePattern.test(symbol.symbolName)) continue;
            if (options.hasLogging !== undefined && symbol.metrics.hasLogging !== options.hasLogging) continue;
            if (options.minComplexity !== undefined && symbol.metrics.complexity < options.minComplexity) continue;
            if (options.maxComplexity !== undefined && symbol.metrics.complexity > options.maxComplexity) continue;
            if (options.implementsOrExtends && !symbol.implementsOrExtends?.includes(options.implementsOrExtends)) continue;
            if (options.isExported === false && symbol.isExported) continue;

            results.push(symbol);

            if (options.limit && results.length >= options.limit) break;
        }

        return results;
    }

    /**
     * Find symbols by exact name
     */
    findByName(name: string): IndexedSymbol[] {
        return this.query({ name });
    }

    /**
     * Find symbols by kind
     */
    findByKind(kind: SymbolKind | SymbolKind[]): IndexedSymbol[] {
        return this.query({ kind });
    }

    /**
     * Find all classes/interfaces that implement or extend a given name
     */
    findImplementors(baseNameOrInterface: string): IndexedSymbol[] {
        return this.query({
            kind: ['class', 'abstract_class'],
            implementsOrExtends: baseNameOrInterface,
        });
    }

    /**
     * Find all exported symbols
     */
    findExported(): IndexedSymbol[] {
        return this.query({ isExported: true });
    }

    /**
     * Find high complexity symbols
     */
    findHighComplexity(threshold = 10): IndexedSymbol[] {
        return this.query({ minComplexity: threshold });
    }

    /**
     * Find symbols with logging
     */
    findWithLogging(): IndexedSymbol[] {
        return this.query({ hasLogging: true });
    }

    /**
     * Get all file paths in the index
     */
    getFilePaths(): string[] {
        return Array.from(this.files.keys());
    }

    /**
     * Get all symbols
     */
    getAllSymbols(): IndexedSymbol[] {
        return Array.from(this.symbols.values());
    }

    /**
     * Get index statistics
     */
    getStats(): IndexStats {
        return {
            totalFiles: this.files.size,
            totalSymbols: this.symbols.size,
            byLanguage: this.countByLanguage(),
            byKind: this.countByKind(),
            indexTimeMs: this.stats.indexTimeMs,
            lastUpdated: this.stats.lastUpdated,
        };
    }

    /**
     * Update stats after indexing
     */
    updateStats(indexTimeMs: number): void {
        this.stats.indexTimeMs = indexTimeMs;
        this.stats.lastUpdated = Date.now();
    }

    /**
     * Clear the entire index
     */
    clear(): void {
        this.symbols.clear();
        this.files.clear();
        this.symbolsByFile.clear();
        this.symbolsByName.clear();
        this.symbolsByKind.clear();
        this.symbolsByLanguage.clear();
        this.exportedSymbols.clear();
        this.stats = {
            totalFiles: 0,
            totalSymbols: 0,
            byLanguage: {},
            byKind: {},
            indexTimeMs: 0,
            lastUpdated: 0,
        };
    }

    /**
     * Export index to JSON
     */
    exportToJSON(): string {
        const data = {
            version: 1,
            exportedAt: Date.now(),
            symbols: Array.from(this.symbols.values()),
            files: Array.from(this.files.values()),
            stats: this.getStats(),
        };
        return JSON.stringify(data, null, 2);
    }

    /**
     * Import index from JSON
     */
    importFromJSON(json: string): void {
        try {
            const data = JSON.parse(json);

            if (data.version !== 1) {
                throw new Error(`Unsupported index version: ${data.version}`);
            }

            this.clear();

            for (const symbol of data.symbols || []) {
                this.addSymbol(symbol as IndexedSymbol);
            }

            for (const file of data.files || []) {
                this.addFile(file as IndexedFile);
            }

            if (data.stats) {
                this.stats.indexTimeMs = data.stats.indexTimeMs || 0;
                this.stats.lastUpdated = data.stats.lastUpdated || Date.now();
            }

            tcAILogger.info(`[StructuredIndexStore] Imported ${this.symbols.size} symbols from ${this.files.size} files`);
        } catch (err) {
            tcAILogger.error(`[StructuredIndexStore] Failed to import index`, { error: err });
            throw err;
        }
    }

    // --- Private helpers ---

    private addToSecondaryIndexes(symbol: IndexedSymbol): void {
        // By file
        if (!this.symbolsByFile.has(symbol.filePath)) {
            this.symbolsByFile.set(symbol.filePath, new Set());
        }
        this.symbolsByFile.get(symbol.filePath)!.add(symbol.id);

        // By name
        if (!this.symbolsByName.has(symbol.symbolName)) {
            this.symbolsByName.set(symbol.symbolName, new Set());
        }
        this.symbolsByName.get(symbol.symbolName)!.add(symbol.id);

        // By kind
        if (!this.symbolsByKind.has(symbol.kind)) {
            this.symbolsByKind.set(symbol.kind, new Set());
        }
        this.symbolsByKind.get(symbol.kind)!.add(symbol.id);

        // By language
        if (!this.symbolsByLanguage.has(symbol.language)) {
            this.symbolsByLanguage.set(symbol.language, new Set());
        }
        this.symbolsByLanguage.get(symbol.language)!.add(symbol.id);

        // Exported
        if (symbol.isExported) {
            this.exportedSymbols.add(symbol.id);
        }
    }

    private removeFromSecondaryIndexes(symbol: IndexedSymbol): void {
        this.symbolsByFile.get(symbol.filePath)?.delete(symbol.id);
        this.symbolsByName.get(symbol.symbolName)?.delete(symbol.id);
        this.symbolsByKind.get(symbol.kind)?.delete(symbol.id);
        this.symbolsByLanguage.get(symbol.language)?.delete(symbol.id);
        this.exportedSymbols.delete(symbol.id);
    }

    private intersect(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined {
        if (!a) return b;
        if (!b) return a;

        const result = new Set<string>();
        for (const id of a) {
            if (b.has(id)) {
                result.add(id);
            }
        }
        return result;
    }

    private countByLanguage(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const [lang, ids] of this.symbolsByLanguage) {
            counts[lang] = ids.size;
        }
        return counts;
    }

    private countByKind(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const [kind, ids] of this.symbolsByKind) {
            counts[kind] = ids.size;
        }
        return counts;
    }
}
