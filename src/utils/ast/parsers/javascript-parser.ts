import type Parser from 'web-tree-sitter';
import { BaseParser } from './base-parser';
import type { Symbol, Import, Export, CallSite, SymbolKind, Parameter } from '../schema';

/**
 * JavaScript/JSX AST parser using Tree-sitter
 */
export class JavaScriptParser extends BaseParser {
    constructor() {
        super('javascript');
    }

    protected extractSymbols(rootNode: Parser.SyntaxNode, sourceCode: string): Symbol[] {
        const symbols: Symbol[] = [];

        for (const child of rootNode.children) {
            const extracted = this.extractSymbolFromNode(child, sourceCode, false);
            if (extracted) {
                symbols.push(...(Array.isArray(extracted) ? extracted : [extracted]));
            }
        }

        return symbols;
    }

    private extractSymbolFromNode(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | Symbol[] | null {
        // Handle export statements wrapping declarations
        if (node.type === 'export_statement') {
            const declaration = this.findChild(node, 'function_declaration')
                || this.findChild(node, 'class_declaration')
                || this.findChild(node, 'lexical_declaration')
                || this.findChild(node, 'variable_declaration');

            if (declaration) {
                return this.extractSymbolFromNode(declaration, sourceCode, true);
            }
            return null;
        }

        switch (node.type) {
            case 'function_declaration':
                return this.extractFunction(node, sourceCode, isExported);

            case 'generator_function_declaration':
                return this.extractGeneratorFunction(node, sourceCode, isExported);

            case 'class_declaration':
                return this.extractClass(node, sourceCode, isExported);

            case 'lexical_declaration':
            case 'variable_declaration':
                return this.extractVariables(node, sourceCode, isExported);

            case 'expression_statement':
                return this.extractExpressionStatement(node, sourceCode);

            default:
                return null;
        }
    }

    private extractFunction(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const isAsync = node.children.some(c => c.type === 'async');
        const params = this.extractParameters(node, sourceCode);

        return {
            name,
            kind: isAsync ? 'async_function' : 'function',
            location: this.extractLocation(node),
            signature: this.buildFunctionSignature(name, params, isAsync),
            isExported,
            isAsync,
            parameters: params,
            body: this.buildSymbolBody(node, sourceCode, ['statement_block']),
        };
    }

    private extractGeneratorFunction(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const params = this.extractParameters(node, sourceCode);

        return {
            name,
            kind: 'generator_function',
            location: this.extractLocation(node),
            signature: `function* ${name}(${params.map(p => p.name).join(', ')})`,
            isExported,
            parameters: params,
            body: this.buildSymbolBody(node, sourceCode, ['statement_block']),
        };
    }

    private extractClass(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);

        // Extract extends clause
        let extendsType: string | undefined;
        const heritageNode = this.findChild(node, 'class_heritage');
        if (heritageNode) {
            const extendsNode = heritageNode.children.find(c => c.type !== 'extends');
            if (extendsNode) {
                extendsType = this.getNodeText(extendsNode, sourceCode);
            }
        }

        // Extract class members
        const members: Symbol[] = [];
        const bodyNode = this.findChild(node, 'class_body');
        if (bodyNode) {
            for (const member of bodyNode.children) {
                const extracted = this.extractClassMember(member, sourceCode);
                if (extracted) {
                    members.push(extracted);
                }
            }
        }

        return {
            name,
            kind: 'class',
            location: this.extractLocation(node),
            isExported,
            extends: extendsType,
            classBody: this.buildClassBody(node, sourceCode, members, ['class_body']),
            members: members.length > 0 ? members : undefined,
        };
    }

