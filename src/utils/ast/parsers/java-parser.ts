import type Parser from 'web-tree-sitter';
import { BaseParser } from './base-parser';
import type { Symbol, Import, Export, CallSite, SymbolKind, Visibility, Parameter } from '../schema';

/**
 * Java AST parser using Tree-sitter
 */
export class JavaParser extends BaseParser {
    constructor() {
        super('java');
    }

    protected extractSymbols(rootNode: Parser.SyntaxNode, sourceCode: string): Symbol[] {
        const symbols: Symbol[] = [];

        // Find program > class_declaration or interface_declaration
        for (const child of rootNode.children) {
            if (child.type === 'class_declaration' ||
                child.type === 'interface_declaration' ||
                child.type === 'enum_declaration' ||
                child.type === 'annotation_type_declaration') {
                const extracted = this.extractTypeDeclaration(child, sourceCode);
                if (extracted) {
                    symbols.push(extracted);
                }
            }
        }

        return symbols;
    }

    private extractTypeDeclaration(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const modifiers = this.extractModifiers(node);
        const annotations = this.extractAnnotations(node, sourceCode);
        const typeParams = this.extractTypeParameters(node, sourceCode);

        let kind: SymbolKind;
        switch (node.type) {
            case 'interface_declaration':
                kind = 'interface';
                break;
            case 'enum_declaration':
                kind = 'enum';
                break;
            case 'annotation_type_declaration':
                kind = 'interface';
                break;
            default:
                kind = modifiers.isAbstract ? 'abstract_class' : 'class';
        }

        // Extract extends
        let extendsType: string | undefined;
        const superclass = this.findChild(node, 'superclass');
        if (superclass) {
            const typeNode = superclass.children.find(c => c.type !== 'extends');
            if (typeNode) {
                extendsType = this.getNodeText(typeNode, sourceCode);
            }
        }

        // Extract implements
        const implementsList: string[] = [];
        const interfaces = this.findChild(node, 'super_interfaces');
        if (interfaces) {
            for (const child of interfaces.children) {
                if (child.type === 'type_list') {
                    for (const typeNode of child.children) {
                        if (typeNode.type !== ',') {
                            implementsList.push(this.getNodeText(typeNode, sourceCode));
                        }
                    }
                }
            }
        }

        // Extract members
        const members: Symbol[] = [];
        const bodyNode = this.findChild(node, 'class_body') ||
            this.findChild(node, 'interface_body') ||
            this.findChild(node, 'enum_body');
        if (bodyNode) {
            for (const member of bodyNode.children) {
                const extracted = this.extractMember(member, sourceCode);
                if (extracted) {
                    members.push(...(Array.isArray(extracted) ? extracted : [extracted]));
                }
            }
        }

        return {
            name,
            kind,
            location: this.extractLocation(node),
            visibility: modifiers.visibility,
            isAbstract: modifiers.isAbstract,
            isStatic: modifiers.isStatic,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
            extends: extendsType,
            implements: implementsList.length > 0 ? implementsList : undefined,
            decorators: annotations.length > 0 ? annotations : undefined,
            classBody: this.buildClassBody(node, sourceCode, members, ['class_body', 'interface_body', 'enum_body']),
            members: members.length > 0 ? members : undefined,
        };
    }

    private extractMember(node: Parser.SyntaxNode, sourceCode: string): Symbol | Symbol[] | null {
        switch (node.type) {
            case 'method_declaration':
                return this.extractMethod(node, sourceCode);

            case 'constructor_declaration':
                return this.extractConstructor(node, sourceCode);

            case 'field_declaration':
                return this.extractFields(node, sourceCode);

            case 'class_declaration':
            case 'interface_declaration':
            case 'enum_declaration':
                return this.extractTypeDeclaration(node, sourceCode);

            case 'enum_constant':
                return this.extractEnumConstant(node, sourceCode);

            default:
                return null;
        }
    }

