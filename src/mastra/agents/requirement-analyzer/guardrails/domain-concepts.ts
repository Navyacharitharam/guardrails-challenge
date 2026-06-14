/**
 * Shared domain-concept → literal-code-pattern synonym table.
 *
 * SINGLE SOURCE OF TRUTH: this table backs BOTH:
 *  - The "Search for CODE PATTERNS, not just concepts" table rendered into
 *    AGENT_INSTRUCTIONS (instructions.ts) - what the MODEL is told to search for.
 *  - DOMAIN_SYNONYMS in false-negative-guardrail.ts - what the GUARDRAIL
 *    checks the model actually searched for.
 *
 * Keeping these in one place means the guardrail can never drift out of sync
 * with what the prompt promises, and adding a new domain concept only
 * requires editing this one file.
 */

export interface DomainConceptEntry {
    /** Human-readable concept name, used as the table row label. */
    concept: string;
    /** A "bad" semantic-only search phrase the agent should AVOID. */
    badExample: string;
    /** Literal code-pattern synonyms the agent SHOULD search for instead. */
    patterns: string[];
}

export const DOMAIN_CONCEPTS: DomainConceptEntry[] = [
    { concept: 'Database indexing', badExample: 'indexing strategy', patterns: ['Index(', 'index=True', 'create_index', 'CREATE INDEX'] },
    { concept: 'Error handling', badExample: 'error handling approach', patterns: ['try', 'catch', 'except', 'rescue', 'error_handler'] },
    { concept: 'Caching', badExample: 'caching mechanism', patterns: ['@cache', 'Redis', 'lru_cache', 'memcached'] },
    { concept: 'Validation', badExample: 'input validation', patterns: ['validate', 'validator', 'Zod', 'yup', 'Pydantic', 'schema'] },
    { concept: 'Rate limiting', badExample: 'rate limiting', patterns: ['ratelimit', 'rate_limit', 'throttle', '@RateLimit'] },
    { concept: 'Authentication', badExample: 'auth strategy', patterns: ['jwt', 'OAuth', '@authenticated', 'passport', 'auth', 'login', 'session'] },
    { concept: 'Authorization', badExample: 'permission strategy', patterns: ['authorize', 'permission', 'role', 'rbac', 'policy', 'acl'] },
    { concept: 'Logging', badExample: 'logging implementation', patterns: ['logger.', 'console.log', 'logging.info'] },
    { concept: 'Multi-tenancy', badExample: 'tenant isolation', patterns: ['tenantId', 'TenantContext', 'rls', 'row level security', 'tenant'] },
    { concept: 'Database security', badExample: 'access control', patterns: ['policy', 'RLS', 'row level', 'ENABLE ROW LEVEL'] },
    { concept: 'Seed/demo data', badExample: 'demo environment', patterns: ['seed', 'seed-data', 'fixtures', 'demo', 'sample-data'] },
    { concept: 'Automated tests', badExample: 'tests exist', patterns: ['.test.', '.spec.', 'describe(', 'test(', 'pytest', 'unittest'] },
    { concept: 'Migration', badExample: 'schema migration approach', patterns: ['migration', 'migrate', 'alembic', 'prisma migrate'] },
    { concept: 'Queue/async jobs', badExample: 'async job processing', patterns: ['queue', 'kafka', 'rabbitmq', 'sqs', 'celery', 'arq'] },
    { concept: 'Webhooks', badExample: 'webhook handling', patterns: ['webhook', 'callback', 'hook'] },
    { concept: 'Retry/backoff', badExample: 'retry strategy', patterns: ['retry', 'backoff', 'exponential', 'tenacity'] },
    { concept: 'Pagination', badExample: 'pagination support', patterns: ['paginate', 'pagination', 'cursor', 'offset', 'limit'] },
    { concept: 'Notifications', badExample: 'notification system', patterns: ['notify', 'notification', 'email', 'sms', 'push'] },
    { concept: 'Agent prompts', badExample: 'agent instructions', patterns: ['PROMPT', 'system_prompt', 'prompt_template', 'AGENT_INSTRUCTIONS', 'instruction'] },
    { concept: 'Performance metrics', badExample: 'cost and latency', patterns: ['cost', 'latency', 'measured', 'p50', 'p95', 'benchmark', 'duration_ms'] },
    { concept: 'AI model config', badExample: 'model settings', patterns: ['model', 'temperature', 'max_tokens', 'llm', 'claude', 'gpt', 'anthropic', 'openai'] },
    { concept: 'Feature flags', badExample: 'feature toggles', patterns: ['feature_flag', 'featureFlag', 'toggle', 'FEATURE_', 'isEnabled'] },
    { concept: 'Configuration', badExample: 'app config', patterns: ['.env', 'config.ts', 'settings', 'CONFIG', 'dotenv', 'process.env'] },
    { concept: 'Type definitions', badExample: 'type system', patterns: ['interface ', 'type ', 'enum ', 'z.object', 'zod', 'schema'] },
];

/**
 * Render DOMAIN_CONCEPTS as the markdown table used in AGENT_INSTRUCTIONS.
 * Replace the static "Search for CODE PATTERNS" table in instructions.ts
 * with `${renderDomainConceptsTable()}`.
 */
export function renderDomainConceptsTable(): string {
    const header = '| Concept | BAD (semantic) | GOOD (literal code pattern) |\n|---------|----------------|----------------------------|';
    const rows = DOMAIN_CONCEPTS.map(
        e => `| ${e.concept} | "${e.badExample}" | ${e.patterns.map(p => `"${p}"`).join(', ')} |`
    );
    return [header, ...rows].join('\n');
}

/**
 * Build a lowercase concept-keyword -> synonym-patterns lookup for the
 * False-Negative Guardrail. Concept names and any individual words within
 * them are usable as match keys against requirement text.
 */
export function buildSynonymLookup(): Record<string, string[]> {
    const lookup: Record<string, string[]> = {};
    for (const entry of DOMAIN_CONCEPTS) {
        const key = entry.concept.toLowerCase();
        lookup[key] = entry.patterns;
        // Also index by simplified single-word forms, e.g. "multi-tenancy" -> "tenant"
        for (const word of key.split(/[\s/-]+/)) {
            if (word.length > 3 && !lookup[word]) {
                lookup[word] = entry.patterns;
            }
        }
    }
    return lookup;
}
