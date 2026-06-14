import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeASTSystem,
    enrichFileNodeWithAST,
    enrichWorkspaceTreeWithAST,
    collectASTMetadata,
    getWorkspaceSymbols,
    getWorkspaceImports,
    type FileNodeWithAST,
    type WorkspaceTreeWithAST,
} from '../../src/utils/ast/index.ts';

// Sample source files for testing
const sampleTypeScriptFile = `
import { Request, Response } from 'express';
import * as path from 'path';

export interface IService {
    start(): void;
    stop(): void;
}

export class UserService implements IService {
    private config: Config;
    
    constructor(config: Config) {
        this.config = config;
    }
    
    public start(): void {
        console.log('Starting...');
    }
    
    public stop(): void {
        console.log('Stopping...');
    }
    
    async fetchUser(id: string): Promise<User> {
        return this.repository.findById(id);
    }
}

export function createService(config: Config): UserService {
    return new UserService(config);
}

export const helper = (x: number) => x * 2;
`;

const sampleJavaScriptFile = `
const express = require('express');
const { Router } = require('express');

class AppController {
    constructor(router) {
        this.router = router;
    }
    
    handleRequest(req, res) {
        res.send('OK');
    }
}

function createApp() {
    const app = express();
    return app;
}

module.exports = { AppController, createApp };
`;

const samplePythonFile = `
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

def process_data(items: List[str]) -> int:
    return len(items)
`;

// Helper to create test FileNodes
function createFileNode(
    name: string,
    path: string,
    content: string
): FileNodeWithAST {
    return {
        name,
        path,
        type: 'file',
        size: content.length,
        modifiedAt: new Date().toISOString(),
        content,
    };
}

function createDirectoryNode(
    name: string,
    path: string,
    children: FileNodeWithAST[]
): FileNodeWithAST {
    return {
        name,
        path,
        type: 'directory',
        size: children.reduce((sum, c) => sum + c.size, 0),
        modifiedAt: new Date().toISOString(),
        children,
    };
}

// Initialize AST system before tests
test('Initialize AST system for file-tree integration tests', async () => {
    await initializeASTSystem();
    assert.ok(true);
});

// Test enrichFileNodeWithAST
test('enrichFileNodeWithAST parses TypeScript file', async () => {
    const node = createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile);
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.ok(enriched.ast, 'Should have AST metadata');
    assert.equal(enriched.ast?.language, 'typescript');
    assert.ok(enriched.ast?.symbols.length > 0, 'Should have symbols');
    
    const functionNames = enriched.ast?.symbols.filter(s => 
        s.kind === 'function' || s.kind === 'async_function' || s.kind === 'arrow_function'
    ).map(s => s.name);
    assert.ok(functionNames?.includes('createService'), 'Should find createService function');
    assert.ok(functionNames?.includes('helper'), 'Should find helper arrow function');
});

test('enrichFileNodeWithAST parses JavaScript file', async () => {
    const node = createFileNode('controller.js', 'src/controller.js', sampleJavaScriptFile);
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.ok(enriched.ast, 'Should have AST metadata');
    assert.equal(enriched.ast?.language, 'javascript');
    
    const classNames = enriched.ast?.symbols.filter(s => s.kind === 'class').map(s => s.name);
    assert.ok(classNames?.includes('AppController'), 'Should find AppController class');
});

test('enrichFileNodeWithAST parses Python file', async () => {
    const node = createFileNode('service.py', 'src/service.py', samplePythonFile);
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.ok(enriched.ast, 'Should have AST metadata');
    assert.equal(enriched.ast?.language, 'python');
    
    const classNames = enriched.ast?.symbols.filter(s => s.kind === 'class').map(s => s.name);
    assert.ok(classNames?.includes('Config'), 'Should find Config class');
    assert.ok(classNames?.includes('Service'), 'Should find Service class');
});

test('enrichFileNodeWithAST skips binary files', async () => {
    const node = createFileNode('image.png', 'assets/image.png', 'binary content');
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.equal(enriched.ast, undefined, 'Should not have AST for binary files');
});

test('enrichFileNodeWithAST skips unsupported extensions', async () => {
    const node = createFileNode('script.rb', 'src/script.rb', 'def hello; puts "Hi"; end');
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.equal(enriched.ast, undefined, 'Should not have AST for unsupported extensions');
});