    private extractMethod(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const modifiers = this.extractModifiers(node);
        const annotations = this.extractAnnotations(node, sourceCode);
        const typeParams = this.extractTypeParameters(node, sourceCode);
        const params = this.extractParameters(node, sourceCode);
        const returnType = this.extractReturnType(node, sourceCode);
        const throwsTypes = this.extractThrowsClause(node, sourceCode);

        return {
            name,
            kind: 'method',
            location: this.extractLocation(node),
            signature: this.buildMethodSignature(name, params, returnType, typeParams, throwsTypes, modifiers),
            visibility: modifiers.visibility,
            isStatic: modifiers.isStatic,
            isAbstract: modifiers.isAbstract,
            parameters: params,
            returnType,
            typeParameters: typeParams.length > 0 ? typeParams : undefined,
            decorators: annotations.length > 0 ? annotations : undefined,
            body: this.buildSymbolBody(node, sourceCode, ['block']),
        };
    }

    private extractConstructor(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const name = this.getNodeText(nameNode, sourceCode);
        const modifiers = this.extractModifiers(node);
        const annotations = this.extractAnnotations(node, sourceCode);
        const params = this.extractParameters(node, sourceCode);
        const throwsTypes = this.extractThrowsClause(node, sourceCode);

        return {
            name,
            kind: 'constructor',
            location: this.extractLocation(node),
            signature: this.buildMethodSignature(name, params, undefined, [], throwsTypes, modifiers),
            visibility: modifiers.visibility,
            parameters: params,
            decorators: annotations.length > 0 ? annotations : undefined,
            body: this.buildSymbolBody(node, sourceCode, ['constructor_body', 'block']),
        };
    }

    private extractFields(node: Parser.SyntaxNode, sourceCode: string): Symbol[] {
        const symbols: Symbol[] = [];
        const modifiers = this.extractModifiers(node);
        const annotations = this.extractAnnotations(node, sourceCode);

        // Get type
        const typeNode = this.findChildByField(node, 'type');
        const type = typeNode ? this.getNodeText(typeNode, sourceCode) : undefined;

        // Get declarators
        const declarators = this.findChildren(node, 'variable_declarator');
        for (const declarator of declarators) {
            const nameNode = this.findChildByField(declarator, 'name');
            if (nameNode) {
                symbols.push({
                    name: this.getNodeText(nameNode, sourceCode),
                    kind: modifiers.isFinal ? 'constant' : 'property',
                    location: this.extractLocation(declarator),
                    visibility: modifiers.visibility,
                    isStatic: modifiers.isStatic,
                    returnType: type,
                    decorators: annotations.length > 0 ? annotations : undefined,
                });
            }
        }

        return symbols;
    }

    private extractEnumConstant(node: Parser.SyntaxNode, sourceCode: string): Symbol | null {
        const nameNode = this.findChildByField(node, 'name');
        if (!nameNode) return null;

        const annotations = this.extractAnnotations(node, sourceCode);

        return {
            name: this.getNodeText(nameNode, sourceCode),
            kind: 'constant',
            location: this.extractLocation(node),
            visibility: 'public',
            isStatic: true,
            decorators: annotations.length > 0 ? annotations : undefined,
        };
    }

    private extractModifiers(node: Parser.SyntaxNode): {
        visibility?: Visibility;
        isStatic?: boolean;
        isAbstract?: boolean;
        isFinal?: boolean;
    } {
        let visibility: Visibility | undefined;
        let isStatic = false;
        let isAbstract = false;
        let isFinal = false;

        const modifiersNode = this.findChild(node, 'modifiers');
        if (modifiersNode) {
            for (const child of modifiersNode.children) {
                switch (child.type) {
                    case 'public':
                        visibility = 'public';
                        break;
                    case 'private':
                        visibility = 'private';
                        break;
                    case 'protected':
                        visibility = 'protected';
                        break;
                    case 'static':
                        isStatic = true;
                        break;
                    case 'abstract':
                        isAbstract = true;
                        break;
                    case 'final':
                        isFinal = true;
                        break;
                }
            }
        }

        return { visibility, isStatic, isAbstract, isFinal };
    }