    private extractClassMember(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const isStatic = node.children.some(c => c.type === 'static');

        switch (node.type) {
            case 'method_definition': {
                const nameNode = this.findChildByField(node, 'name');
                if (!nameNode) return null;

                const name = this.getNodeText(nameNode, sourceCode);
                const isAsync = node.children.some(c => c.type === 'async');
                const isGetter = node.children.some(c => c.type === 'get');
                const isSetter = node.children.some(c => c.type === 'set');
                const isGenerator = node.children.some(c => c.type === '*');
                const params = this.extractParameters(node, sourceCode);

                let kind: SymbolKind = 'method';
                if (isGetter) kind = 'getter';
                else if (isSetter) kind = 'setter';
                else if (name === 'constructor') kind = 'constructor';
                else if (isGenerator) kind = 'generator_function';
                else if (isAsync) kind = 'async_function';

                return {
                    name,
                    kind,
                    location: this.extractLocation(node),
                    signature: this.buildFunctionSignature(name, params, isAsync),
                    isStatic,
                    isAsync,
                    parameters: params,
                    body: this.buildSymbolBody(node, sourceCode, ['statement_block']),
                };
            }

            case 'field_definition': {
                const nameNode = this.findChildByField(node, 'property');
                if (!nameNode) return null;

                const name = this.getNodeText(nameNode, sourceCode);

                // Check if the value is an arrow function
                const valueNode = this.findChildByField(node, 'value');
                if (valueNode && valueNode.type === 'arrow_function') {
                    const isAsync = valueNode.children.some(c => c.type === 'async');
                    const params = this.extractArrowFunctionParameters(valueNode, sourceCode);

                    return {
                        name,
                        kind: isAsync ? 'async_function' : 'arrow_function',
                        location: this.extractLocation(node),
                        signature: this.buildFunctionSignature(name, params, isAsync),
                        isStatic,
                        isAsync,
                        parameters: params,
                        body: this.buildSymbolBody(valueNode, sourceCode, ['statement_block']),
                    };
                }

                return {
                    name,
                    kind: 'property',
                    location: this.extractLocation(node),
                    isStatic,
                };
            }

            default:
                return null;
        }
    }

