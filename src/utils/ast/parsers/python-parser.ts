import type Parser from 'web-tree-sitter';
import { BaseParser } from './base-parser';
import type { Symbol, Import, Export, CallSite, SymbolKind, Parameter } from '../schema';

/**
 * Python AST parser using Tree-sitter
 */
export class PythonParser extends BaseParser {
    constructor() {
        super('python');
    }

    protected extractSymbols(rootNode: Parser.SyntaxNode, sourceCode: string): Symbol[] {
        const symbols: Symbol[] = [];

        for (const child of rootNode.children) {
            const extracted = this.extractSymbolFromNode(child, sourceCode, []);
            if (extracted) {
                symbols.push(...(Array.isArray(extracted) ? extracted : [extracted]));
            }
        }

        return symbols;
    }

    private extractSymbolFromNode(
        node: Parser.SyntaxNode,
        sourceCode: string,
        decorators: string[]
    ): Symbol | Symbol[] | null {
        // Collect decorators
        if (node.type === 'decorated_definition') {
            const collectedDecorators: string[] = [];
            for (const child of node.children) {
                if (child.type === 'decorator') {
                    const decoratorText = this.getNodeText(child, sourceCode).replace(/^@/, '');
                    collectedDecorators.push(decoratorText);
                }
            }

            // Find the actual definition
            const definition = node.children.find(c =>
                c.type === 'function_definition' ||
                c.type === 'class_definition' ||
                c.type === 'async_function_definition'
            );

            if (definition) {
                return this.extractSymbolFromNode(definition, sourceCode, collectedDecorators);
            }
            return null;
        }

        switch (node.type) {
            case 'function_definition':
                return this.extractFunction(node, sourceCode, false, decorators);

            case 'async_function_definition':
                return this.extractFunction(node, sourceCode, true, decorators);

            case 'class_definition':
                return this.extractClass(node, sourceCode, decorators);

            case 'expression_statement':
                return this.extractAssignment(node, sourceCode);

            default:
                return null;
        }
    }

    private extractFunction(
        node: Parser.SyntaxNode,
        sourceCode: string,
        isAsync: boolean,
        decorators: string[]
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const params = this.extractParameters(node, sourceCode);
        const returnType = this.extractReturnType(node, sourceCode);

        // Check for lambda nested inside
        const isLambda = node.type === 'lambda';

        let kind: SymbolKind = isAsync ? 'async_function' : 'function';
        if (isLambda) kind = 'lambda';

        return {
            name,
            kind,
            location: this.extractLocation(node),
            signature: this.buildFunctionSignature(name, params, returnType, isAsync),
            isAsync,
            parameters: params,
            returnType,
            decorators: decorators.length > 0 ? decorators : undefined,
            body: this.buildSymbolBody(node, sourceCode, ['block']),
        };
    }

    private extractClass(
        node: Parser.SyntaxNode,
        sourceCode: string,
        decorators: string[]
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);

        // Extract base classes
        const baseClasses: string[] = [];
        const argList = this.findChild(node, 'argument_list');
        if (argList) {
            for (const child of argList.children) {
                if (child.type === 'identifier' || child.type === 'attribute') {
                    baseClasses.push(this.getNodeText(child, sourceCode));
                }
            }
        }

        // Extract members
        const members: Symbol[] = [];
        const bodyNode = this.findChild(node, 'block');
        if (bodyNode) {
            for (const child of bodyNode.children) {
                const extracted = this.extractClassMember(child, sourceCode);
                if (extracted) {
                    members.push(...(Array.isArray(extracted) ? extracted : [extracted]));
                }
            }
        }

