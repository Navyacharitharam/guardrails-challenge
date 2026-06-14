import * as fs from 'fs/promises';
import * as path from 'path';
import pLimit from 'p-limit';
import type { Workspace } from '@mastra/core/workspace';
import type { Language, ASTMetadata, Symbol as ASTSymbol } from '../schema';
import { parseFile as astParseFile, isExtensionSupported, initializeASTSystem } from '../parsers';
import { calculateCyclomaticComplexity, calculateNestingDepth, calculateLinesOfCode } from '../analysis/complexity';
import { EXCLUDED_FILE_PATTERNS, isExcludedFile } from '../../filtered-filesystem';
import { tcAILogger } from '../../logger';
import { getReviewEmbedder } from '../../embedder-service';
import {
    type IndexedSymbol,
    type IndexedFile,
    type IndexStats,
    type SymbolMetrics,
    generateSymbolId,
} from './indexed-symbol';
import { StructuredIndexStore } from './structured-index-store';
import { DependencyTracker, resolveImportPath } from './dependency-tracker';
import { detectLogging, detectErrorHandling } from './logging-detector';
import { findAllReferences, attachReferencesToSymbols } from './reference-finder';
import {
    validateAllImports,
    getSymbolsUsingBrokenImports,
    type ImportValidationResult,
} from './import-validator';
import { analyzeMockData, shouldAnalyzeMockData } from './mock-data-detector';

/**
 * Options for AST indexing
 */
export interface ASTIndexOptions {
    basePath: string;
    workspace?: Workspace;
    includeBody?: boolean;
    concurrency?: number;
}

/**
 * Result of indexing operation
 */
export interface IndexingResult {
    filesIndexed: number;
    symbolsIndexed: number;
    filesSkipped: number;
    errors: { file: string; error: string }[];
    durationMs: number;
    indexedFilesList: string[];
    skippedFilesList: string[];
}

/**
 * AST Indexer Service
 * 
 * Iterates workspace, parses source files using Tree-sitter,
 * extracts symbols with pre-computed metrics, and stores them
 * in both structured (in-memory) and vector stores.
 */
export class ASTIndexerService {
    private store: StructuredIndexStore;
    private dependencyTracker: DependencyTracker;
    private workspace?: Workspace;
    private basePath = '';
    private fileExistsCache = new Map<string, boolean>();
    private symbolsEmbedded = 0;
    // Store file contents for reference finding
    private fileContents = new Map<string, { sourceCode: string; language: Language }>();

    constructor() {
        this.store = new StructuredIndexStore();
        this.dependencyTracker = new DependencyTracker();
    }

