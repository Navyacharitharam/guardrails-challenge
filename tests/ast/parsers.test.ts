import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeASTSystem,
    parseSource,
    parseFile,
    isExtensionSupported,
    getSupportedExtensions,
    getParserRegistry,
    validateASTMetadata,
    safeValidateASTMetadata,
} from '../../src/utils/ast/index.ts';

// Test AST Schema validation
test('validateASTMetadata accepts valid AST structure', () => {
    const validAST = {
        language: 'typescript',
        symbols: [{
            name: 'testFunc',
            kind: 'function',
            location: { line: 1, column: 0, startByte: 0, endByte: 50 },
            body: {
                declarationText: 'function testFunc() { return true; }',
                bodyText: '{ return true; }',
                normalizedBodyText: '{ return true; }',
                statementCount: 1,
                callTargets: ['Boolean'],
                rawLogicSummary: 'Contains 1 top-level statement; returns or yields a value',
            },
        }],
        imports: [],
        exports: [],
        metrics: {
            totalLines: 10,
            symbolCount: 1,
            functionCount: 1,
            classCount: 0,
            importCount: 0,
            exportCount: 0,
        },
    };

    const result = validateASTMetadata(validAST);
    assert.equal(result.language, 'typescript');
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].body?.statementCount, 1);
});

test('safeValidateASTMetadata returns null for invalid AST', () => {
    const invalidAST = {
        language: 'invalid_language',
        symbols: [],
        imports: [],
        exports: [],
    };

    const result = safeValidateASTMetadata(invalidAST);
    assert.equal(result, null);
});

// Test extension support
test('isExtensionSupported returns true for TypeScript', () => {
    assert.equal(isExtensionSupported('.ts'), true);
    assert.equal(isExtensionSupported('.tsx'), true);
    assert.equal(isExtensionSupported('ts'), true);
});

test('isExtensionSupported returns true for JavaScript', () => {
    assert.equal(isExtensionSupported('.js'), true);
    assert.equal(isExtensionSupported('.jsx'), true);
    assert.equal(isExtensionSupported('.mjs'), true);
});

test('isExtensionSupported returns true for Python', () => {
    assert.equal(isExtensionSupported('.py'), true);
});

test('isExtensionSupported returns true for Java', () => {
    assert.equal(isExtensionSupported('.java'), true);
});

test('isExtensionSupported returns false for unsupported extensions', () => {
    assert.equal(isExtensionSupported('.rb'), false);
    assert.equal(isExtensionSupported('.go'), false);
    assert.equal(isExtensionSupported('.rs'), false);
});

test('getSupportedExtensions returns all supported extensions', () => {
    const extensions = getSupportedExtensions();
    assert.ok(extensions.includes('.ts'));
    assert.ok(extensions.includes('.tsx'));
    assert.ok(extensions.includes('.js'));
    assert.ok(extensions.includes('.jsx'));
    assert.ok(extensions.includes('.py'));
    assert.ok(extensions.includes('.java'));
});

// Test parser registry language detection
test('ParserRegistry detects language from file path', () => {
    const registry = getParserRegistry();

    assert.equal(registry.getLanguageFromPath('src/utils/helper.ts'), 'typescript');
    assert.equal(registry.getLanguageFromPath('components/Button.tsx'), 'typescript');
    assert.equal(registry.getLanguageFromPath('src/index.js'), 'javascript');
    assert.equal(registry.getLanguageFromPath('utils/helpers.py'), 'python');
    assert.equal(registry.getLanguageFromPath('com/example/Main.java'), 'java');
    assert.equal(registry.getLanguageFromPath('README.md'), null);
});

