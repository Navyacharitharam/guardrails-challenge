import type {
    Processor,
    ProcessInputStepArgs,
    ProcessInputStepResult,
} from '@mastra/core/processors';
import type { MastraToolInvocation, MastraToolInvocationPart } from '@mastra/core/agent/message-list';
import type { MastraDBMessage } from '@mastra/core/memory';
import { estimateTokenCount } from 'tokenx';
import { tcAILogger } from '../../../../utils/logger';
import { astIndexerService, indexedDocumentPaths } from '../../../workspaces';

// ============================================================================
// Config
// ============================================================================

interface ToolResultManagerConfig {
    /** Max tokens for tool results before triggering summarization. */
    maxToolResultTokens?: number;
}

const DEFAULT_CONFIG: Required<ToolResultManagerConfig> = {
    // Set a high token limit for tool results to allow deep analysis, but prevent OOM.
    // Based on MAX_CONTEXT_SIZE env var minus a buffer for the prompt, system messages, and LLM response (default 8K).
    maxToolResultTokens: process.env.MAX_CONTEXT_SIZE ? parseInt(process.env.MAX_CONTEXT_SIZE, 10) - 8000 : 43960,
};

// ============================================================================
// Types
// ============================================================================

interface SymbolInfo {
    symbolPath?: string;
    symbolName?: string;
    symbol?: string;
}

interface SearchResult {
    files?: { filePath: string; symbols: SymbolInfo[] }[];
    documents?: { filePath: string }[];
}

interface ReadResult {
    symbolPath?: string;
    filePath?: string;
    language?: string;
    symbols?: SymbolInfo[];
    content?: string;
    type?: string;
    size?: number;
    totalLines?: number;
    error?: string;
}

interface SourceRef {
    tool: 'search' | 'read';
    query?: string;
    path?: string;
    step: number;
    toolCallId: string;
}

interface ToolInvocationInfo {
    messageId: string;
    toolCallId: string;
    tokens: number;
    step: number;
    paths: string[];
}

// Phases
type Phase = 'normal' | 'awaiting_summary' | 'continuing';

// ============================================================================
// Dedup State
// ============================================================================

interface DedupState {
    symbols: Map<string, SourceRef>;
    searchedDocs: Map<string, SourceRef>;
    readDocs: Map<string, SourceRef>;
}

function createDedupState(): DedupState {
    return { symbols: new Map(), searchedDocs: new Map(), readDocs: new Map() };
}

function snapshotState(state: DedupState): DedupState {
    return {
        symbols: new Map(state.symbols),
        searchedDocs: new Map(state.searchedDocs),
        readDocs: new Map(state.readDocs),
    };
}

// ============================================================================
// Processor (Hybrid: processInputStep + processOutputStep)
// ============================================================================

/**
 * Manages tool results: deduplication + token limiting + summarization.
 * 
 * Flow:
 * 1. Normal: Dedupe tool results, track tokens
 * 2. At 80% limit: Inject summary request, set toolChoice: 'none'
 * 3. processOutputStep detects summary → strips tool invocations, triggers retry
 * 4. On retry: processInputStep with 'continuing' phase injects fresh context
 * 
 * Thread: All messages preserved for visibility. Tool invocations stripped
 * before summary to reduce context. Summary + continuation instructions sent.
 */
export class ToolResultManager implements Processor {
    id = 'tool-result-manager';

    private config: Required<ToolResultManagerConfig>;
    private state = createDedupState();
    private snapshot = createDedupState();
    private stats = { tokensSaved: 0, dedupCount: 0, droppedCount: 0, summaryCycles: 0 };
    private currentStep = 0;
    private currentQuery = '';
    private currentToolCallId = '';

    // Token limiting
    private toolInvocations: ToolInvocationInfo[] = [];
    private totalToolTokens = 0;

    // Summarization state
    private phase: Phase = 'normal';

