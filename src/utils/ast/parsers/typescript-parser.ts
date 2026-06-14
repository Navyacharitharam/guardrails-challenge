import type Parser from 'web-tree-sitter';
import { BaseParser } from './base-parser';
import type { Symbol, Import, Export, CallSite, SymbolKind, Visibility, Parameter } from '../schema';

/**
 * TypeScript/TSX AST parser using Tree-sitter
 */
export class TypeScriptParser extends BaseParser {
    constructor() {
        super('typescript');
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
                || this.findChild(node, 'interface_declaration')
                || this.findChild(node, 'type_alias_declaration')
                || this.findChild(node, 'enum_declaration')
                || this.findChild(node, 'lexical_declaration')
                || this.findChild(node, 'variable_declaration')
                || this.findChild(node, 'abstract_class_declaration');

            if (declaration) {
                const extracted = this.extractSymbolFromNode(declaration, sourceCode, true);
                return extracted;
            }
            return null;
        }

        switch (node.type) {
            case 'function_declaration':
            case 'function_signature':
                return this.extractFunction(node, sourceCode, isExported);

            case 'generator_function_declaration':
                return this.extractGeneratorFunction(node, sourceCode, isExported);

            case 'class_declaration':
                return this.extractClass(node, sourceCode, isExported, false);

            case 'abstract_class_declaration':
                return this.extractClass(node, sourceCode, isExported, true);

            case 'interface_declaration':
                return this.extractInterface(node, sourceCode, isExported);

            case 'type_alias_declaration':
                return this.extractTypeAlias(node, sourceCode, isExported);

            case 'enum_declaration':
                return this.extractEnum(node, sourceCode, isExported);

            case 'lexical_declaration':
            case 'variable_declaration':
                return this.extractVariables(node, sourceCode, isExported);

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
        const typeParams = this.extractTypeParameters(node, sourceCode);
        const params = this.extractParameters(node, sourceCode);
        const returnType = this.extractReturnType(node, sourceCode);

        return {
            name,
            kind: isAsync ? 'async_function' : 'function',
            location: this.extractLocation(node),
            signature: this.buildFunctionSignature(name, params, returnType, isAsync, typeParams),
            isExported,
            isAsync,
            parameters: params,
            returnType,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
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
        const returnType = this.extractReturnType(node, sourceCode);

        return {
            name,
            kind: 'generator_function',
            location: this.extractLocation(node),
            signature: `function* ${name}(${params.map(p => p.name).join(', ')})`,
            isExported,
            parameters: params,
            returnType,
            body: this.buildSymbolBody(node, sourceCode, ['statement_block']),
        };
    }

    private extractClass(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean,
        isAbstract: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const typeParams = this.extractTypeParameters(node, sourceCode);

        // Extract extends clause
        let extendsType: string | undefined;
        const heritageClause = this.findChild(node, 'class_heritage');
        if (heritageClause) {
            const extendsClause = this.findChild(heritageClause, 'extends_clause');
            if (extendsClause) {
                const typeNode = extendsClause.children.find(c => c.type !== 'extends');
                if (typeNode) {
                    extendsType = this.getNodeText(typeNode, sourceCode);
                }
            }
        }

        // Extract implements clause
        const implementsList: string[] = [];
        if (heritageClause) {
            const implementsClause = this.findChild(heritageClause, 'implements_clause');
            if (implementsClause) {
                for (const child of implementsClause.children) {
                    if (child.type !== 'implements' && child.type !== ',') {
                        implementsList.push(this.getNodeText(child, sourceCode));
                    }
                }
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
            kind: isAbstract ? 'abstract_class' : 'class',
            location: this.extractLocation(node),
            isExported,
            isAbstract,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
            extends: extendsType,
            implements: implementsList.length > 0 ? implementsList : undefined,
            classBody: this.buildClassBody(node, sourceCode, members, ['class_body']),
            members: members.length > 0 ? members : undefined,
        };
    }

    private extractClassMember(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const visibility = this.extractVisibility(node);
        const isStatic = node.children.some(c => c.type === 'static');
        const isAbstract = node.children.some(c => c.type === 'abstract');

        switch (node.type) {
            case 'method_definition':
            case 'method_signature': {
                const nameNode = this.findChildByField(node, 'name');
                if (!nameNode) return null;

                const name = this.getNodeText(nameNode, sourceCode);
                const isAsync = node.children.some(c => c.type === 'async');
                const isGetter = node.children.some(c => c.type === 'get');
                const isSetter = node.children.some(c => c.type === 'set');
                const params = this.extractParameters(node, sourceCode);
                const returnType = this.extractReturnType(node, sourceCode);

                let kind: SymbolKind = 'method';
                if (isGetter) kind = 'getter';
                else if (isSetter) kind = 'setter';
                else if (name === 'constructor') kind = 'constructor';
                else if (isAsync) kind = 'async_function';

                return {
                    name,
                    kind,
                    location: this.extractLocation(node),
                    signature: this.buildFunctionSignature(name, params, returnType, isAsync),
                    visibility,
                    isStatic,
                    isAbstract,
                    isAsync,
                    parameters: params,
                    returnType,
                    body: this.buildSymbolBody(node, sourceCode, ['statement_block']),
                };
            }

            case 'public_field_definition':
            case 'property_signature': {
                const nameNode = this.findChildByField(node, 'name');
                if (!nameNode) return null;

                const name = this.getNodeText(nameNode, sourceCode);
                const typeAnnotation = this.findChild(node, 'type_annotation');
                const type = typeAnnotation
                    ? this.getNodeText(typeAnnotation, sourceCode).replace(/^:\s*/, '')
                    : undefined;

                return {
                    name,
                    kind: 'property',
                    location: this.extractLocation(node),
                    visibility,
                    isStatic,
                    returnType: type,
                };
            }

            default:
                return null;
        }
    }

    private extractInterface(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const typeParams = this.extractTypeParameters(node, sourceCode);

        // Extract extends
        const extendsList: string[] = [];
        const extendsClause = this.findChild(node, 'extends_type_clause');
        if (extendsClause) {
            for (const child of extendsClause.children) {
                if (child.type !== 'extends' && child.type !== ',') {
                    extendsList.push(this.getNodeText(child, sourceCode));
                }
            }
        }

        // Extract members
        const members: Symbol[] = [];
        const bodyNode = this.findChild(node, 'interface_body') || this.findChild(node, 'object_type');
        if (bodyNode) {
            for (const member of bodyNode.children) {
                if (member.type === 'property_signature' || member.type === 'method_signature') {
                    const extracted = this.extractClassMember(member, sourceCode);
                    if (extracted) {
                        members.push(extracted);
                    }
                }
            }
        }

        return {
            name,
            kind: 'interface',
            location: this.extractLocation(node),
            isExported,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
            implements: extendsList.length > 0 ? extendsList : undefined,
            classBody: this.buildClassBody(node, sourceCode, members, ['interface_body', 'object_type']),
            members: members.length > 0 ? members : undefined,
        };
    }

    private extractTypeAlias(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const typeParams = this.extractTypeParameters(node, sourceCode);

        return {
            name,
            kind: 'type_alias',
            location: this.extractLocation(node),
            isExported,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
        };
    }

    private extractEnum(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isExported: boolean
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);

        return {
            name,
            kind: 'enum',
            location: this.extractLocation(node),
            isExported,
            classBody: this.buildClassBody(node, sourceCode, [], ['enum_body']),
        };
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

            // Check if it's an arrow function
            const valueNode = this.findChildByField(declarator, 'value');
            if (valueNode && valueNode.type === 'arrow_function') {
                const isAsync = valueNode.children.some(c => c.type === 'async');
                const params = this.extractArrowFunctionParameters(valueNode, sourceCode);
                const returnType = this.extractReturnType(valueNode, sourceCode);

                symbols.push({
                    name,
                    kind: isAsync ? 'async_function' : 'arrow_function',
                    location: this.extractLocation(declarator),
                    signature: this.buildFunctionSignature(name, params, returnType, isAsync),
                    isExported,
                    isAsync,
                    parameters: params,
                    returnType,
                    body: this.buildSymbolBody(valueNode, sourceCode, ['statement_block']),
                });
            } else {
                symbols.push({
                    name,
                    kind: isConst ? 'constant' : 'variable',
                    location: this.extractLocation(declarator),
                    isExported,
                });
            }
        }

        return symbols;
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
            if (child.type === 'required_parameter' ||
                child.type === 'optional_parameter' ||
                child.type === 'rest_parameter') {

                const pattern = this.findChildByField(child, 'pattern') || this.findChild(child, 'identifier');
                if (pattern) {
                    const name = this.getNodeText(pattern, sourceCode);
                    const typeAnnotation = this.findChild(child, 'type_annotation');
                    const type = typeAnnotation
                        ? this.getNodeText(typeAnnotation, sourceCode).replace(/^:\s*/, '')
                        : undefined;

                    params.push({
                        name,
                        type,
                        isOptional: child.type === 'optional_parameter',
                        isRest: child.type === 'rest_parameter',
                    });
                }
            } else if (child.type === 'identifier') {
                params.push({ name: this.getNodeText(child, sourceCode) });
            }
        }

