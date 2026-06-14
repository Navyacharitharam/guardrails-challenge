import { z } from 'zod';
import type { SymbolKind, Visibility, Language } from '../schema';
import type { MockDataAnalysis } from './mock-data-detector';

/**
 * Span information for indexed symbols
 */
export const spanSchema = z.object({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    startCol: z.number().int().min(0),
    endCol: z.number().int().min(0),
    startByte: z.number().int().min(0),
    endByte: z.number().int().min(0),
});

export type Span = z.infer<typeof spanSchema>;

/**
 * Pre-computed metrics for a symbol (language-agnostic)
 */
export interface SymbolMetrics {
    complexity: number;
    nesting: number;
    linesOfCode: number;
    parameterCount: number;
    hasLogging: boolean;
    hasErrorHandling: boolean;
}

/**
 * A reference to a symbol (where it's called/used)
 */
export interface SymbolReference {
    /** File where the reference occurs */
    filePath: string;
    /** Line number of the reference */
    line: number;
    /** Column of the reference */
    column: number;
    /** The calling context/signature (e.g., "await fetchUser(id)") */
    callSignature: string;
    /** The function/method containing this call (if any) */
    containingSymbol?: string;
}

/**
 * Unified indexed symbol schema for the AST index store.
 * Normalized across all supported languages.
 */
export interface IndexedSymbol {
    // Identity
    id: string;
    filePath: string;
    language: Language;

    // Symbol info
    symbolName: string;
    kind: SymbolKind;
    span: Span;
    signature?: string;
    visibility?: Visibility;
    isExported?: boolean;
    isAsync?: boolean;
    isStatic?: boolean;
    isAbstract?: boolean;

    // Hierarchy
    parentSymbolId?: string;
    parentSymbolName?: string;
    parentSymbolKind?: SymbolKind;
    childrenIds?: string[];

    // Property-specific
    propertyType?: string;
    isOptional?: boolean;
    isReadonly?: boolean;
    hasInitializer?: boolean;

    // Relations
    imports?: string[];
    exports?: string[];
    callTargets?: string[];
    implementsOrExtends?: string[];
    decorators?: string[];

    // Pre-computed metrics
    metrics: SymbolMetrics;

    // References (where this symbol is called/used)
    references?: SymbolReference[];

    // Broken imports used by this symbol
    brokenImports?: {
        importPath: string;
        resolvedPath: string;
        importedSymbols: string[];
        issue: 'file_not_found' | 'symbol_not_exported';
    }[];

    // Mock data detection results
    mockData?: MockDataAnalysis;

    // Body content (optional, for review)
    bodyText?: string;
    docComment?: string;

    // Metadata
    indexedAt: number;
}

/**
 * File-level index entry
 */
export interface IndexedFile {
    filePath: string;
    language: Language;
    symbolIds: string[];
    imports: string[];
    exports: string[];
    metrics: {
        totalLines: number;
        codeLines: number;
        symbolCount: number;
        functionCount: number;
        classCount: number;
    };
    parseTimeMs: number;
    indexedAt: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
    totalFiles: number;
    totalSymbols: number;
    byLanguage: Record<string, number>;
    byKind: Record<string, number>;
    indexTimeMs: number;
    lastUpdated: number;
}

/**
 * Generate a unique ID for a symbol
 */
export function generateSymbolId(
    filePath: string,
    symbolName: string,
    kind: string,
    line: number
): string {
    const input = `${filePath}:${symbolName}:${kind}:${line}`;
    // Simple hash for uniqueness
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return `sym_${Math.abs(hash).toString(36)}_${line}`;
}