    private extractVariables(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol[] {
        const symbols: Symbol[] = [];
        const isConst = node.children.some(c => c.type === 'const');

        const declarators = this.findChildren(node, 'variable_declarator');
        for (const declarator of declarators) {
            const nameNode = this.findChildByField(declarator, 'name');
            if (!nameNode) continue;

            const name = this.getNodeText(nameNode, sourceCode);

            // Check if it's an arrow function or function expression
            const valueNode = this.findChildByField(declarator, 'value');
            if (valueNode) {
                if (valueNode.type === 'arrow_function') {
                    const isAsync = valueNode.children.some(c => c.type === 'async');
                    const params = this.extractArrowFunctionParameters(valueNode, sourceCode);

                    symbols.push({
                        name,
                        kind: isAsync ? 'async_function' : 'arrow_function',
                        location: this.extractLocation(declarator),
                        signature: this.buildFunctionSignature(name, params, isAsync),
                        isExported,
                        isAsync,
                        parameters: params,
                        body: this.buildSymbolBody(valueNode, sourceCode, ['statement_block']),
                    });
                    continue;
                }

                if (valueNode.type === 'function' || valueNode.type === 'function_expression') {
                    const isAsync = valueNode.children.some(c => c.type === 'async');
                    const params = this.extractParameters(valueNode, sourceCode);

                    symbols.push({
                        name,
                        kind: isAsync ? 'async_function' : 'function',
                        location: this.extractLocation(declarator),
                        signature: this.buildFunctionSignature(name, params, isAsync),
                        isExported,
                        isAsync,
                        parameters: params,
                        body: this.buildSymbolBody(valueNode, sourceCode, ['statement_block']),
                    });
                    continue;
                }

                // Check for IIFE
                if (valueNode.type === 'call_expression') {
                    const funcNode = this.findChildByField(valueNode, 'function');
                    if (funcNode && (funcNode.type === 'arrow_function' || funcNode.type === 'function' || funcNode.type === 'parenthesized_expression')) {
                        symbols.push({
                            name,
                            kind: 'iife',
                            location: this.extractLocation(declarator),
                            isExported,
                            body: this.buildSymbolBody(funcNode.type === 'parenthesized_expression' ? funcNode.firstChild ?? funcNode : funcNode, sourceCode, ['statement_block']),
                        });
                        continue;
                    }
                }
            }

            symbols.push({
                name,
                kind: isConst ? 'constant' : 'variable',
                location: this.extractLocation(declarator),
                isExported,
            });
        }

        return symbols;
    }

    private extractExpressionStatement(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        // Handle CommonJS module.exports
        const expression = node.children[0];
        if (!expression) return null;

        if (expression.type === 'assignment_expression') {
            const left = this.findChildByField(expression, 'left');
            if (left && left.type === 'member_expression') {
                const leftText = this.getNodeText(left, sourceCode);
                if (leftText === 'module.exports' || leftText.startsWith('exports.')) {
                    const right = this.findChildByField(expression, 'right');
                    if (right) {
                        if (right.type === 'function' || right.type === 'arrow_function') {
                            const params = right.type === 'arrow_function'
                                ? this.extractArrowFunctionParameters(right, sourceCode)
                                : this.extractParameters(right, sourceCode);

                            const name = leftText === 'module.exports'
                                ? 'default'
                                : leftText.replace('exports.', '');

                            return {
                                name,
                                kind: 'function',
                                location: this.extractLocation(expression),
                                signature: this.buildFunctionSignature(name, params, false),
                                isExported: true,
                                parameters: params,
                                body: this.buildSymbolBody(right, sourceCode, ['statement_block']),
                            };
                        }

                        if (right.type === 'class') {
                            const nameNode = this.findChildByField(right, 'name');
                            const name = nameNode
                                ? this.getNodeText(nameNode, sourceCode)
                                : (leftText === 'module.exports' ? 'default' : leftText.replace('exports.', ''));

                            return {
                                name,
                                kind: 'class',
                                location: this.extractLocation(expression),
                                isExported: true,
                                classBody: this.buildClassBody(right, sourceCode, [], ['class_body']),
                            };
                        }
                    }
                }
            }
        }

        return null;
    }

    private extractArrowFunctionParameters(node: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const params: Parameter[] = [];

        // Single parameter without parens
        const singleParam = this.findChildByField(node, 'parameter');
        if (singleParam && singleParam.type === 'identifier') {
            params.push({ name: this.getNodeText(singleParam, sourceCode) });
            return params;
        }

        // Multiple parameters in parens
        const paramsNode = this.findChildByField(node, 'parameters') || this.findChild(node, 'formal_parameters');
        if (paramsNode) {
            return this.extractParametersFromNode(paramsNode, sourceCode);
        }

        return params;
    }

    private extractParameters(node: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const paramsNode = this.findChildByField(node, 'parameters') || this.findChild(node, 'formal_parameters');
        if (!paramsNode) return [];
        return this.extractParametersFromNode(paramsNode, sourceCode);
    }

    private extractParametersFromNode(paramsNode: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const params: Parameter[] = [];

        for (const child of paramsNode.children) {
            if (child.type === 'identifier') {
                params.push({ name: this.getNodeText(child, sourceCode) });
            } else if (child.type === 'rest_pattern') {
                const nameNode = this.findChild(child, 'identifier');
                if (nameNode) {
                    params.push({
                        name: this.getNodeText(nameNode, sourceCode),
                        isRest: true,
                    });
                }
            } else if (child.type === 'assignment_pattern') {
                const left = this.findChildByField(child, 'left');
                const right = this.findChildByField(child, 'right');
                if (left) {
                    params.push({
                        name: this.getNodeText(left, sourceCode),
                        defaultValue: right ? this.getNodeText(right, sourceCode) : undefined,
                    });
                }
            }
        }

        return params;
    }

    private buildFunctionSignature(name: string, params: Parameter[], isAsync?: boolean): string {
        const asyncPrefix = isAsync ? 'async ' : '';
        const paramsPart = params.map(p => {
            if (p.isRest) return `...${p.name}`;
            if (p.defaultValue) return `${p.name} = ${p.defaultValue}`;
            return p.name;
        }).join(', ');
        return `${asyncPrefix}function ${name}(${paramsPart})`;
    }

    protected extractImports(rootNode: Parser.SyntaxNode, sourceCode: string): Import[] {
        const imports: Import[] = [];

        // ES6 imports
        const importNodes = this.findDescendants(rootNode, 'import_statement');
        for (const node of importNodes) {
            const importData = this.parseImportStatement(node, sourceCode);
            if (importData) {
                imports.push(importData);
            }
        }

        // CommonJS requires
        const callNodes = this.findDescendants(rootNode, 'call_expression');
        for (const node of callNodes) {
            const funcNode = this.findChildByField(node, 'function');
            if (funcNode && this.getNodeText(funcNode, sourceCode) === 'require') {
                const argsNode = this.findChildByField(node, 'arguments');
                if (argsNode) {
                    const sourceNode = argsNode.children.find(c => c.type === 'string');
                    if (sourceNode) {
                        const source = this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, '');
                        imports.push({
                            source,
                            kind: 'named',
                            location: this.extractLocation(node),
                            isRelative: source.startsWith('.') || source.startsWith('/'),
                        });
                    }
                }
            }
        }

        return imports;
    }

