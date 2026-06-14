import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isUtf16Encoded,
    convertUtf16ToUtf8,
    isPatchContent,
    cleanPatchContent,
    preprocessContent,
} from '../src/utils/workspace-indexer.ts';
import {
    normalizeEncoding,
    cleanPatchBinaryData,
    preprocessFileContent,
} from '../src/utils/filtered-filesystem.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// UTF-16 Detection Tests
// ============================================================================

test('isUtf16Encoded detects UTF-16 LE content', () => {
    // Simulate UTF-16 LE: each ASCII char followed by null byte
    const utf16Content = 'd\0i\0f\0f\0 \0-\0-\0g\0i\0t\0';
    assert.equal(isUtf16Encoded(utf16Content), true);
});

test('isUtf16Encoded returns false for normal UTF-8', () => {
    const utf8Content = 'diff --git a/README.md b/README.md';
    assert.equal(isUtf16Encoded(utf8Content), false);
});

test('isUtf16Encoded returns false for empty content', () => {
    assert.equal(isUtf16Encoded(''), false);
});

test('isUtf16Encoded handles content with some null bytes but below threshold', () => {
    // Less than 20% null bytes should not be detected as UTF-16
    const content = 'normal text with a few\0null\0bytes';
    assert.equal(isUtf16Encoded(content), false);
});

// ============================================================================
// UTF-16 Conversion Tests
// ============================================================================

test('convertUtf16ToUtf8 removes null bytes', () => {
    const input = 'd\0i\0f\0f\0';
    const result = convertUtf16ToUtf8(input);
    assert.equal(result, 'diff');
});

test('convertUtf16ToUtf8 removes BOM markers', () => {
    const inputWithBom = '\uFEFFdiff --git';
    const result = convertUtf16ToUtf8(inputWithBom);
    assert.equal(result, 'diff --git');
});

test('convertUtf16ToUtf8 removes replacement characters', () => {
    const inputWithReplacement = '\uFFFD\uFFFDdiff --git';
    const result = convertUtf16ToUtf8(inputWithReplacement);
    assert.equal(result, 'diff --git');
});

test('convertUtf16ToUtf8 handles multiple BOM/replacement chars', () => {
    const input = '\uFFFD\uFEFF\uFFFD\uFFFEtext';
    const result = convertUtf16ToUtf8(input);
    assert.equal(result, 'text');
});

test('convertUtf16ToUtf8 preserves normal content', () => {
    const normalContent = 'diff --git a/file.ts b/file.ts';
    const result = convertUtf16ToUtf8(normalContent);
    assert.equal(result, normalContent);
});

// ============================================================================
// Patch Content Detection Tests
// ============================================================================

test('isPatchContent detects diff --git prefix', () => {
    const content = 'diff --git a/README.md b/README.md\nindex 123..456 100644';
    assert.equal(isPatchContent(content), true);
});

test('isPatchContent detects --- prefix', () => {
    const content = '--- a/file.ts\n+++ b/file.ts';
    assert.equal(isPatchContent(content), true);
});

test('isPatchContent detects diff --git in middle of content', () => {
    const content = 'Some header text\ndiff --git a/file.ts b/file.ts';
    assert.equal(isPatchContent(content), true);
});

test('isPatchContent detects --- a/ pattern', () => {
    const content = 'Header\n--- a/original.ts\n+++ b/modified.ts';
    assert.equal(isPatchContent(content), true);
});

test('isPatchContent returns false for non-patch content', () => {
    const normalCode = 'const x = 1;\nfunction test() {}';
    assert.equal(isPatchContent(normalCode), false);
});

test('isPatchContent returns false for empty content', () => {
    assert.equal(isPatchContent(''), false);
});

// ============================================================================
// Binary Patch Cleaning Tests
// ============================================================================