test('enrichFileNodeWithAST skips files without content', async () => {
    const node: FileNodeWithAST = {
        name: 'empty.ts',
        path: 'src/empty.ts',
        type: 'file',
        size: 0,
    };
    const enriched = await enrichFileNodeWithAST(node);
    
    assert.equal(enriched.ast, undefined, 'Should not have AST for files without content');
});

test('enrichFileNodeWithAST respects disabled option', async () => {
    const node = createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile);
    const enriched = await enrichFileNodeWithAST(node, { enabled: false });
    
    assert.equal(enriched.ast, undefined, 'Should not have AST when disabled');
});

test('enrichFileNodeWithAST handles directories recursively', async () => {
    const tree = createDirectoryNode('src', 'src', [
        createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile),
        createDirectoryNode('utils', 'src/utils', [
            createFileNode('helper.js', 'src/utils/helper.js', sampleJavaScriptFile),
        ]),
    ]);
    
    const enriched = await enrichFileNodeWithAST(tree);
    
    assert.equal(enriched.type, 'directory');
    assert.ok(enriched.children?.[0].ast, 'First file should have AST');
    assert.ok(enriched.children?.[1].children?.[0].ast, 'Nested file should have AST');
});

// Test enrichWorkspaceTreeWithAST
test('enrichWorkspaceTreeWithAST processes entire tree', async () => {
    const tree: WorkspaceTreeWithAST = {
        root: '',
        tree: [
            createDirectoryNode('src', 'src', [
                createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile),
                createFileNode('controller.js', 'src/controller.js', sampleJavaScriptFile),
                createFileNode('service.py', 'src/service.py', samplePythonFile),
            ]),
            createFileNode('README.md', 'README.md', '# Project'),
        ],
        summary: {
            totalFiles: 4,
            totalDirectories: 1,
            totalSize: 1000,
            textFilesWithContent: 4,
            indexedContentChars: 5000,
            excludedFiles: 0,
            excludedDirectories: 0,
            excludedFilePaths: [],
            excludedDirectoryPaths: [],
            exclusionPatternsUsed: [],
        },
    };
    
    const enriched = await enrichWorkspaceTreeWithAST(tree);
    
    assert.ok(enriched.summary.astParsedFiles !== undefined, 'Should have astParsedFiles in summary');
    assert.ok(enriched.summary.astParsedFiles! >= 3, 'Should have parsed at least 3 files');
    assert.ok(enriched.summary.astTotalParseTimeMs !== undefined, 'Should have parse time in summary');
});

// Test collectASTMetadata
test('collectASTMetadata collects all AST from tree', async () => {
    const tree: WorkspaceTreeWithAST = {
        root: '',
        tree: [
            await enrichFileNodeWithAST(createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile)),
            await enrichFileNodeWithAST(createFileNode('controller.js', 'src/controller.js', sampleJavaScriptFile)),
        ],
        summary: {
            totalFiles: 2,
            totalDirectories: 0,
            totalSize: 1000,
            textFilesWithContent: 2,
            indexedContentChars: 3000,
            excludedFiles: 0,
            excludedDirectories: 0,
            excludedFilePaths: [],
            excludedDirectoryPaths: [],
            exclusionPatternsUsed: [],
        },
    };
    
    const astData = collectASTMetadata(tree);
    
    assert.equal(astData.length, 2, 'Should collect 2 AST entries');
    assert.ok(astData.some(a => a.filePath === 'src/service.ts'), 'Should include service.ts');
    assert.ok(astData.some(a => a.filePath === 'src/controller.js'), 'Should include controller.js');
});