    private parseImportStatement(node: Parser.SyntaxNode, sourceCode: string): Import | null {
        const sourceNode = this.findChild(node, 'string');
        if (!sourceNode) return null;

        const source = this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, '');
        const location = this.extractLocation(node);
        const isRelative = source.startsWith('.') || source.startsWith('/');

        // Side-effect import
        const importClause = this.findChild(node, 'import_clause');
        if (!importClause) {
            return {
                source,
                kind: 'side_effect',
                location,
                isRelative,
            };
        }

        // Default import
        const defaultImport = this.findChild(importClause, 'identifier');

        // Named imports
        const namedImports = this.findChild(importClause, 'named_imports');

        // Namespace import
        const namespaceImport = this.findChild(importClause, 'namespace_import');

        if (namespaceImport) {
            const asNode = this.findChild(namespaceImport, 'identifier');
            return {
                source,
                kind: 'namespace',
                namespaceName: asNode ? this.getNodeText(asNode, sourceCode) : '*',
                location,
                isRelative,
            };
        }

        if (defaultImport && !namedImports) {
            return {
                source,
                kind: 'default',
                defaultName: this.getNodeText(defaultImport, sourceCode),
                location,
                isRelative,
            };
        }

        const symbols: { name: string; alias?: string }[] = [];

        if (defaultImport) {
            symbols.push({ name: 'default', alias: this.getNodeText(defaultImport, sourceCode) });
        }

