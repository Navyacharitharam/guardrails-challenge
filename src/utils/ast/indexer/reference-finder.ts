/**
 * Reference finder for locating where symbols are called/used across the codebase.
 */

import type { Language } from '../schema';
import type { SymbolReference, IndexedSymbol } from './indexed-symbol';
import type { StructuredIndexStore } from './structured-index-store';

/**
 * Function-like symbol kinds (referenced via function calls)
 */
const FUNCTION_LIKE_KINDS = new Set([
    'function',
    'async_function',
    'arrow_function',
    'generator_function',
    'method',
    'constructor',
    'getter',
    'setter',
    'lambda',
]);

/**
 * Variable/constant kinds (referenced by identifier)
 */
const VARIABLE_LIKE_KINDS = new Set([
    'variable',
    'constant',
    'let',
    'const',
    'var',
]);

/**
 * Property kinds (class fields, referenced via this.prop or obj.prop)
 */
const PROPERTY_LIKE_KINDS = new Set([
    'property',
    'field',
    'member',
]);

/**
 * Class-like kinds (referenced via new ClassName() or extends/implements)
 */
const CLASS_LIKE_KINDS = new Set([
    'class',
    'abstract_class',
    'interface',
    'type_alias',
    'enum',
]);

/**
 * Extract the call signature from source code around a match
 */
function extractCallSignature(
    sourceCode: string,
    matchIndex: number
): string {
    // Find the start of the statement (look back for newline or semicolon)
    let start = matchIndex;
    while (start > 0 && !['\n', ';', '{', '}'].includes(sourceCode[start - 1])) {
        start--;
    }

    // Find the end of the call (match parentheses)
    let end = matchIndex;
    let parenDepth = 0;
    let foundOpenParen = false;

    while (end < sourceCode.length) {
        const char = sourceCode[end];
        if (char === '(') {
            parenDepth++;
            foundOpenParen = true;
        } else if (char === ')') {
            parenDepth--;
            if (foundOpenParen && parenDepth === 0) {
                end++;
                break;
            }
        } else if (char === '\n' && foundOpenParen && parenDepth === 0) {
            break;
        }
        end++;
    }

    // Extract and clean up the signature
    let signature = sourceCode.slice(start, end).trim();

    // Truncate if too long
    if (signature.length > 100) {
        signature = signature.slice(0, 97) + '...';
    }

    return signature;
}

/**
 * Get line and column from byte offset
 */
function getLineAndColumn(
    sourceCode: string,
    byteOffset: number
): { line: number; column: number } {
    const before = sourceCode.slice(0, byteOffset);
    const lines = before.split('\n');
    return {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
    };
}

/**
 * Find containing function/method for a given position
 */
function findContainingSymbol(
    symbols: IndexedSymbol[],
    filePath: string,
    line: number
): string | undefined {
    const fileSymbols = symbols.filter(s =>
        s.filePath === filePath &&
        FUNCTION_LIKE_KINDS.has(s.kind) &&
        s.span.startLine <= line &&
        s.span.endLine >= line
    );

    // Return the innermost (smallest range) containing symbol
    if (fileSymbols.length === 0) return undefined;

    fileSymbols.sort((a, b) => {
        const aRange = a.span.endLine - a.span.startLine;
        const bRange = b.span.endLine - b.span.startLine;
        return aRange - bRange;
    });

    return fileSymbols[0].symbolName;
}

/**
 * Find all references to symbols across the indexed codebase.
 * Handles function calls, identifier references, and class instantiations.
 *
 * @param store - The structured index store containing all indexed symbols
 * @param fileContents - Map of filePath -> sourceCode for all indexed files
 * @returns Map of symbolId -> references
 */