// Test getWorkspaceSymbols
test('getWorkspaceSymbols organizes symbols by type', async () => {
    const tree: WorkspaceTreeWithAST = {
        root: '',
        tree: [
            await enrichFileNodeWithAST(createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile)),
        ],
        summary: {
            totalFiles: 1,
            totalDirectories: 0,
            totalSize: 500,
            textFilesWithContent: 1,
            indexedContentChars: 1500,
            excludedFiles: 0,
            excludedDirectories: 0,
            excludedFilePaths: [],
            excludedDirectoryPaths: [],
            exclusionPatternsUsed: [],
        },
    };
    
    const symbols = getWorkspaceSymbols(tree);
    
    assert.ok(symbols.functions.length > 0, 'Should have functions');
    assert.ok(symbols.classes.length > 0, 'Should have classes');
    assert.ok(symbols.interfaces.length > 0, 'Should have interfaces');
    
    assert.ok(
        symbols.functions.some(f => f.name === 'createService'),
        'Should find createService function'
    );
    assert.ok(
        symbols.classes.some(c => c.name === 'UserService'),
        'Should find UserService class'
    );
    assert.ok(
        symbols.interfaces.some(i => i.name === 'IService'),
        'Should find IService interface'
    );
});

// Test getWorkspaceImports
test('getWorkspaceImports groups imports by source', async () => {
    const tree: WorkspaceTreeWithAST = {
        root: '',
        tree: [
            await enrichFileNodeWithAST(createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile)),
            await enrichFileNodeWithAST(createFileNode('controller.js', 'src/controller.js', sampleJavaScriptFile)),
        ],
        summary: {
            totalFiles: 2,
            totalDirectories: 0,
            totalSize: 1000,
            textFilesWithContent: 2,
            indexedContentChars: 3000,
            excludedFiles: 0,
            excludedDirectories: 0,
            excludedFilePaths: [],
            excludedDirectoryPaths: [],
            exclusionPatternsUsed: [],
        },
    };
    
    const imports = getWorkspaceImports(tree);
    
    assert.ok(imports.has('express'), 'Should have express imports');
    
    const expressImports = imports.get('express');
    assert.ok(expressImports && expressImports.length >= 2, 'Express should be imported in multiple files');
});

// Test serialization round-trip
test('AST metadata survives JSON serialization', async () => {
    const node = await enrichFileNodeWithAST(
        createFileNode('service.ts', 'src/service.ts', sampleTypeScriptFile)
    );
    
    assert.ok(node.ast, 'Should have AST');
    
    // Serialize and deserialize
    const json = JSON.stringify(node);
    const restored = JSON.parse(json) as FileNodeWithAST;
    
    assert.ok(restored.ast, 'Restored node should have AST');
    assert.equal(restored.ast?.language, 'typescript');
    assert.equal(restored.ast?.symbols.length, node.ast?.symbols.length);
    
    // Verify symbol data survived
    const originalFunc = node.ast?.symbols.find(s => s.name === 'createService');
    const restoredFunc = restored.ast?.symbols.find(s => s.name === 'createService');
    assert.ok(originalFunc && restoredFunc, 'Should find createService in both');
    assert.equal(restoredFunc.signature, originalFunc.signature);
});

// Performance test
test('enrichWorkspaceTreeWithAST completes within reasonable time', async () => {
    // Create a larger tree with multiple files
    const files: FileNodeWithAST[] = [];
    for (let i = 0; i < 20; i++) {
        files.push(createFileNode(`file${i}.ts`, `src/file${i}.ts`, sampleTypeScriptFile));
    }
    
    const tree: WorkspaceTreeWithAST = {
        root: '',
        tree: [createDirectoryNode('src', 'src', files)],
        summary: {
            totalFiles: 20,
            totalDirectories: 1,
            totalSize: 20000,
            textFilesWithContent: 20,
            indexedContentChars: 50000,
            excludedFiles: 0,
            excludedDirectories: 0,
            excludedFilePaths: [],
            excludedDirectoryPaths: [],
            exclusionPatternsUsed: [],
        },
    };
    
    const startTime = performance.now();
    const enriched = await enrichWorkspaceTreeWithAST(tree);
    const elapsed = performance.now() - startTime;
    
    console.log(`Enriched 20 files in ${elapsed.toFixed(2)}ms`);
    console.log(`Average per file: ${(elapsed / 20).toFixed(2)}ms`);
    console.log(`Total parse time: ${enriched.summary.astTotalParseTimeMs?.toFixed(2)}ms`);
    
    assert.ok(elapsed < 5000, `Should complete within 5 seconds, took ${elapsed.toFixed(2)}ms`);
    assert.equal(enriched.summary.astParsedFiles, 20, 'Should parse all 20 files');
});