    private extractAnnotations(node: Parser.SyntaxNode, sourceCode: string): string[] {
        const annotations: string[] = [];

        const modifiersNode = this.findChild(node, 'modifiers');
        if (modifiersNode) {
            for (const child of modifiersNode.children) {
                if (child.type === 'annotation' || child.type === 'marker_annotation') {
                    annotations.push(this.getNodeText(child, sourceCode));
                }
            }
        }

        return annotations;
    }

    private extractTypeParameters(node: Parser.SyntaxNode, sourceCode: string): string[] {
        const params: string[] = [];
        const typeParams = this.findChild(node, 'type_parameters');
        if (typeParams) {
            for (const child of typeParams.children) {
                if (child.type === 'type_parameter') {
                    params.push(this.getNodeText(child, sourceCode));
                }
            }
        }
        return params;
    }

    private extractParameters(node: Parser.SyntaxNode, sourceCode: string): Parameter[] {
        const params: Parameter[] = [];
        const paramsNode = this.findChild(node, 'formal_parameters');
        if (!paramsNode) return params;

        for (const child of paramsNode.children) {
            if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
                const typeNode = this.findChildByField(child, 'type');
                const nameNode = this.findChildByField(child, 'name');

                if (nameNode) {
                    params.push({
                        name: this.getNodeText(nameNode, sourceCode),
                        type: typeNode ? this.getNodeText(typeNode, sourceCode) : undefined,
                        isRest: child.type === 'spread_parameter',
                    });
                }
            }
        }