    constructor(config: ToolResultManagerConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ==========================================================================
    // Input Step: Deduplication
    // ==========================================================================

    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
        const { messageList, stepNumber, systemMessages } = args;
        this.currentStep = stepNumber;
        this.snapshot = snapshotState(this.state);

        // Process deduplication
        this.processDeduplication(messageList);

        // Apply hard token limit if still over
        // DISABLED
        // this.applyTokenLimit(messageList);

        // Add indexed files as system message for context (can be large, so added after dedupe/limit)
        const store = astIndexerService.getStore();
        const codeFilePaths = store.getFilePaths();
        const allIndexedPaths = [...new Set([...codeFilePaths, ...indexedDocumentPaths])];
        // clean up the set from 'submission/' prefix
        const cleanedPaths = allIndexedPaths.map(path => path.replace(/^submission\//, ''));

        // Clean system message of unnecessary messages
        // Add more filtering logic here if other irrelevant system messages are observed in the future...
        const filteredSystemMessages = systemMessages.filter(msg => {
            if (!msg.content) return true;
            // Added by Mastra AI Workspace processor, not useful for requirement analysis as we use custom tools
            if (typeof msg.content === 'string' && msg.content.includes('Local filesystem at')) return false;
            return true;
        });

        tcAILogger.info(`[${this.id}] Step ${stepNumber} | Phase: ${this.phase} | Tokens: ${this.totalToolTokens}/${this.config.maxToolResultTokens}`);

        return {
            messageList,
            systemMessages: [
                ...filteredSystemMessages,
                {
                    role: 'system',
                    content: `The following files are available for requirement review. Read them using submission_read tool when needed:\n${cleanedPaths.join('\n')}\n\n`,
                }
            ]
        };
    }


    // ==========================================================================
    // Deduplication
    // ==========================================================================

    private processDeduplication(messageList: ProcessInputStepArgs['messageList']) {
        for (const msg of messageList.get.all.db()) {
            if (!Array.isArray(msg.content?.parts)) continue;

            for (const part of msg.content.parts) {
                if (part.type !== 'tool-invocation') continue;

                const { toolInvocation } = part as MastraToolInvocationPart;
                if (!toolInvocation?.result || toolInvocation.state !== 'result') continue;
                if (this.isDeduped(toolInvocation.result)) continue;

                this.currentToolCallId = toolInvocation.toolCallId;
                const managed = this.processToolResult(toolInvocation);
                if (!managed) continue;

                this.trackTokenSavings(toolInvocation.result, managed);
                this.trackToolInvocation(msg, toolInvocation, managed);
                this.updateInvocation(messageList, toolInvocation, managed);
            }
        }
    }

    // ==========================================================================
    // Token Limiting (hard limit fallback)
    // ==========================================================================

    private trackToolInvocation(msg: MastraDBMessage, inv: MastraToolInvocation, result: unknown) {
        const tokens = estimateTokenCount(JSON.stringify(result));
        const paths = this.getPathsFromResult(inv.toolName, result);

        this.toolInvocations.push({
            messageId: msg.id,
            toolCallId: inv.toolCallId,
            tokens,
            step: this.currentStep,
            paths,
        });
        this.totalToolTokens += tokens;
    }

    private getPathsFromResult(toolName: string, result: unknown): string[] {
        const paths: string[] = [];
        const r = result as Record<string, unknown>;

        if (toolName === 'submission_search') {
            for (const file of (r.files as { symbols: SymbolInfo[] }[]) || []) {
                for (const sym of file.symbols || []) {
                    if (sym.symbolPath) paths.push(`sym:${sym.symbolPath}`);
                }
            }
            for (const doc of (r.documents as { filePath: string }[]) || []) {
                paths.push(`searchDoc:${doc.filePath}`);
            }
        } else if (toolName === 'submission_read') {
            if (r.symbolPath) paths.push(`sym:${r.symbolPath}`);
            if (r.filePath && r.content !== undefined) paths.push(`readDoc:${r.filePath}`);
            if (r.symbols && r.filePath) {
                for (const sym of r.symbols as SymbolInfo[]) {
                    const name = sym.symbolName || sym.symbol;
                    if (name) paths.push(`sym:${r.filePath}:${name}`);
                }
            }
        }
        return paths;
    }

    private applyTokenLimit(messageList: ProcessInputStepArgs['messageList']) {
        if (this.totalToolTokens <= this.config.maxToolResultTokens) return;

        const sorted = [...this.toolInvocations].sort((a, b) => a.step - b.step);

        while (this.totalToolTokens > this.config.maxToolResultTokens && sorted.length > 0) {
            const oldest = sorted.shift()!;
            this.dropToolInvocation(messageList, oldest);
        }
    }

    private dropToolInvocation(messageList: ProcessInputStepArgs['messageList'], info: ToolInvocationInfo) {
        for (const pathKey of info.paths) {
            if (pathKey.startsWith('sym:')) {
                this.state.symbols.delete(pathKey.slice(4));
            } else if (pathKey.startsWith('searchDoc:')) {
                this.state.searchedDocs.delete(pathKey.slice(10));
            } else if (pathKey.startsWith('readDoc:')) {
                this.state.readDocs.delete(pathKey.slice(8));
            }
        }

        const droppedResult = {
            _dropped: true,
            _reason: 'Token limit exceeded',
            _tokens: info.tokens,
            _step: info.step,
        };

        for (const msg of messageList.get.all.db()) {
            if (msg.id !== info.messageId) continue;
            if (!Array.isArray(msg.content?.parts)) continue;

            for (const part of msg.content.parts) {
                if (part.type !== 'tool-invocation') continue;
                const { toolInvocation } = part as MastraToolInvocationPart;
                if (toolInvocation?.toolCallId !== info.toolCallId) continue;

                messageList.updateToolInvocation({
                    type: 'tool-invocation',
                    toolInvocation: { ...toolInvocation, result: droppedResult },
                });
                break;
            }
        }

        this.totalToolTokens -= info.tokens;
        this.toolInvocations = this.toolInvocations.filter(i => i.toolCallId !== info.toolCallId);
        this.stats.droppedCount++;

        tcAILogger.info(`[${this.id}] Dropped tool ${info.toolCallId.slice(0, 8)} (${info.tokens} tokens, step ${info.step})`);
    }

    // ==========================================================================
    // Deduplication Logic
    // ==========================================================================

    private isDeduped(result: unknown): boolean {
        return typeof result === 'object' && result !== null &&
            ('_deduped' in result || '_dropped' in result || '_compressed' in result);
    }

    private processToolResult(inv: MastraToolInvocation): unknown | undefined {
        const { toolName, result, args } = inv;

        if (toolName === 'submission_search') {
            this.currentQuery = (args as { query?: string })?.query || '';
            return this.dedupeSearch(result as SearchResult);
        }
        if (toolName === 'submission_read') {
            const path = (args as { path?: string })?.path || '';
            return this.dedupeRead(result as ReadResult, path);
        }
        return undefined;
    }

    private dedupeSearch(result: SearchResult): unknown {
        const { files = [], documents = [] } = result;
        const dedupedSymbolRefs: { path: string; seenIn: SourceRef }[] = [];
        const dedupedDocRefs: { path: string; seenIn: SourceRef }[] = [];

        const sourceRef: SourceRef = {
            tool: 'search',
            query: this.currentQuery,
            step: this.currentStep,
            toolCallId: this.currentToolCallId,
        };

        const filteredFiles = files.map(file => {
            const newSymbols = file.symbols.filter(sym => {
                const path = sym.symbolPath!;
                const existing = this.snapshot.symbols.get(path);
                if (existing) {
                    dedupedSymbolRefs.push({ path, seenIn: existing });
                    return false;
                }
                this.state.symbols.set(path, sourceRef);
                return true;
            });
            return newSymbols.length > 0 ? { ...file, symbols: newSymbols } : null;
        }).filter(Boolean);

        const filteredDocs = documents.filter(doc => {
            const { filePath } = doc;
            const existingSearch = this.snapshot.searchedDocs.get(filePath);
            const existingRead = this.snapshot.readDocs.get(filePath);
            if (existingSearch || existingRead) {
                dedupedDocRefs.push({ path: filePath, seenIn: (existingRead || existingSearch)! });
                return false;
            }
            this.state.searchedDocs.set(filePath, sourceRef);
            return true;
        });

        return {
            files: filteredFiles,
            documents: filteredDocs,
            _deduped: true,
            ...(dedupedSymbolRefs.length > 0 && {
                _skippedSymbols: dedupedSymbolRefs.map(r => ({
                    symbolPath: r.path,
                    _seeAlso: this.formatSourceRef(r.seenIn),
                })),
            }),
            ...(dedupedDocRefs.length > 0 && {
                _skippedDocuments: dedupedDocRefs.map(r => ({
                    filePath: r.path,
                    _seeAlso: this.formatSourceRef(r.seenIn),
                })),
            }),
        };
    }

    private dedupeRead(result: ReadResult, requestPath: string): unknown | undefined {
        if ('error' in result) return undefined;

        const sourceRef: SourceRef = {
            tool: 'read',
            path: requestPath,
            step: this.currentStep,
            toolCallId: this.currentToolCallId,
        };

        if (result.symbolPath) {
            return this.dedupeSymbol(result.symbolPath, result, sourceRef);
        }
        if (result.symbols && result.filePath) {
            return this.dedupeFileSymbols(result, sourceRef);
        }
        if (result.content !== undefined && result.filePath) {
            return this.dedupeDocument(result, sourceRef);
        }
        return undefined;
    }

    private dedupeSymbol(path: string, result: ReadResult, sourceRef: SourceRef): unknown {
        const existing = this.snapshot.symbols.get(path);
        if (existing) {
            return { symbolPath: path, _deduped: true, _seeAlso: this.formatSourceRef(existing) };
        }
        this.state.symbols.set(path, sourceRef);
        return { ...result, _deduped: true };
    }

    private dedupeFileSymbols(result: ReadResult, sourceRef: SourceRef): unknown {
        const { filePath, language, symbols = [] } = result;
        const newSymbols: unknown[] = [];
        const skippedSymbols: { symbolPath: string; _seeAlso: string }[] = [];

        for (const sym of symbols) {
            const name = sym.symbolName || sym.symbol;
            const path = `${filePath}:${name}`;
            const existing = this.snapshot.symbols.get(path);

            if (existing) {
                skippedSymbols.push({ symbolPath: path, _seeAlso: this.formatSourceRef(existing) });
            } else {
                this.state.symbols.set(path, sourceRef);
                newSymbols.push(sym);
            }
        }

        if (newSymbols.length === 0) {
            return {
                filePath, language, _deduped: true,
                _note: `All ${symbols.length} symbols already seen`,
                _skippedSymbols: skippedSymbols,
            };
        }

        return {
            filePath, language, symbols: newSymbols, _deduped: true,
            ...(skippedSymbols.length > 0 && { _skippedSymbols: skippedSymbols }),
        };
    }

    private dedupeDocument(result: ReadResult, sourceRef: SourceRef): unknown {
        const { filePath, type, size, totalLines } = result;
        const existing = this.snapshot.readDocs.get(filePath!);

        if (existing) {
            return { filePath, type, size, totalLines, _deduped: true, _seeAlso: this.formatSourceRef(existing) };
        }

        this.state.readDocs.set(filePath!, sourceRef);
        return { ...result, _deduped: true };
    }

    // ==========================================================================
    // Helpers
    // ==========================================================================

    private formatSourceRef(ref: SourceRef): string {
        if (ref.tool === 'search') {
            return `submission_search(query="${ref.query}") in step ${ref.step}`;
        }
        return `submission_read("${ref.path}") in step ${ref.step}`;
    }

    private trackTokenSavings(original: unknown, managed: unknown) {
        const saved = estimateTokenCount(JSON.stringify(original)) -
            estimateTokenCount(JSON.stringify(managed));
        if (saved > 0) {
            this.stats.tokensSaved += saved;
            this.stats.dedupCount++;
        }
    }

    private updateInvocation(messageList: ProcessInputStepArgs['messageList'], inv: MastraToolInvocation, result: unknown) {
        messageList.updateToolInvocation({
            type: 'tool-invocation',
            toolInvocation: { ...inv, result },
        });
    }
}