export function findAllReferences(
    store: StructuredIndexStore,
    fileContents: Map<string, { sourceCode: string; language: Language }>
): Map<string, SymbolReference[]> {
    const referencesMap = new Map<string, SymbolReference[]>();

    // Get all symbols that can be referenced
    const allIndexedSymbols = store.query({});

    // Build lookup maps by symbol name and kind
    const functionsByName = new Map<string, IndexedSymbol[]>();
    const variablesByName = new Map<string, IndexedSymbol[]>();
    const classesByName = new Map<string, IndexedSymbol[]>();
    const propertiesByName = new Map<string, IndexedSymbol[]>();

    for (const symbol of allIndexedSymbols) {
        // Initialize empty references array for each symbol
        referencesMap.set(symbol.id, []);

        if (FUNCTION_LIKE_KINDS.has(symbol.kind)) {
            const existing = functionsByName.get(symbol.symbolName) || [];
            existing.push(symbol);
            functionsByName.set(symbol.symbolName, existing);
        } else if (VARIABLE_LIKE_KINDS.has(symbol.kind)) {
            const existing = variablesByName.get(symbol.symbolName) || [];
            existing.push(symbol);
            variablesByName.set(symbol.symbolName, existing);
        } else if (CLASS_LIKE_KINDS.has(symbol.kind)) {
            const existing = classesByName.get(symbol.symbolName) || [];
            existing.push(symbol);
            classesByName.set(symbol.symbolName, existing);
        } else if (PROPERTY_LIKE_KINDS.has(symbol.kind)) {
            const existing = propertiesByName.get(symbol.symbolName) || [];
            existing.push(symbol);
            propertiesByName.set(symbol.symbolName, existing);
        }
    }

    // Scan each file for references
    for (const [filePath, { sourceCode }] of fileContents) {
        // Find function calls
        findFunctionCallReferences(
            filePath, sourceCode,
            functionsByName, allIndexedSymbols, referencesMap
        );

        // Find variable/constant usages
        findIdentifierReferences(
            filePath, sourceCode,
            variablesByName, allIndexedSymbols, referencesMap
        );

        // Find class instantiations and type references
        findClassReferences(
            filePath, sourceCode,
            classesByName, allIndexedSymbols, referencesMap
        );

        // Find property accesses (this.prop, obj.prop)
        findPropertyReferences(
            filePath, sourceCode,
            propertiesByName, allIndexedSymbols, referencesMap
        );
    }

    return referencesMap;
}

/**
 * Find function call references in a file
 */
function findFunctionCallReferences(
    filePath: string,
    sourceCode: string,
    functionsByName: Map<string, IndexedSymbol[]>,
    allSymbols: IndexedSymbol[],
    referencesMap: Map<string, SymbolReference[]>
): void {
    // Pattern to match function calls: functionName( or object.method(
    const callPattern = /(?:await\s+)?(?:\w+\.)?(\w+)\s*(?:<[^>]*>)?\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(sourceCode)) !== null) {
        const functionName = match[1];

        const candidates = functionsByName.get(functionName);
        if (!candidates || candidates.length === 0) continue;

        const { line, column } = getLineAndColumn(sourceCode, match.index);
        const callSignature = extractCallSignature(sourceCode, match.index);
        const containingSymbol = findContainingSymbol(allSymbols, filePath, line);

        for (const symbol of candidates) {
            // Skip definition line
            if (symbol.filePath === filePath && symbol.span.startLine === line) continue;

            const refs = referencesMap.get(symbol.id) || [];
            refs.push({ filePath, line, column, callSignature, containingSymbol });
            referencesMap.set(symbol.id, refs);
        }
    }
}

/**
 * Find identifier (variable/constant) references in a file
 */
function findIdentifierReferences(
    filePath: string,
    sourceCode: string,
    variablesByName: Map<string, IndexedSymbol[]>,
    allSymbols: IndexedSymbol[],
    referencesMap: Map<string, SymbolReference[]>
): void {
    // For each variable/constant we're tracking, search for its usage
    for (const [varName, symbols] of variablesByName) {
        // Pattern to match identifier usage (word boundary to avoid partial matches)
        // Matches: varName but not varName2, not part of other identifiers
        const identifierPattern = new RegExp(`\\b${escapeRegExp(varName)}\\b`, 'g');

        let match: RegExpExecArray | null;
        while ((match = identifierPattern.exec(sourceCode)) !== null) {
            const { line, column } = getLineAndColumn(sourceCode, match.index);

            // Skip if this is likely the definition (check all symbols with this name)
            let isDefinition = false;
            for (const symbol of symbols) {
                if (symbol.filePath === filePath &&
                    line >= symbol.span.startLine &&
                    line <= symbol.span.endLine &&
                    symbol.span.startLine === line) {
                    // This is on the definition line
                    isDefinition = true;
                    break;
                }
            }
            if (isDefinition) continue;

            const callSignature = extractCallSignature(sourceCode, match.index);
            const containingSymbol = findContainingSymbol(allSymbols, filePath, line);

            // Add reference to matching symbols (prefer same-file symbols)
            const sameFileSymbols = symbols.filter(s => s.filePath === filePath);
            const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;

            for (const symbol of targetSymbols) {
                const refs = referencesMap.get(symbol.id) || [];
                refs.push({ filePath, line, column, callSignature, containingSymbol });
                referencesMap.set(symbol.id, refs);
            }
        }
    }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find class/interface/type references in a file
 * Matches: new ClassName(), extends ClassName, implements Interface, : TypeName
 */
function findClassReferences(
    filePath: string,
    sourceCode: string,
    classesByName: Map<string, IndexedSymbol[]>,
    allSymbols: IndexedSymbol[],
    referencesMap: Map<string, SymbolReference[]>
): void {
    for (const [className, symbols] of classesByName) {
        // Patterns for class usage:
        // - new ClassName(  - instantiation
        // - extends ClassName - inheritance
        // - implements ClassName - interface implementation
        // - : ClassName - type annotation
        // - <ClassName> - generic type parameter
        // - as ClassName - type casting
        const patterns = [
            new RegExp(`\\bnew\\s+${escapeRegExp(className)}\\s*(?:<[^>]*>)?\\s*\\(`, 'g'),  // new Class()
            new RegExp(`\\bextends\\s+${escapeRegExp(className)}\\b`, 'g'),                   // extends Class
            new RegExp(`\\bimplements\\s+[\\w,\\s]*\\b${escapeRegExp(className)}\\b`, 'g'),   // implements Interface
            new RegExp(`:\\s*${escapeRegExp(className)}\\b`, 'g'),                            // : Type
            new RegExp(`<${escapeRegExp(className)}\\b`, 'g'),                                // <Generic>
            new RegExp(`\\bas\\s+${escapeRegExp(className)}\\b`, 'g'),                        // as Type
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(sourceCode)) !== null) {
                const { line, column } = getLineAndColumn(sourceCode, match.index);

                // Skip definition line
                let isDefinition = false;
                for (const symbol of symbols) {
                    if (symbol.filePath === filePath && symbol.span.startLine === line) {
                        isDefinition = true;
                        break;
                    }
                }
                if (isDefinition) continue;

                const callSignature = extractCallSignature(sourceCode, match.index);
                const containingSymbol = findContainingSymbol(allSymbols, filePath, line);

                // Prefer same-file symbols
                const sameFileSymbols = symbols.filter(s => s.filePath === filePath);
                const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;

                for (const symbol of targetSymbols) {
                    const refs = referencesMap.get(symbol.id) || [];
                    // Avoid duplicate references on the same line
                    if (!refs.some(r => r.filePath === filePath && r.line === line)) {
                        refs.push({ filePath, line, column, callSignature, containingSymbol });
                        referencesMap.set(symbol.id, refs);
                    }
                }
            }
        }
    }
}

