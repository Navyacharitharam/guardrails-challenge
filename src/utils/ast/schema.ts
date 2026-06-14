import { z } from 'zod';

/**
 * Location information for AST nodes
 */
export const locationSchema = z.object({
    line: z.number().int().min(1).describe('1-based line number'),
    column: z.number().int().min(0).describe('0-based column number'),
    startByte: z.number().int().min(0).describe('Start byte offset in source'),
    endByte: z.number().int().min(0).describe('End byte offset in source'),
});

export type Location = z.infer<typeof locationSchema>;

/**
 * Visibility modifiers for symbols
 */
export const visibilitySchema = z.enum(['public', 'private', 'protected', 'internal', 'default']);
export type Visibility = z.infer<typeof visibilitySchema>;

/**
 * Symbol kinds supported across languages
 */
export const symbolKindSchema = z.enum([
    'function',
    'async_function',
    'arrow_function',
    'generator_function',
    'method',
    'constructor',
    'getter',
    'setter',
    'class',
    'abstract_class',
    'interface',
    'type_alias',
    'enum',
    'variable',
    'constant',
    'property',
    'parameter',
    'decorator',
    'lambda',
    'iife',
]);
export type SymbolKind = z.infer<typeof symbolKindSchema>;

/**
 * Generic parameter definition schema
 */
export const parameterSchema = z.object({
    name: z.string(),
    type: z.string().optional(),
    defaultValue: z.string().optional(),
    isRest: z.boolean().optional(),
    isOptional: z.boolean().optional(),
});

export type Parameter = z.infer<typeof parameterSchema>;

/**
 * Review-oriented metadata for function and method bodies.
 */
export const symbolBodySchema = z.object({
    declarationText: z.string().optional().describe('Full declaration text for the symbol'),
    bodyText: z.string().optional().describe('Raw body text for the symbol'),
    normalizedBodyText: z.string().optional().describe('Whitespace-normalized body text for review and comparisons'),
    statementCount: z.number().int().min(0).optional().describe('Approximate number of top-level statements in the body'),
    callTargets: z.array(z.string()).optional().describe('Detected call targets referenced from the body'),
    rawLogicSummary: z.string().optional().describe('Deterministic, review-oriented summary of the body logic'),
});

export type SymbolBody = z.infer<typeof symbolBodySchema>;

/**
 * Review-oriented metadata for class, interface, and enum bodies.
 */
export const classBodySchema = z.object({
    bodyText: z.string().optional().describe('Raw body text for the type declaration'),
    normalizedBodyText: z.string().optional().describe('Whitespace-normalized body text for review and comparisons'),
    memberCount: z.number().int().min(0).optional().describe('Total number of members declared in the type body'),
    methodCount: z.number().int().min(0).optional().describe('Number of function-like members declared in the type body'),
    propertyCount: z.number().int().min(0).optional().describe('Number of property-like members declared in the type body'),
    methodNames: z.array(z.string()).optional().describe('Names of function-like members declared in the type body'),
    rawLogicSummary: z.string().optional().describe('Deterministic, review-oriented summary of the class or interface body'),
});

export type ClassBody = z.infer<typeof classBodySchema>;

/**
 * Symbol definition - normalized across all languages
 */
export interface Symbol {
    name: string;
    kind: SymbolKind;
    location: Location;
    signature?: string;
    visibility?: Visibility;
    isExported?: boolean;
    isStatic?: boolean;
    isAsync?: boolean;
    isAbstract?: boolean;
    parameters?: Parameter[];
    returnType?: string;
    typeParameters?: string[];
    decorators?: string[];
    extends?: string;
    implements?: string[];
    body?: SymbolBody;
    classBody?: ClassBody;
    members?: Symbol[];
}

export const symbolSchema: z.ZodType<Symbol> = z.lazy(() => z.object({
    name: z.string().describe('Symbol name'),
    kind: symbolKindSchema.describe('Symbol kind'),
    location: locationSchema.describe('Source location'),
    signature: z.string().optional().describe('Full signature (for functions/methods)'),
    visibility: visibilitySchema.optional().describe('Visibility modifier'),
    isExported: z.boolean().optional().describe('Whether symbol is exported'),
    isStatic: z.boolean().optional().describe('Whether symbol is static (for class members)'),
    isAsync: z.boolean().optional().describe('Whether function is async'),
    isAbstract: z.boolean().optional().describe('Whether class/method is abstract'),
    parameters: z.array(parameterSchema).optional().describe('Function/method parameters'),
    returnType: z.string().optional().describe('Return type (if available)'),
    typeParameters: z.array(z.string()).optional().describe('Generic type parameters'),
    decorators: z.array(z.string()).optional().describe('Decorators/annotations'),
    extends: z.string().optional().describe('Parent class (for classes)'),
    implements: z.array(z.string()).optional().describe('Implemented interfaces'),
    body: symbolBodySchema.optional().describe('Review-oriented function or method body metadata'),
    classBody: classBodySchema.optional().describe('Review-oriented class, interface, or enum body metadata'),
    members: z.array(symbolSchema).optional().describe('Child symbols (for classes)'),
}));

