import { z } from 'zod';
import { astMetadataSchema, type ASTMetadata } from './schema';
import { parseFile } from './parsers';
import { getParserRegistry } from './parsers/registry';

/**
 * Extended FileNode schema that includes optional AST metadata.
 * This extends the base file-tree schema without breaking changes.
 */
export const fileNodeWithASTSchema: z.ZodType<FileNodeWithAST> = z.lazy(() =>
    z.object({
        name: z.string().describe('File or directory name'),
        path: z.string().describe('Absolute workspace-relative path'),
        type: z.enum(['file', 'directory']).describe('Entry type'),
        size: z.number().describe('Size in bytes (0 for directories, aggregate for dirs when computed)'),
        modifiedAt: z.string().optional().describe('ISO 8601 last-modified timestamp'),
        content: z.string().optional().describe('Entire file content for human-readable text files; omitted for binary/non-text files and directories'),
        children: z.array(fileNodeWithASTSchema).optional().describe('Child entries (only for directories)'),
        ast: astMetadataSchema.optional().describe('AST metadata for source files; omitted for binary files, directories, and files that failed parsing'),
    }),
);

/**
 * Extended FileNode type with AST metadata
 */
export interface FileNodeWithAST {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt?: string;
    content?: string;
    children?: FileNodeWithAST[];
    ast?: ASTMetadata;
}

/**
 * Extended workspace tree schema with AST support
 */
export const workspaceTreeWithASTSchema = z.object({
    root: z.string().describe('The root path that was scanned'),
    tree: z.array(fileNodeWithASTSchema).describe('Top-level entries in the workspace'),
    summary: z.object({
        totalFiles: z.number().describe('Total number of files found (after exclusions)'),
        totalDirectories: z.number().describe('Total number of directories found (after exclusions)'),
        totalSize: z.number().describe('Aggregate size of all files in bytes (after exclusions)'),
        textFilesWithContent: z.number().describe('Number of text files whose content was successfully indexed'),
        indexedContentChars: z.number().describe('Total number of characters indexed from text file contents'),
        excludedFiles: z.number().describe('Number of files excluded by exclusion patterns'),
        excludedDirectories: z.number().describe('Number of directories excluded by exclusion patterns'),
        excludedFilePaths: z.array(z.string()).describe('Paths of files excluded by exclusion patterns'),
        excludedDirectoryPaths: z.array(z.string()).describe('Paths of directories excluded by exclusion patterns'),
        exclusionPatternsUsed: z.array(z.string()).describe('Exclusion patterns that were applied'),
        astParsedFiles: z.number().optional().describe('Number of files successfully parsed for AST'),
        astParseErrors: z.number().optional().describe('Number of files that failed AST parsing'),
        astTotalParseTimeMs: z.number().optional().describe('Total time spent parsing AST (milliseconds)'),
    }),
});

export type WorkspaceTreeWithAST = z.infer<typeof workspaceTreeWithASTSchema>;

/**
 * Options for AST parsing integration
 */
export interface ASTParseOptions {
    enabled: boolean;
    maxFileSizeBytes?: number;  // Skip files larger than this (default: 1MB)
    timeoutMs?: number;         // Max parse time per file (default: 5000ms)
    languages?: ('typescript' | 'javascript' | 'python' | 'java')[];
}

const DEFAULT_AST_OPTIONS: Required<ASTParseOptions> = {
    enabled: true,
    maxFileSizeBytes: 1024 * 1024, // 1MB
    timeoutMs: 5000,
    languages: ['typescript', 'javascript', 'python', 'java'],
};

/**
 * Parse AST metadata for a file node if applicable.
 * Returns the node unchanged if AST parsing is not applicable or fails.
 */
