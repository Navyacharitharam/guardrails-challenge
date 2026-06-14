export { BaseParser } from './base-parser';
export { TreeSitterRuntime, getTreeSitterRuntime } from './tree-sitter-runtime';
export { ParserRegistry, getParserRegistry } from './registry';
export { TypeScriptParser } from './typescript-parser';
export { JavaScriptParser } from './javascript-parser';
export { PythonParser } from './python-parser';
export { JavaParser } from './java-parser';

import { getParserRegistry } from './registry';
import { getTreeSitterRuntime } from './tree-sitter-runtime';
import { TypeScriptParser } from './typescript-parser';
import { JavaScriptParser } from './javascript-parser';
import { PythonParser } from './python-parser';
import { JavaParser } from './java-parser';
import type { Language, ASTMetadata } from '../schema';

let initialized = false;

/**
 * Initialize the AST parsing system.
 * Registers all language parsers with the registry.
 */
export async function initializeASTSystem(): Promise<void> {
    if (initialized) return;

    const runtime = getTreeSitterRuntime();
    await runtime.initialize();

    const registry = getParserRegistry();
    
    // Register parsers
    registry.registerParser('typescript', new TypeScriptParser());
    registry.registerParser('javascript', new JavaScriptParser());
    registry.registerParser('python', new PythonParser());
    registry.registerParser('java', new JavaParser());

    initialized = true;
}

/**
 * Check if the AST system is initialized
 */
export function isASTSystemInitialized(): boolean {
    return initialized;
}

/**
 * Reset the AST system (primarily for testing)
 */
export function resetASTSystem(): void {
    getParserRegistry().getRegisteredLanguages().forEach(() => {
        // Parsers will be garbage collected
    });
    getTreeSitterRuntime();
    initialized = false;
}

/**
 * Parse a file and return AST metadata.
 * Automatically initializes the system if needed.
 */
export async function parseFile(filePath: string, sourceCode: string): Promise<ASTMetadata | null> {
    if (!initialized) {
        await initializeASTSystem();
    }

    const registry = getParserRegistry();
    return registry.parseFile(filePath, sourceCode);
}

/**
 * Parse source code with explicit language specification.
 */
export async function parseSource(sourceCode: string, language: Language): Promise<ASTMetadata | null> {
    if (!initialized) {
        await initializeASTSystem();
    }

    const registry = getParserRegistry();
    const parser = registry.getParserForLanguage(language);
    if (!parser) {
        return null;
    }

    return parser.parse(sourceCode);
}

/**
 * Check if a file extension is supported for AST parsing
 */
export function isExtensionSupported(extension: string): boolean {
    const registry = getParserRegistry();
    return registry.isSupported(extension);
}

/**
 * Get all supported file extensions
 */
export function getSupportedExtensions(): string[] {
    const registry = getParserRegistry();
    return registry.getSupportedExtensions();
}
