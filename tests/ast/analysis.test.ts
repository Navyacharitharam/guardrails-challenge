import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeASTSystem,
    parseSource,
    detectStubInContent,
    calculateCyclomaticComplexity,
    calculateLinesOfCode,
    calculateNestingDepth,
    COMPLEXITY_THRESHOLDS,
} from '../../src/utils/ast/index.ts';

// Initialize AST system
test('Initialize AST system for analysis tests', async () => {
    await initializeASTSystem();
    assert.ok(true);
});

// Stub detection tests
test('detectStubInContent identifies throw TODO pattern', () => {
    const code = `function notImpl() {
        throw new Error('TODO: implement this');
    }`;
    
    const result = detectStubInContent(code, 'notImpl', 'typescript');
    
    assert.equal(result.isStub, true);
    assert.equal(result.pattern, 'throw_todo');
    assert.ok(result.confidence >= 0.9);
});

test('detectStubInContent identifies throw Not implemented pattern', () => {
    const code = `function stub() {
        throw new Error('Not implemented');
    }`;
    
    const result = detectStubInContent(code, 'stub', 'typescript');
    
    assert.equal(result.isStub, true);
    assert.ok(result.pattern === 'throw_todo' || result.pattern === 'throw_not_impl');
});

test('detectStubInContent identifies empty function body', () => {
    const result = detectStubInContent('{}', 'empty', 'typescript');
    
    assert.equal(result.isStub, true);
    assert.equal(result.pattern, 'empty_body');
});

test('detectStubInContent identifies Python pass statement', () => {
    const code = `def placeholder():
    pass`;
    
    const result = detectStubInContent(code, 'placeholder', 'python');
    
    assert.equal(result.isStub, true);
    assert.equal(result.pattern, 'pass_statement');
});

test('detectStubInContent identifies Python NotImplementedError', () => {
    const code = `def not_ready():
    raise NotImplementedError('TODO')`;
    
    const result = detectStubInContent(code, 'not_ready', 'python');
    
    assert.equal(result.isStub, true);
});

test('detectStubInContent identifies return undefined only', () => {
    const code = `function noop() {
    return undefined;
}`;
    
    const result = detectStubInContent(code, 'noop', 'typescript');
    
    assert.equal(result.isStub, true);
    assert.equal(result.pattern, 'return_undefined');
});

test('detectStubInContent does not flag real implementation', () => {
    const code = `function process(items) {
        const result = items.map(item => item.value);
        return result.filter(Boolean);
    }`;
    
    const result = detectStubInContent(code, 'process', 'javascript');
    
    assert.equal(result.isStub, false);
});

test('detectStubInContent does not flag function with logic', () => {
    const code = `async function fetchData(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Fetch failed');
        }
        return response.json();
    }`;
    
    const result = detectStubInContent(code, 'fetchData', 'typescript');
    
    assert.equal(result.isStub, false);
});

