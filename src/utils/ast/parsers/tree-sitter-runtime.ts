import Parser from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import type { Language } from '../schema';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create require function for resolving package paths
const require = createRequire(import.meta.url);

/**
 * Find the actual path to a package's directory using require.resolve
 */
function findPackagePath(packageName: string): string | null {
    try {
        // Resolve the package.json to find the package root
        const packageJsonPath = require.resolve(`${packageName}/package.json`);
        return dirname(packageJsonPath);
    } catch {
        return null;
    }
}

/**
 * Grammar file paths for supported languages.
 * Tree-sitter WASM grammars are loaded from tree-sitter-wasms package or local paths.
 */
function findGrammarPath(grammarName: string): string | null {
    // First try to find tree-sitter-wasms package using require.resolve
    const wasmsPackagePath = findPackagePath('tree-sitter-wasms');
    if (wasmsPackagePath) {
        const wasmPath = resolve(wasmsPackagePath, 'out', `${grammarName}.wasm`);
        if (existsSync(wasmPath)) {
            return wasmPath;
        }
    }

    // Fallback paths using __dirname
    const possiblePaths = [
        // tree-sitter-wasms package (pre-built grammars)
        resolve(__dirname, '../../../../node_modules/tree-sitter-wasms/out', `${grammarName}.wasm`),
        // Individual grammar packages
        resolve(__dirname, '../../../../node_modules', grammarName, `${grammarName}.wasm`),
        resolve(__dirname, '../../../../node_modules', grammarName, 'tree-sitter.wasm'),
        // Pre-built grammars directory (if we bundle them)
        resolve(__dirname, '../grammars', `${grammarName}.wasm`),
    ];

    for (const p of possiblePaths) {
        if (existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Find the web-tree-sitter WASM binary path
 */
function findTreeSitterWasmPath(): string | null {
    // First try using require.resolve
    const webTreeSitterPath = findPackagePath('web-tree-sitter');
    if (webTreeSitterPath) {
        const wasmPath = resolve(webTreeSitterPath, 'tree-sitter.wasm');
        if (existsSync(wasmPath)) {
            return wasmPath;
        }
    }

    // Fallback paths
    const possiblePaths = [
        resolve(__dirname, '../../../../node_modules/web-tree-sitter/tree-sitter.wasm'),
        resolve(__dirname, '../../../../../node_modules/web-tree-sitter/tree-sitter.wasm'),
    ];

    for (const p of possiblePaths) {
        if (existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Singleton runtime for Tree-sitter WASM parser management.
 * Manages initialization and grammar loading with caching.
 */
export class TreeSitterRuntime {
    private static instance: TreeSitterRuntime | null = null;
    private initialized = false;
    private initializing: Promise<void> | null = null;
    private grammars = new Map<Language, Parser.Language>();
    private loadingGrammars = new Map<Language, Promise<Parser.Language | null>>();
    private initTimeMs = 0;

    // Private constructor for singleton pattern
    private constructor() {
        // Intentionally empty - initialization happens via initialize()
    }

    /**
     * Get the singleton runtime instance
     */
    static getInstance(): TreeSitterRuntime {
        if (!TreeSitterRuntime.instance) {
            TreeSitterRuntime.instance = new TreeSitterRuntime();
        }
        return TreeSitterRuntime.instance;
    }

    /**
     * Reset the singleton (primarily for testing)
     */
    static reset(): void {
        if (TreeSitterRuntime.instance) {
            TreeSitterRuntime.instance.grammars.clear();
            TreeSitterRuntime.instance.loadingGrammars.clear();
            TreeSitterRuntime.instance.initialized = false;
            TreeSitterRuntime.instance.initializing = null;
        }
        TreeSitterRuntime.instance = null;
    }

    /**
     * Initialize the Tree-sitter WASM runtime.
     * Must be called before any parsing operations.
     * Safe to call multiple times - will only initialize once.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        if (this.initializing) {
            return this.initializing;
        }

        const startTime = performance.now();
        this.initializing = (async () => {
            try {
                // Find the WASM binary using robust path resolution
                const wasmPath = findTreeSitterWasmPath();
                if (!wasmPath) {
                    throw new Error('Could not find web-tree-sitter WASM binary. Ensure web-tree-sitter is installed.');
                }

                await Parser.init({
                    locateFile: (scriptName: string) => {
                        if (scriptName === 'tree-sitter.wasm') {
                            return wasmPath;
                        }
                        return scriptName;
                    },
                });

                this.initialized = true;
                this.initTimeMs = performance.now() - startTime;
            } catch (error) {
                this.initializing = null;
                const message = `Failed to initialize Tree-sitter: ${error instanceof Error ? error.message : String(error)}`;
                throw new Error(message, { cause: error });
            }
        })();

        return this.initializing;
    }

    /**
     * Check if the runtime is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get initialization time in milliseconds
     */
    getInitTimeMs(): number {
        return this.initTimeMs;
    }

    /**
     * Load a grammar for the specified language.
     * Grammars are cached after first load.
     */
    async loadGrammar(language: Language): Promise<Parser.Language | null> {
        if (!this.initialized) {
            await this.initialize();
        }

        // Check cache
        const cached = this.grammars.get(language);
        if (cached) {
            return cached;
        }

        // Check if already loading
        const loading = this.loadingGrammars.get(language);
        if (loading) {
            return loading;
        }

        // Map language to grammar package name
        const grammarMap: Record<Language, string> = {
            typescript: 'tree-sitter-typescript',
            javascript: 'tree-sitter-javascript',
            python: 'tree-sitter-python',
            java: 'tree-sitter-java',
        };

        const grammarName = grammarMap[language];
        const loadPromise = (async () => {
            try {
                const grammarPath = findGrammarPath(grammarName);
                if (!grammarPath) {
                    console.warn(`[tree-sitter] Grammar not found for ${language}. Install ${grammarName} package.`);
                    return null;
                }

                const grammar = await Parser.Language.load(grammarPath);
                this.grammars.set(language, grammar);
                return grammar;
            } catch (error) {
                console.warn(`[tree-sitter] Failed to load grammar for ${language}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            } finally {
                this.loadingGrammars.delete(language);
            }
        })();

        this.loadingGrammars.set(language, loadPromise);
        return loadPromise;
    }

    /**
     * Create a new parser instance configured for the specified language.
     */
    async createParser(language: Language): Promise<Parser | null> {
        const grammar = await this.loadGrammar(language);
        if (!grammar) {
            return null;
        }

        const parser = new Parser();
        parser.setLanguage(grammar);
        return parser;
    }

    /**
     * Parse source code and return the syntax tree.
     */
    async parse(sourceCode: string, language: Language): Promise<Parser.Tree | null> {
        const parser = await this.createParser(language);
        if (!parser) {
            return null;
        }

        try {
            return parser.parse(sourceCode);
        } catch (error) {
            console.warn(`[tree-sitter] Parse error for ${language}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Get list of loaded grammars
     */
    getLoadedGrammars(): Language[] {
        return Array.from(this.grammars.keys());
    }
}

/**
 * Convenience function to get the runtime instance
 */
export function getTreeSitterRuntime(): TreeSitterRuntime {
    return TreeSitterRuntime.getInstance();
}
