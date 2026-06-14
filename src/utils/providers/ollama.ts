import {
  createOllama,
  type OllamaChatSettings,
  type OllamaProvider,
  type Options,
} from 'ai-sdk-ollama';

const ollamaProvider = createOllama({
  baseURL: process.env.OLLAMA_HOST || 'http://ollama.tc.internal:11434',
});

export const OLLAMA_REVIEW_DEFAULT_OPTIONS: Partial<Options> = {
  // Near-deterministic behavior for consistent, schema-friendly review output.
  temperature: 0.1,
  top_k: 40,
  top_p: 0.9,

  // Reduce repeated phrasing across long multi-question audits.
  repeat_penalty: 1.1,
  repeat_last_n: 256,

  // Balance deep repo analysis with operational reliability.
  // Default max context size is 49152 tokens in Ollama, but we set it via env var to allow flexibility based on the specific model and deployment.
  num_ctx: process.env.MAX_CONTEXT_SIZE ? parseInt(process.env.MAX_CONTEXT_SIZE, 10) : 49152,
  num_predict: 2048,
  num_batch: 1024,
};

const withReviewDefaults = (settings?: OllamaChatSettings): OllamaChatSettings => ({
  ...(settings ?? {}),
  options: {
    ...OLLAMA_REVIEW_DEFAULT_OPTIONS,
    ...(settings?.options ?? {}),
  },
});

const ollamaWithDefaults = ((modelId: string, settings?: OllamaChatSettings) =>
  ollamaProvider(modelId, withReviewDefaults(settings))) as OllamaProvider;

ollamaWithDefaults.chat = (modelId, settings) =>
  ollamaProvider.chat(modelId, withReviewDefaults(settings));
ollamaWithDefaults.languageModel = (modelId, settings) =>
  ollamaProvider.languageModel(modelId, withReviewDefaults(settings));

ollamaWithDefaults.embedding = (modelId, settings) =>
  ollamaProvider.embedding(modelId, withReviewDefaults(settings));
ollamaWithDefaults.textEmbedding = (modelId, settings) =>
  ollamaProvider.textEmbedding(modelId, settings);
ollamaWithDefaults.textEmbeddingModel = (modelId, settings) =>
  ollamaProvider.textEmbeddingModel(modelId, settings);

ollamaWithDefaults.reranking = (modelId, settings) =>
  ollamaProvider.reranking(modelId, settings);
ollamaWithDefaults.rerankingModel = (modelId, settings) =>
  ollamaProvider.rerankingModel(modelId, settings);
ollamaWithDefaults.embeddingReranking = (modelId, settings) =>
  ollamaProvider.embeddingReranking(modelId, settings);

ollamaWithDefaults.tools = ollamaProvider.tools;

export const ollama = ollamaWithDefaults;
