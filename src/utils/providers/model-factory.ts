import { ollama } from './ollama';
import { wipro } from './wipro';
import { bedrock } from './bedrock';
import { tcAILogger } from '../logger';
import { openai } from './openai';

export type SupportedProvider = 'TC-Ollama' | 'WiproAI' | 'AWSBedrock';

export function createModel(providerName?: string, modelName?: string) {
    const provider = providerName || process.env.LLM_PROVIDER_NAME || 'WiproAI';
    const model = modelName || process.env.LLM_MODEL_NAME || (provider === 'AWSBedrock' ? 'us.anthropic.claude-sonnet-4-20250514-v1:0' : 'gpt-5-chat');

    tcAILogger.info(`[Model Factory] env LLM_PROVIDER_NAME: ${process.env.LLM_PROVIDER_NAME ?? 'not set'}`);
    tcAILogger.info(`[Model Factory] env LLM_MODEL_NAME: ${process.env.LLM_MODEL_NAME ?? 'not set'}`);
    tcAILogger.info(`[Model Factory] Creating model with provider: ${provider}, model name: ${model}`);

    switch (provider) {
        case 'TC-Ollama':
            return ollama(model);

        case 'WiproAI':
            return wipro.chatModel(model);

        case 'AWSBedrock':
            return bedrock(model);

        case 'OpenAI':
            return openai(model);

        default:
            tcAILogger.error(`[Model Factory] Unsupported LLM provider: ${provider}. Supported providers: TC-Ollama, WiproAI, AWSBedrock`);
            throw new Error(`Unsupported LLM provider: ${provider}. Supported providers: TC-Ollama, WiproAI, AWSBedrock`);
    }
}