test('cleanPatchContent removes single binary section', () => {
    const patchWithBinary = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title
+New line
diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
GIT binary patch
literal 12345
zcmV;B1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz
zcmV;B1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz

diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const app = express();
+app.use(cors());`;

    const result = cleanPatchContent(patchWithBinary);

    assert.ok(result.includes('diff --git a/README.md'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(result.includes('diff --git a/src/app.ts'));
    assert.ok(!result.includes('zcmV;B1234567890'));
    assert.ok(!result.includes('literal 12345'));
});

test('cleanPatchContent removes multiple binary sections', () => {
    const patchWithMultipleBinaries = `diff --git a/file1.png b/file1.png
GIT binary patch
literal 1000
zBinaryData1111111111

diff --git a/file2.jpg b/file2.jpg
GIT binary patch
literal 2000
zBinaryData2222222222

diff --git a/src/code.ts b/src/code.ts
--- a/src/code.ts
+++ b/src/code.ts
@@ -1 +1,2 @@
 export const x = 1;
+export const y = 2;`;

    const result = cleanPatchContent(patchWithMultipleBinaries);

    // Should have two [Binary file patch omitted] markers
    const binaryMarkerCount = (result.match(/\[Binary file patch omitted\]/g) || []).length;
    assert.equal(binaryMarkerCount, 2);

    // Should still have the code diff
    assert.ok(result.includes('export const y = 2'));
    assert.ok(!result.includes('zBinaryData'));
});

test('cleanPatchContent preserves patch without binary sections', () => {
    const normalPatch = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+import cors from 'cors';
 
 const app = express();
+app.use(cors());`;

    const result = cleanPatchContent(normalPatch);
    assert.equal(result, normalPatch);
});

test('cleanPatchContent handles empty content', () => {
    assert.equal(cleanPatchContent(''), '');
});

test('cleanPatchContent handles UTF-16 encoded patch', () => {
    // Simulate UTF-16 LE encoded "diff --git" with null bytes
    const utf16Patch = 'd\0i\0f\0f\0 \0-\0-\0g\0i\0t\0 \0a\0/\0f\0i\0l\0e\0.\0t\0s\0';
    const result = cleanPatchContent(utf16Patch);
    assert.equal(result, 'diff --git a/file.ts');
});