        return {
            name,
            kind: 'class',
            location: this.extractLocation(node),
            extends: baseClasses.length > 0 ? baseClasses[0] : undefined,
            implements: baseClasses.length > 1 ? baseClasses.slice(1) : undefined,
            decorators: decorators.length > 0 ? decorators : undefined,
            classBody: this.buildClassBody(node, sourceCode, members, ['block']),
            members: members.length > 0 ? members : undefined,
        };
    }

    private extractClassMember(node: Parser.SyntaxNode, sourceCode: string): Symbol | Symbol[] | null {
        // Handle decorated methods
        if (node.type === 'decorated_definition') {
            const decorators: string[] = [];
            for (const child of node.children) {
                if (child.type === 'decorator') {
                    decorators.push(this.getNodeText(child, sourceCode).replace(/^@/, ''));
                }
            }

            const definition = node.children.find(c =>
                c.type === 'function_definition' ||
                c.type === 'async_function_definition'
            );

            if (definition) {
                const method = this.extractMethod(definition, sourceCode, decorators);
                return method;
            }
            return null;
        }

        if (node.type === 'function_definition' || node.type === 'async_function_definition') {
            return this.extractMethod(node, sourceCode, []);
        }

        // Class-level assignments (class attributes)
        if (node.type === 'expression_statement') {
            const assignment = this.findChild(node, 'assignment');
            if (assignment) {
                const left = this.findChildByField(assignment, 'left');
                if (left && left.type === 'identifier') {
                    return {
                        name: this.getNodeText(left, sourceCode),
                        kind: 'property',
                        location: this.extractLocation(node),
                    };
                }
            }
        }

        return null;
    }

    private extractMethod(
        node: Parser.SyntaxNode,
        sourceCode: string,
        decorators: string[]
    ): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const isAsync = node.type === 'async_function_definition';
        const params = this.extractParameters(node, sourceCode);
        const returnType = this.extractReturnType(node, sourceCode);

        // Determine method type from decorators
        const isStatic = decorators.includes('staticmethod') || decorators.includes('classmethod');
        const isProperty = decorators.includes('property');

        let kind: SymbolKind = 'method';
        if (name === '__init__') kind = 'constructor';
        else if (isProperty) kind = 'getter';
        else if (isAsync) kind = 'async_function';

        return {
            name,
            kind,
            location: this.extractLocation(node),
            signature: this.buildFunctionSignature(name, params, returnType, isAsync),
            isStatic,
            isAsync,
            parameters: params,
            returnType,
            decorators: decorators.length > 0 ? decorators : undefined,
            body: this.buildSymbolBody(node, sourceCode, ['block']),
        };
    }

    private extractAssignment(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const assignment = this.findChild(node, 'assignment');
        if (!assignment) return null;

        const left = this.findChildByField(assignment, 'left');
        const right = this.findChildByField(assignment, 'right');

        if (!left || left.type !== 'identifier') return null;

        const name = this.getNodeText(left, sourceCode);

        // Check if it's a lambda
        if (right && right.type === 'lambda') {
            const params = this.extractLambdaParameters(right, sourceCode);
            return {
                name,
                kind: 'lambda',
                location: this.extractLocation(assignment),
                parameters: params,
            };
        }

        // Regular variable assignment (module-level)
        return {
            name,
            kind: 'variable',
            location: this.extractLocation(assignment),
        };
    }

    private extractParameters(node: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const paramsNode = this.findChild(node, 'parameters');
        if (!paramsNode) return [];
        return this.extractParametersFromNode(paramsNode, sourceCode);
    }

    private extractLambdaParameters(node: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const paramsNode = this.findChild(node, 'lambda_parameters');
        if (!paramsNode) return [];
        return this.extractParametersFromNode(paramsNode, sourceCode);
    }

    private extractParametersFromNode(paramsNode: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const params: Parameter[] = [];

        for (const child of paramsNode.children) {
            switch (child.type) {
                case 'identifier': {
                    params.push({ name: this.getNodeText(child, sourceCode) });
                    break;
                }

                case 'typed_parameter': {
                    const nameNode = this.findChild(child, 'identifier');
                    const typeNode = this.findChildByField(child, 'type');
                    if (nameNode) {
                        params.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            type: typeNode ? this.getNodeText(typeNode, sourceCode) : undefined,
                        });
                    }
                    break;
                }

                case 'default_parameter': {
                    const nameNode = this.findChildByField(child, 'name');
                    const valueNode = this.findChildByField(child, 'value');
                    if (nameNode) {
                        params.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            defaultValue: valueNode ? this.getNodeText(valueNode, sourceCode) : undefined,
                            isOptional: true,
                        });
                    }
                    break;
                }

                case 'typed_default_parameter': {
                    const nameNode = this.findChildByField(child, 'name');
                    const typeNode = this.findChildByField(child, 'type');
                    const valueNode = this.findChildByField(child, 'value');
                    if (nameNode) {
                        params.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            type: typeNode ? this.getNodeText(typeNode, sourceCode) : undefined,
                            defaultValue: valueNode ? this.getNodeText(valueNode, sourceCode) : undefined,
                            isOptional: true,
                        });
                    }
                    break;
                }

                case 'list_splat_pattern':
                case 'dictionary_splat_pattern': {
                    const nameNode = this.findChild(child, 'identifier');
                    if (nameNode) {
                        params.push({
                            name: this.getNodeText(nameNode, sourceCode),
                            isRest: true,
                        });
                    }
                    break;
                }
            }
        }

        return params;
    }

    private extractReturnType(node: Parser.SyntaxNode, sourceCode: string): string | undefined {
        const returnType = this.findChildByField(node, 'return_type');
        if (returnType) {
            return this.getNodeText(returnType, sourceCode);
        }
        return undefined;
    }

    private buildFunctionSignature(
        name: string,
        params: Parameter[],
        returnType?: string,
        isAsync?: boolean
    ): string {
        const asyncPrefix = isAsync ? 'async ' : '';
        const paramsPart = params.map(p => {
            let str = p.isRest ? `*${p.name}` : p.name;
            if (p.type) str += `: ${p.type}`;
            if (p.defaultValue) str += ` = ${p.defaultValue}`;
            return str;
        }).join(', ');
        const returnPart = returnType ? ` -> ${returnType}` : '';
        return `${asyncPrefix}def ${name}(${paramsPart})${returnPart}`;
    }

    protected extractImports(rootNode: Parser.SyntaxNode, sourceCode: string): Import[] {
        const imports: Import[] = [];

        // import statements
        const importNodes = this.findDescendants(rootNode, 'import_statement');
        for (const node of importNodes) {
            const parsed = this.parseImportStatement(node, sourceCode);
            if (parsed) {
                imports.push(...(Array.isArray(parsed) ? parsed : [parsed]));
            }
        }

        // from...import statements
        const fromImportNodes = this.findDescendants(rootNode, 'import_from_statement');
        for (const node of fromImportNodes) {
            const parsed = this.parseFromImportStatement(node, sourceCode);
            if (parsed) {
                imports.push(parsed);
            }
        }

        return imports;
    }

    private parseImportStatement(node: Parser.SyntaxNode, sourceCode: string): Import | Import[] | null {
        const imports: Import[] = [];
        const location = this.extractLocation(node);

        // import module1, module2 as alias
        for (const child of node.children) {
            if (child.type === 'dotted_name') {
                const name = this.getNodeText(child, sourceCode);
                imports.push({
                    source: name,
                    kind: 'named',
                    location,
                    isRelative: false,
                });
            } else if (child.type === 'aliased_import') {
                const nameNode = this.findChildByField(child, 'name');
                const aliasNode = this.findChildByField(child, 'alias');
                if (nameNode) {
                    imports.push({
                        source: this.getNodeText(nameNode, sourceCode),
                        kind: 'named',
                        symbols: aliasNode ? [{
                            name: this.getNodeText(nameNode, sourceCode),
                            alias: this.getNodeText(aliasNode, sourceCode)
                        }] : undefined,
                        location,
                        isRelative: false,
                    });
                }
            }
        }

        return imports.length > 0 ? imports : null;
    }

    private parseFromImportStatement(node: Parser.SyntaxNode, sourceCode: string): Import | null {
        const location = this.extractLocation(node);

        // Find module name
        const moduleNode = this.findChild(node, 'dotted_name') || this.findChild(node, 'relative_import');
        if (!moduleNode) return null;

        const source = this.getNodeText(moduleNode, sourceCode);
        const isRelative = source.startsWith('.');

        // Check for wildcard import
        if (node.children.some(c => c.type === 'wildcard_import')) {
            return {
                source,
                kind: 'namespace',
                namespaceName: '*',
                location,
                isRelative,
            };
        }

        // Named imports
        const symbols: { name: string; alias?: string }[] = [];

        for (const child of node.children) {
            if (child.type === 'dotted_name' && child !== moduleNode) {
                symbols.push({ name: this.getNodeText(child, sourceCode) });
            } else if (child.type === 'aliased_import') {
                const nameNode = this.findChildByField(child, 'name');
                const aliasNode = this.findChildByField(child, 'alias');
                if (nameNode) {
                    symbols.push({
                        name: this.getNodeText(nameNode, sourceCode),
                        alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : undefined,
                    });
                }
            }
        }

        return {
            source,
            kind: 'named',
            symbols: symbols.length > 0 ? symbols : undefined,
            location,
            isRelative,
        };
    }

    protected extractExports(rootNode: Parser.SyntaxNode, sourceCode: string): Export[] {
        const exports: Export[] = [];

        // Python doesn't have explicit exports, but __all__ defines public API
        const assignments = this.findDescendants(rootNode, 'assignment');
        for (const assignment of assignments) {
            const left = this.findChildByField(assignment, 'left');
            if (left && this.getNodeText(left, sourceCode) === '__all__') {
                const right = this.findChildByField(assignment, 'right');
                if (right && right.type === 'list') {
                    const symbols: { name: string }[] = [];
                    for (const item of right.children) {
                        if (item.type === 'string') {
                            const name = this.getNodeText(item, sourceCode).replace(/^['"]|['"]$/g, '');
                            symbols.push({ name });
                        }
                    }
                    if (symbols.length > 0) {
                        exports.push({
                            kind: 'named',
                            symbols,
                            location: this.extractLocation(assignment),
                        });
                    }
                }
            }
        }

        // Also consider top-level public functions/classes as implicit exports
        for (const child of rootNode.children) {
            if (child.type === 'function_definition' || child.type === 'async_function_definition') {
                const nameNode = this.findChildByField(child, 'name');
                if (nameNode) {
                    const name = this.getNodeText(nameNode, sourceCode);
                    if (!name.startsWith('_')) {
                        exports.push({
                            kind: 'named',
                            symbols: [{ name }],
                            location: this.extractLocation(child),
                        });
                    }
                }
            } else if (child.type === 'class_definition') {
                const nameNode = this.findChildByField(child, 'name');
                if (nameNode) {
                    const name = this.getNodeText(nameNode, sourceCode);
                    if (!name.startsWith('_')) {
                        exports.push({
                            kind: 'named',
                            symbols: [{ name }],
                            location: this.extractLocation(child),
                        });
                    }
                }
            } else if (child.type === 'decorated_definition') {
                const definition = child.children.find(c =>
                    c.type === 'function_definition' ||
                    c.type === 'async_function_definition' ||
                    c.type === 'class_definition'
                );
                if (definition) {
                    const nameNode = this.findChildByField(definition, 'name');
                    if (nameNode) {
                        const name = this.getNodeText(nameNode, sourceCode);
                        if (!name.startsWith('_')) {
                            exports.push({
                                kind: 'named',
                                symbols: [{ name }],
                                location: this.extractLocation(child),
                            });
                        }
                    }
                }
            }
        }

        return exports;
    }

    protected extractCallSites(rootNode: Parser.SyntaxNode, sourceCode: string): CallSite[] {
        const callSites: CallSite[] = [];
        const callNodes = this.findDescendants(rootNode, 'call');

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
            ? argsNode.children.filter(c =>
                c.type !== '(' &&
                c.type !== ')' &&
                c.type !== ',' &&
                c.type !== 'comment'
            ).length
            : 0;

        // Method call
        if (functionNode.type === 'attribute') {
            const object = this.findChildByField(functionNode, 'object');
            const attribute = this.findChildByField(functionNode, 'attribute');

            if (attribute) {
                return {
                    callee: this.getNodeText(attribute, sourceCode),
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
