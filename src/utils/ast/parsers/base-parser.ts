import type Parser from 'web-tree-sitter';
import type {
    Language,
    ASTMetadata,
    Symbol,
    SymbolBody,
    ClassBody,
    Import,
    Export,
    CallSite,
    ParseError,
    Location
} from '../schema';
import { getTreeSitterRuntime } from './tree-sitter-runtime';

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
    'iife',
]);

const PROPERTY_LIKE_KINDS = new Set(['property', 'constant', 'variable']);

const CALL_TARGET_KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'new',
    'function',
    'class',
    'typeof',
    'super',
    'await',
    'yield',
    'throw',
    'else',
    'elif',
    'def',
    'lambda',
    'print',
]);

/**
 * Base class for language-specific AST parsers.
 * Provides common functionality and defines the parsing contract.
 */
export abstract class BaseParser {
    protected language: Language;
    protected parser: Parser | null = null;

    constructor(language: Language) {
        this.language = language;
    }

    /**
     * Initialize the parser with Tree-sitter grammar
     */
    async initialize(): Promise<boolean> {
        const runtime = getTreeSitterRuntime();
        this.parser = await runtime.createParser(this.language);
        return this.parser !== null;
    }

    /**
     * Check if parser is initialized
     */
    isInitialized(): boolean {
        return this.parser !== null;
    }

    /**
     * Get the language this parser handles
     */
    getLanguage(): Language {
        return this.language;
    }

    /**
     * Parse source code and extract AST metadata
     */
    async parse(sourceCode: string): Promise<ASTMetadata | null> {
        if (!this.parser) {
            const initialized = await this.initialize();
            if (!initialized) {
                return null;
            }
        }

        const startTime = performance.now();

        try {
            const tree = this.parser!.parse(sourceCode);
            if (!tree || !tree.rootNode) {
                return null;
            }

            const symbols = this.extractSymbols(tree.rootNode, sourceCode);
            const imports = this.extractImports(tree.rootNode, sourceCode);
            const exports = this.extractExports(tree.rootNode, sourceCode);
            const callSites = this.extractCallSites(tree.rootNode, sourceCode);
            const errors = this.extractErrors(tree.rootNode, sourceCode);

            const parseTimeMs = performance.now() - startTime;

            const totalLines = sourceCode.split('\n').length;
            const functionKinds = new Set(['function', 'async_function', 'arrow_function', 'generator_function', 'method', 'constructor', 'lambda']);
            const classKinds = new Set(['class', 'abstract_class', 'interface']);

            return {
                language: this.language,
                symbols,
                imports,
                exports,
                callSites: callSites.length > 0 ? callSites : undefined,
                errors: errors.length > 0 ? errors : undefined,
                metrics: {
                    totalLines,
                    symbolCount: symbols.length,
                    functionCount: this.countSymbolsByKind(symbols, functionKinds),
                    classCount: this.countSymbolsByKind(symbols, classKinds),
                    importCount: imports.length,
                    exportCount: exports.length,
                },
                parseTimeMs,
            };
        } catch (error) {
            console.error(`[${this.language}-parser] Parse error: ${error instanceof Error ? error.message : String(error)}`);
            return {
                language: this.language,
                symbols: [],
                imports: [],
                exports: [],
                errors: [{
                    message: error instanceof Error ? error.message : String(error),
                    severity: 'error',
                }],
                metrics: {
                    totalLines: sourceCode.split('\n').length,
                    symbolCount: 0,
                    functionCount: 0,
                    classCount: 0,
                    importCount: 0,
                    exportCount: 0,
                },
                parseTimeMs: performance.now() - startTime,
            };
        }
    }

    /**
     * Count symbols by kinds
     */
    private countSymbolsByKind(symbols: Symbol[], kinds: Set<string>): number {
        let count = 0;
        for (const symbol of symbols) {
            if (kinds.has(symbol.kind)) {
                count++;
            }
            if (symbol.members) {
                count += this.countSymbolsByKind(symbol.members, kinds);
            }
        }
        return count;
    }