/**
 * Import statement representation
 */
export const importSchema = z.object({
    source: z.string().describe('Import source module/path'),
    kind: z.enum(['named', 'default', 'namespace', 'type_only', 'side_effect']).describe('Import kind'),
    symbols: z.array(z.object({
        name: z.string(),
        alias: z.string().optional(),
    })).optional().describe('Imported symbol names (for named imports)'),
    defaultName: z.string().optional().describe('Default import name'),
    namespaceName: z.string().optional().describe('Namespace import name (* as X)'),
    location: locationSchema.describe('Source location'),
    isRelative: z.boolean().optional().describe('Whether import is relative path'),
});

export type Import = z.infer<typeof importSchema>;

/**
 * Export statement representation
 */
export const exportSchema = z.object({
    kind: z.enum(['named', 'default', 're_export', 'type_only', 'all']).describe('Export kind'),
    symbols: z.array(z.object({
        name: z.string(),
        alias: z.string().optional(),
    })).optional().describe('Exported symbol names (for named exports)'),
    source: z.string().optional().describe('Re-export source module'),
    defaultName: z.string().optional().describe('Default export name/expression'),
    location: locationSchema.describe('Source location'),
});

export type Export = z.infer<typeof exportSchema>;

/**
 * Call site information for call graph construction
 */
export const callSiteSchema = z.object({
    callee: z.string().describe('Called function/method name'),
    location: locationSchema.describe('Location of the call'),
    isMethodCall: z.boolean().optional().describe('Whether this is a method call (obj.method())'),
    receiver: z.string().optional().describe('Receiver object for method calls'),
    arguments: z.number().optional().describe('Number of arguments'),
});

export type CallSite = z.infer<typeof callSiteSchema>;

/**
 * Parsing error information
 */
export const parseErrorSchema = z.object({
    message: z.string(),
    location: locationSchema.optional(),
    severity: z.enum(['error', 'warning']).optional(),
});

export type ParseError = z.infer<typeof parseErrorSchema>;

/**
 * Supported programming languages
 */
export const languageSchema = z.enum(['typescript', 'javascript', 'python', 'java']);
export type Language = z.infer<typeof languageSchema>;

/**
 * Complete AST metadata for a single file
 */
export const astMetadataSchema = z.object({
    language: languageSchema.describe('Source language'),
    symbols: z.array(symbolSchema).describe('All top-level symbols'),
    imports: z.array(importSchema).describe('All import statements'),
    exports: z.array(exportSchema).describe('All export statements'),
    callSites: z.array(callSiteSchema).optional().describe('Function call sites'),
    errors: z.array(parseErrorSchema).optional().describe('Parsing errors/warnings'),
    metrics: z.object({
        totalLines: z.number().int().min(0).describe('Total lines in file'),
        codeLines: z.number().int().min(0).optional().describe('Non-empty, non-comment lines'),
        symbolCount: z.number().int().min(0).describe('Total symbol count'),
        functionCount: z.number().int().min(0).describe('Function/method count'),
        classCount: z.number().int().min(0).describe('Class/interface count'),
        importCount: z.number().int().min(0).describe('Import count'),
        exportCount: z.number().int().min(0).describe('Export count'),
    }).optional().describe('Code metrics'),
    parseTimeMs: z.number().optional().describe('Time taken to parse (milliseconds)'),
});

export type ASTMetadata = z.infer<typeof astMetadataSchema>;

/**
 * Validates AST metadata structure
 */
export function validateASTMetadata(data: unknown): ASTMetadata {
    return astMetadataSchema.parse(data);
}

/**
 * Safely validates AST metadata, returns null on failure
 */
export function safeValidateASTMetadata(data: unknown): ASTMetadata | null {
    const result = astMetadataSchema.safeParse(data);
    return result.success ? result.data : null;
}