    /**
     * Index entire workspace
     */
    async indexWorkspace(options: ASTIndexOptions): Promise<IndexingResult> {
        const startTime = Date.now();
        this.basePath = options.basePath;
        this.workspace = options.workspace;
        this.symbolsEmbedded = 0;
        const concurrency = options.concurrency ?? 5;

        tcAILogger.info(`[ASTIndexer] Starting workspace indexing: ${options.basePath}`);
        if (this.workspace) {
            tcAILogger.info(`[ASTIndexer] Vector store indexing enabled`);
        }

        // Initialize AST system (registers parsers)
        await initializeASTSystem();
        tcAILogger.info(`[ASTIndexer] AST system initialized`);

        const result: IndexingResult = {
            filesIndexed: 0,
            symbolsIndexed: 0,
            filesSkipped: 0,
            errors: [],
            durationMs: 0,
            indexedFilesList: [],
            skippedFilesList: [],
        };

        // Clear existing index
        this.store.clear();
        this.dependencyTracker.clear();
        this.fileExistsCache.clear();
        this.fileContents.clear();

        // Collect source files
        const sourceFiles = await this.collectSourceFiles(options.basePath);
        const totalFiles = sourceFiles.length;
        tcAILogger.info(`[ASTIndexer] Found ${totalFiles} source files to index`);
        tcAILogger.info(`[ASTIndexer] Concurrency limit: ${concurrency}`);

        // Process files using streaming worker pool
        const limit = pLimit(concurrency);
        let processedFiles = 0;

        const indexingPromises = sourceFiles.map((filePath) =>
            limit(async () => {
                try {
                    tcAILogger.debug(`[ASTIndexer] Parsing: ${filePath}`);
                    const indexed = await this.indexFile(filePath, options);
                    processedFiles++;

                    if (indexed) {
                        result.filesIndexed++;
                        result.symbolsIndexed += indexed.symbolCount;
                        result.indexedFilesList.push(filePath);
                        tcAILogger.info(`[ASTIndexer]   + ${filePath} (${indexed.symbolCount} symbols)`);
                    } else {
                        result.filesSkipped++;
                        result.skippedFilesList.push(filePath);
                        tcAILogger.debug(`[ASTIndexer]   - ${filePath} (skipped)`);
                    }
                } catch (err) {
                    processedFiles++;
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    result.errors.push({ file: filePath, error: errorMsg });
                    tcAILogger.warn(`[ASTIndexer]   ! ${filePath} (error: ${errorMsg})`);
                }

                // Progress update
                if (processedFiles % 20 === 0 || processedFiles === totalFiles) {
                    const progress = Math.round((processedFiles / totalFiles) * 100);
                    tcAILogger.info(`[ASTIndexer] Progress: ${progress}% (${result.symbolsIndexed} symbols indexed)`);
                }
            })
        );

        await Promise.all(indexingPromises);

        // Find all references for symbols
        tcAILogger.info(`[ASTIndexer] Phase 2: Finding references across ${this.fileContents.size} files...`);
        const refStartTime = Date.now();
        const referencesMap = findAllReferences(this.store, this.fileContents);
        tcAILogger.info(`[ASTIndexer] Reference scanning completed in ${Date.now() - refStartTime}ms`);

        tcAILogger.info(`[ASTIndexer] Attaching references to symbols...`);
        attachReferencesToSymbols(this.store, referencesMap);

        // Count symbols with/without references
        let symbolsWithRefs = 0;
        let symbolsWithoutRefs = 0;
        let totalRefs = 0;
        for (const [, refs] of referencesMap) {
            if (refs.length > 0) {
                symbolsWithRefs++;
                totalRefs += refs.length;
            } else {
                symbolsWithoutRefs++;
            }
        }
        tcAILogger.info(`[ASTIndexer] References: ${totalRefs} total, ${symbolsWithRefs} symbols with refs, ${symbolsWithoutRefs} without`);

        // Phase 3: Validate imports
        tcAILogger.info(`[ASTIndexer] Phase 3: Validating imports...`);
        const importValidation = validateAllImports(this.store, this.basePath);
        this.attachBrokenImportsToSymbols(importValidation.results);

        if (importValidation.totalBroken > 0) {
            tcAILogger.warn(`[ASTIndexer] Found ${importValidation.totalBroken} broken imports in ${importValidation.filesWithBrokenImports} files`);
            for (const result of importValidation.results) {
                for (const broken of result.brokenImports) {
                    const issueType = broken.issue === 'file_not_found' ? 'FILE NOT FOUND' : 'SYMBOL NOT EXPORTED';
                    tcAILogger.warn(`[ASTIndexer]   ! ${result.filePath}: ${broken.importedSymbols.join(', ')} from '${broken.importPath}' (${issueType})`);
                }
            }
        } else {
            tcAILogger.info(`[ASTIndexer] All imports validated successfully`);
        }

        result.durationMs = Date.now() - startTime;
        this.store.updateStats(result.durationMs);

        // Log summary
        this.logIndexingSummary(result);

        return result;
    }

