/**
 * Scoring Distiller Agent
 * 
 * An agent that extracts & distills scoring rationale from the Requirement Analyzer's analysis report,
 * focusing on coverage and implementation verification.
 */

import { Agent } from '@mastra/core/agent';
import { APIErrorProcessor, createModel } from '../../../utils';
import { SCORING_DISTILLER_AGENT_INSTRUCTIONS, ScoringDistillerSchema, type ScoringDistillerOutput } from './instructions';

// Model configuration - override via LLM_MODEL_NAME env var
// Recommended: qwen3:14b, llama3:8b-instruct, deepseek-coder-v2:16b
const DEFAULT_MODEL = 'qwen3.5:latest';
const MODEL_ID = process.env.LLM_MODEL_NAME || DEFAULT_MODEL;
const PROVIDER_NAME = process.env.LLM_PROVIDER_NAME || 'TC-Ollama';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const scoringDistillerAgent = new Agent<'scoring-distiller-agent', {}, ScoringDistillerOutput>({
    id: 'scoring-distiller-agent',
    name: 'Scoring Distiller',
    description: 'Extracts and distills scoring rationale from the Requirement Analyzer\'s analysis report, focusing on coverage and implementation verification.',
    instructions: SCORING_DISTILLER_AGENT_INSTRUCTIONS,
    // Model with extended context and timeout-friendly settings
    // Override model via LLM_MODEL_NAME env var (see recommendations above)
    model: createModel(PROVIDER_NAME, MODEL_ID),
    defaultOptions: {
        activeTools: [],
        maxSteps: 1,
        structuredOutput: {
            schema: ScoringDistillerSchema,
            // jsonPromptInjection: true,
        },
    },
    // Error processors handle API failures with retry
    errorProcessors: [
        new APIErrorProcessor({
            maxRetries: 2,
            retryablePatterns: [
                'timeout',
                'ETIMEDOUT',
                'ECONNRESET',
                'ECONNREFUSED',
                'socket hang up',
                '503',
                '502',
                '504',
                'rate limit',
                'overloaded',
                /context.*length.*exceeded/i,
                /model.*busy/i,
            ],
        }),
    ],
});
