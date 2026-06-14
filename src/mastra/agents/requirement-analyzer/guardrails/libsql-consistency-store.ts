/**
 * LibSQL-backed ConsistencyStore implementation.
 *
 * Persists (fingerprint -> StoredResult) rows so consistency checks survive
 * process restarts and so the resulting .db file can be included in the
 * submission's LibSQLStore artifacts as required by the challenge.
 *
 * Usage:
 * ```ts
 * import { LibSQLStore } from '@mastra/libsql';
 * import { LibSQLConsistencyStore } from './libsql-consistency-store';
 *
 * const consistencyStore = new LibSQLConsistencyStore(
 *   new LibSQLStore({ id: 'requirement-analyzer-consistency', url: 'file:./requirement-analyzer-consistency.db' })
 * );
 * await consistencyStore.init();
 *
 * const guardrail = new ResultConsistencyGuardrail({}, consistencyStore);
 * ```
 */

import type { LibSQLStore } from '@mastra/libsql';
import type { ConsistencyStore, StoredResult } from './result-consistency-guardrail';
import { tcAILogger } from '../../../../utils/logger';

const TABLE_NAME = 'requirement_consistency_results';

export class LibSQLConsistencyStore implements ConsistencyStore {
    private store: LibSQLStore;
    private initialized = false;
    private client: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows?: unknown[] }> } | null = null;

    constructor(store: LibSQLStore) {
        this.store = store;
    }

    /** Create the backing table if it doesn't exist. Call once at startup. */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        // Access the underlying libsql client. LibSQLStore exposes it as `.client`
        // (public in practice, though not in the type declaration). We try it and
        // fall back to a safe no-op if the internal structure has changed.
        try {
            const rawStore = this.store as unknown as {
                client?: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows?: unknown[] }> };
                db?: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows?: unknown[] }> };
            };
            const client = rawStore.client || rawStore.db;
            if (!client) {
                tcAILogger.warn('[LibSQLConsistencyStore] No raw client found on LibSQLStore - consistency will be in-memory only');
                return;
            }
            this.client = client;

            await client.execute(`
                CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                    fingerprint TEXT PRIMARY KEY,
                    verdict TEXT NOT NULL,
                    coverage_score REAL NOT NULL,
                    constraint_statuses TEXT NOT NULL,
                    sample_count INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
            `);
            tcAILogger.debug(`[LibSQLConsistencyStore] Table \${TABLE_NAME} ready`);
        } catch (err) {
            tcAILogger.warn(`[LibSQLConsistencyStore] init() failed - consistency in-memory only: \${err}`);
        }
    }

    async get(fingerprint: string): Promise<StoredResult | undefined> {
        await this.init();
        if (!this.client) return undefined;

        try {
            const result = await this.client.execute({
                sql: `SELECT verdict, coverage_score, constraint_statuses, sample_count, updated_at FROM ${TABLE_NAME} WHERE fingerprint = ?`,
                args: [fingerprint],
            });

            const row = result.rows?.[0] as Record<string, unknown> | undefined;
            if (!row) return undefined;

            return {
                verdict: row.verdict as StoredResult['verdict'],
                coverageScore: row.coverage_score as number,
                constraintStatuses: JSON.parse(row.constraint_statuses as string),
                sampleCount: row.sample_count as number,
                updatedAt: row.updated_at as number,
            };
        } catch (err) {
            tcAILogger.warn(`[LibSQLConsistencyStore] get() failed: \${err}`);
            return undefined;
        }
    }

    async set(fingerprint: string, result: StoredResult): Promise<void> {
        await this.init();
        if (!this.client) return;

        try {
        await this.client.execute({
            sql: `
                INSERT INTO ${TABLE_NAME} (fingerprint, verdict, coverage_score, constraint_statuses, sample_count, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    verdict = excluded.verdict,
                    coverage_score = excluded.coverage_score,
                    constraint_statuses = excluded.constraint_statuses,
                    sample_count = excluded.sample_count,
                    updated_at = excluded.updated_at
            `,
            args: [
                fingerprint,
                result.verdict,
                result.coverageScore,
                JSON.stringify(result.constraintStatuses),
                result.sampleCount,
                result.updatedAt,
            ],
        });
        } catch (err) {
            tcAILogger.warn(`[LibSQLConsistencyStore] set() failed: ${err}`);
        }
    }
}