        if (namedImports) {
            for (const specifier of namedImports.children) {
                if (specifier.type === 'import_specifier') {
                    const nameNode = this.findChildByField(specifier, 'name');
                    const aliasNode = this.findChildByField(specifier, 'alias');

                    if (nameNode) {
                        symbols.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : undefined,
                        });
                    }
                }
            }
        }

        return {
            source,
            kind: 'named',
            symbols: symbols.length > 0 ? symbols : undefined,
            defaultName: defaultImport ? this.getNodeText(defaultImport, sourceCode) : undefined,
            location,
            isRelative,
        };
    }

    protected extractExports(rootNode: Parser.SyntaxNode, sourceCode: string): Export[] {
        const exports: Export[] = [];

        // ES6 exports
        const exportNodes = this.findDescendants(rootNode, 'export_statement');
        for (const node of exportNodes) {
            const exportData = this.parseExportStatement(node, sourceCode);
            if (exportData) {
                exports.push(exportData);
            }
        }

        // CommonJS exports
        const assignmentNodes = this.findDescendants(rootNode, 'assignment_expression');
        for (const node of assignmentNodes) {
            const left = this.findChildByField(node, 'left');
            if (left && left.type === 'member_expression') {
                const leftText = this.getNodeText(left, sourceCode);
                if (leftText === 'module.exports') {
                    exports.push({
                        kind: 'default',
                        defaultName: 'module.exports',
                        location: this.extractLocation(node),
                    });
                } else if (leftText.startsWith('exports.')) {
                    const exportName = leftText.replace('exports.', '');
                    exports.push({
                        kind: 'named',
                        symbols: [{ name: exportName }],
                        location: this.extractLocation(node),
                    });
                }
            }
        }

        return exports;
    }

    private parseExportStatement(node: Parser.SyntaxNode, sourceCode: string): Export | null {
        const location = this.extractLocation(node);

        // Check for export * from
        const sourceNode = this.findChild(node, 'string');

        if (node.children.some(c => c.type === '*')) {
            return {
                kind: 're_export',
                source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, '') : undefined,
                location,
            };
        }

        // Check for export default
        if (node.children.some(c => c.type === 'default')) {
            const declaration = node.children.find(c =>
                c.type !== 'export' &&
                c.type !== 'default' &&
                c.type !== ';'
            );

            return {
                kind: 'default',
                defaultName: declaration ? this.getNodeText(declaration, sourceCode).slice(0, 50) : 'default',
                location,
            };
        }

        // Named exports
        const exportClause = this.findChild(node, 'export_clause');
        if (exportClause) {
            const symbols: { name: string; alias?: string }[] = [];

            for (const specifier of exportClause.children) {
                if (specifier.type === 'export_specifier') {
                    const nameNode = this.findChildByField(specifier, 'name');
                    const aliasNode = this.findChildByField(specifier, 'alias');

                    if (nameNode) {
                        symbols.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : undefined,
                        });
                    }
                }
            }

            return {
                kind: sourceNode ? 're_export' : 'named',
                symbols: symbols.length > 0 ? symbols : undefined,
                source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, '') : undefined,
                location,
            };
        }

        // Export declaration
        const declaration = this.findChild(node, 'function_declaration')
            || this.findChild(node, 'class_declaration')
            || this.findChild(node, 'lexical_declaration')
            || this.findChild(node, 'variable_declaration');

        if (declaration) {
            const nameNode = this.findChildByField(declaration, 'name');
            if (nameNode) {
                return {
                    kind: 'named',
                    symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
                    location,
                };
            }

            // For variable declarations
            const declarators = this.findChildren(declaration, 'variable_declarator');
            const symbols = declarators
                .map(d => this.findChildByField(d, 'name'))
                .filter((n): n is Parser.SyntaxNode => n !== null)
                .map(n => ({ name: this.getNodeText(n, sourceCode) }));

            if (symbols.length > 0) {
                return {
                    kind: 'named',
                    symbols,
                    location,
                };
            }
        }

        return null;
    }

    protected extractCallSites(rootNode: Parser.SyntaxNode, sourceCode: string): CallSite[] {
        const callSites: CallSite[] = [];
        const callNodes = this.findDescendantsOfTypes(rootNode, ['call_expression', 'new_expression']);

        for (const node of callNodes) {
            const callSite = this.parseCallExpression(node, sourceCode);
            if (callSite) {
                callSites.push(callSite);
            }
        }

        return callSites;
    }

    private parseCallExpression(node: Parser.SyntaxNode, sourceCode: string): CallSite | null {
        const functionNode = this.findChildByField(node, 'function');
        if (!functionNode) return null;

        const location = this.extractLocation(node);
        const argsNode = this.findChildByField(node, 'arguments');
        const argCount = argsNode
            ? argsNode.children.filter(c => c.type !== '(' && c.type !== ')' && c.type !== ',').length
            : 0;

        // Method call
        if (functionNode.type === 'member_expression') {
            const object = this.findChildByField(functionNode, 'object');
            const property = this.findChildByField(functionNode, 'property');

            if (property) {
                return {
                    callee: this.getNodeText(property, sourceCode),
                    location,
                    isMethodCall: true,
                    receiver: object ? this.getNodeText(object, sourceCode) : undefined,
                    arguments: argCount,
                };
            }
        }

        // Direct call
        if (functionNode.type === 'identifier') {
            return {
                callee: this.getNodeText(functionNode, sourceCode),
                location,
                isMethodCall: false,
                arguments: argCount,
            };
        }

        return null;
    }
}