    /**
     * Extract location from a Tree-sitter node
     */
    protected extractLocation(node: Parser.SyntaxNode): Location {
        return {
            line: node.startPosition.row + 1, // Convert to 1-based
            column: node.startPosition.column,
            startByte: node.startIndex,
            endByte: node.endIndex,
        };
    }

    /**
     * Get text content of a node
     */
    protected getNodeText(node: Parser.SyntaxNode, sourceCode: string): string {
        return sourceCode.slice(node.startIndex, node.endIndex);
    }

    /**
     * Normalize source text for compact review summaries.
     */
    protected normalizeBodyText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * Resolve the body node for a declaration.
     */
    protected findBodyNode(node: Parser.SyntaxNode, fallbackTypes: string[] = []): Parser.SyntaxNode | null {
        const bodyNode = this.findChildByField(node, 'body');
        if (bodyNode) {
            return bodyNode;
        }

        for (const type of fallbackTypes) {
            const child = this.findChild(node, type);
            if (child) {
                return child;
            }
        }

        return null;
    }

    /**
     * Approximate the number of top-level statements in a body node.
     */
    protected countBodyStatements(bodyNode: Parser.SyntaxNode): number {
        const ignoredTypes = new Set(['{', '}', '(', ')', ':', ';', ',']);
        const relevantChildren = bodyNode.children.filter(child => !ignoredTypes.has(child.type));
        return relevantChildren.length > 0 ? relevantChildren.length : (this.normalizeBodyText(bodyNode.text).length > 0 ? 1 : 0);
    }

    /**
     * Extract a set of likely call targets from raw body text.
     * Increased limit from 8 to 25 to capture diverse call patterns in large functions
     * (e.g., migration files with op.create_table, op.create_index, etc.)
     */
    protected extractCallTargetsFromText(bodyText: string): string[] {
        const matches = bodyText.matchAll(/\b([A-Za-z_][\w.$]*)\s*\(/g);
        const targets = new Set<string>();

        for (const match of matches) {
            const candidate = match[1];
            if (!candidate || CALL_TARGET_KEYWORDS.has(candidate)) {
                continue;
            }
            targets.add(candidate);
            if (targets.size >= 25) {
                break;
            }
        }

        return Array.from(targets);
    }

    /**
     * Build deterministic review metadata for function and method bodies.
     */
    protected buildSymbolBody(
        node: Parser.SyntaxNode,
        sourceCode: string,
        fallbackBodyTypes: string[] = []
    ): SymbolBody | undefined {
        const bodyNode = this.findBodyNode(node, fallbackBodyTypes);
        if (!bodyNode) {
            return undefined;
        }

        const declarationText = this.getNodeText(node, sourceCode);
        const bodyText = this.getNodeText(bodyNode, sourceCode);
        const normalizedBodyText = this.normalizeBodyText(bodyText);
        const statementCount = this.countBodyStatements(bodyNode);
        const callTargets = this.extractCallTargetsFromText(bodyText);
        const summaryParts: string[] = [];

        summaryParts.push(`Contains ${statementCount} top-level ${statementCount === 1 ? 'statement' : 'statements'}`);
        if (/\breturn\b|\byield\b/.test(bodyText)) {
            summaryParts.push('returns or yields a value');
        }
        if (/\bif\b|\bswitch\b|\bmatch\b|\belif\b/.test(bodyText)) {
            summaryParts.push('uses branching logic');
        }
        if (/\bfor\b|\bwhile\b/.test(bodyText)) {
            summaryParts.push('uses iteration');
        }
        if (callTargets.length > 0) {
            summaryParts.push(`calls ${callTargets.slice(0, 3).join(', ')}`);
        }

        return {
            declarationText,
            bodyText,
            normalizedBodyText,
            statementCount,
            callTargets: callTargets.length > 0 ? callTargets : undefined,
            rawLogicSummary: summaryParts.join('; '),
        };
    }

    /**
     * Build deterministic review metadata for class, interface, and enum bodies.
     */
    protected buildClassBody(
        node: Parser.SyntaxNode,
        sourceCode: string,
        members: Symbol[],
        fallbackBodyTypes: string[] = []
    ): ClassBody | undefined {
        const bodyNode = this.findBodyNode(node, fallbackBodyTypes);
        if (!bodyNode) {
            return undefined;
        }

        const bodyText = this.getNodeText(bodyNode, sourceCode);
        const methodNames = members
            .filter(member => FUNCTION_LIKE_KINDS.has(member.kind))
            .map(member => member.name);
        const methodCount = methodNames.length;
        const propertyCount = members.filter(member => PROPERTY_LIKE_KINDS.has(member.kind)).length;
        const summaryParts: string[] = [
            `Defines ${members.length} ${members.length === 1 ? 'member' : 'members'}`,
        ];

        if (methodCount > 0) {
            summaryParts.push(`${methodCount} function-like ${methodCount === 1 ? 'member' : 'members'}`);
        }
        if (propertyCount > 0) {
            summaryParts.push(`${propertyCount} property-like ${propertyCount === 1 ? 'member' : 'members'}`);
        }
        if (methodNames.length > 0) {
            summaryParts.push(`key methods: ${methodNames.slice(0, 4).join(', ')}`);
        }

        return {
            bodyText,
            normalizedBodyText: this.normalizeBodyText(bodyText),
            memberCount: members.length,
            methodCount,
            propertyCount,
            methodNames: methodNames.length > 0 ? methodNames : undefined,
            rawLogicSummary: summaryParts.join('; '),
        };
    }

    /**
     * Find child node by type
     */
    protected findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
        for (const child of node.children) {
            if (child.type === type) {
                return child;
            }
        }
        return null;
    }

