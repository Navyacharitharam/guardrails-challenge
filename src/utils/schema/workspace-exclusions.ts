import { z } from 'zod';

/**
 * Categories of exclusion patterns for workspace file tree filtering.
 * Each category groups related patterns that can be toggled together.
 */
export const ExclusionCategory = {
    SYSTEM: 'system',
    IDE: 'ide',
    DEPENDENCIES: 'dependencies',
    BUILD_ARTIFACTS: 'buildArtifacts',
    TEST_OUTPUTS: 'testOutputs',
} as const;

export type ExclusionCategoryType = (typeof ExclusionCategory)[keyof typeof ExclusionCategory];

/**
 * Default exclusion patterns organized by category.
 * These patterns follow glob-like syntax with support for:
 * - Exact matches: 'node_modules'
 * - Directory wildcards: 'node_modules/**'
 * - Prefix patterns: '._*' (files starting with ._ )
 * - Extension patterns: '*.pyc'
 */
export const DEFAULT_EXCLUSION_PATTERNS: Record<ExclusionCategoryType, string[]> = {
    // Always excluded - system/metadata files that should never be reviewed
    [ExclusionCategory.SYSTEM]: [
        // macOS
        '__MACOSX',
        '__MACOSX/**',
        '._*',
        '.DS_Store',
        '.AppleDouble',
        '.LSOverride',
        // Windows
        'Thumbs.db',
        'Thumbs.db:encryptable',
        'ehthumbs.db',
        'ehthumbs_vista.db',
        'desktop.ini',
        '[Dd]esktop.ini',
        // Linux
        '.directory',
        '*~',
        // Version control
        '.git',
        '.git/**',
        '.svn',
        '.svn/**',
        '.hg',
        '.hg/**',
        '.bzr',
        '.bzr/**',
        // Temporary files
        '*.tmp',
        '*.temp',
        '*.bak',
        '*.backup',
        '*.orig',
    ],

    // IDE and editor configuration files
    [ExclusionCategory.IDE]: [
        // JetBrains
        '.idea',
        '.idea/**',
        '*.iml',
        '*.ipr',
        '*.iws',
        // VS Code
        '.vscode',
        '.vscode/**',
        '*.code-workspace',
        // Visual Studio
        '.vs',
        '.vs/**',
        '*.suo',
        '*.user',
        '*.userosscache',
        '*.sln.docstates',
        // Vim/Neovim
        '*.swp',
        '*.swo',
        '*.swn',
        '.netrwhist',
        // Emacs
        '*~',
        '\\#*\\#',
        '.\\#*',
        // Sublime Text
        '*.sublime-workspace',
        '*.sublime-project',
        // Eclipse
        '.project',
        '.classpath',
        '.settings',
        '.settings/**',
    ],

    // Package manager dependencies
    [ExclusionCategory.DEPENDENCIES]: [
        // JavaScript/Node.js
        'node_modules',
        'node_modules/**',
        '.npm',
        '.yarn',
        '.pnpm-store',
        'bower_components',
        'bower_components/**',
        'jspm_packages',
        // Python
        '.venv',
        '.venv/**',
        'venv',
        'venv/**',
        'env',
        'env/**',
        '.env.local',
        '__pycache__',
        '__pycache__/**',
        '*.py[cod]',
        '*$py.class',
        '.Python',
        '*.egg',
        '*.egg-info',
        '*.egg-info/**',
        '.eggs',
        '.eggs/**',
        'pip-wheel-metadata',
        // Ruby
        'vendor/bundle',
        'vendor/bundle/**',
        '.bundle',
        // PHP
        'vendor',
        'vendor/**',
        // Go
        'go/pkg',
        // Rust
        '.cargo',
        '.cargo/**',
        // iOS/macOS
        'Pods',
        'Pods/**',
        'Carthage/Build',
        // .NET
        'packages',
        'packages/**',
    ],

    // Build outputs and compiled artifacts
    [ExclusionCategory.BUILD_ARTIFACTS]: [
        // Generic
        'dist',
        'dist/**',
        'build',
        'build/**',
        'out',
        'out/**',
        'output',
        'output/**',
        'bin',
        'bin/**',
        'obj',
        'obj/**',
        'lib',
        // JavaScript/TypeScript
        '.next',
        '.next/**',
        '.nuxt',
        '.nuxt/**',
        '.output',
        '.output/**',
        '.cache',
        '.cache/**',
        '.parcel-cache',
        '.parcel-cache/**',
        '.turbo',
        '.turbo/**',
        '.vercel',
        '.vercel/**',
        '.netlify',
        // Java/JVM
        'target',
        'target/**',
        '*.class',
        '*.jar',
        '*.war',
        '*.ear',
        // .NET
        'bin/Debug',
        'bin/Debug/**',
        'bin/Release',
        'bin/Release/**',
        // Native
        '*.o',
        '*.obj',
        '*.so',
        '*.dylib',
        '*.dll',
        '*.exe',
        '*.out',
        '*.a',
        '*.lib',
        // Rust
        'target/debug',
        'target/debug/**',
        'target/release',
        'target/release/**',
        // Generated
        '*.min.js',
        '*.min.css',
        '*.map',
        '*.generated.*',
    ],

    // Test and coverage outputs
    [ExclusionCategory.TEST_OUTPUTS]: [
        'coverage',
        'coverage/**',
        '.nyc_output',
        '.nyc_output/**',
        'htmlcov',
        'htmlcov/**',
        '.coverage',
        '.coverage.*',
        '.pytest_cache',
        '.pytest_cache/**',
        '.mypy_cache',
        '.mypy_cache/**',
        '.tox',
        '.tox/**',
        '.nox',
        '.nox/**',
        'test-results',
        'test-results/**',
        'test-reports',
        'test-reports/**',
        '*.lcov',
        'junit.xml',
        'junit-*.xml',
    ],
};