        return params;
    }

    private extractReturnType(node: Parser.SyntaxNode, sourceCode: string): string | undefined {
        const returnType = this.findChild(node, 'type_annotation');
        if (returnType) {
            return this.getNodeText(returnType, sourceCode).replace(/^:\s*/, '');
        }
        return undefined;
    }

    private extractTypeParameters(node: Parser.SyntaxNode, sourceCode: string): string[] {
        const typeParams = this.findChild(node, 'type_parameters');
        if (!typeParams) return [];

        const params: string[] = [];
        for (const child of typeParams.children) {
            if (child.type === 'type_parameter') {
                const nameNode = this.findChildByField(child, 'name') || this.findChild(child, 'type_identifier');
                if (nameNode) {
                    params.push(this.getNodeText(nameNode, sourceCode));
                }
            }
        }
        return params;
    }

    private extractVisibility(node: Parser.SyntaxNode): Visibility | undefined {
        for (const child of node.children) {
            if (child.type === 'accessibility_modifier') {
                const text = child.text;
                if (text === 'public') return 'public';
                if (text === 'private') return 'private';
                if (text === 'protected') return 'protected';
            }
        }
        return undefined;
    }

    private buildFunctionSignature(
        name: string,
        params: Parameter[],
        returnType?: string,
        isAsync?: boolean,
        typeParams?: string[]
    ): string {
        const asyncPrefix = isAsync ? 'async ' : '';
        const genericPart = typeParams?.length ? `<${typeParams.join(', ')}>` : '';
        const paramsPart = params.map(p => {
            let str = p.isRest ? `...${p.name}` : p.name;
            if (p.isOptional) str += '?';
            if (p.type) str += `: ${p.type}`;
            return str;
        }).join(', ');
        const returnPart = returnType ? `: ${returnType}` : '';
        return `${asyncPrefix}function ${name}${genericPart}(${paramsPart})${returnPart}`;
    }

    protected extractImports(rootNode: Parser.SyntaxNode, sourceCode: string): Import[] {
        const imports: Import[] = [];
        const importNodes = this.findDescendants(rootNode, 'import_statement');

        for (const node of importNodes) {
            const importData = this.parseImportStatement(node, sourceCode);
            if (importData) {
                imports.push(importData);
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

        // Side-effect import: import 'module';
        const importClause = this.findChild(node, 'import_clause');
        if (!importClause) {
            return {
                source,
                kind: 'side_effect',
                location,
                isRelative,
            };
        }

        // Check for type-only import
        const isTypeOnly = node.children.some(c => c.type === 'type');

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
                kind: isTypeOnly ? 'type_only' : 'namespace',
                namespaceName: asNode ? this.getNodeText(asNode, sourceCode) : '*',
                location,
                isRelative,
            };
        }

        if (defaultImport && !namedImports) {
            return {
                source,
                kind: isTypeOnly ? 'type_only' : 'default',
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
            kind: isTypeOnly ? 'type_only' : 'named',
            symbols: symbols.length > 0 ? symbols : undefined,
            defaultName: defaultImport ? this.getNodeText(defaultImport, sourceCode) : undefined,
            location,
            isRelative,
        };
    }

    protected extractExports(rootNode: Parser.SyntaxNode, sourceCode: string): Export[] {
        const exports: Export[] = [];
        const exportNodes = this.findDescendants(rootNode, 'export_statement');

        for (const node of exportNodes) {
            const exportData = this.parseExportStatement(node, sourceCode);
            if (exportData) {
                exports.push(exportData);
            }
        }

        return exports;
    }

    private parseExportStatement(node: Parser.SyntaxNode, sourceCode: string): Export | null {
        const location = this.extractLocation(node);
        const isTypeOnly = node.children.some(c => c.type === 'type');

        // Check for export * from
        const exportClause = this.findChild(node, 'export_clause');
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
            // Find what's being exported
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
                kind: isTypeOnly ? 'type_only' : (sourceNode ? 're_export' : 'named'),
                symbols: symbols.length > 0 ? symbols : undefined,
                source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, '') : undefined,
                location,
            };
        }

        // Export declaration (export function, export class, etc.)
        const declaration = this.findChild(node, 'function_declaration')
            || this.findChild(node, 'class_declaration')
            || this.findChild(node, 'interface_declaration')
            || this.findChild(node, 'type_alias_declaration')
            || this.findChild(node, 'enum_declaration')
            || this.findChild(node, 'lexical_declaration')
            || this.findChild(node, 'variable_declaration');

        if (declaration) {
            const nameNode = this.findChildByField(declaration, 'name');
            if (nameNode) {
                return {
                    kind: isTypeOnly ? 'type_only' : 'named',
                    symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
                    location,
                };
            }

            // For variable declarations, get all declarator names
            const declarators = this.findChildren(declaration, 'variable_declarator');
            const symbols = declarators
                .map(d => this.findChildByField(d, 'name'))
                .filter((n): n is Parser.SyntaxNode => n !== null)
                .map(n => ({ name: this.getNodeText(n, sourceCode) }));

            if (symbols.length > 0) {
                return {
                    kind: isTypeOnly ? 'type_only' : 'named',
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

        // Method call: obj.method()
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

        // Direct call: func()
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