    /**
     * Attach broken import info to symbols that use them
     */
    private attachBrokenImportsToSymbols(validationResults: ImportValidationResult[]): void {
        const symbolToBrokenImports = getSymbolsUsingBrokenImports(validationResults);

        for (const [symbolKey, brokenImports] of symbolToBrokenImports) {
            const [filePath, symbolName] = symbolKey.split(':');
            const symbols = this.store.getSymbolsForFile(filePath);
            const symbol = symbols.find(s => s.symbolName === symbolName);

            if (symbol) {
                symbol.brokenImports = brokenImports.map(bi => ({
                    importPath: bi.importPath,
                    resolvedPath: bi.resolvedPath,
                    importedSymbols: bi.importedSymbols,
                    issue: bi.issue,
                }));
            }
        }
    }

    /**
     * Index a single file
     */
    async indexFile(
        filePath: string,
        options: Pick<ASTIndexOptions, 'includeBody'>
    ): Promise<{ symbolCount: number } | null> {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.basePath, filePath);
        const relativePath = path.isAbsolute(filePath)
            ? path.relative(this.basePath, filePath)
            : filePath;

        tcAILogger.debug(`[ASTIndexer] Processing: ${relativePath}`);

        // Check if supported
        if (!isExtensionSupported(path.extname(filePath))) {
            tcAILogger.debug(`[ASTIndexer] [${relativePath}] Skipped: unsupported extension`);
            return null;
        }

        // Check if excluded
        if (isExcludedFile(relativePath)) {
            tcAILogger.debug(`[ASTIndexer] [${relativePath}] Skipped: excluded file`);
            return null;
        }

        // Read file
        let sourceCode: string;
        try {
            sourceCode = await fs.readFile(absolutePath, 'utf-8');
        } catch {
            return null;
        }

        // Parse AST (auto-initializes the AST system if needed)
        const ast = await astParseFile(filePath, sourceCode);
        if (!ast) {
            return null;
        }

        // Store file contents for reference finding
        this.fileContents.set(relativePath, { sourceCode, language: ast.language });

        // Convert to indexed symbols
        const indexedSymbols = this.convertToIndexedSymbols(
            relativePath,
            ast,
            sourceCode,
            options.includeBody ?? false
        );

        // Store symbols
        this.store.addSymbols(indexedSymbols);

        // Create file entry
        const indexedFile: IndexedFile = {
            filePath: relativePath,
            language: ast.language,
            symbolIds: indexedSymbols.map(s => s.id),
            imports: ast.imports.map(i => i.source),
            exports: ast.exports.map(e => e.defaultName || e.symbols?.map(s => s.name).join(', ') || ''),
            metrics: {
                totalLines: ast.metrics?.totalLines ?? 0,
                codeLines: ast.metrics?.codeLines ?? 0,
                symbolCount: ast.metrics?.symbolCount ?? 0,
                functionCount: ast.metrics?.functionCount ?? 0,
                classCount: ast.metrics?.classCount ?? 0,
            },
            parseTimeMs: ast.parseTimeMs ?? 0,
            indexedAt: Date.now(),
        };
        this.store.addFile(indexedFile);

        // Track dependencies
        const resolvedImports = this.resolveImports(ast.imports.map(i => i.source), relativePath);
        this.dependencyTracker.registerFile(indexedFile, resolvedImports);

        // Index symbols in vector store for search
        if (this.workspace) {
            await this.indexSymbolsInVectorStore(indexedSymbols, sourceCode);
        }

        tcAILogger.debug(`[ASTIndexer] Indexed: ${relativePath} (${indexedSymbols.length} symbols)`);