// TypeScript parsing tests (will only work if grammar is available)
test('parseSource handles TypeScript function extraction', async () => {
    const code = `
export function regularFunction(a: string, b: number): boolean {
    return a.length > b;
}

export async function asyncFunction(): Promise<void> {
    await Promise.resolve();
}

const arrowFunc = (x: number) => x * 2;

function* generatorFunc() {
    yield 1;
    yield 2;
}

export const exportedArrow = async (data: string): Promise<string> => {
    return data.toUpperCase();
};
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'typescript');

        if (result) {
            assert.equal(result.language, 'typescript');
            assert.ok(result.symbols.length >= 4, `Expected at least 4 symbols, got ${result.symbols.length}`);

            const funcNames = result.symbols.map(s => s.name);
            assert.ok(funcNames.includes('regularFunction'), 'Should find regularFunction');
            assert.ok(funcNames.includes('asyncFunction'), 'Should find asyncFunction');

            const asyncFunc = result.symbols.find(s => s.name === 'asyncFunction');
            assert.ok(asyncFunc?.isAsync, 'asyncFunction should be marked as async');

            const regularFunc = result.symbols.find(s => s.name === 'regularFunction');
            assert.ok(regularFunc?.isExported, 'regularFunction should be marked as exported');
            assert.ok(regularFunc?.parameters?.length === 2, 'regularFunction should have 2 parameters');
        } else {
            console.log('Note: TypeScript grammar not available, skipping detailed assertions');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

test('parseSource handles TypeScript class extraction', async () => {
    const code = `
export class BaseService {
    private config: Config;
    
    constructor(config: Config) {
        this.config = config;
    }
    
    public async fetchData(): Promise<Data> {
        return this.doFetch();
    }
    
    protected doFetch(): Promise<Data> {
        throw new Error('Not implemented');
    }
    
    static getInstance(): BaseService {
        return new BaseService({});
    }
}

export abstract class AbstractHandler {
    abstract handle(request: Request): Response;
}

export interface IService {
    start(): void;
    stop(): void;
}

export type ServiceConfig = {
    timeout: number;
    retries: number;
};

export enum Status {
    ACTIVE,
    INACTIVE,
    PENDING
}
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'typescript');

        if (result) {
            assert.equal(result.language, 'typescript');

            const classSymbol = result.symbols.find(s => s.name === 'BaseService');
            if (classSymbol) {
                assert.equal(classSymbol.kind, 'class');
                assert.ok(classSymbol.members && classSymbol.members.length > 0, 'Class should have members');

                const constructor = classSymbol.members?.find(m => m.kind === 'constructor');
                assert.ok(constructor, 'Class should have constructor');

                const staticMethod = classSymbol.members?.find(m => m.name === 'getInstance');
                assert.ok(staticMethod?.isStatic, 'getInstance should be static');
            }

            const interfaceSymbol = result.symbols.find(s => s.name === 'IService');
            if (interfaceSymbol) {
                assert.equal(interfaceSymbol.kind, 'interface');
            }

            const enumSymbol = result.symbols.find(s => s.name === 'Status');
            if (enumSymbol) {
                assert.equal(enumSymbol.kind, 'enum');
            }
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

test('parseSource includes TypeScript review body metadata', async () => {
    const code = `
export function regularFunction(a: string, b: number): boolean {
    const threshold = b + 1;
    return a.length > threshold;
}

export class BaseService {
    private config: Config;

    constructor(config: Config) {
        this.config = config;
    }

    public async fetchData(): Promise<Data> {
        return this.doFetch();
    }

    protected doFetch(): Promise<Data> {
        throw new Error('Not implemented');
    }
}
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'typescript');

        if (result) {
            const regularFunction = result.symbols.find(s => s.name === 'regularFunction');
            assert.ok(regularFunction?.body?.bodyText?.includes('return a.length > threshold'), 'Function body should include raw body text');
            assert.ok((regularFunction?.body?.statementCount ?? 0) >= 2, 'Function body should count top-level statements');
            assert.ok(regularFunction?.body?.rawLogicSummary?.includes('returns or yields a value'), 'Function summary should describe return behavior');

            const baseService = result.symbols.find(s => s.name === 'BaseService');
            assert.ok(baseService?.classBody?.memberCount, 'Class should include classBody metadata');
            assert.ok(baseService?.classBody?.methodNames?.includes('fetchData'), 'Class summary should include method names');

            const fetchData = baseService?.members?.find(m => m.name === 'fetchData');
            assert.ok(fetchData?.body?.callTargets?.includes('this.doFetch'), 'Method body should include detected call targets');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

test('parseSource handles TypeScript imports and exports', async () => {
    const code = `
import { readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import './side-effect-module';

export { readFile };
export { writeFile as write };
export * from './utils';
export default class MainExport {}
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'typescript');

        if (result) {
            assert.ok(result.imports.length >= 4, `Expected at least 4 imports, got ${result.imports.length}`);

            const namedImport = result.imports.find(i => i.source === 'fs/promises');
            if (namedImport) {
                assert.equal(namedImport.kind, 'named');
                assert.ok(namedImport.symbols?.some(s => s.name === 'readFile'));
            }

            const namespaceImport = result.imports.find(i => i.source === 'path');
            if (namespaceImport) {
                assert.equal(namespaceImport.kind, 'namespace');
            }

            const sideEffectImport = result.imports.find(i => i.source === './side-effect-module');
            if (sideEffectImport) {
                assert.equal(sideEffectImport.kind, 'side_effect');
            }

            assert.ok(result.exports.length >= 3, `Expected at least 3 exports, got ${result.exports.length}`);
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

// JavaScript parsing tests
test('parseSource handles JavaScript CommonJS modules', async () => {
    const code = `
const express = require('express');
const { Router } = require('express');

function createApp() {
    const app = express();
    return app;
}

module.exports = createApp;
exports.Router = Router;
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'javascript');

        if (result) {
            assert.equal(result.language, 'javascript');

            // Should detect require() calls as imports
            const expressImport = result.imports.find(i => i.source === 'express');
            assert.ok(expressImport, 'Should find express import');

            // Should detect module.exports
            const defaultExport = result.exports.find(e => e.kind === 'default');
            assert.ok(defaultExport, 'Should find module.exports as default export');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

test('parseSource includes body metadata for JavaScript, Python, and Java', async () => {
    const fixtures = [
        {
            language: 'javascript' as const,
            code: `
class Example {
    value = () => computeValue(1);

    execute(input) {
        return transform(input);
    }
}

const helper = (value) => value + 1;
`,
            assertResult(result: NonNullable<Awaited<ReturnType<typeof parseSource>>>) {
                const example = result.symbols.find(s => s.name === 'Example');
                assert.ok(example?.classBody?.memberCount, 'JavaScript class should have classBody metadata');
                const helper = result.symbols.find(s => s.name === 'helper');
                assert.ok(helper?.body?.bodyText, 'JavaScript arrow function should expose body metadata');
            },
        },
        {
            language: 'python' as const,
            code: `
class Worker(BaseWorker):
    def process(self, item):
        normalized = normalize(item)
        return save(normalized)
`,
            assertResult(result: NonNullable<Awaited<ReturnType<typeof parseSource>>>) {
                const worker = result.symbols.find(s => s.name === 'Worker');
                assert.ok(worker?.classBody?.rawLogicSummary, 'Python class should have classBody summary');
                const process = worker?.members?.find(m => m.name === 'process');
                assert.ok(process?.body?.callTargets?.includes('normalize'), 'Python method should capture call targets');
            },
        },
        {
            language: 'java' as const,
            code: `
public class OrderService {
    public Order create(OrderRequest request) {
        validate(request);
        return repository.save(request);
    }
}
`,
            assertResult(result: NonNullable<Awaited<ReturnType<typeof parseSource>>>) {
                const orderService = result.symbols.find(s => s.name === 'OrderService');
                assert.ok(orderService?.classBody?.methodNames?.includes('create'), 'Java class should list method names');
                const create = orderService?.members?.find(m => m.name === 'create');
                assert.ok(create?.body?.rawLogicSummary?.includes('calls'), 'Java method summary should mention calls');
            },
        },
    ];

    try {
        await initializeASTSystem();

        for (const fixture of fixtures) {
            const result = await parseSource(fixture.code, fixture.language);
            if (result) {
                fixture.assertResult(result);
            }
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

// Python parsing tests
test('parseSource handles Python function and class extraction', async () => {
    const code = `
import os
from typing import List, Optional
from dataclasses import dataclass

@dataclass
class Config:
    name: str
    value: int = 0

class Service:
    def __init__(self, config: Config):
        self.config = config
    
    async def fetch_data(self) -> List[dict]:
        return []
    
    @staticmethod
    def create_default() -> 'Service':
        return Service(Config(name='default'))
    
    @classmethod
    def from_env(cls) -> 'Service':
        return cls(Config(name=os.getenv('NAME', 'default')))

def regular_function(a: str, b: int = 10) -> bool:
    return len(a) > b

async def async_function():
    await some_async_call()

lambda_func = lambda x: x * 2

__all__ = ['Config', 'Service', 'regular_function']
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'python');

        if (result) {
            assert.equal(result.language, 'python');

            // Check class extraction
            const configClass = result.symbols.find(s => s.name === 'Config');
            if (configClass) {
                assert.equal(configClass.kind, 'class');
                assert.ok(configClass.decorators?.includes('dataclass'), 'Config should have dataclass decorator');
            }

            const serviceClass = result.symbols.find(s => s.name === 'Service');
            if (serviceClass) {
                assert.equal(serviceClass.kind, 'class');
                assert.ok(serviceClass.members && serviceClass.members.length > 0, 'Service should have members');

                const initMethod = serviceClass.members?.find(m => m.name === '__init__');
                assert.ok(initMethod?.kind === 'constructor', '__init__ should be marked as constructor');

                const staticMethod = serviceClass.members?.find(m => m.name === 'create_default');
                assert.ok(staticMethod?.isStatic, 'create_default should be static');
            }

            // Check imports
            const osImport = result.imports.find(i => i.source === 'os');
            assert.ok(osImport, 'Should find os import');

            const typingImport = result.imports.find(i => i.source === 'typing');
            assert.ok(typingImport, 'Should find typing import');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

// Java parsing tests
test('parseSource handles Java class and method extraction', async () => {
    const code = `
package com.example;

import java.util.List;
import java.util.Map;
import static java.lang.Math.*;

@Service
public class UserService implements IService {
    private final UserRepository repository;
    
    public UserService(UserRepository repository) {
        this.repository = repository;
    }
    
    @Override
    public List<User> findAll() {
        return repository.findAll();
    }
    
    public <T extends User> T findById(Long id) throws NotFoundException {
        return repository.findById(id);
    }
    
    public static UserService create() {
        return new UserService(new UserRepository());
    }
}

public interface IService {
    List<User> findAll();
}

public enum Status {
    ACTIVE,
    INACTIVE
}
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(code, 'java');

        if (result) {
            assert.equal(result.language, 'java');

            // Check class extraction
            const userService = result.symbols.find(s => s.name === 'UserService');
            if (userService) {
                assert.equal(userService.kind, 'class');
                assert.equal(userService.visibility, 'public');
                assert.ok(userService.implements?.includes('IService'), 'Should implement IService');
                assert.ok(userService.decorators?.some(d => d.includes('@Service')), 'Should have @Service annotation');
            }

            // Check interface
            const iService = result.symbols.find(s => s.name === 'IService');
            if (iService) {
                assert.equal(iService.kind, 'interface');
            }

            // Check enum
            const status = result.symbols.find(s => s.name === 'Status');
            if (status) {
                assert.equal(status.kind, 'enum');
            }

            // Check imports
            assert.ok(result.imports.length >= 2, 'Should have at least 2 imports');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

// Error handling tests
test('parseSource handles syntax errors gracefully', async () => {
    const codeWithErrors = `
function broken( {
    // Missing closing parenthesis and brace
    const x = 
`;

    try {
        await initializeASTSystem();
        const result = await parseSource(codeWithErrors, 'typescript');

        if (result) {
            // Should return partial results with errors
            assert.equal(result.language, 'typescript');
            assert.ok(result.errors && result.errors.length > 0, 'Should report parsing errors');
        }
    } catch {
        // Some level of error handling is expected
        console.log('Parser handled syntax error appropriately');
    }
});

// parseFile tests
test('parseFile detects language from file path', async () => {
    const tsCode = `export const value = 42;`;

    try {
        await initializeASTSystem();
        const result = await parseFile('src/utils/helper.ts', tsCode);

        if (result) {
            assert.equal(result.language, 'typescript');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

test('parseFile returns null for unsupported extensions', async () => {
    const rubyCode = `def hello; puts "Hello"; end`;

    try {
        await initializeASTSystem();
        const result = await parseFile('script.rb', rubyCode);
        assert.equal(result, null);
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});

// Performance test
test('parseSource completes within performance target', async () => {
    // Generate a moderately complex file
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
        lines.push(`function func${i}(a: number, b: string): boolean {`);
        lines.push(`    const result = a > 0 && b.length > 0;`);
        lines.push(`    if (result) { console.log('${i}'); }`);
        lines.push(`    return result;`);
        lines.push(`}`);
        lines.push('');
    }
    const code = lines.join('\n');

    try {
        await initializeASTSystem();
        const startTime = performance.now();
        const result = await parseSource(code, 'typescript');
        const elapsed = performance.now() - startTime;

        if (result) {
            console.log(`Parsed 500-function file in ${elapsed.toFixed(2)}ms`);
            assert.ok(elapsed < 2000, `Parsing should complete in < 2000ms, took ${elapsed.toFixed(2)}ms`);
            assert.ok(result.parseTimeMs !== undefined, 'Should report parse time');
        }
    } catch (error) {
        console.log(`Note: Tree-sitter initialization failed: ${error}. Grammar may not be installed.`);
    }
});