export async function enrichFileNodeWithAST(
    node: FileNodeWithAST,
    options: Partial<ASTParseOptions> = {}
): Promise<FileNodeWithAST> {
    const opts = { ...DEFAULT_AST_OPTIONS, ...options };

    // Skip if AST parsing is disabled
    if (!opts.enabled) {
        return node;
    }

    // Skip directories
    if (node.type === 'directory') {
        if (node.children) {
            const enrichedChildren = await Promise.all(
                node.children.map(child => enrichFileNodeWithAST(child, options))
            );
            return { ...node, children: enrichedChildren };
        }
        return node;
    }

    // Skip files without content
    if (!node.content) {
        return node;
    }

    // Skip files that are too large
    if (node.size > opts.maxFileSizeBytes) {
        return node;
    }

    // Check if file extension is supported
    if (!getParserRegistry().isPathSupported(node.path)) {
        return node;
    }

    // Parse AST
    try {
        const ast = await parseFile(node.path, node.content);
        if (ast) {
            return { ...node, ast };
        }
    } catch (error) {
        console.warn(`[ast-integration] Failed to parse ${node.path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return node;
}

/**
 * Enrich an entire workspace tree with AST metadata.
 * Processes all files in parallel for performance.
 */
export async function enrichWorkspaceTreeWithAST(
    tree: WorkspaceTreeWithAST,
    options: Partial<ASTParseOptions> = {}
): Promise<WorkspaceTreeWithAST> {
    const opts = { ...DEFAULT_AST_OPTIONS, ...options };
    
    if (!opts.enabled) {
        return tree;
    }

    let astParsedFiles = 0;
    let astParseErrors = 0;
    let astTotalParseTimeMs = 0;

    const enrichNodeWithTracking = async (node: FileNodeWithAST): Promise<FileNodeWithAST> => {
        if (node.type === 'directory') {
            if (node.children) {
                const enrichedChildren = await Promise.all(
                    node.children.map(enrichNodeWithTracking)
                );
                return { ...node, children: enrichedChildren };
            }
            return node;
        }

        // Skip files without content or too large
        if (!node.content || node.size > opts.maxFileSizeBytes) {
            return node;
        }

        // Check if file extension is supported
        if (!getParserRegistry().isPathSupported(node.path)) {
            return node;
        }

        // Parse AST with timing
        const startTime = performance.now();
        try {
            const ast = await parseFile(node.path, node.content);
            const elapsed = performance.now() - startTime;
            astTotalParseTimeMs += elapsed;

            if (ast) {
                astParsedFiles++;
                return { ...node, ast };
            } else {
                astParseErrors++;
            }
        } catch (error) {
            astParseErrors++;
            console.warn(`[ast-integration] Failed to parse ${node.path}: ${error instanceof Error ? error.message : String(error)}`);
        }

        return node;
    };

    const enrichedTree = await Promise.all(
        tree.tree.map(enrichNodeWithTracking)
    );

    return {
        ...tree,
        tree: enrichedTree,
        summary: {
            ...tree.summary,
            astParsedFiles,
            astParseErrors,
            astTotalParseTimeMs,
        },
    };
}

/**
 * Collect all AST metadata from a workspace tree into a flat list.
 * Useful for building indices and search.
 */
export function collectASTMetadata(tree: WorkspaceTreeWithAST): { filePath: string; ast: ASTMetadata }[] {
    const results: { filePath: string; ast: ASTMetadata }[] = [];

    const collect = (node: FileNodeWithAST) => {
        if (node.type === 'file' && node.ast) {
            results.push({ filePath: node.path, ast: node.ast });
        }
        if (node.children) {
            node.children.forEach(collect);
        }
    };

    tree.tree.forEach(collect);
    return results;
}

/**
 * Get all symbols from the workspace tree organized by type.
 */
export function getWorkspaceSymbols(tree: WorkspaceTreeWithAST): {
    functions: { filePath: string; name: string; signature?: string; isExported?: boolean }[];
    classes: { filePath: string; name: string; isExported?: boolean }[];
    interfaces: { filePath: string; name: string; isExported?: boolean }[];
    types: { filePath: string; name: string }[];
} {
    const astFiles = collectASTMetadata(tree);
    
    const functions: { filePath: string; name: string; signature?: string; isExported?: boolean }[] = [];
    const classes: { filePath: string; name: string; isExported?: boolean }[] = [];
    const interfaces: { filePath: string; name: string; isExported?: boolean }[] = [];
    const types: { filePath: string; name: string }[] = [];

    for (const { filePath, ast } of astFiles) {
        for (const symbol of ast.symbols) {
            switch (symbol.kind) {
                case 'function':
                case 'async_function':
                case 'arrow_function':
                case 'generator_function':
                    functions.push({
                        filePath,
                        name: symbol.name,
                        signature: symbol.signature,
                        isExported: symbol.isExported,
                    });
                    break;
                case 'class':
                case 'abstract_class':
                    classes.push({
                        filePath,
                        name: symbol.name,
                        isExported: symbol.isExported,
                    });
                    break;
                case 'interface':
                    interfaces.push({
                        filePath,
                        name: symbol.name,
                        isExported: symbol.isExported,
                    });
                    break;
                case 'type_alias':
                    types.push({
                        filePath,
                        name: symbol.name,
                    });
                    break;
            }
        }
    }

    return { functions, classes, interfaces, types };
}

/**
 * Get all imports from the workspace tree organized by source.
 */
export function getWorkspaceImports(tree: WorkspaceTreeWithAST): Map<string, { filePath: string; symbols?: { name: string; alias?: string }[] }[]> {
    const astFiles = collectASTMetadata(tree);
    const importsBySource = new Map<string, { filePath: string; symbols?: { name: string; alias?: string }[] }[]>();

    for (const { filePath, ast } of astFiles) {
        for (const imp of ast.imports) {
            const existing = importsBySource.get(imp.source) || [];
            existing.push({
                filePath,
                symbols: imp.symbols,
            });
            importsBySource.set(imp.source, existing);
        }
    }

    return importsBySource;
}