// Complexity tests
test('calculateCyclomaticComplexity returns 1 for simple function', () => {
    const code = `function simple() {
        return 42;
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    assert.equal(complexity, 1);
});

test('calculateCyclomaticComplexity counts if statements', () => {
    const code = `function withIf(x) {
        if (x > 0) {
            return 'positive';
        } else if (x < 0) {
            return 'negative';
        }
        return 'zero';
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // 1 base + 2 if/else-if = 3
    assert.ok(complexity >= 2, `Expected at least 2, got ${complexity}`);
});

test('calculateCyclomaticComplexity counts loops', () => {
    const code = `function withLoops(arr) {
        for (const item of arr) {
            while (item.ready) {
                process(item);
            }
        }
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // 1 base + 1 for + 1 while = 3
    assert.ok(complexity >= 3, `Expected at least 3, got ${complexity}`);
});

test('calculateCyclomaticComplexity counts logical operators', () => {
    const code = `function withLogic(a, b, c) {
        if (a && b || c) {
            return true;
        }
        return false;
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // 1 base + 1 if + 1 && + 1 || = 4
    assert.ok(complexity >= 4, `Expected at least 4, got ${complexity}`);
});

test('calculateCyclomaticComplexity counts switch cases', () => {
    const code = `function withSwitch(x) {
        switch(x) {
            case 1: return 'one';
            case 2: return 'two';
            case 3: return 'three';
            default: return 'other';
        }
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // 1 base + 1 switch + 3 cases = 5 (or more depending on counting)
    assert.ok(complexity >= 4, `Expected at least 4, got ${complexity}`);
});

test('calculateCyclomaticComplexity counts ternary operators', () => {
    const code = `function withTernary(x) {
        return x > 0 ? 'positive' : x < 0 ? 'negative' : 'zero';
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // 1 base + 2 ternary = 3
    assert.ok(complexity >= 3, `Expected at least 3, got ${complexity}`);
});

test('calculateCyclomaticComplexity handles Python syntax', () => {
    const code = `def complex_func(data):
    if data and len(data) > 0:
        for item in data:
            if item.valid or item.pending:
                yield item
    elif data is None:
        return []`;
    
    const complexity = calculateCyclomaticComplexity(code, 'python');
    
    // 1 base + multiple conditions
    assert.ok(complexity >= 5, `Expected at least 5, got ${complexity}`);
});

test('calculateCyclomaticComplexity ignores strings and comments', () => {
    const code = `function withStrings() {
        // if this was code it would count
        const str = "if (x) { return y; }";
        /* another if inside comment */
        return str;
    }`;
    
    const complexity = calculateCyclomaticComplexity(code, 'typescript');
    
    // Should be 1 - no actual decision points
    assert.equal(complexity, 1);
});

// Lines of code tests
test('calculateLinesOfCode counts non-empty lines', () => {
    const code = `function example() {
    const x = 1;
    
    const y = 2;
    
    return x + y;
}`;
    
    const loc = calculateLinesOfCode(code, 'typescript');
    
    // 4 lines with code: function, const x, const y, return
    assert.ok(loc >= 4, `Expected at least 4 LOC, got ${loc}`);
});

test('calculateLinesOfCode excludes comments', () => {
    const code = `function example() {
    // This is a comment
    const x = 1;
    /* Multi-line
       comment */
    return x;
}`;
    
    const loc = calculateLinesOfCode(code, 'typescript');
    
    // Only function, const x, return
    assert.ok(loc <= 5, `Expected at most 5 LOC without comments, got ${loc}`);
});

// Nesting depth tests
test('calculateNestingDepth measures brace nesting', () => {
    const code = `function nested() {
    if (true) {
        for (let i = 0; i < 10; i++) {
            if (i > 5) {
                console.log(i);
            }
        }
    }
}`;
    
    const depth = calculateNestingDepth(code);
    
    assert.ok(depth >= 3, `Expected at least 3 nesting levels, got ${depth}`);
});

test('calculateNestingDepth handles Python indentation', () => {
    const code = `def nested():
    if True:
        for i in range(10):
            if i > 5:
                print(i)`;
    
    const depth = calculateNestingDepth(code);
    
    assert.ok(depth >= 3, `Expected at least 3 nesting levels, got ${depth}`);
});

// Integration test with actual parsing
test('Full complexity analysis on parsed TypeScript', async () => {
    const code = `
export function complexFunction(data: any[]) {
    if (!data) return [];
    
    const result: any[] = [];
    
    for (const item of data) {
        if (item.type === 'A') {
            result.push(processA(item));
        } else if (item.type === 'B') {
            result.push(processB(item));
        } else {
            if (item.fallback && item.fallback.enabled) {
                result.push(item.fallback.value);
            }
        }
    }
    
    return result.filter(x => x !== null && x !== undefined);
}

function simpleFunction() {
    return 42;
}

function stubFunction() {
    throw new Error('TODO: implement');
}
`;
    
    const ast = await parseSource(code, 'typescript');
    
    assert.ok(ast, 'Should parse successfully');
    assert.ok(ast?.symbols.length >= 3, 'Should find 3 functions');
    
    // Calculate complexity for the complex function body
    const complexFuncCode = code.slice(
        code.indexOf('export function complexFunction'),
        code.indexOf('function simpleFunction')
    );
    
    const complexity = calculateCyclomaticComplexity(complexFuncCode, 'typescript');
    console.log(`complexFunction CC: ${complexity}`);
    
    // This function has: if, for, if, else if, else, if && = at least 7 decision points
    assert.ok(complexity >= 6, `Expected CC >= 6, got ${complexity}`);
});

// COMPLEXITY_THRESHOLDS test
test('COMPLEXITY_THRESHOLDS has expected values', () => {
    assert.equal(COMPLEXITY_THRESHOLDS.LOW, 5);
    assert.equal(COMPLEXITY_THRESHOLDS.MEDIUM, 10);
    assert.equal(COMPLEXITY_THRESHOLDS.HIGH, 20);
});