test('cleanPatchContent handles binary section at end of patch', () => {
    const patchEndingWithBinary = `diff --git a/code.ts b/code.ts
--- a/code.ts
+++ b/code.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/image.png b/image.png
GIT binary patch
literal 5000
zEndBinaryDataHere123456789`;

    const result = cleanPatchContent(patchEndingWithBinary);
    
    assert.ok(result.includes('const y = 2'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('zEndBinaryDataHere'));
});

// ============================================================================
// Complex Patch Scenarios
// ============================================================================

test('cleanPatchContent handles realistic large patch with mixed content', () => {
    const complexPatch = `From abc123 Mon Sep 17 00:00:00 2001
From: Developer <dev@example.com>
Date: Mon, 1 Jan 2024 12:00:00 +0000
Subject: [PATCH] Add authentication feature

diff --git a/README.md b/README.md
index 87e6ca8..7889974 100644
--- a/README.md
+++ b/README.md
@@ -1,5 +1,6 @@
 # My Project
 
+## Authentication
 This project includes authentication.

diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..abcdef1
GIT binary patch
literal 31597
zcmeFZcT\`kQ+bsx!<RD2hC@3H~Ne(I?AW=YajV^T(HqZi+LkmbFnjjKYBudUr&XPkD
z1saJ>P7U-u{N8Wg\`\`!8O%$jv){+r8MO\`lWo)Kg

diff --git a/src/auth/login.ts b/src/auth/login.ts
new file mode 100644
index 0000000..fedcba9
--- /dev/null
+++ b/src/auth/login.ts
@@ -0,0 +1,15 @@
+import { validateCredentials } from './validate';
+
+export async function login(username: string, password: string) {
+  const isValid = await validateCredentials(username, password);
+  if (!isValid) {
+    throw new Error('Invalid credentials');
+  }
+  return generateToken(username);
+}

diff --git a/assets/icons/user.svg b/assets/icons/user.svg
new file mode 100644
index 0000000..123abc4
GIT binary patch
literal 1024
zSVGBinaryContentHere

diff --git a/src/auth/validate.ts b/src/auth/validate.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/validate.ts
@@ -0,0 +1,8 @@
+export async function validateCredentials(
+  username: string,
+  password: string
+): Promise<boolean> {
+  // Validate against database
+  return true;
+}
-- 
2.34.1`;

    const result = cleanPatchContent(complexPatch);

    // Should preserve all text diffs
    assert.ok(result.includes('## Authentication'));
    assert.ok(result.includes('export async function login'));
    assert.ok(result.includes('export async function validateCredentials'));

    // Should mark binary sections
    const binaryMarkerCount = (result.match(/\[Binary file patch omitted\]/g) || []).length;
    assert.equal(binaryMarkerCount, 2);

    // Should not contain binary data
    assert.ok(!result.includes('zcmeFZcT'));
    assert.ok(!result.includes('zSVGBinaryContentHere'));

    // Significant size reduction expected
    assert.ok(result.length < complexPatch.length);
});

test('cleanPatchContent preserves hunk headers and context', () => {
    const patch = `diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,7 +10,8 @@ function existingFunction() {
   return true;
 }
 
-function oldFunction() {
+function newFunction() {
+  // Added comment
   return false;
 }`;

    const result = cleanPatchContent(patch);

    assert.ok(result.includes('@@ -10,7 +10,8 @@'));
    assert.ok(result.includes('function existingFunction'));
    assert.ok(result.includes('-function oldFunction'));
    assert.ok(result.includes('+function newFunction'));
    assert.ok(result.includes('+  // Added comment'));
});

// ============================================================================
// Edge Cases
// ============================================================================

test('cleanPatchContent handles "GIT binary patch" appearing in code comment', () => {
    const patchWithComment = `diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,3 +1,5 @@
 # Documentation
 
+Note: If you see "GIT binary patch" in a diff, it means the file is binary.
+
 ## Getting Started`;

    const result = cleanPatchContent(patchWithComment);

    // The line starting with + contains "GIT binary patch" but it's not at line start
    // So it should be preserved (the detection looks for line.startsWith)
    assert.ok(result.includes('GIT binary patch'));
    assert.ok(result.includes('## Getting Started'));
});

test('cleanPatchContent handles consecutive diff headers', () => {
    const patch = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old2
+new2`;

    const result = cleanPatchContent(patch);
    assert.ok(result.includes('diff --git a/file1.ts'));
    assert.ok(result.includes('diff --git a/file2.ts'));
    assert.ok(result.includes('+new'));
    assert.ok(result.includes('+new2'));
});

test('cleanPatchContent handles patch with only binary files', () => {
    const binaryOnlyPatch = `diff --git a/image1.png b/image1.png
GIT binary patch
literal 1000
zBinaryData1

diff --git a/image2.png b/image2.png
GIT binary patch
literal 2000
zBinaryData2`;

    const result = cleanPatchContent(binaryOnlyPatch);

    // Should have markers but be much smaller
    const binaryMarkerCount = (result.match(/\[Binary file patch omitted\]/g) || []).length;
    assert.equal(binaryMarkerCount, 2);
    assert.ok(!result.includes('zBinaryData'));
});

test('cleanPatchContent handles Windows line endings (CRLF)', () => {
    const patchWithCRLF = 'diff --git a/file.ts b/file.ts\r\n--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1,2 @@\r\n const x = 1;\r\n+const y = 2;\r\n';
    const result = cleanPatchContent(patchWithCRLF);

    assert.ok(result.includes('const x = 1'));
    assert.ok(result.includes('const y = 2'));
});

// ============================================================================
// Performance / Size Reduction Tests
// ============================================================================

test('cleanPatchContent significantly reduces size for binary-heavy patches', () => {
    // Create a patch with a large binary section
    const binaryData = 'z' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'.repeat(100);
    const largePatch = `diff --git a/src/code.ts b/src/code.ts
--- a/src/code.ts
+++ b/src/code.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/large-image.png b/large-image.png
GIT binary patch
literal 100000
${binaryData}
${binaryData}
${binaryData}

diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-old
+new`;

    const result = cleanPatchContent(largePatch);

    // Should achieve significant size reduction
    const sizeReduction = 1 - (result.length / largePatch.length);
    assert.ok(sizeReduction > 0.5, `Expected >50% reduction, got ${(sizeReduction * 100).toFixed(1)}%`);

    // Should preserve actual code changes
    assert.ok(result.includes('const y = 2'));
    assert.ok(result.includes('+new'));
});

// ============================================================================
// Integration-style Tests
// ============================================================================

test('full preprocessing pipeline handles UTF-16 patch with binary data', () => {
    // Simulate a UTF-16 encoded patch with binary content
    const simulatedUtf16 = (str: string) => str.split('').map(c => c + '\0').join('');

    const originalPatch = `diff --git a/code.ts b/code.ts
--- a/code.ts
+++ b/code.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/img.png b/img.png
GIT binary patch
literal 500
zBinaryContent123`;

    const utf16Encoded = '\uFEFF' + simulatedUtf16(originalPatch);
    const result = cleanPatchContent(utf16Encoded);

    // Should handle both UTF-16 conversion AND binary removal
    assert.ok(result.includes('const y = 2'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('zBinaryContent'));
    assert.ok(!result.includes('\0'));
});

// ============================================================================
// preprocessContent Tests
// ============================================================================

test('preprocessContent processes .patch files', () => {
    const patchContent = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/image.png b/image.png
GIT binary patch
literal 1000
zBinaryData`;

    const result = preprocessContent('changes.patch', patchContent);

    assert.ok(result.includes('const y = 2'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('zBinaryData'));
});

test('preprocessContent processes .diff files', () => {
    const diffContent = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 import express from 'express';
+import cors from 'cors';`;

    const result = preprocessContent('update.diff', diffContent);
    assert.ok(result.includes("import cors from 'cors'"));
});

test('preprocessContent auto-detects patch content regardless of extension', () => {
    const patchContent = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;`;

    // Even with .txt extension, should detect patch content
    const result = preprocessContent('changes.txt', patchContent);
    assert.equal(result, patchContent); // No binary to remove, should be unchanged
});

test('preprocessContent leaves non-patch files unchanged', () => {
    const jsContent = `const x = 1;
function test() {
  return x + 1;
}`;

    const result = preprocessContent('code.js', jsContent);
    assert.equal(result, jsContent);
});

test('preprocessContent handles .PATCH uppercase extension', () => {
    const patchContent = `diff --git a/file.ts b/file.ts
GIT binary patch
literal 500
zData`;

    const result = preprocessContent('changes.PATCH', patchContent);
    assert.ok(result.includes('[Binary file patch omitted]'));
});

test('preprocessContent handles mixed case .Diff extension', () => {
    const diffContent = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;

    const result = preprocessContent('update.Diff', diffContent);
    assert.ok(result.includes('+new'));
});

test('preprocessContent handles empty patch file', () => {
    const result = preprocessContent('empty.patch', '');
    assert.equal(result, '');
});

test('preprocessContent handles patch with UTF-16 encoding via extension', () => {
    const simulatedUtf16 = (str: string) => str.split('').map(c => c + '\0').join('');
    const content = simulatedUtf16('diff --git a/f.ts b/f.ts\n+new line');

    const result = preprocessContent('update.patch', content);
    assert.ok(result.includes('diff --git'));
    assert.ok(result.includes('+new line'));
    assert.ok(!result.includes('\0'));
});

// ============================================================================
// FilteredFilesystem Encoding Functions Tests
// ============================================================================

test('normalizeEncoding converts UTF-16 to UTF-8', () => {
    const utf16Content = 'h\0e\0l\0l\0o\0';
    const result = normalizeEncoding(utf16Content);
    assert.equal(result, 'hello');
});

test('normalizeEncoding removes UTF-8 BOM', () => {
    const contentWithBom = '\uFEFFhello world';
    const result = normalizeEncoding(contentWithBom);
    assert.equal(result, 'hello world');
});

test('normalizeEncoding preserves normal content', () => {
    const normalContent = 'hello world';
    const result = normalizeEncoding(normalContent);
    assert.equal(result, normalContent);
});

test('cleanPatchBinaryData removes binary sections', () => {
    const patchWithBinary = `diff --git a/code.ts b/code.ts
--- a/code.ts
+++ b/code.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/image.png b/image.png
GIT binary patch
literal 1000
zBinaryData`;

    const result = cleanPatchBinaryData(patchWithBinary);
    assert.ok(result.includes('const y = 2'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('zBinaryData'));
});

test('preprocessFileContent handles UTF-16 encoded patch file', () => {
    const simulatedUtf16 = (str: string) => str.split('').map(c => c + '\0').join('');
    const patchContent = `diff --git a/file.ts b/file.ts
GIT binary patch
literal 500
zData`;

    const utf16Encoded = simulatedUtf16(patchContent);
    const result = preprocessFileContent('changes.patch', utf16Encoded);

    assert.ok(result.includes('diff --git'));
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('\0'));
    assert.ok(!result.includes('zData'));
});

test('preprocessFileContent normalizes encoding for non-patch files', () => {
    // Simulate UTF-16 LE encoding for "const x = 1;"
    const simulatedUtf16 = (str: string) => str.split('').map(c => c + '\0').join('');
    const utf16Js = simulatedUtf16('const x = 1;');
    const result = preprocessFileContent('code.js', utf16Js);
    assert.equal(result, 'const x = 1;');
});

test('preprocessFileContent auto-detects patch content in .txt file', () => {
    const patchInTxt = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/img.png b/img.png
GIT binary patch
literal 100
zBinary`;

    const result = preprocessFileContent('changes.txt', patchInTxt);
    assert.ok(result.includes('[Binary file patch omitted]'));
    assert.ok(!result.includes('zBinary'));
});

// ============================================================================
// Real-world Patch File Tests
// ============================================================================

test('processes real patch file from workspace if it exists', () => {
    const patchPath = path.join(__dirname, '../workspace/submission/topcoder-auth-implementation.patch');

    // Skip if file doesn't exist
    if (!fs.existsSync(patchPath)) {
        return;
    }

    const rawContent = fs.readFileSync(patchPath, 'utf-8');
    const originalSize = rawContent.length;

    // Should detect as UTF-16 (the actual file has null bytes)
    const isUtf16 = isUtf16Encoded(rawContent);
    assert.equal(isUtf16, true, 'Real patch file should be detected as UTF-16');

    // Process through the full pipeline
    const processed = preprocessContent('topcoder-auth-implementation.patch', rawContent);

    // Should achieve significant size reduction
    const sizeReduction = ((originalSize - processed.length) / originalSize) * 100;
    assert.ok(sizeReduction > 50, `Expected >50% size reduction, got ${sizeReduction.toFixed(1)}%`);

    // Should contain actual diff content
    assert.ok(processed.includes('diff --git'), 'Should contain diff headers');
    assert.ok(processed.includes('README.md'), 'Should contain README.md changes');

    // Should have cleaned binary sections
    assert.ok(processed.includes('[Binary file patch omitted]'), 'Should have binary markers');

    // Should not contain null bytes or binary data
    assert.ok(!processed.includes('\0'), 'Should not contain null bytes');

    // Log stats for visibility during test runs
    console.log(`  Real patch file: ${originalSize} -> ${processed.length} bytes (${sizeReduction.toFixed(1)}% reduction)`);
});