    /**
     * Find all children by type
     */
    protected findChildren(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
        return node.children.filter(child => child.type === type);
    }

    /**
     * Find child node by field name
     */
    protected findChildByField(node: Parser.SyntaxNode, fieldName: string): Parser.SyntaxNode | null {
        return node.childForFieldName(fieldName);
    }

    /**
     * Recursively find all descendant nodes of a specific type
     */
    protected findDescendants(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
        const results: Parser.SyntaxNode[] = [];

        const walk = (n: Parser.SyntaxNode) => {
            if (n.type === type) {
                results.push(n);
            }
            for (const child of n.children) {
                walk(child);
            }
        };

        walk(node);
        return results;
    }

    /**
     * Find all descendant nodes matching any of the given types
     */
    protected findDescendantsOfTypes(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode[] {
        const typeSet = new Set(types);
        const results: Parser.SyntaxNode[] = [];

        const walk = (n: Parser.SyntaxNode) => {
            if (typeSet.has(n.type)) {
                results.push(n);
            }
            for (const child of n.children) {
                walk(child);
            }
        };

        walk(node);
        return results;
    }

    /**
     * Check if node has error
     */
    protected hasError(node: Parser.SyntaxNode): boolean {
        return node.hasError;
    }

    // Abstract methods to be implemented by language-specific parsers

    /**
     * Extract all symbols (functions, classes, interfaces, etc.)
     */
    protected abstract extractSymbols(rootNode: Parser.SyntaxNode, sourceCode: string): Symbol[];

    /**
     * Extract all import statements
     */
    protected abstract extractImports(rootNode: Parser.SyntaxNode, sourceCode: string): Import[];

    /**
     * Extract all export statements
     */
    protected abstract extractExports(rootNode: Parser.SyntaxNode, sourceCode: string): Export[];

    /**
     * Extract function call sites
     */
    protected abstract extractCallSites(rootNode: Parser.SyntaxNode, sourceCode: string): CallSite[];

    /**
     * Extract syntax errors from the tree
     */
    protected extractErrors(rootNode: Parser.SyntaxNode, sourceCode: string): ParseError[] {
        const errors: ParseError[] = [];

        const walk = (node: Parser.SyntaxNode) => {
            if (node.type === 'ERROR' || node.isMissing) {
                errors.push({
                    message: node.isMissing
                        ? `Missing expected token`
                        : `Syntax error at "${this.getNodeText(node, sourceCode).slice(0, 50)}"`,
                    location: this.extractLocation(node),
                    severity: 'error',
                });
            }
            for (const child of node.children) {
                walk(child);
            }
        };

        walk(rootNode);
        return errors;
    }
}