/**
 * Find property references in a file (this.prop, self.prop, object.prop)
 */
function findPropertyReferences(
    filePath: string,
    sourceCode: string,
    propertiesByName: Map<string, IndexedSymbol[]>,
    allSymbols: IndexedSymbol[],
    referencesMap: Map<string, SymbolReference[]>
): void {
    for (const [propName, symbols] of propertiesByName) {
        // Pattern to match property access: this.propName, self.propName, or identifier.propName
        // Also matches direct usage in same class context
        const patterns = [
            new RegExp(`\\bthis\\.${escapeRegExp(propName)}\\b`, 'g'),      // this.prop
            new RegExp(`\\bself\\.${escapeRegExp(propName)}\\b`, 'g'),      // self.prop (Python)
            new RegExp(`\\.${escapeRegExp(propName)}\\b(?!\\s*[:(])`, 'g'), // obj.prop (not method call)
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(sourceCode)) !== null) {
                const { line, column } = getLineAndColumn(sourceCode, match.index);

                // Skip definition line
                let isDefinition = false;
                for (const symbol of symbols) {
                    if (symbol.filePath === filePath && symbol.span.startLine === line) {
                        isDefinition = true;
                        break;
                    }
                }
                if (isDefinition) continue;

                const callSignature = extractCallSignature(sourceCode, match.index);
                const containingSymbol = findContainingSymbol(allSymbols, filePath, line);

                // For properties, strongly prefer same-file symbols (class members)
                const sameFileSymbols = symbols.filter(s => s.filePath === filePath);
                const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;

                for (const symbol of targetSymbols) {
                    const refs = referencesMap.get(symbol.id) || [];
                    // Avoid duplicate references on the same line
                    if (!refs.some(r => r.filePath === filePath && r.line === line)) {
                        refs.push({ filePath, line, column, callSignature, containingSymbol });
                        referencesMap.set(symbol.id, refs);
                    }
                }
            }
        }
    }
}

/**
 * Update symbols in the store with their references
 */
export function attachReferencesToSymbols(
    store: StructuredIndexStore,
    referencesMap: Map<string, SymbolReference[]>
): void {
    for (const [symbolId, references] of referencesMap) {
        const symbol = store.getSymbol(symbolId);
        if (symbol) {
            symbol.references = references;
        }
    }
}

/**
 * Format references for display
 */
export function formatReferences(references: SymbolReference[] | undefined): string {
    if (!references || references.length === 0) {
        return '[NO REFERENCES FOUND]';
    }

    const lines: string[] = [`References (${references.length}):`];

    for (const ref of references) {
        const location = `${ref.filePath}:${ref.line}:${ref.column}`;
        const context = ref.containingSymbol ? ` in ${ref.containingSymbol}()` : '';
        lines.push(`  - ${location}${context}`);
        lines.push(`    ${ref.callSignature}`);
    }

    return lines.join('\n');
}
