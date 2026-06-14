/**
 * Per-thread state store.
 *
 * Mastra agent instances (and their inputProcessors/outputProcessors arrays)
 * are constructed ONCE and reused across every `agent.generate()` call -
 * including every requirement in a `requirementsAnalyzerWorkflow` run, each
 * of which uses a distinct `threadId`
 * (`${challengeId}-req-${requirement.id}-${SUBMISSION_ID}-${Date.now()}`,
 * see workflows/requirements-analyzer.ts).
 *
 * Without per-thread isolation, a stateful guardrail (tracking search/read
 * history, verified paths, etc. as plain instance fields) would leak state
 * between DIFFERENT requirements - e.g. REQ_02's report could be validated
 * against files read while analyzing REQ_01, or a MISSING verdict for REQ_05
 * could be auto-accepted because REQ_01 already satisfied the search-count
 * minimum. This directly violates the "one requirement per agent thread,
 * agent should not mix requirements evaluations" constraint.
 *
 * `RunStateStore<T>` gives each guardrail a `Map<threadId, T>` with simple
 * LRU-ish eviction (oldest-accessed entries dropped once `maxEntries` is
 * exceeded) so long-running processes (the Mastra dev server, handling many
 * workflow runs over time) don't leak memory indefinitely.
 */

export class RunStateStore<T> {
    private states = new Map<string, T>();
    private lastAccess = new Map<string, number>();
    private readonly maxEntries: number;
    private readonly factory: () => T;

    constructor(factory: () => T, maxEntries = 200) {
        this.factory = factory;
        this.maxEntries = maxEntries;
    }

    /** Get (creating if absent) the state for a given threadId. */
    get(threadId: string): T {
        let state = this.states.get(threadId);
        if (!state) {
            state = this.factory();
            this.states.set(threadId, state);
            this.evictIfNeeded();
        }
        this.lastAccess.set(threadId, Date.now());
        return state;
    }

    /** Explicitly clear state for a threadId (e.g. on run completion). */
    clear(threadId: string): void {
        this.states.delete(threadId);
        this.lastAccess.delete(threadId);
    }

    private evictIfNeeded(): void {
        if (this.states.size <= this.maxEntries) return;

        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, time] of this.lastAccess) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            this.states.delete(oldestKey);
            this.lastAccess.delete(oldestKey);
        }
    }
}

/**
 * Extract a stable per-run key from a processor's args. Prefers
 * `requestContext.threadId` (set per-requirement by the workflow); falls
 * back to `resourceId`, then to a constant ("default") for contexts where
 * neither is set (e.g. ad-hoc chat sessions in the studio UI - in that case
 * all state is shared for the session, which matches the "one requirement
 * per thread" expectation for manual single-requirement testing).
 *
 * RequestContext is a Map-like class with a .get(key) method, not a plain
 * object. We also accept plain objects (used in unit tests).
 */
export function getRunKey(args: { requestContext?: unknown }): string {
    const ctx = args.requestContext;
    if (!ctx) return 'default';

    // Real RequestContext from @mastra/core: Map-like class with .get(key)
    if (typeof (ctx as any).get === 'function') {
        const rc = ctx as { get: (key: string) => string | undefined };
        return rc.get('mastra__threadId') || rc.get('mastra__resourceId') || 'default';
    }

    // Plain-object fallback used in unit tests
    const plain = ctx as { threadId?: string; resourceId?: string };
    return plain.threadId || plain.resourceId || 'default';
}