        return { symbolCount: indexedSymbols.length };
    }

    /**
     * Update a file and its dependents (for incremental updates)
     */
    async updateFile(filePath: string, options: ASTIndexOptions): Promise<IndexingResult> {
        const startTime = Date.now();
        const result: IndexingResult = {
            filesIndexed: 0,
            symbolsIndexed: 0,
            filesSkipped: 0,
            errors: [],
            durationMs: 0,
            indexedFilesList: [],
            skippedFilesList: [],
        };

        // Get affected files
        const affectedFiles = this.dependencyTracker.getAffectedFiles(filePath);
        tcAILogger.info(`[ASTIndexer] Updating ${affectedFiles.length} affected files`);

        for (const file of affectedFiles) {
            // Remove old data
            this.store.removeFile(file);

            try {
                const indexed = await this.indexFile(file, options);
                if (indexed) {
                    result.filesIndexed++;
                    result.symbolsIndexed += indexed.symbolCount;
                    result.indexedFilesList.push(file);
                } else {
                    result.filesSkipped++;
                    result.skippedFilesList.push(file);
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                result.errors.push({ file, error: errorMsg });
            }
        }

        result.durationMs = Date.now() - startTime;
        return result;
    }

    /**
     * Get the structured index store
     */
    getStore(): StructuredIndexStore {
        return this.store;
    }

    /**
     * Get dependency tracker
     */
    getDependencyTracker(): DependencyTracker {
        return this.dependencyTracker;
    }

    /**
     * Get index statistics
     */
    getStats(): IndexStats {
        return this.store.getStats();
    }

    /**
     * Export index to JSON
     */
    exportIndex(): { index: string; dependencies: string } {
        return {
            index: this.store.exportToJSON(),
            dependencies: this.dependencyTracker.exportToJSON(),
        };
    }

    /**
     * Import index from JSON
     */
    importIndex(data: { index: string; dependencies: string }): void {
        this.store.importFromJSON(data.index);
        this.dependencyTracker.importFromJSON(data.dependencies);
    }

    /**
     * Clear all indexed data
     */
    clear(): void {
        this.store.clear();
        this.dependencyTracker.clear();
        this.fileExistsCache.clear();
    }

    // --- Private methods ---

    private async collectSourceFiles(basePath: string): Promise<string[]> {
        const files: string[] = [];

        const walk = async (dir: string, relativePath: string): Promise<void> => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                const entryFullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip excluded directories
                    if (EXCLUDED_FILE_PATTERNS.directories.includes(entry.name)) continue;
                    if (entry.name.startsWith('.') && entry.name !== '.github') continue;

                    await walk(entryFullPath, entryRelPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (isExtensionSupported(ext) && !isExcludedFile(entryRelPath)) {
                        files.push(entryRelPath);
                        this.fileExistsCache.set(entryRelPath, true);
                    }
                }
            }
        };

        await walk(basePath, '');
        return files;
    }

    private convertToIndexedSymbols(
        filePath: string,
        ast: ASTMetadata,
        sourceCode: string,
        includeBody: boolean
    ): IndexedSymbol[] {
        const symbols: IndexedSymbol[] = [];

        const processSymbol = (
            symbol: ASTSymbol,
            parentId?: string,
            parentName?: string,
            parentKind?: string
        ): void => {
            const id = generateSymbolId(filePath, symbol.name, symbol.kind, symbol.location.line);

            // Get body text for metrics
            const bodyText = sourceCode.slice(symbol.location.startByte, symbol.location.endByte);

            // Compute metrics
            const metrics = this.computeMetrics(bodyText, ast.language, symbol);

            // Extract property metadata if this is a property-like symbol
            const propertyMeta = this.extractPropertyMetadata(symbol, bodyText);

            const indexed: IndexedSymbol = {
                id,
                filePath,
                language: ast.language,
                symbolName: symbol.name,
                kind: symbol.kind,
                span: {
                    startLine: symbol.location.line,
                    endLine: symbol.location.line + bodyText.split('\n').length - 1,
                    startCol: symbol.location.column,
                    endCol: symbol.location.column, // Could be more precise
                    startByte: symbol.location.startByte,
                    endByte: symbol.location.endByte,
                },
                signature: symbol.signature,
                visibility: symbol.visibility,
                isExported: symbol.isExported,
                isAsync: symbol.isAsync,
                isStatic: symbol.isStatic,
                isAbstract: symbol.isAbstract,
                parentSymbolId: parentId,
                parentSymbolName: parentName,
                parentSymbolKind: parentKind as IndexedSymbol['parentSymbolKind'],
                childrenIds: symbol.members?.map(m =>
                    generateSymbolId(filePath, m.name, m.kind, m.location.line)
                ),
                // Property-specific fields
                propertyType: propertyMeta.propertyType,
                isOptional: propertyMeta.isOptional,
                isReadonly: propertyMeta.isReadonly,
                hasInitializer: propertyMeta.hasInitializer,
                // Relations
                callTargets: symbol.body?.callTargets,
                implementsOrExtends: [
                    ...(symbol.extends ? [symbol.extends] : []),
                    ...(symbol.implements ?? []),
                ],
                decorators: symbol.decorators,
                metrics,
                indexedAt: Date.now(),
            };

            // Analyze mock data for applicable symbol kinds
            if (shouldAnalyzeMockData(symbol.kind)) {
                const mockAnalysis = analyzeMockData(
                    bodyText,
                    symbol.name,
                    symbol.body?.callTargets ?? [],
                    ast.language
                );
                // Only attach if mock data detected or high confidence non-mock
                if (mockAnalysis.hasMockData || mockAnalysis.indicators.length > 0) {
                    indexed.mockData = mockAnalysis;
                }
            }

            if (includeBody) {
                indexed.bodyText = bodyText;
            }

            symbols.push(indexed);

            // Process nested symbols with parent context
            if (symbol.members) {
                for (const member of symbol.members) {
                    processSymbol(member, id, symbol.name, symbol.kind);
                }
            }
        };

        for (const symbol of ast.symbols) {
            processSymbol(symbol);
        }

        return symbols;
    }

    /**
     * Extract property-specific metadata from symbol and body text
     */
    private extractPropertyMetadata(symbol: ASTSymbol, bodyText: string): {
        propertyType?: string;
        isOptional?: boolean;
        isReadonly?: boolean;
        hasInitializer?: boolean;
    } {
        const propertyKinds = ['property', 'field', 'property_signature'];
        if (!propertyKinds.includes(symbol.kind)) {
            return {};
        }

        // Try to extract from signature first
        const sig = symbol.signature ?? bodyText;

        // Check for optional (?)
        const isOptional = /\w+\s*\?:/.test(sig) || /\w+\s*\?\s*=/.test(sig);

        // Check for readonly
        const isReadonly = /\breadonly\b/i.test(sig);

        // Check for initializer (= something)
        const hasInitializer = /=\s*[^>]/.test(sig) && !/=>\s*/.test(sig);

        // Extract type annotation
        let propertyType: string | undefined;
        const typeMatch = sig.match(/:\s*([^=;]+?)(?:\s*[=;]|$)/);
        if (typeMatch) {
            propertyType = typeMatch[1].trim();
        }

        return {
            propertyType,
            isOptional: isOptional || undefined,
            isReadonly: isReadonly || undefined,
            hasInitializer: hasInitializer || undefined,
        };
    }

    private computeMetrics(bodyText: string, language: Language, symbol: ASTSymbol): SymbolMetrics {
        const isFunctionLike = [
            'function', 'async_function', 'arrow_function', 'generator_function',
            'method', 'constructor', 'getter', 'setter', 'lambda'
        ].includes(symbol.kind);

        return {
            complexity: isFunctionLike ? calculateCyclomaticComplexity(bodyText, language) : 0,
            nesting: calculateNestingDepth(bodyText),
            linesOfCode: calculateLinesOfCode(bodyText, language),
            parameterCount: symbol.parameters?.length ?? 0,
            hasLogging: detectLogging(bodyText, language),
            hasErrorHandling: detectErrorHandling(bodyText, language),
        };
    }

    private resolveImports(importSources: string[], fromFile: string): string[] {
        const resolved: string[] = [];
        const fileExists = (p: string) => this.fileExistsCache.has(p);

        for (const source of importSources) {
            const resolvedPath = resolveImportPath(source, fromFile, fileExists);
            if (resolvedPath) {
                resolved.push(resolvedPath);
            }
        }

        return resolved;
    }

    /**
     * Index symbols in the Mastra workspace vector store for semantic search.
     * Creates comprehensive text representations including signature, body, and metrics.
     * Uses parallel embedding with concurrency control from EmbedderService.
     */
    private async indexSymbolsInVectorStore(symbols: IndexedSymbol[], sourceCode: string): Promise<void> {
        if (!this.workspace) return;
        if (symbols.length === 0) return;

        const embedder = getReviewEmbedder();
        const embedLimit = pLimit(8); // Match embedder concurrency

        const embedPromises = symbols.map((symbol) =>
            embedLimit(async () => {
                const documentPath = `${symbol.filePath}:${symbol.symbolName}`;
                const content = this.createSymbolDocument(symbol, sourceCode);

                try {
                    embedder.setEmbedSource(`symbol:${documentPath}`);

                    await this.workspace!.index(documentPath, content, {
                        type: 'file',
                        metadata: {
                            symbolId: symbol.id,
                            kind: symbol.kind,
                            language: symbol.language,
                            filePath: symbol.filePath,
                            symbolName: symbol.symbolName,
                            line: symbol.span.startLine,
                            complexity: symbol.metrics.complexity,
                            hasLogging: symbol.metrics.hasLogging,
                            hasErrorHandling: symbol.metrics.hasErrorHandling,
                            isExported: symbol.isExported ?? false,
                        },
                    });
                    this.symbolsEmbedded++;
                } catch (err) {
                    tcAILogger.debug(`[ASTIndexer] Failed to embed symbol: ${documentPath}`, { error: err });
                }
            })
        );

        await Promise.all(embedPromises);
    }

    /**
     * Create a comprehensive document for a symbol including all details for search.
     */
    private createSymbolDocument(symbol: IndexedSymbol, sourceCode: string): string {
        const sections: string[] = [];

        // Header with kind and name
        sections.push(`[${symbol.kind.toUpperCase()}] ${symbol.symbolName}`);
        sections.push(`Language: ${symbol.language}`);
        sections.push(`File: ${symbol.filePath}:${symbol.span.startLine}`);

        // Signature
        if (symbol.signature) {
            sections.push(`\nSignature:\n${symbol.signature}`);
        }

        // Visibility and modifiers
        const modifiers: string[] = [];
        if (symbol.visibility) modifiers.push(symbol.visibility);
        if (symbol.isExported) modifiers.push('exported');
        if (symbol.isAsync) modifiers.push('async');
        if (symbol.isStatic) modifiers.push('static');
        if (symbol.isAbstract) modifiers.push('abstract');
        if (modifiers.length > 0) {
            sections.push(`Modifiers: ${modifiers.join(', ')}`);
        }

        // Inheritance
        if (symbol.implementsOrExtends && symbol.implementsOrExtends.length > 0) {
            sections.push(`Extends/Implements: ${symbol.implementsOrExtends.join(', ')}`);
        }

        // Decorators
        if (symbol.decorators && symbol.decorators.length > 0) {
            sections.push(`Decorators: ${symbol.decorators.join(', ')}`);
        }

        // Metrics
        sections.push(`\nMetrics:`);
        sections.push(`  Complexity: ${symbol.metrics.complexity}`);
        sections.push(`  Nesting depth: ${symbol.metrics.nesting}`);
        sections.push(`  Lines of code: ${symbol.metrics.linesOfCode}`);
        sections.push(`  Parameters: ${symbol.metrics.parameterCount}`);
        sections.push(`  Has logging: ${symbol.metrics.hasLogging ? 'yes' : 'no'}`);
        sections.push(`  Has error handling: ${symbol.metrics.hasErrorHandling ? 'yes' : 'no'}`);

        // Call targets
        if (symbol.callTargets && symbol.callTargets.length > 0) {
            sections.push(`\nCalls: ${symbol.callTargets.join(', ')}`);
        }

        // Body (the actual code)
        if (symbol.bodyText) {
            sections.push(`\nBody:\n${symbol.bodyText}`);
        } else {
            // Extract body from source code using span
            const body = sourceCode.slice(symbol.span.startByte, symbol.span.endByte);
            if (body.length <= 4000) { // Limit body size
                sections.push(`\nBody:\n${body}`);
            } else {
                sections.push(`\nBody (truncated):\n${body.slice(0, 4000)}...`);
            }
        }

        // Doc comment
        if (symbol.docComment) {
            sections.push(`\nDocumentation:\n${symbol.docComment}`);
        }

        return sections.join('\n');
    }

    private logIndexingSummary(result: IndexingResult): void {
        const stats = this.store.getStats();

        tcAILogger.info(`[ASTIndexer] ========== Indexing Complete ==========`);
        tcAILogger.info(`[ASTIndexer] Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
        tcAILogger.info(`[ASTIndexer] Files indexed: ${result.filesIndexed}`);
        tcAILogger.info(`[ASTIndexer] Files skipped: ${result.filesSkipped}`);
        tcAILogger.info(`[ASTIndexer] Symbols indexed: ${result.symbolsIndexed}`);
        tcAILogger.info(`[ASTIndexer] Symbols in vector store: ${this.symbolsEmbedded}`);
        tcAILogger.info(`[ASTIndexer] Errors: ${result.errors.length}`);

        // Log indexed files list
        if (result.indexedFilesList.length > 0) {
            tcAILogger.info(`[ASTIndexer] Indexed files:`);
            for (const file of result.indexedFilesList) {
                const fileSymbols = this.store.getSymbolsForFile(file);
                tcAILogger.info(`[ASTIndexer]   + ${file} (${fileSymbols.length} symbols)`);
            }
        }

        // Log skipped files list
        if (result.skippedFilesList.length > 0) {
            tcAILogger.info(`[ASTIndexer] Skipped files:`);
            for (const file of result.skippedFilesList) {
                tcAILogger.info(`[ASTIndexer]   - ${file}`);
            }
        }

        if (Object.keys(stats.byLanguage).length > 0) {
            tcAILogger.info(`[ASTIndexer] By language:`);
            for (const [lang, count] of Object.entries(stats.byLanguage)) {
                tcAILogger.info(`[ASTIndexer]   - ${lang}: ${count} symbols`);
            }
        }

        if (Object.keys(stats.byKind).length > 0) {
            tcAILogger.info(`[ASTIndexer] By kind (top 5):`);
            const sorted = Object.entries(stats.byKind).sort((a, b) => b[1] - a[1]).slice(0, 5);
            for (const [kind, count] of sorted) {
                tcAILogger.info(`[ASTIndexer]   - ${kind}: ${count}`);
            }
        }

        const depStats = this.dependencyTracker.getStats();
        tcAILogger.info(`[ASTIndexer] Dependencies: avg ${depStats.avgImports.toFixed(1)} imports/file`);
        if (depStats.maxDependents) {
            tcAILogger.info(`[ASTIndexer] Most depended: ${depStats.maxDependents.file} (${depStats.maxDependents.count} dependents)`);
        }

        if (result.errors.length > 0 && result.errors.length <= 5) {
            tcAILogger.warn(`[ASTIndexer] Error details:`);
            for (const { file, error } of result.errors) {
                tcAILogger.warn(`[ASTIndexer]   ! ${file}: ${error}`);
            }
        }

        tcAILogger.info(`[ASTIndexer] ==========================================`);
    }
}