/**
 * Get all default exclusion patterns as a flat array.
 */
export function getAllDefaultExclusionPatterns(): string[] {
    return Object.values(DEFAULT_EXCLUSION_PATTERNS).flat();
}

/**
 * Get exclusion patterns for specific categories.
 */
export function getExclusionPatternsForCategories(categories: ExclusionCategoryType[]): string[] {
    const patterns: string[] = [];
    for (const category of categories) {
        const categoryPatterns = DEFAULT_EXCLUSION_PATTERNS[category];
        if (categoryPatterns) {
            patterns.push(...categoryPatterns);
        }
    }
    return [...new Set(patterns)]; // Dedupe
}

/**
 * Zod schema for exclusion configuration in workflow inputs.
 */
export const exclusionCategorySchema = z.enum([
    ExclusionCategory.SYSTEM,
    ExclusionCategory.IDE,
    ExclusionCategory.DEPENDENCIES,
    ExclusionCategory.BUILD_ARTIFACTS,
    ExclusionCategory.TEST_OUTPUTS,
]);

export const workspaceExclusionConfigSchema = z.object({
    /** Custom glob patterns to exclude (in addition to category defaults) */
    customPatterns: z.array(z.string()).optional().default([]),

    /** Which default categories to apply. Defaults to all categories. */
    categories: z
        .array(exclusionCategorySchema)
        .optional()
        .default([
            ExclusionCategory.SYSTEM,
            ExclusionCategory.IDE,
            ExclusionCategory.DEPENDENCIES,
            ExclusionCategory.BUILD_ARTIFACTS,
            ExclusionCategory.TEST_OUTPUTS,
        ]),

    /** If true, completely skip excluded paths. If false, include in tree but mark as excluded. */
    skipExcluded: z.boolean().optional().default(true),

    /** Patterns to explicitly include even if they match exclusion patterns */
    includeOverrides: z.array(z.string()).optional().default([]),
});

export type WorkspaceExclusionConfig = z.infer<typeof workspaceExclusionConfigSchema>;

/**
 * Build the final list of exclusion patterns from a config object.
 */
export function buildExclusionPatterns(config: WorkspaceExclusionConfig): string[] {
    const categoryPatterns = getExclusionPatternsForCategories(config.categories);
    const allPatterns = [...categoryPatterns, ...config.customPatterns];
    return [...new Set(allPatterns)];
}
