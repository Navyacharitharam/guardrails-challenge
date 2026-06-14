import type { Language, ASTMetadata } from '../schema';
import type { BaseParser } from './base-parser';

/**
 * File extension to language mapping
 */
const extensionToLanguage: Record<string, Language> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyw': 'python',
    '.java': 'java',
};

/**
 * Registry for language-specific AST parsers.
 * Provides centralized parser lookup and language detection.
 */
export class ParserRegistry {
    private static instance: ParserRegistry | null = null;
    private parsers = new Map<Language, BaseParser>();

    // Private constructor for singleton pattern
    private constructor() {
        // Intentionally empty - initialization happens via registerParser()
    }

    /**
     * Get the singleton registry instance
     */
    static getInstance(): ParserRegistry {
        if (!ParserRegistry.instance) {
            ParserRegistry.instance = new ParserRegistry();
        }
        return ParserRegistry.instance;
    }

    /**
     * Reset the singleton (primarily for testing)
     */
    static reset(): void {
        if (ParserRegistry.instance) {
            ParserRegistry.instance.parsers.clear();
        }
        ParserRegistry.instance = null;
    }

    /**
     * Register a parser for a specific language
     */
    registerParser(language: Language, parser: BaseParser): void {
        this.parsers.set(language, parser);
    }

    /**
     * Get parser for a specific language
     */
    getParserForLanguage(language: Language): BaseParser | null {
        return this.parsers.get(language) || null;
    }

    /**
     * Detect language from file extension
     */
    detectLanguage(fileExtension: string): Language | null {
        const ext = fileExtension.toLowerCase().startsWith('.') 
            ? fileExtension.toLowerCase() 
            : `.${fileExtension.toLowerCase()}`;
        return extensionToLanguage[ext] || null;
    }

    /**
     * Get language from file path
     */
    getLanguageFromPath(filePath: string): Language | null {
        const lastDot = filePath.lastIndexOf('.');
        if (lastDot === -1 || lastDot === filePath.length - 1) {
            return null;
        }
        const extension = filePath.slice(lastDot).toLowerCase();
        return this.detectLanguage(extension);
    }

    /**
     * Get parser for a file based on extension
     */
    getParser(fileExtension: string): BaseParser | null {
        const language = this.detectLanguage(fileExtension);
        if (!language) {
            console.warn(`[parser-registry] Unsupported file extension: ${fileExtension}`);
            return null;
        }

        const parser = this.parsers.get(language);
        if (!parser) {
            console.warn(`[parser-registry] No parser registered for language: ${language}`);
            return null;
        }

        return parser;
    }

    /**
     * Get parser for a file path
     */
    getParserForPath(filePath: string): BaseParser | null {
        const lastDot = filePath.lastIndexOf('.');
        if (lastDot === -1 || lastDot === filePath.length - 1) {
            console.warn(`[parser-registry] Cannot determine extension for: ${filePath}`);
            return null;
        }
        const extension = filePath.slice(lastDot);
        return this.getParser(extension);
    }

    /**
     * Parse source code from a file path
     */
    async parseFile(filePath: string, sourceCode: string): Promise<ASTMetadata | null> {
        const parser = this.getParserForPath(filePath);
        if (!parser) {
            return null;
        }

        try {
            return await parser.parse(sourceCode);
        } catch (error) {
            console.error(`[parser-registry] Error parsing ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Check if a file extension is supported
     */
    isSupported(fileExtension: string): boolean {
        return this.detectLanguage(fileExtension) !== null;
    }

    /**
     * Check if a file path is supported
     */
    isPathSupported(filePath: string): boolean {
        const lastDot = filePath.lastIndexOf('.');
        if (lastDot === -1 || lastDot === filePath.length - 1) {
            return false;
        }
        const extension = filePath.slice(lastDot);
        return this.isSupported(extension);
    }

    /**
     * Get all supported extensions
     */
    getSupportedExtensions(): string[] {
        return Object.keys(extensionToLanguage);
    }

    /**
     * Get all registered languages
     */
    getRegisteredLanguages(): Language[] {
        return Array.from(this.parsers.keys());
    }

    /**
     * Check if a language has a registered parser
     */
    hasParser(language: Language): boolean {
        return this.parsers.has(language);
    }
}

/**
 * Convenience function to get the registry instance
 */
export function getParserRegistry(): ParserRegistry {
    return ParserRegistry.getInstance();
}
