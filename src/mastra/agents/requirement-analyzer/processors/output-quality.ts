import type {
    ProcessOutputStepArgs,
    Processor,
    ProcessorMessageResult,
} from '@mastra/core/processors';
import { tcAILogger } from '../../../../utils/logger';
import { MastraToolInvocationPart } from '@mastra/core/agent/message-list';

interface OutputQualityConfig {
    maxEmptyResponseRetries?: number;
}

const DEFAULT_CONFIG: Required<OutputQualityConfig> = {
    maxEmptyResponseRetries: 2,
};

/**
 * Guards against blank model outputs so the agent can self-correct with retry feedback.
 */
export class OutputQualityProcessor implements Processor {
    id = 'output-quality-processor';

    private readonly config: Required<OutputQualityConfig>;

    constructor(config: OutputQualityConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult {
        const text = args.text?.trim() ?? '';
        const hasToolCalls = Array.isArray(args.toolCalls) && args.toolCalls.length > 0;
        const retryLimitReached = args.retryCount >= this.config.maxEmptyResponseRetries;

        if (text.length === 0 && !hasToolCalls) {
            const reason = 'The previous response was empty (no text or tool calls). Regenerate the step with a complete response.';

            tcAILogger.warn(`[${this.id}] Empty AI response detected at step ${args.stepNumber}`, {
                retryCount: args.retryCount,
                finishReason: args.finishReason,
                toolCalls: args.toolCalls?.length ?? 0,
                usage: args.usage,
            });

            args.abort(reason, { retry: !retryLimitReached });
        }
        // DISABLED as this put agent in dead loop for empty/junk submissions
        // where the model couldn't find relevant code to reference and kept generating long responses without tool calls.
        // We shall revisit this with more nuanced heuristics around expected tool usage based on the conversation context and model capabilities...
        //
        // } else if (text.length > 150 && !hasToolCalls) {
        //     let hasFileReads = false;
        //     for (const msg of args.messageList.get.all.db()) {
        //         if (!Array.isArray(msg.content?.parts)) continue;

        //         for (const part of msg.content.parts) {
        //             if (part.type !== 'tool-invocation') continue;

        //             const { toolInvocation } = part as MastraToolInvocationPart;
        //             if (!toolInvocation?.result || toolInvocation.state !== 'result') continue;

        //             if (toolInvocation.toolName === 'submission_read') {
        //                 hasFileReads = true;
        //                 break;
        //             }
        //         }

        //         if (hasFileReads) break;
        //     }

        //     // If the model is generating a long response but not used submission_read, it may be going off-track. Prompt a retry with feedback.
        //     if (!hasFileReads) {
        //         const reason = 'Your analysis requires code evidence, make sure to use submission_read to reference specific files or symbols. Regenerate the step with relevant code references.';

        //         tcAILogger.warn(`[${this.id}] Long response without file reads at step ${args.stepNumber}`, {
        //             retryCount: args.retryCount,
        //             finishReason: args.finishReason,
        //             toolCalls: args.toolCalls?.length ?? 0,
        //             usage: args.usage,
        //         });

        //         args.abort(reason, { retry: !retryLimitReached });
        //     }
        // }

        return args.messageList;
    }
}