        return params;
    }

    private extractReturnType(node: Parser.SyntaxNode, sourceCode: string): string | undefined {
        const typeNode = this.findChildByField(node, 'type');
        if (typeNode) {
            return this.getNodeText(typeNode, sourceCode);
        }
        return undefined;
    }

    private extractThrowsClause(node: Parser.SyntaxNode, sourceCode: string): string[] {
        const throws: string[] = [];
        const throwsNode = this.findChild(node, 'throws');
        if (throwsNode) {
            for (const child of throwsNode.children) {
                if (child.type !== 'throws' && child.type !== ',') {
                    throws.push(this.getNodeText(child, sourceCode));
                }
            }
        }
        return throws;
    }

    private buildMethodSignature(
        name: string,
        params: Parameter[],
        returnType?: string,
        typeParams?: string[],
        throwsTypes?: string[],
        modifiers?: { visibility?: Visibility; isStatic?: boolean; isAbstract?: boolean }
    ): string {
        const parts: string[] = [];

        if (modifiers?.visibility) parts.push(modifiers.visibility);
        if (modifiers?.isStatic) parts.push('static');
        if (modifiers?.isAbstract) parts.push('abstract');

        if (typeParams?.length) {
            parts.push(`<${typeParams.join(', ')}>`);
        }

        if (returnType) parts.push(returnType);

        const paramsPart = params.map(p => {
            if (p.isRest) return `${p.type}... ${p.name}`;
            return p.type ? `${p.type} ${p.name}` : p.name;
        }).join(', ');

        parts.push(`${name}(${paramsPart})`);

        if (throwsTypes?.length) {
            parts.push(`throws ${throwsTypes.join(', ')}`);
        }

        return parts.join(' ');
    }

    protected extractImports(rootNode: Parser.SyntaxNode, sourceCode: string): Import[] {
        const imports: Import[] = [];
        const importNodes = this.findDescendants(rootNode, 'import_declaration');

        for (const node of importNodes) {
            const parsed = this.parseImportStatement(node, sourceCode);
            if (parsed) {
                imports.push(parsed);
            }
        }

        return imports;
    }

    private parseImportStatement(node: Parser.SyntaxNode, sourceCode: string): Import | null {
        const location = this.extractLocation(node);
        const isStatic = node.children.some(c => c.type === 'static');

        // Find the imported name
        const scopedId = this.findChild(node, 'scoped_identifier');
        const asteriskNode = this.findChild(node, 'asterisk');

        if (scopedId) {
            const fullPath = this.getNodeText(scopedId, sourceCode);

            // Check for wildcard import
            if (asteriskNode) {
                return {
                    source: fullPath,
                    kind: 'namespace',
                    namespaceName: '*',
                    location,
                    isRelative: false,
                };
            }

            // Extract package and class name
            const lastDot = fullPath.lastIndexOf('.');
            const packageName = lastDot > 0 ? fullPath.slice(0, lastDot) : '';
            const className = lastDot > 0 ? fullPath.slice(lastDot + 1) : fullPath;

            return {
                source: packageName || fullPath,
                kind: isStatic ? 'named' : 'named',
                symbols: [{ name: className }],
                location,
                isRelative: false,
            };
        }

        // Simple identifier import (rare)
        const identifier = this.findChild(node, 'identifier');
        if (identifier) {
            return {
                source: this.getNodeText(identifier, sourceCode),
                kind: 'named',
                location,
                isRelative: false,
            };
        }

        return null;
    }

    protected extractExports(rootNode: Parser.SyntaxNode, sourceCode: string): Export[] {
        const exports: Export[] = [];

        // In Java, public classes/interfaces/enums are effectively exports
        for (const child of rootNode.children) {
            if (child.type === 'class_declaration' ||
                child.type === 'interface_declaration' ||
                child.type === 'enum_declaration') {
                const modifiers = this.extractModifiers(child);
                if (modifiers.visibility === 'public') {
                    const nameNode = this.findChildByField(child, 'name');
                    if (nameNode) {
                        exports.push({
                            kind: 'named',
                            symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
                            location: this.extractLocation(child),
                        });
                    }
                }
            }
        }

        return exports;
    }

    protected extractCallSites(rootNode: Parser.SyntaxNode, sourceCode: string): CallSite[] {
        const callSites: CallSite[] = [];
        const callNodes = this.findDescendantsOfTypes(rootNode, ['method_invocation', 'object_creation_expression']);

        for (const node of callNodes) {
            const callSite = this.parseCallExpression(node, sourceCode);
            if (callSite) {
                callSites.push(callSite);
            }
        }

        return callSites;
    }

    private parseCallExpression(node: Parser.SyntaxNode, sourceCode: string): CallSite | null {
        const location = this.extractLocation(node);

        if (node.type === 'object_creation_expression') {
            const typeNode = this.findChildByField(node, 'type');
            if (typeNode) {
                const argsNode = this.findChildByField(node, 'arguments');
                const argCount = argsNode
                    ? argsNode.children.filter(c =>
                        c.type !== '(' &&
                        c.type !== ')' &&
                        c.type !== ','
                    ).length
                    : 0;

                return {
                    callee: this.getNodeText(typeNode, sourceCode),
                    location,
                    isMethodCall: false,
                    arguments: argCount,
                };
            }
        }

        if (node.type === 'method_invocation') {
            const nameNode = this.findChildByField(node, 'name');
            const objectNode = this.findChildByField(node, 'object');

            if (nameNode) {
                const argsNode = this.findChildByField(node, 'arguments');
                const argCount = argsNode
                    ? argsNode.children.filter(c =>
                        c.type !== '(' &&
                        c.type !== ')' &&
                        c.type !== ','
                    ).length
                    : 0;

                return {
                    callee: this.getNodeText(nameNode, sourceCode),
                    location,
                    isMethodCall: objectNode !== null,
                    receiver: objectNode ? this.getNodeText(objectNode, sourceCode) : undefined,
                    arguments: argCount,
                };
            }
        }

        return null;
    }
}
