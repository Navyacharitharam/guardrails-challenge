import { Mastra } from '@mastra/core';
import { Observability, SensitiveDataFilter, DefaultExporter } from '@mastra/observability';
import { createOllama } from 'ai-sdk-ollama';
import { createWipro } from '@topcoder/wipro-ai-sdk-provider';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { PinoLogger } from '@mastra/loggers';
import { createOpenAI } from '@ai-sdk/openai';
import { createAIWorkflowRunItems, updateAIWorkflowRun } from 'tc-ai-utils';
import z$1, { z } from 'zod';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import * as path from 'path';
import { dirname, resolve } from 'path';
import * as fs from 'fs/promises';
import pLimit from 'p-limit';
import { embed } from 'ai';
import Parser from 'web-tree-sitter';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { LibSQLVector, LibSQLStore } from '@mastra/libsql';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createHash } from 'crypto';
import { createScorer } from '@mastra/core/evals';
import { Memory } from '@mastra/memory';
import { estimateTokenCount } from 'tokenx';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { readFile } from 'node:fs/promises';
import path$1 from 'node:path';

"use strict";
const ollamaProvider = createOllama({
  baseURL: process.env.OLLAMA_HOST || "http://ollama.tc.internal:11434"
});
const OLLAMA_REVIEW_DEFAULT_OPTIONS = {
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
  num_batch: 1024
};
const withReviewDefaults = (settings) => ({
  ...settings ?? {},
  options: {
    ...OLLAMA_REVIEW_DEFAULT_OPTIONS,
    ...settings?.options ?? {}
  }
});
const ollamaWithDefaults = ((modelId, settings) => ollamaProvider(modelId, withReviewDefaults(settings)));
ollamaWithDefaults.chat = (modelId, settings) => ollamaProvider.chat(modelId, withReviewDefaults(settings));
ollamaWithDefaults.languageModel = (modelId, settings) => ollamaProvider.languageModel(modelId, withReviewDefaults(settings));
ollamaWithDefaults.embedding = (modelId, settings) => ollamaProvider.embedding(modelId, withReviewDefaults(settings));
ollamaWithDefaults.textEmbedding = (modelId, settings) => ollamaProvider.textEmbedding(modelId, settings);
ollamaWithDefaults.textEmbeddingModel = (modelId, settings) => ollamaProvider.textEmbeddingModel(modelId, settings);
ollamaWithDefaults.reranking = (modelId, settings) => ollamaProvider.reranking(modelId, settings);
ollamaWithDefaults.rerankingModel = (modelId, settings) => ollamaProvider.rerankingModel(modelId, settings);
ollamaWithDefaults.embeddingReranking = (modelId, settings) => ollamaProvider.embeddingReranking(modelId, settings);
ollamaWithDefaults.tools = ollamaProvider.tools;
const ollama = ollamaWithDefaults;

"use strict";
const wipro = createWipro({
  headers: { "x-api-key": process.env.WIPRO_API_KEY },
  chatSettings: {
    // Reliability profile for schema-constrained AI review output.
    // Keep sampling deterministic to reduce malformed/shape-drifted JSON.
    temperature: 0,
    topP: 0.1,
    topK: 20,
    maxOutputTokens: 8192,
    // Avoid repetition penalties that can destabilize strict JSON output.
    frequencyPenalty: 0,
    presencePenalty: 0,
    // Default JSON mode for non-structured calls.
    // Structured calls can still override this when needed.
    responseFormat: "json_object"
  }
});

"use strict";
const bedrockProvider = createAmazonBedrock({
  region: process.env.AWS_REGION || "us-east-1",
  credentialProvider: fromNodeProviderChain()
});
const bedrock = bedrockProvider;

"use strict";
const tcAILogger = new PinoLogger({
  name: "TC AI Reviewer",
  level: "info"
});

"use strict";
const openai = createOpenAI({
  // custom settings can be added here if needed
});

"use strict";
function createModel(providerName, modelName) {
  const provider = providerName || process.env.LLM_PROVIDER_NAME || "WiproAI";
  const model = modelName || process.env.LLM_MODEL_NAME || (provider === "AWSBedrock" ? "us.anthropic.claude-sonnet-4-20250514-v1:0" : "gpt-5-chat");
  tcAILogger.info(`[Model Factory] env LLM_PROVIDER_NAME: ${process.env.LLM_PROVIDER_NAME ?? "not set"}`);
  tcAILogger.info(`[Model Factory] env LLM_MODEL_NAME: ${process.env.LLM_MODEL_NAME ?? "not set"}`);
  tcAILogger.info(`[Model Factory] Creating model with provider: ${provider}, model name: ${model}`);
  switch (provider) {
    case "TC-Ollama":
      return ollama(model);
    case "WiproAI":
      return wipro.chatModel(model);
    case "AWSBedrock":
      return bedrock(model);
    case "OpenAI":
      return openai(model);
    default:
      tcAILogger.error(`[Model Factory] Unsupported LLM provider: ${provider}. Supported providers: TC-Ollama, WiproAI, AWSBedrock`);
      throw new Error(`Unsupported LLM provider: ${provider}. Supported providers: TC-Ollama, WiproAI, AWSBedrock`);
  }
}

"use strict";
const MAX_RETRIES$2 = 3;
const RETRY_DELAY_MS = 1e3;
const MAX_REQUEST_BODY_SIZE = 8e3;
const API_OPERATION_TIMEOUT_MS = 1e4;
const WAF_SENSITIVE_PATTERNS = [
  /DATABASE_URL\s*=\s*[^\s]+/gi,
  /postgresql:\/\/[^\s]+/gi,
  /mysql:\/\/[^\s]+/gi,
  /mongodb:\/\/[^\s]+/gi,
  /redis:\/\/[^\s]+/gi,
  /password\s*[:=]\s*[^\s]+/gi,
  /secret\s*[:=]\s*[^\s]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s]+/gi,
  /auth[_-]?token\s*[:=]\s*[^\s]+/gi,
  /<script[^>]*>/gi,
  /<\/script>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi
];
function formatFileInspection(inspection) {
  const lines = inspection.lineStart && inspection.lineEnd ? ` (L${inspection.lineStart}-L${inspection.lineEnd})` : "";
  const observation = inspection.observation ? ` - ${inspection.observation}` : "";
  const snippet = inspection.snippet ? `
\`\`\`
${inspection.snippet.slice(0, 500)}${inspection.snippet.length > 500 ? "..." : ""}
\`\`\`` : "";
  return `- \`${inspection.filePath}\`${lines}${observation}${snippet}`;
}
function formatRequirementMapping(mapping) {
  const statusEmoji = mapping.status === "FOUND" ? "\u2705" : mapping.status === "PARTIAL" ? "\u26A0\uFE0F" : "\u274C";
  const refs = mapping.evidenceRefs?.length ? `
  - Evidence: ${mapping.evidenceRefs.join(", ")}` : "";
  return `- ${statusEmoji} **${mapping.requirementId}**: ${mapping.status}${refs}`;
}
function formatEvidenceCitation(citation) {
  const lines = citation.lineStart && citation.lineEnd ? `:${citation.lineStart}-${citation.lineEnd}` : "";
  return `\`${citation.filePath}${lines}\``;
}
function sanitizeContentForWAF(content) {
  let sanitized = content;
  for (const pattern of WAF_SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.toLowerCase().includes("database_url") || match.includes("://")) {
        return "[CONNECTION_STRING_REDACTED]";
      }
      if (match.toLowerCase().includes("password")) {
        return "[PASSWORD_REDACTED]";
      }
      if (match.toLowerCase().includes("secret")) {
        return "[SECRET_REDACTED]";
      }
      if (match.toLowerCase().includes("api") || match.toLowerCase().includes("key")) {
        return "[API_KEY_REDACTED]";
      }
      if (match.toLowerCase().includes("token")) {
        return "[TOKEN_REDACTED]";
      }
      if (match.startsWith("<") || match.includes("javascript")) {
        return "[SCRIPT_REMOVED]";
      }
      return "[REDACTED]";
    });
  }
  return sanitized;
}
function batchItemsBySize(items, maxSize) {
  const batches = [];
  let currentBatch = [];
  let currentSize = 2;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1;
    if (currentBatch.length > 0 && currentSize + itemSize > maxSize) {
      batches.push(currentBatch);
      currentBatch = [item];
      currentSize = 2 + itemSize;
    } else {
      currentBatch.push(item);
      currentSize += itemSize;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}
function generateQuestionContentMarkdown(answer, question) {
  const sections = [];
  const verdictEmoji = {
    "PASS": "\u2705",
    "FAIL": "\u274C",
    "WARN": "\u26A0\uFE0F",
    "N_A": "\u2796"
  }[answer.verdict];
  sections.push(`## ${verdictEmoji} Verdict: **${answer.verdict}**`);
  if (question && answer.applicable) {
    if (question.type === "YES_NO" && answer.yesNoAnswer !== null && answer.yesNoAnswer !== void 0) {
      sections.push(`**Answer:** ${answer.yesNoAnswer ? "YES" : "NO"}`);
    } else if (question.type === "SCALE" && answer.scaleAnswer !== null && answer.scaleAnswer !== void 0) {
      const min = question.scaleMin ?? 1;
      const max = question.scaleMax ?? null;
      if (max !== null) {
        sections.push(`**Score:** ${answer.scaleAnswer} / ${max} (min: ${min})`);
      } else {
        sections.push(`**Score:** ${answer.scaleAnswer}`);
      }
    } else if (question.type === "TEST_CASE" && answer.testCasePass !== null && answer.testCasePass !== void 0) {
      sections.push(`**Test Result:** ${answer.testCasePass ? "PASSED" : "FAILED"}`);
    }
  }
  if (!answer.applicable) {
    sections.push(`**Applicability:** Not applicable to this submission.`);
    if (answer.applicabilityBasis?.summary) {
      sections.push(`> ${answer.applicabilityBasis.summary}`);
    }
    return sections.join("\n\n");
  }
  if (answer.evidence && !answer.evidence.includes("(output truncated")) {
    sections.push(`### Evidence
${answer.evidence}`);
  }
  if (answer.fileInspections?.length) {
    const inspections = answer.fileInspections.slice(0, 10).map(formatFileInspection).join("\n");
    sections.push(`### File Inspections
${inspections}`);
  }
  if (answer.evidenceCitations?.length) {
    const citations = answer.evidenceCitations.slice(0, 15).map(formatEvidenceCitation).join(", ");
    sections.push(`### References
${citations}`);
  }
  if (answer.requirementMapping?.length) {
    const mappings = answer.requirementMapping.map(formatRequirementMapping).join("\n");
    sections.push(`### Requirement Coverage
${mappings}`);
  }
  if (answer.reasoning && !answer.reasoning.includes("(output truncated")) {
    sections.push(`### Reasoning
${answer.reasoning}`);
  }
  if (answer.decision && !answer.decision.includes("(output truncated")) {
    sections.push(`### Decision
${answer.decision}`);
  }
  if (answer.applicabilityBasis?.checkedSources?.length) {
    sections.push(`### Applicability Check
- Sources checked: ${answer.applicabilityBasis.checkedSources.join(", ")}`);
    if (answer.applicabilityBasis.summary) {
      sections.push(`- Summary: ${answer.applicabilityBasis.summary}`);
    }
  }
  return sections.join("\n\n");
}
function calculateQuestionScore(answer, question) {
  const questionType = question?.type;
  if (!answer.applicable || answer.verdict === "N_A") {
    switch (questionType) {
      case "YES_NO":
      case "TEST_CASE":
        return 1;
      // Max score for binary questions
      case "SCALE":
        return question?.scaleMax ?? 5;
      // Max scale value
      default:
        return 1;
    }
  }
  switch (questionType) {
    case "YES_NO":
      return answer.yesNoAnswer === true ? 1 : 0;
    case "SCALE":
      return answer.scaleAnswer ?? (question?.scaleMin ?? 1);
    case "TEST_CASE":
      return answer.testCasePass === true ? 1 : 0;
    default:
      return answer.verdict === "PASS" ? 1 : 0;
  }
}
async function withRetry(operation, operationName) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES$2; attempt++) {
    try {
      tcAILogger.info(`[tc-api-reporter] ${operationName} - attempt ${attempt}/${MAX_RETRIES$2}`);
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      tcAILogger.warn(
        `[tc-api-reporter] ${operationName} failed on attempt ${attempt}/${MAX_RETRIES$2}: ${lastError.message}`
      );
      if (attempt < MAX_RETRIES$2) {
        const delay = RETRY_DELAY_MS * attempt;
        tcAILogger.info(`[tc-api-reporter] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new Error(`${operationName} failed after ${MAX_RETRIES$2} attempts`);
}
async function withTimeout$1(operation, timeoutMs, operationName) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
function buildQuestionLookupFromScorecard(scorecard) {
  const lookup = {};
  for (const group of scorecard.scorecardGroups) {
    for (const section of group.sections) {
      for (const question of section.questions) {
        lookup[question.id] = {
          id: question.id,
          type: question.type,
          description: question.description,
          guidelines: question.guidelines,
          scaleMin: question.scaleMin,
          scaleMax: question.scaleMax
        };
      }
    }
  }
  return lookup;
}
function buildQuestionLookupFromReport(report) {
  const lookup = {};
  for (const group of report.groups) {
    for (const section of group.sections) {
      for (const qa of section.questionAnswers) {
        const inferredType = qa.yesNoAnswer !== null && qa.yesNoAnswer !== void 0 ? "YES_NO" : qa.scaleAnswer !== null && qa.scaleAnswer !== void 0 ? "SCALE" : qa.testCasePass !== null && qa.testCasePass !== void 0 ? "TEST_CASE" : "YES_NO";
        lookup[qa.questionId] = {
          id: qa.questionId,
          type: inferredType,
          description: "",
          guidelines: ""
        };
      }
    }
  }
  return lookup;
}
async function postReviewResultsToTCApi(report, aiWorkflowId, scorecardQuestions) {
  const result = {
    success: false,
    runItemsCreated: 0,
    runUpdated: false,
    errors: []
  };
  if (!process.env.TC_API_BASE_URL) {
    result.errors.push("TC_API_BASE_URL environment variable is not set");
    tcAILogger.error("[tc-api-reporter] TC_API_BASE_URL environment variable is not set");
    return result;
  }
  if (!process.env.TC_RUN_ID) {
    result.errors.push("TC_RUN_ID environment variable is not set");
    tcAILogger.error("[tc-api-reporter] TC_RUN_ID environment variable is not set");
    return result;
  }
  if (!process.env.TC_API_TOKEN) {
    result.errors.push("TC_API_TOKEN environment variable is not set");
    tcAILogger.error("[tc-api-reporter] TC_API_TOKEN environment variable is not set");
    return result;
  }
  tcAILogger.info(`[tc-api-reporter] Starting TC API report for workflow ${aiWorkflowId}, run ${process.env.TC_RUN_ID}`);
  const questionLookup = scorecardQuestions ?? buildQuestionLookupFromReport(report);
  const runItems = [];
  for (const group of report.groups) {
    for (const section of group.sections) {
      for (const qa of section.questionAnswers) {
        const question = questionLookup[qa.questionId];
        const content = generateQuestionContentMarkdown(qa, question);
        const questionScore = calculateQuestionScore(qa, question);
        runItems.push({
          scorecardQuestionId: qa.questionId,
          content,
          questionScore
        });
        tcAILogger.debug(
          `[tc-api-reporter] Prepared item for question ${qa.questionId}: verdict=${qa.verdict}, score=${questionScore}`
        );
      }
    }
  }
  tcAILogger.info(`[tc-api-reporter] Prepared ${runItems.length} run items for submission`);
  const batches = batchItemsBySize(runItems, MAX_REQUEST_BODY_SIZE);
  tcAILogger.info(
    `[tc-api-reporter] Split ${runItems.length} run items into ${batches.length} batch(es) (max body size: ${MAX_REQUEST_BODY_SIZE} chars)`
  );
  try {
    let itemsCreated = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchLabel = `${i + 1}/${batches.length}`;
      tcAILogger.info(
        `[tc-api-reporter] Sending batch ${batchLabel} with ${batch.length} items`
      );
      let success = false;
      let lastError;
      for (let attempt = 1; attempt <= MAX_RETRIES$2 && !success; attempt++) {
        try {
          tcAILogger.info(`[tc-api-reporter] Create AI Workflow Run Items (batch ${batchLabel}) - attempt ${attempt}/${MAX_RETRIES$2}`);
          const response = await withTimeout$1(
            createAIWorkflowRunItems(aiWorkflowId, batch),
            API_OPERATION_TIMEOUT_MS,
            `createAIWorkflowRunItems batch ${batchLabel}`
          );
          if (response.ok) {
            success = true;
            itemsCreated += batch.length;
            tcAILogger.info(`[tc-api-reporter] Successfully sent batch ${batchLabel}`);
            break;
          }
          const errorText = await response.text().catch(() => "Unknown error");
          if (response.status === 403) {
            tcAILogger.warn(`[tc-api-reporter] Batch ${batchLabel} blocked by WAF (403), attempting content sanitization`);
            tcAILogger.debug(`[tc-api-reporter] WAF response: ${errorText}`);
            const sanitizedBatch = batch.map((item) => ({
              ...item,
              content: sanitizeContentForWAF(item.content)
            }));
            tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} with sanitized content`);
            const sanitizedResponse = await withTimeout$1(
              createAIWorkflowRunItems(aiWorkflowId, sanitizedBatch),
              API_OPERATION_TIMEOUT_MS,
              `createAIWorkflowRunItems batch ${batchLabel} (sanitized)`
            );
            if (sanitizedResponse.ok) {
              success = true;
              itemsCreated += batch.length;
              tcAILogger.info(`[tc-api-reporter] Successfully sent batch ${batchLabel} after sanitization`);
              break;
            }
            tcAILogger.warn(`[tc-api-reporter] Sanitized batch ${batchLabel} still blocked, trying individual items`);
            let individualSuccess = 0;
            for (const item of sanitizedBatch) {
              try {
                const singleResponse = await withTimeout$1(
                  createAIWorkflowRunItems(aiWorkflowId, [item]),
                  API_OPERATION_TIMEOUT_MS,
                  `createAIWorkflowRunItems single item ${item.scorecardQuestionId}`
                );
                if (singleResponse.ok) {
                  individualSuccess++;
                } else {
                  tcAILogger.warn(`[tc-api-reporter] Failed to send item ${item.scorecardQuestionId}: HTTP ${singleResponse.status}`);
                }
              } catch (singleError) {
                tcAILogger.warn(`[tc-api-reporter] Failed to send item ${item.scorecardQuestionId}: ${singleError instanceof Error ? singleError.message : String(singleError)}`);
              }
            }
            itemsCreated += individualSuccess;
            tcAILogger.info(`[tc-api-reporter] Batch ${batchLabel}: sent ${individualSuccess}/${batch.length} items individually`);
            success = true;
            break;
          }
          tcAILogger.error(`[tc-api-reporter] API Error Response: ${errorText}`);
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
          if (attempt < MAX_RETRIES$2) {
            const delay = RETRY_DELAY_MS * attempt;
            tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          tcAILogger.warn(
            `[tc-api-reporter] Batch ${batchLabel} attempt ${attempt}/${MAX_RETRIES$2} failed: ${lastError.message}`
          );
          if (attempt < MAX_RETRIES$2) {
            const delay = RETRY_DELAY_MS * attempt;
            tcAILogger.info(`[tc-api-reporter] Retrying batch ${batchLabel} in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      if (!success && lastError) {
        throw lastError;
      }
    }
    result.runItemsCreated = itemsCreated;
    tcAILogger.info(`[tc-api-reporter] Successfully created ${itemsCreated} run items in ${batches.length} batch(es)`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to create run items: ${errorMsg}`);
    tcAILogger.error(`[tc-api-reporter] Failed to create run items: ${errorMsg}`);
    return result;
  }
  const updateData = {
    score: report.totalScore,
    usage: {
      input: report.tokenUsage.summary.inputTokens,
      output: report.tokenUsage.summary.outputTokens
    }
  };
  try {
    await withRetry(
      async () => {
        const response = await updateAIWorkflowRun(aiWorkflowId, updateData);
        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          tcAILogger.error(`[tc-api-reporter] API Error Response: ${errorText}`);
          tcAILogger.error(`[tc-api-reporter] Response status: ${response.status}`);
          tcAILogger.error(`[tc-api-reporter] Request body: ${JSON.stringify(updateData)}`);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        return response;
      },
      "Update AI Workflow Run"
    );
    result.runUpdated = true;
    tcAILogger.info(
      `[tc-api-reporter] Successfully updated workflow run with score=${report.totalScore}, usage=(input=${updateData.usage.input}, output=${updateData.usage.output})`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to update workflow run: ${errorMsg}`);
    tcAILogger.error(`[tc-api-reporter] Failed to update workflow run: ${errorMsg}`);
    return result;
  }
  result.success = true;
  tcAILogger.info(
    `[tc-api-reporter] TC API report completed successfully: ${result.runItemsCreated} items created, run updated with score ${report.totalScore}`
  );
  return result;
}
async function postReviewResultsFromFile(reportPath, aiWorkflowId) {
  const { readFileSync } = await import('node:fs');
  tcAILogger.info(`[tc-api-reporter] Loading report from ${reportPath}`);
  try {
    const reportContent = readFileSync(reportPath, "utf-8");
    const report = JSON.parse(reportContent);
    const scorecardReport = report.result ?? report;
    if (!scorecardReport.groups || scorecardReport.totalScore === void 0) {
      throw new Error("Invalid report format: missing required fields (groups, totalScore)");
    }
    return postReviewResultsToTCApi(scorecardReport, aiWorkflowId);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    tcAILogger.error(`[tc-api-reporter] Failed to load or parse report: ${errorMsg}`);
    return {
      success: false,
      runItemsCreated: 0,
      runUpdated: false,
      errors: [`Failed to load report: ${errorMsg}`]
    };
  }
}

"use strict";
const constraintSchema = z.object({
  id: z.string(),
  text: z.string()
});
const requirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  constraints: z.array(constraintSchema)
});
const requirementGroupSchema = z.object({
  id: z.string().describe("Sequential group ID, e.g. GRP_01"),
  name: z.string().describe('Short name of the feature area / story, e.g. "Energy Monitoring"'),
  requirementIds: z.array(z.string()).describe("Ordered list of requirement IDs belonging to this group")
});
const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.object({
    id: z.string(),
    name: z.string()
  }).optional()
});
const reviewerInfoSchema = z.object({
  scorecardId: z.string(),
  isMemberReview: z.boolean(),
  type: z.string().optional(),
  aiWorkflowId: z.string().optional()
});
const runtimeEnvironmentSchema = z.object({
  os: z.string().nullable().describe('Expected target operating system (e.g. "Linux", "Windows", "macOS", "any", "unknown")'),
  containerized: z.boolean().nullable().describe("Whether the challenge expects the solution to run inside a container (Docker, Podman, etc.)"),
  containerTool: z.string().nullable().optional().describe('Expected container tool if containerized (e.g. "Docker", "Docker Compose", "Podman", "Kubernetes")'),
  dockerfileExpected: z.boolean().nullable().optional().describe("Whether the challenge expects a Dockerfile / docker-compose file to be included in the submission"),
  runtimeEngine: z.string().nullable().describe('Expected primary runtime engine (e.g. "Node.js", "Python", "JVM", "Go", ".NET CLR", "browser", "unknown")'),
  runtimeVersion: z.string().nullable().optional().describe('Required runtime version if specified in the challenge (e.g. ">=18", "3.11", "21 LTS")'),
  programmingLanguages: z.array(z.string()).nullable().describe('Programming languages required by the challenge (e.g. ["TypeScript", "Python"])'),
  packageManager: z.string().nullable().optional().describe('Expected package manager if mentioned in the challenge (e.g. "npm", "pnpm", "yarn", "pip", "poetry", "maven")'),
  buildTool: z.string().nullable().optional().describe('Expected build tool if mentioned in the challenge (e.g. "webpack", "vite", "tsc", "gradle", "make")'),
  deploymentTarget: z.string().nullable().optional().describe('Expected deployment target if specified (e.g. "AWS Lambda", "Vercel", "Heroku", "on-premise", "local")'),
  serverType: z.string().nullable().optional().describe('Expected server framework or type if specified (e.g. "Express", "NestJS", "FastAPI", "Spring Boot")'),
  databaseEngine: z.string().nullable().optional().describe('Expected primary database if mentioned in the challenge (e.g. "PostgreSQL", "MongoDB", "DynamoDB")'),
  additionalServices: z.array(z.string()).nullable().optional().describe('Additional services expected by the challenge (e.g. ["Redis", "RabbitMQ", "Elasticsearch"])'),
  notes: z.string().nullable().optional().describe("Any other runtime / environment expectations inferred from the challenge spec")
});
const existingArtifactSchema = z.object({
  type: z.enum([
    "repository",
    "starter_code",
    "boilerplate",
    "documentation",
    "api_spec",
    "design",
    "dataset",
    "database_dump",
    "config",
    "library",
    "other"
  ]).describe("Kind of pre-existing artifact"),
  description: z.string().describe("What this artifact contains or provides"),
  url: z.string().nullable().optional().describe("URL / link if mentioned (e.g. Git repo, Figma, Swagger)"),
  notes: z.string().nullable().optional().describe("Additional context about this artifact")
});
const existingCodebaseSchema = z.object({
  isGreenfield: z.boolean().describe(
    "true if the challenge is entirely from scratch with no pre-existing code or artifacts to build upon"
  ),
  summary: z.string().describe(
    'Brief description of the existing codebase / starting-point status (e.g. "Existing NestJS API with Prisma ORM \u2014 extend with new endpoints" or "Greenfield \u2014 build from scratch")'
  ),
  artifacts: z.array(existingArtifactSchema).describe(
    "List of pre-existing artifacts referenced by the challenge (repos, starter code, docs, designs, etc.). Empty array if greenfield."
  ),
  repositoryUrl: z.string().nullable().optional().describe(
    "Primary Git repository URL if an existing codebase is provided"
  ),
  branchOrTag: z.string().nullable().optional().describe(
    "Branch, tag, or commit reference to use if specified"
  ),
  languages: z.array(z.string()).optional().describe(
    "Programming languages present in the existing codebase (may differ from challenge requirements)"
  ),
  frameworks: z.array(z.string()).optional().describe(
    "Frameworks / libraries already present in the existing codebase"
  ),
  notes: z.string().optional().describe(
    "Any other observations about the starting point inferred from the challenge spec"
  )
});
const submissionGuidelinesSchema = z.object({
  summary: z.string().describe(
    "Brief overall summary of the submission requirements in 1-3 sentences"
  ),
  whatToSubmit: z.array(z.string()).describe(
    'List of deliverables the submitter must include (e.g. "source code", "README.md", "Postman collection", "Docker setup", "unit tests", "demo video")'
  ),
  howToSubmit: z.string().describe(
    'Instructions on how to package / format the submission (e.g. "ZIP archive", "Git patch file", "single commit on a branch")'
  ),
  whereToSubmit: z.string().describe(
    'Submission destination / platform (e.g. "Topcoder challenge page", "GitHub pull request", "external URL")'
  ),
  submissionType: z.enum([
    "full_codebase",
    "patch",
    "link_to_repository",
    "link_to_deployment",
    "file_upload",
    "other"
  ]).describe(
    "Whether the challenge expects the entire codebase, a patch / diff of an existing codebase, a link to an external Git repository, a link to a running deployment, a file upload, or something else"
  ),
  submissionStorage: z.enum([
    "topcoder_upload",
    "git_repository",
    "external_file_storage",
    "cloud_deployment",
    "other"
  ]).describe(
    "Where the final submission artifact lives \u2014 uploaded to Topcoder, pushed to a Git repo, hosted on external file storage (S3, Drive, etc.), deployed to a cloud environment, or other"
  ),
  isPatchOfExisting: z.boolean().describe(
    "true if the submission should be a patch / diff on top of an existing codebase rather than a standalone full codebase. IMPORTANT: This should ONLY be true when existing_codebase.isGreenfield is false AND a concrete repository URL or existing artifacts are provided. If isGreenfield is true (no existing code to patch), isPatchOfExisting MUST be false."
  ),
  eligibilityConditions: z.array(z.string()).optional().describe(
    'Any conditions that must be met for the submission to be eligible for review (e.g. "must pass SAST scanner", "must include unit tests with \u226580% coverage")'
  ),
  notes: z.string().optional().describe(
    "Any additional submission-related information that does not fit the above fields"
  )
});
const prizeSchema = z.object({
  placement: z.number(),
  value: z.number(),
  currency: z.string()
});
const scorecardQuestionSchema = z.object({
  id: z.string(),
  type: z.enum(["SCALE", "YES_NO", "TEST_CASE"]),
  description: z.string(),
  guidelines: z.string(),
  weight: z.number(),
  requiresUpload: z.boolean().optional(),
  scaleMin: z.number().nullable().optional(),
  scaleMax: z.number().nullable().optional(),
  sortOrder: z.number()
});
const scorecardSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  sortOrder: z.number(),
  questions: z.array(scorecardQuestionSchema)
});
const scorecardGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  sortOrder: z.number(),
  sections: z.array(scorecardSectionSchema)
});
const scorecardSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(["ACTIVE", "INACTIVE", "DELETED"]),
  type: z.enum([
    "SCREENING",
    "REVIEW",
    "APPROVAL",
    "POST_MORTEM",
    "SPECIFICATION_REVIEW",
    "CHECKPOINT_SCREENING",
    "CHECKPOINT_REVIEW",
    "ITERATIVE_REVIEW"
  ]),
  challengeTrack: z.string(),
  challengeType: z.string(),
  minScore: z.number(),
  minimumPassingScore: z.number(),
  maxScore: z.number(),
  scorecardGroups: z.array(scorecardGroupSchema)
});
const unifiedContextSchema = z.object({
  challengeId: z.string(),
  title: z.string(),
  descriptionRaw: z.string(),
  privateDescription: z.string().optional(),
  descriptionFormat: z.string(),
  requirements: z.array(requirementSchema),
  requirement_groups: z.array(requirementGroupSchema),
  tech_stack: z.array(z.string()),
  skills: z.array(skillSchema),
  challenge_metadata: z.object({
    status: z.string(),
    track: z.string(),
    type: z.string(),
    totalPrizes: z.number(),
    numOfRegistrants: z.number(),
    numOfSubmissions: z.number(),
    isTask: z.boolean()
  }),
  timeline: z.object({
    registrationStartDate: z.string(),
    registrationEndDate: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    totalDurationDays: z.number()
  }),
  prizes: z.array(prizeSchema),
  review_criteria: z.object({
    reviewType: z.string(),
    reviewers: z.array(reviewerInfoSchema),
    scorecard: scorecardSchema.nullable().describe(
      "The human review scorecard fetched from the Topcoder API. null if no human reviewer entry (isMemberReview: true) was found or the API call failed."
    )
  }),
  runtime_environment: runtimeEnvironmentSchema.describe(
    "Runtime / execution environment expectations extracted solely from the challenge specification. No submission exists at this point \u2014 all values reflect what the challenge requires or implies."
  ),
  existing_codebase: existingCodebaseSchema.describe(
    "Status quo of the challenge: existing artifacts, codebase, documentation, or starting-point material referenced in the specification. If none, isGreenfield is true and artifacts is empty."
  ),
  submission_guidelines: submissionGuidelinesSchema.describe(
    "Structured submission guidelines extracted from the challenge specification: what to deliver, how to package it, where to submit, and whether it is a patch or full codebase."
  ),
  discussion_url: z.string().optional()
});

"use strict";
class APIErrorProcessor {
  id = "api-error-handler";
  name = "API Error Handler";
  description = "Captures LLM API errors and handles retries";
  options;
  constructor(options = {}) {
    this.options = {
      maxRetries: options.maxRetries ?? 2,
      retryablePatterns: options.retryablePatterns ?? [
        "timeout",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "socket hang up",
        "503",
        "502",
        "504",
        "rate limit",
        "overloaded",
        /context.*length.*exceeded/i,
        /model.*busy/i
      ]
    };
  }
  async processAPIError({
    error,
    stepNumber,
    steps,
    retryCount,
    state
  }) {
    const errorMessage = this.extractErrorMessage(error);
    const errorCode = this.extractErrorCode(error);
    const errorLog = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      stepNumber,
      stepsCompleted: steps.length,
      retryCount,
      errorMessage,
      errorCode,
      errorStack: error instanceof Error ? error.stack : void 0
    };
    state.lastError = errorLog;
    state.errorHistory = state.errorHistory || [];
    state.errorHistory.push(errorLog);
    tcAILogger.error("[APIErrorProcessor] LLM API error occurred", errorLog);
    const isRetryable = this.isRetryableError(errorMessage, errorCode);
    const canRetry = retryCount < this.options.maxRetries;
    if (isRetryable && canRetry) {
      tcAILogger.info("[APIErrorProcessor] Scheduling retry", {
        retryCount: retryCount + 1,
        maxRetries: this.options.maxRetries,
        errorMessage
      });
      return { retry: true };
    }
    if (!canRetry) {
      tcAILogger.warn("[APIErrorProcessor] Max retries exceeded", {
        retryCount,
        maxRetries: this.options.maxRetries
      });
    }
    if (!isRetryable) {
      tcAILogger.warn("[APIErrorProcessor] Error is not retryable", {
        errorMessage,
        errorCode
      });
    }
    return void 0;
  }
  extractErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object") {
      const obj = error;
      if (obj.message) return String(obj.message);
      if (obj.error) return String(obj.error);
      if (obj.reason) return String(obj.reason);
    }
    return "Unknown error";
  }
  extractErrorCode(error) {
    if (error && typeof error === "object") {
      const obj = error;
      if (obj.code) return String(obj.code);
      if (obj.status) return String(obj.status);
      if (obj.statusCode) return String(obj.statusCode);
    }
    return void 0;
  }
  isRetryableError(message, code) {
    const searchText = `${message} ${code || ""}`.toLowerCase();
    for (const pattern of this.options.retryablePatterns) {
      if (typeof pattern === "string") {
        if (searchText.includes(pattern.toLowerCase())) {
          return true;
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(searchText)) {
          return true;
        }
      }
    }
    return false;
  }
}

"use strict";

"use strict";
function formatZodType(schema) {
  const def = schema.def || schema._def;
  const typeName = def?.type || def?.typeName;
  if (typeName === "optional") {
    return `${formatZodType(def.innerType)} (optional)`;
  }
  if (typeName === "nullable") {
    return `${formatZodType(def.innerType)} | null`;
  }
  if (typeName === "default") {
    return formatZodType(def.innerType);
  }
  if (typeName === "string") {
    const checks = def.checks || [];
    const regex = checks.find((c) => c.kind === "regex");
    if (regex) return `string (pattern: ${regex.regex})`;
    const maxLen = checks.find((c) => c.kind === "max");
    if (maxLen) return `string (max ${maxLen.value} chars)`;
    return "string";
  }
  if (typeName === "number") {
    const checks = def.checks || [];
    const isInt = checks.some((c) => c.kind === "int");
    const min = checks.find((c) => c.kind === "min");
    const max = checks.find((c) => c.kind === "max");
    let type = isInt ? "integer" : "number";
    if (min && max) type += ` (${min.value}-${max.value})`;
    return type;
  }
  if (typeName === "boolean") return "boolean";
  if (typeName === "literal") {
    const val = def.value;
    return typeof val === "string" ? `"${val}"` : String(val);
  }
  if (typeName === "enum") {
    const entries = def.entries;
    if (entries && typeof entries === "object") {
      return Object.values(entries).map((v) => `"${v}"`).join(" | ");
    }
    const values = def.values;
    if (Array.isArray(values)) {
      return values.map((v) => `"${v}"`).join(" | ");
    }
    return "enum";
  }
  if (typeName === "nativeEnum") {
    const enumObj = def.values || def.entries;
    if (enumObj && typeof enumObj === "object") {
      const values = Object.values(enumObj).filter((v) => typeof v === "string" || typeof v === "number");
      return values.map((v) => typeof v === "string" ? `"${v}"` : String(v)).join(" | ");
    }
    return "enum";
  }
  if (typeName === "array") {
    const elementSchema = def.element || def.type;
    const innerType = formatZodType(elementSchema);
    const maxItems = def.maxLength?.value;
    return `[${innerType}]${maxItems ? ` (max ${maxItems} items)` : ""}`;
  }
  if (typeName === "object") {
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;
    if (shape && typeof shape === "object") {
      const inner = Object.entries(shape).map(([k, v]) => {
        const zodField = v;
        const desc = zodField.description;
        const typeStr = formatZodType(zodField);
        return `${k}: ${typeStr}${desc ? ` /* ${desc} */` : ""}`;
      }).join(", ");
      return `{ ${inner} }`;
    }
    return "object";
  }
  if (typeName === "union") {
    const options = def.options;
    if (Array.isArray(options)) {
      return options.map((opt) => formatZodType(opt)).join(" | ");
    }
    return "union";
  }
  if (typeName === "tuple") {
    const items = def.items;
    if (Array.isArray(items)) {
      return `[${items.map((item) => formatZodType(item)).join(", ")}]`;
    }
    return "tuple";
  }
  if (typeName === "record") {
    const valueType = formatZodType(def.valueType);
    return `Record<string, ${valueType}>`;
  }
  if (typeName === "any") return "any";
  if (typeName === "unknown") return "unknown";
  if (typeName === "null") return "null";
  if (typeName === "undefined") return "undefined";
  if (typeName === "void") return "void";
  if (typeName === "date") return "Date";
  if (schema.shape) {
    const shape = schema.shape;
    const resolvedShape = typeof shape === "function" ? shape() : shape;
    const inner = Object.entries(resolvedShape).map(([k, v]) => {
      const zodField = v;
      const desc = zodField.description;
      const typeStr = formatZodType(zodField);
      return `${k}: ${typeStr}${desc ? ` /* ${desc} */` : ""}`;
    }).join(", ");
    return `{ ${inner} }`;
  }
  return typeName ? `<${typeName}>` : "unknown";
}
function formatSchemaForInstructions(schema) {
  const shape = schema.shape;
  const lines = ["{"];
  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value;
    const desc = zodValue.description || "";
    const typeStr = formatZodType(zodValue);
    lines.push(`  "${key}": ${typeStr}${desc ? ` // ${desc}` : ""}`);
  }
  lines.push("}");
  return lines.join("\n");
}

"use strict";

"use strict";

"use strict";
function isUtf16Encoded(content) {
  const sample = content.slice(0, 200);
  let nullCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) {
      nullCount++;
    }
  }
  return nullCount > sample.length * 0.2;
}
function convertUtf16ToUtf8(content) {
  let result = content.replace(/\0/g, "");
  result = result.replace(/^[\uFFFE\uFEFF\uFFFD]+/, "");
  return result;
}
function normalizeEncoding(content) {
  if (isUtf16Encoded(content)) {
    return convertUtf16ToUtf8(content);
  }
  if (content.charCodeAt(0) === 65279) {
    return content.slice(1);
  }
  return content;
}
function isPatchContent(content) {
  return content.startsWith("diff --git ") || content.startsWith("--- ") || content.includes("\ndiff --git ") || content.includes("\n--- a/");
}
function cleanPatchBinaryData(content) {
  const lines = content.split("\n");
  const cleanedLines = [];
  let inBinarySection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("GIT binary patch")) {
      inBinarySection = true;
      cleanedLines.push("[Binary file patch omitted]");
      continue;
    }
    if (inBinarySection) {
      if (line.startsWith("diff --git ") || line.startsWith("-- ") || line === "") {
        if (line === "" && i + 1 < lines.length && lines[i + 1].startsWith("diff --git ")) {
          inBinarySection = false;
          cleanedLines.push(line);
        } else if (line.startsWith("diff --git ")) {
          inBinarySection = false;
          cleanedLines.push(line);
        }
        continue;
      }
      continue;
    }
    cleanedLines.push(line);
  }
  return cleanedLines.join("\n");
}
function preprocessFileContent(filePath, content) {
  let processed = normalizeEncoding(content);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".patch" || ext === ".diff" || isPatchContent(processed)) {
    processed = cleanPatchBinaryData(processed);
  }
  return processed;
}
const EXCLUDED_FILE_PATTERNS = {
  // Exact filenames to block (matched anywhere in path)
  filenames: [
    // JavaScript/Node lock files
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "npm-shrinkwrap.json",
    "bun.lockb",
    // Ruby
    "Gemfile.lock",
    // PHP
    "composer.lock",
    // Python
    "poetry.lock",
    "Pipfile.lock",
    "pdm.lock",
    "uv.lock",
    // Rust
    "Cargo.lock",
    // Go
    "go.sum",
    // .NET/NuGet
    "packages.lock.json",
    // Dart/Flutter
    "pubspec.lock",
    // Elixir
    "mix.lock",
    // Terraform
    ".terraform.lock.hcl",
    // Cocoapods
    "Podfile.lock",
    // Gradle
    "gradle.lockfile",
    // Custom
    "challenge-context.json",
    // Database dumps
    "dump.sql",
    "schema.sql",
    // IDE/Editor
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    // Migration lock files
    "migration_lock.toml"
  ],
  // File extensions to block
  extensions: [
    // Minified/bundled JavaScript
    ".min.js",
    ".min.css",
    ".bundle.js",
    ".chunk.js",
    // Source maps
    ".map",
    ".js.map",
    ".css.map",
    // Compiled/binary
    ".pyc",
    ".pyo",
    ".class",
    ".dll",
    ".exe",
    ".so",
    ".dylib",
    ".o",
    ".obj",
    ".wasm",
    // Archives
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".jar",
    ".war",
    ".ear",
    // Images (binary, not useful for code review)
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".webp",
    ".bmp",
    ".svg",
    ".tiff",
    ".psd",
    // Fonts
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    // Audio/Video
    ".mp3",
    ".mp4",
    ".wav",
    ".avi",
    ".mov",
    ".webm",
    // Documents (binary)
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    // Logs
    ".log",
    // SQLite databases
    ".sqlite",
    ".sqlite3",
    ".db",
    // Coverage reports (generated)
    ".lcov"
  ],
  // Directory names that block all files within
  directories: [
    // Package managers
    "node_modules",
    "bower_components",
    "jspm_packages",
    // Build outputs
    "dist",
    "build",
    "out",
    "output",
    "target",
    "bin",
    "obj",
    // Framework-specific build
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".vercel",
    ".netlify",
    ".turbo",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".tox",
    ".nox",
    ".pytest_cache",
    ".mypy_cache",
    "site-packages",
    "*.egg-info",
    // Ruby
    "vendor/bundle",
    // Coverage
    "coverage",
    ".nyc_output",
    "htmlcov",
    // IDE/Editor
    ".idea",
    ".vscode",
    ".vs",
    ".eclipse",
    // Version control
    ".git",
    ".svn",
    ".hg",
    // Terraform
    ".terraform",
    // macOS artifacts
    "__MACOSX",
    // Temporary
    "tmp",
    "temp",
    ".cache",
    ".parcel-cache",
    // Logs
    "logs"
  ]
};
function isExcludedFile(filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() || "";
  const pathSegments = normalizedPath.split("/");
  if (EXCLUDED_FILE_PATTERNS.filenames.includes(fileName)) {
    return true;
  }
  for (const ext of EXCLUDED_FILE_PATTERNS.extensions) {
    if (fileName.endsWith(ext)) {
      return true;
    }
  }
  for (const dir of EXCLUDED_FILE_PATTERNS.directories) {
    if (pathSegments.includes(dir)) {
      return true;
    }
  }
  return false;
}
const MAX_FILE_CONTENT_CHARS = 4e3;
const TRUNCATION_NOTICE_TEMPLATE = (lineCount, charCount) => `

[...TRUNCATED: File has ${lineCount} total lines, ${charCount} chars. Use workspace_evidence_search tool to find specific sections if needed.]`;
function truncateFileContent(content, filePath) {
  if (content.length <= MAX_FILE_CONTENT_CHARS) {
    return content;
  }
  const lines = content.split("\n");
  const lineCount = lines.length;
  const charCount = content.length;
  let truncateAt = MAX_FILE_CONTENT_CHARS;
  const lastNewline = content.lastIndexOf("\n", MAX_FILE_CONTENT_CHARS);
  if (lastNewline > MAX_FILE_CONTENT_CHARS * 0.8) {
    truncateAt = lastNewline;
  }
  const truncated = content.slice(0, truncateAt);
  const notice = TRUNCATION_NOTICE_TEMPLATE(lineCount, charCount);
  tcAILogger.debug(
    `[FilteredLocalFilesystem] Truncated ${filePath}: ${charCount} \u2192 ${truncated.length} chars (${lineCount} lines, saved ~${Math.round((charCount - truncated.length) / 4)} tokens)`
  );
  return truncated + notice;
}
function isVirtualSymbolPath(path2) {
  const colonIndex = path2.lastIndexOf(":");
  if (colonIndex <= 0) return false;
  if (colonIndex === 1 && /^[A-Za-z]$/.test(path2[0])) return false;
  const symbolPart = path2.slice(colonIndex + 1);
  return symbolPart.length > 0 && !symbolPart.includes("/") && !symbolPart.includes("\\");
}
function parseVirtualSymbolPath(path2) {
  if (!isVirtualSymbolPath(path2)) return null;
  const colonIndex = path2.lastIndexOf(":");
  return {
    filePath: path2.slice(0, colonIndex),
    symbolName: path2.slice(colonIndex + 1)
  };
}
class FilteredLocalFilesystem extends LocalFilesystem {
  symbolResolver = null;
  /**
   * Set the symbol resolver for handling virtual symbol paths.
   * Call this after the AST indexer is initialized.
   */
  setSymbolResolver(resolver) {
    this.symbolResolver = resolver;
    tcAILogger.info(`[FilteredLocalFilesystem] Symbol resolver registered`);
  }
  /**
   * Check if a path exists. For virtual symbol paths, check if the symbol exists.
   */
  async exists(path2) {
    const virtualPath = parseVirtualSymbolPath(path2);
    if (virtualPath) {
      if (this.symbolResolver) {
        const content = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
        if (content !== null) {
          return true;
        }
      }
      return super.exists(virtualPath.filePath);
    }
    return super.exists(path2);
  }
  /**
   * Get file stats. For virtual symbol paths, return synthetic stats.
   */
  async stat(path2) {
    const virtualPath = parseVirtualSymbolPath(path2);
    if (virtualPath) {
      if (this.symbolResolver) {
        const content = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
        if (content !== null) {
          return {
            name: virtualPath.symbolName,
            path: path2,
            type: "file",
            size: content.length,
            createdAt: /* @__PURE__ */ new Date(),
            modifiedAt: /* @__PURE__ */ new Date(),
            mimeType: "text/plain"
          };
        }
      }
      return super.stat(virtualPath.filePath);
    }
    return super.stat(path2);
  }
  async readFile(filePath, options) {
    const virtualPath = parseVirtualSymbolPath(filePath);
    if (virtualPath) {
      tcAILogger.debug(`[FilteredLocalFilesystem] Virtual symbol path detected: ${filePath}`);
      if (this.symbolResolver) {
        const symbolContent = this.symbolResolver(virtualPath.filePath, virtualPath.symbolName);
        if (symbolContent) {
          tcAILogger.debug(`[FilteredLocalFilesystem] Symbol resolved: ${virtualPath.symbolName}`);
          return symbolContent;
        }
      }
      tcAILogger.debug(`[FilteredLocalFilesystem] Symbol not found, reading file: ${virtualPath.filePath}`);
      return this.readFile(virtualPath.filePath, options);
    }
    if (isExcludedFile(filePath)) {
      tcAILogger.warn(`[FilteredLocalFilesystem] Blocked read of excluded file: ${filePath}`);
      throw new Error(
        `File "${filePath}" is excluded from reading. Lock files, minified bundles, and large generated files are not useful for code review. For dependency info, read package.json instead.`
      );
    }
    const content = await super.readFile(filePath, options);
    if (typeof content === "string") {
      const processed = preprocessFileContent(filePath, content);
      return truncateFileContent(processed, filePath);
    }
    return content;
  }
}
const autoIndexPatterns = [
  // Source code files handled by special AST based indexer.
  // 
  // '**/*.ts',
  // '**/*.tsx',
  // '**/*.js',
  // '**/*.jsx',
  // '**/*.mjs',
  // '**/*.cjs',
  // '**/*.py',
  // '**/*.java',
  // '**/*.go',
  // '**/*.rs',
  // '**/*.rb',
  // '**/*.php',
  // '**/*.cs',
  // '**/*.cpp',
  // '**/*.c',
  // '**/*.h',
  // '**/*.hpp',
  // '**/*.swift',
  // '**/*.kt',
  // '**/*.scala',
  // JSON config files - explicit whitelist (NO **/*.json to avoid lock files!)
  "**/package.json",
  "**/tsconfig.json",
  "**/jsconfig.json",
  "**/jest.config.json",
  "**/babel.config.json",
  "**/.eslintrc.json",
  "**/.prettierrc.json",
  "**/.babelrc.json",
  "**/nest-cli.json",
  "**/angular.json",
  // YAML config (exclude lock files via specific patterns)
  "**/*.yaml",
  "**/*.yml",
  // XML
  "**/*.xml",
  "**/pom.xml",
  // TOML (exclude lock files)
  "**/Cargo.toml",
  "**/pyproject.toml",
  "**/*.toml",
  // Database schema files
  "**/*.prisma",
  "**/*.sql",
  "**/*.dbml",
  "**/*.graphql",
  "**/*.gql",
  // Documentation
  "**/*.md",
  "**/*.txt",
  "**/*.rst",
  "**/*.adoc",
  // Patch/Diff files
  "**/*.patch",
  "**/*.diff",
  // Shell scripts
  "**/*.sh",
  "**/*.bash",
  "**/*.zsh",
  // Docker
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  // Env examples
  "**/*.env.example",
  "**/.env.example",
  "**/*.example",
  // Config JSON files in config directories
  "**/config/*.json",
  "**/constants.json",
  // Data and seed JSON files (common locations for seed/fixture data)
  "**/data/*.json",
  "**/seed/*.json",
  "**/seeds/*.json",
  "**/fixtures/*.json",
  "**/mock/*.json",
  "**/mocks/*.json",
  "**/testdata/*.json",
  // Git and CI files
  "**/.gitignore",
  "**/.gitattributes"
];

"use strict";
const DEFAULT_EMBED_CONCURRENCY = 8;
const DEFAULT_EMBED_TIMEOUT_MS = 3e4;
class EmbedTimeoutError extends Error {
  constructor(timeoutMs, source) {
    super(`Embedding request timed out after ${timeoutMs}ms${source ? ` (source: ${source})` : ""}`);
    this.name = "EmbedTimeoutError";
  }
}
function withTimeout(promise, timeoutMs, source) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new EmbedTimeoutError(timeoutMs, source));
    }, timeoutMs);
    promise.then((result) => {
      clearTimeout(timeoutId);
      resolve(result);
    }).catch((err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}
class EmbedderService {
  config;
  timeoutMs;
  concurrencyLimit;
  concurrency;
  usage = {
    totalTokens: 0,
    totalRequests: 0,
    totalChars: 0
  };
  timeoutCount = 0;
  constructor(config) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.concurrency = config.concurrency ?? DEFAULT_EMBED_CONCURRENCY;
    this.concurrencyLimit = pLimit(this.concurrency);
    tcAILogger.info(`[EmbedderService] Initialized with model: ${config.model}, dimensions: ${config.dimensions}, timeout: ${this.timeoutMs}ms, concurrency: ${this.concurrency}`);
  }
  // Track the last source being embedded for error logging
  lastEmbedSource = null;
  /**
   * Set the source context for the next embed call (for error logging).
   */
  setEmbedSource(source) {
    this.lastEmbedSource = source;
  }
  /**
   * Generate embedding for the given text.
   * Tracks token usage internally.
   */
  async embed(text) {
    const charCount = text.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    const source = this.lastEmbedSource;
    this.lastEmbedSource = null;
    try {
      const embedPromise = embed({
        model: ollama.embedding(this.config.model, {
          dimensions: this.config.dimensions
        }),
        value: text
      });
      const { embedding, usage } = await withTimeout(embedPromise, this.timeoutMs, source ?? void 0);
      const actualTokens = usage?.tokens ?? estimatedTokens;
      this.usage.totalTokens += actualTokens;
      this.usage.totalRequests += 1;
      this.usage.totalChars += charCount;
      tcAILogger.debug(
        `[EmbedderService] Embedded ${charCount} chars (~${actualTokens} tokens), total: ${this.usage.totalTokens} tokens in ${this.usage.totalRequests} requests`
      );
      return embedding;
    } catch (err) {
      const textPreview = text.length > 200 ? text.substring(0, 200) + "..." : text;
      if (err instanceof EmbedTimeoutError) {
        this.timeoutCount++;
        tcAILogger.warn(`[EmbedderService] Embedding timed out (${this.timeoutCount} total timeouts)`, {
          timeoutMs: this.timeoutMs,
          charCount,
          source: source ?? "unknown"
        });
      } else {
        tcAILogger.error(`[EmbedderService] Embedding failed`, {
          error: err,
          charCount,
          estimatedTokens,
          source: source ?? "unknown",
          textPreview
        });
      }
      throw err;
    }
  }
  /**
   * Embed multiple texts in parallel with concurrency control.
   * Returns embeddings in the same order as input texts.
   */
  async embedBatch(items) {
    if (items.length === 0) return [];
    tcAILogger.info(`[EmbedderService] Starting batch embed of ${items.length} items (concurrency: ${this.concurrency})`);
    let completed = 0;
    const results = await Promise.all(
      items.map(
        (item) => this.concurrencyLimit(async () => {
          try {
            if (item.source) {
              this.setEmbedSource(item.source);
            }
            const embedding = await this.embed(item.text);
            completed++;
            if (completed % 50 === 0 || completed === items.length) {
              tcAILogger.info(`[EmbedderService] Batch progress: ${completed}/${items.length}`);
            }
            return embedding;
          } catch {
            completed++;
            return null;
          }
        })
      )
    );
    const successCount = results.filter((r) => r !== null).length;
    tcAILogger.info(`[EmbedderService] Batch complete: ${successCount}/${items.length} successful`);
    return results;
  }
  /**
   * Get current token usage statistics.
   */
  getUsage() {
    return { ...this.usage };
  }
  /**
   * Set token usage values (useful for restoring state).
   */
  setUsage(usage) {
    if (usage.totalTokens !== void 0) {
      this.usage.totalTokens = usage.totalTokens;
    }
    if (usage.totalRequests !== void 0) {
      this.usage.totalRequests = usage.totalRequests;
    }
    if (usage.totalChars !== void 0) {
      this.usage.totalChars = usage.totalChars;
    }
    tcAILogger.debug(`[EmbedderService] Usage updated`, this.usage);
  }
  /**
   * Reset token usage counters.
   */
  resetUsage() {
    this.usage = {
      totalTokens: 0,
      totalRequests: 0,
      totalChars: 0
    };
    tcAILogger.info(`[EmbedderService] Usage counters reset`);
  }
  /**
   * Get the embedder function compatible with Mastra Workspace.
   * The returned function includes source tracking for error diagnostics.
   */
  getEmbedder() {
    return (text) => this.embed(text);
  }
  /**
   * Get an embedder function that tracks the source for error logging.
   * Use this when you know the source context (e.g., file path).
   */
  getEmbedderWithSource(source) {
    return (text) => {
      this.setEmbedSource(source);
      return this.embed(text);
    };
  }
  /**
   * Get the number of timeouts that have occurred.
   */
  getTimeoutCount() {
    return this.timeoutCount;
  }
  /**
   * Log current usage summary.
   */
  logUsageSummary() {
    const avgTokensPerRequest = this.usage.totalRequests > 0 ? (this.usage.totalTokens / this.usage.totalRequests).toFixed(1) : "0";
    const avgCharsPerRequest = this.usage.totalRequests > 0 ? (this.usage.totalChars / this.usage.totalRequests).toFixed(0) : "0";
    tcAILogger.info(`[EmbedderService] ========== Usage Summary ==========`);
    tcAILogger.info(`[EmbedderService] Total requests: ${this.usage.totalRequests}`);
    tcAILogger.info(`[EmbedderService] Total tokens: ${this.usage.totalTokens}`);
    tcAILogger.info(`[EmbedderService] Total chars: ${this.usage.totalChars}`);
    tcAILogger.info(`[EmbedderService] Avg tokens/request: ${avgTokensPerRequest}`);
    tcAILogger.info(`[EmbedderService] Avg chars/request: ${avgCharsPerRequest}`);
    if (this.timeoutCount > 0) {
      tcAILogger.warn(`[EmbedderService] Timeouts: ${this.timeoutCount}`);
    }
    tcAILogger.info(`[EmbedderService] ===================================`);
  }
}
const DEFAULT_EMBEDDER_CONFIG = {
  model: "nomic-embed-text-v2-moe:latest",
  dimensions: 768
};
let reviewEmbedderInstance = null;
function getReviewEmbedder(config = DEFAULT_EMBEDDER_CONFIG) {
  if (!reviewEmbedderInstance) {
    reviewEmbedderInstance = new EmbedderService(config);
  }
  return reviewEmbedderInstance;
}

"use strict";
function cleanPatchContent(content) {
  const normalized = normalizeEncoding(content);
  return cleanPatchBinaryData(normalized);
}
function preprocessContent(relativePath, content) {
  return preprocessFileContent(relativePath, content);
}
function extractExtensionsFromPatterns(patterns) {
  const extensions = /* @__PURE__ */ new Set();
  for (const pattern of patterns) {
    const match = pattern.match(/\*\.([a-zA-Z0-9]+)$/);
    if (match) {
      extensions.add(`.${match[1]}`);
    }
  }
  return extensions;
}
function matchesSpecificFilePattern(filename, patterns) {
  for (const pattern of patterns) {
    const filePattern = pattern.replace(/^\*\*\//, "").replace(/\*/g, ".*");
    if (new RegExp(`^${filePattern}$`).test(filename)) {
      return true;
    }
  }
  return false;
}
async function collectFiles(basePath, extensions, specificPatterns) {
  const files = [];
  async function walkDir(currentPath, relativePath) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_FILE_PATTERNS.directories.includes(entry.name)) {
          continue;
        }
        if (entry.name.startsWith(".") && entry.name !== ".github") {
          continue;
        }
        await walkDir(path.join(currentPath, entry.name), entryRelPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext) || matchesSpecificFilePattern(entry.name, specificPatterns)) {
          files.push(entryRelPath);
        }
      }
    }
  }
  await walkDir(basePath, "");
  return files;
}
async function indexWorkspace(workspace, options) {
  const { basePath, patterns = autoIndexPatterns, concurrency = 10 } = options;
  const startTime = Date.now();
  const stats = {
    totalFilesFound: 0,
    indexedFiles: 0,
    skippedFiles: 0,
    errorFiles: 0,
    totalBytes: 0,
    durationMs: 0,
    skippedReasons: {},
    errors: [],
    indexedFilesList: [],
    skippedFilesList: []
  };
  tcAILogger.info(`[WorkspaceIndexer] Starting indexing of workspace: ${basePath}`);
  tcAILogger.info(`[WorkspaceIndexer] Using ${patterns.length} patterns`);
  const extensions = extractExtensionsFromPatterns(patterns);
  const specificPatterns = patterns.filter((p) => !p.match(/\*\.[a-zA-Z0-9]+$/));
  tcAILogger.debug(`[WorkspaceIndexer] Extensions: ${Array.from(extensions).join(", ")}`);
  tcAILogger.debug(`[WorkspaceIndexer] Specific patterns: ${specificPatterns.length}`);
  const allFiles = await collectFiles(basePath, extensions, specificPatterns);
  stats.totalFilesFound = allFiles.length;
  tcAILogger.info(`[WorkspaceIndexer] Found ${stats.totalFilesFound} files matching patterns`);
  tcAILogger.info(`[WorkspaceIndexer] Concurrency limit: ${concurrency}`);
  const limit = pLimit(concurrency);
  let processedCount = 0;
  const indexingPromises = allFiles.map(
    (relativePath) => limit(async () => {
      const fullPath = path.join(basePath, relativePath);
      if (isExcludedFile(relativePath)) {
        stats.skippedFiles++;
        const reason = "excluded_pattern";
        stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
        stats.skippedFilesList.push({ file: relativePath, reason });
        processedCount++;
        return;
      }
      try {
        const rawContent = await fs.readFile(fullPath, "utf-8");
        const content = preprocessContent(relativePath, rawContent);
        const fileSize = Buffer.byteLength(content, "utf-8");
        if (content.trim().length === 0) {
          stats.skippedFiles++;
          const reason = "empty_file";
          stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
          stats.skippedFilesList.push({ file: relativePath, reason });
          processedCount++;
          return;
        }
        getReviewEmbedder().setEmbedSource(`file:${relativePath}`);
        await workspace.index(relativePath, content, {
          type: "file",
          metadata: {
            relativePath,
            size: fileSize,
            preprocessed: rawContent !== content
          }
        });
        stats.indexedFiles++;
        stats.totalBytes += fileSize;
        stats.indexedFilesList.push(relativePath);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("binary") || errorMessage.includes("encoding")) {
          stats.skippedFiles++;
          const reason = "binary_file";
          stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
          stats.skippedFilesList.push({ file: relativePath, reason });
          processedCount++;
          return;
        }
        stats.errorFiles++;
        stats.errors.push({ file: relativePath, error: errorMessage });
        tcAILogger.warn(`[WorkspaceIndexer] Error indexing: ${relativePath}`, { error: errorMessage });
      }
      processedCount++;
      if (processedCount % 100 === 0 || processedCount === allFiles.length) {
        tcAILogger.info(`[WorkspaceIndexer] Progress: ${processedCount}/${stats.totalFilesFound} files processed`);
      }
    })
  );
  await Promise.all(indexingPromises);
  stats.durationMs = Date.now() - startTime;
  tcAILogger.info(`[WorkspaceIndexer] ========== Indexing Complete ==========`);
  tcAILogger.info(`[WorkspaceIndexer] Duration: ${(stats.durationMs / 1e3).toFixed(2)}s`);
  tcAILogger.info(`[WorkspaceIndexer] Total files found: ${stats.totalFilesFound}`);
  tcAILogger.info(`[WorkspaceIndexer] Successfully indexed: ${stats.indexedFiles}`);
  tcAILogger.info(`[WorkspaceIndexer] Skipped: ${stats.skippedFiles}`);
  tcAILogger.info(`[WorkspaceIndexer] Errors: ${stats.errorFiles}`);
  tcAILogger.info(`[WorkspaceIndexer] Total size indexed: ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
  if (stats.indexedFilesList.length > 0) {
    tcAILogger.info(`[WorkspaceIndexer] Indexed files:`);
    for (const file of stats.indexedFilesList) {
      tcAILogger.info(`[WorkspaceIndexer]   + ${file}`);
    }
  }
  if (stats.skippedFilesList.length > 0) {
    tcAILogger.info(`[WorkspaceIndexer] Skipped files:`);
    for (const { file, reason } of stats.skippedFilesList) {
      tcAILogger.info(`[WorkspaceIndexer]   - ${file} (${reason})`);
    }
  }
  if (Object.keys(stats.skippedReasons).length > 0) {
    tcAILogger.info(`[WorkspaceIndexer] Skip reasons summary:`);
    for (const [reason, count] of Object.entries(stats.skippedReasons)) {
      tcAILogger.info(`[WorkspaceIndexer]   - ${reason}: ${count}`);
    }
  }
  if (stats.errors.length > 0 && stats.errors.length <= 10) {
    tcAILogger.warn(`[WorkspaceIndexer] Error details:`);
    for (const { file, error } of stats.errors) {
      tcAILogger.warn(`[WorkspaceIndexer]   ! ${file}: ${error}`);
    }
  } else if (stats.errors.length > 10) {
    tcAILogger.warn(`[WorkspaceIndexer] ${stats.errors.length} errors occurred (showing first 10):`);
    for (const { file, error } of stats.errors.slice(0, 10)) {
      tcAILogger.warn(`[WorkspaceIndexer]   ! ${file}: ${error}`);
    }
  }
  tcAILogger.info(`[WorkspaceIndexer] =======================================`);
  return stats;
}
function startBackgroundIndexing(workspace, options) {
  tcAILogger.info(`[WorkspaceIndexer] Starting background indexing...`);
  const indexingPromise = indexWorkspace(workspace, options).catch((err) => {
    tcAILogger.error(`[WorkspaceIndexer] Background indexing failed`, { error: err });
    throw err;
  });
  return indexingPromise;
}

"use strict";
const spanSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  startCol: z.number().int().min(0),
  endCol: z.number().int().min(0),
  startByte: z.number().int().min(0),
  endByte: z.number().int().min(0)
});
function generateSymbolId(filePath, symbolName, kind, line) {
  const input = `${filePath}:${symbolName}:${kind}:${line}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `sym_${Math.abs(hash).toString(36)}_${line}`;
}

"use strict";
const FUNCTION_LIKE_KINDS$2 = /* @__PURE__ */ new Set([
  "function",
  "async_function",
  "arrow_function",
  "generator_function",
  "method",
  "constructor",
  "getter",
  "setter",
  "lambda"
]);
const VARIABLE_LIKE_KINDS = /* @__PURE__ */ new Set([
  "variable",
  "constant",
  "let",
  "const",
  "var"
]);
const PROPERTY_LIKE_KINDS$2 = /* @__PURE__ */ new Set([
  "property",
  "field",
  "member"
]);
const CLASS_LIKE_KINDS = /* @__PURE__ */ new Set([
  "class",
  "abstract_class",
  "interface",
  "type_alias",
  "enum"
]);
function extractCallSignature(sourceCode, matchIndex) {
  let start = matchIndex;
  while (start > 0 && !["\n", ";", "{", "}"].includes(sourceCode[start - 1])) {
    start--;
  }
  let end = matchIndex;
  let parenDepth = 0;
  let foundOpenParen = false;
  while (end < sourceCode.length) {
    const char = sourceCode[end];
    if (char === "(") {
      parenDepth++;
      foundOpenParen = true;
    } else if (char === ")") {
      parenDepth--;
      if (foundOpenParen && parenDepth === 0) {
        end++;
        break;
      }
    } else if (char === "\n" && foundOpenParen && parenDepth === 0) {
      break;
    }
    end++;
  }
  let signature = sourceCode.slice(start, end).trim();
  if (signature.length > 100) {
    signature = signature.slice(0, 97) + "...";
  }
  return signature;
}
function getLineAndColumn(sourceCode, byteOffset) {
  const before = sourceCode.slice(0, byteOffset);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}
function findContainingSymbol(symbols, filePath, line) {
  const fileSymbols = symbols.filter(
    (s) => s.filePath === filePath && FUNCTION_LIKE_KINDS$2.has(s.kind) && s.span.startLine <= line && s.span.endLine >= line
  );
  if (fileSymbols.length === 0) return void 0;
  fileSymbols.sort((a, b) => {
    const aRange = a.span.endLine - a.span.startLine;
    const bRange = b.span.endLine - b.span.startLine;
    return aRange - bRange;
  });
  return fileSymbols[0].symbolName;
}
function findAllReferences(store, fileContents) {
  const referencesMap = /* @__PURE__ */ new Map();
  const allIndexedSymbols = store.query({});
  const functionsByName = /* @__PURE__ */ new Map();
  const variablesByName = /* @__PURE__ */ new Map();
  const classesByName = /* @__PURE__ */ new Map();
  const propertiesByName = /* @__PURE__ */ new Map();
  for (const symbol of allIndexedSymbols) {
    referencesMap.set(symbol.id, []);
    if (FUNCTION_LIKE_KINDS$2.has(symbol.kind)) {
      const existing = functionsByName.get(symbol.symbolName) || [];
      existing.push(symbol);
      functionsByName.set(symbol.symbolName, existing);
    } else if (VARIABLE_LIKE_KINDS.has(symbol.kind)) {
      const existing = variablesByName.get(symbol.symbolName) || [];
      existing.push(symbol);
      variablesByName.set(symbol.symbolName, existing);
    } else if (CLASS_LIKE_KINDS.has(symbol.kind)) {
      const existing = classesByName.get(symbol.symbolName) || [];
      existing.push(symbol);
      classesByName.set(symbol.symbolName, existing);
    } else if (PROPERTY_LIKE_KINDS$2.has(symbol.kind)) {
      const existing = propertiesByName.get(symbol.symbolName) || [];
      existing.push(symbol);
      propertiesByName.set(symbol.symbolName, existing);
    }
  }
  for (const [filePath, { sourceCode }] of fileContents) {
    findFunctionCallReferences(
      filePath,
      sourceCode,
      functionsByName,
      allIndexedSymbols,
      referencesMap
    );
    findIdentifierReferences(
      filePath,
      sourceCode,
      variablesByName,
      allIndexedSymbols,
      referencesMap
    );
    findClassReferences(
      filePath,
      sourceCode,
      classesByName,
      allIndexedSymbols,
      referencesMap
    );
    findPropertyReferences(
      filePath,
      sourceCode,
      propertiesByName,
      allIndexedSymbols,
      referencesMap
    );
  }
  return referencesMap;
}
function findFunctionCallReferences(filePath, sourceCode, functionsByName, allSymbols, referencesMap) {
  const callPattern = /(?:await\s+)?(?:\w+\.)?(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = callPattern.exec(sourceCode)) !== null) {
    const functionName = match[1];
    const candidates = functionsByName.get(functionName);
    if (!candidates || candidates.length === 0) continue;
    const { line, column } = getLineAndColumn(sourceCode, match.index);
    const callSignature = extractCallSignature(sourceCode, match.index);
    const containingSymbol = findContainingSymbol(allSymbols, filePath, line);
    for (const symbol of candidates) {
      if (symbol.filePath === filePath && symbol.span.startLine === line) continue;
      const refs = referencesMap.get(symbol.id) || [];
      refs.push({ filePath, line, column, callSignature, containingSymbol });
      referencesMap.set(symbol.id, refs);
    }
  }
}
function findIdentifierReferences(filePath, sourceCode, variablesByName, allSymbols, referencesMap) {
  for (const [varName, symbols] of variablesByName) {
    const identifierPattern = new RegExp(`\\b${escapeRegExp(varName)}\\b`, "g");
    let match;
    while ((match = identifierPattern.exec(sourceCode)) !== null) {
      const { line, column } = getLineAndColumn(sourceCode, match.index);
      let isDefinition = false;
      for (const symbol of symbols) {
        if (symbol.filePath === filePath && line >= symbol.span.startLine && line <= symbol.span.endLine && symbol.span.startLine === line) {
          isDefinition = true;
          break;
        }
      }
      if (isDefinition) continue;
      const callSignature = extractCallSignature(sourceCode, match.index);
      const containingSymbol = findContainingSymbol(allSymbols, filePath, line);
      const sameFileSymbols = symbols.filter((s) => s.filePath === filePath);
      const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;
      for (const symbol of targetSymbols) {
        const refs = referencesMap.get(symbol.id) || [];
        refs.push({ filePath, line, column, callSignature, containingSymbol });
        referencesMap.set(symbol.id, refs);
      }
    }
  }
}
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findClassReferences(filePath, sourceCode, classesByName, allSymbols, referencesMap) {
  for (const [className, symbols] of classesByName) {
    const patterns = [
      new RegExp(`\\bnew\\s+${escapeRegExp(className)}\\s*(?:<[^>]*>)?\\s*\\(`, "g"),
      // new Class()
      new RegExp(`\\bextends\\s+${escapeRegExp(className)}\\b`, "g"),
      // extends Class
      new RegExp(`\\bimplements\\s+[\\w,\\s]*\\b${escapeRegExp(className)}\\b`, "g"),
      // implements Interface
      new RegExp(`:\\s*${escapeRegExp(className)}\\b`, "g"),
      // : Type
      new RegExp(`<${escapeRegExp(className)}\\b`, "g"),
      // <Generic>
      new RegExp(`\\bas\\s+${escapeRegExp(className)}\\b`, "g")
      // as Type
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const { line, column } = getLineAndColumn(sourceCode, match.index);
        let isDefinition = false;
        for (const symbol of symbols) {
          if (symbol.filePath === filePath && symbol.span.startLine === line) {
            isDefinition = true;
            break;
          }
        }
        if (isDefinition) continue;
        const callSignature = extractCallSignature(sourceCode, match.index);
        const containingSymbol = findContainingSymbol(allSymbols, filePath, line);
        const sameFileSymbols = symbols.filter((s) => s.filePath === filePath);
        const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;
        for (const symbol of targetSymbols) {
          const refs = referencesMap.get(symbol.id) || [];
          if (!refs.some((r) => r.filePath === filePath && r.line === line)) {
            refs.push({ filePath, line, column, callSignature, containingSymbol });
            referencesMap.set(symbol.id, refs);
          }
        }
      }
    }
  }
}
function findPropertyReferences(filePath, sourceCode, propertiesByName, allSymbols, referencesMap) {
  for (const [propName, symbols] of propertiesByName) {
    const patterns = [
      new RegExp(`\\bthis\\.${escapeRegExp(propName)}\\b`, "g"),
      // this.prop
      new RegExp(`\\bself\\.${escapeRegExp(propName)}\\b`, "g"),
      // self.prop (Python)
      new RegExp(`\\.${escapeRegExp(propName)}\\b(?!\\s*[:(])`, "g")
      // obj.prop (not method call)
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const { line, column } = getLineAndColumn(sourceCode, match.index);
        let isDefinition = false;
        for (const symbol of symbols) {
          if (symbol.filePath === filePath && symbol.span.startLine === line) {
            isDefinition = true;
            break;
          }
        }
        if (isDefinition) continue;
        const callSignature = extractCallSignature(sourceCode, match.index);
        const containingSymbol = findContainingSymbol(allSymbols, filePath, line);
        const sameFileSymbols = symbols.filter((s) => s.filePath === filePath);
        const targetSymbols = sameFileSymbols.length > 0 ? sameFileSymbols : symbols;
        for (const symbol of targetSymbols) {
          const refs = referencesMap.get(symbol.id) || [];
          if (!refs.some((r) => r.filePath === filePath && r.line === line)) {
            refs.push({ filePath, line, column, callSignature, containingSymbol });
            referencesMap.set(symbol.id, refs);
          }
        }
      }
    }
  }
}
function attachReferencesToSymbols(store, referencesMap) {
  for (const [symbolId, references] of referencesMap) {
    const symbol = store.getSymbol(symbolId);
    if (symbol) {
      symbol.references = references;
    }
  }
}
function formatReferences(references) {
  if (!references || references.length === 0) {
    return "[NO REFERENCES FOUND]";
  }
  const lines = [`References (${references.length}):`];
  for (const ref of references) {
    const location = `${ref.filePath}:${ref.line}:${ref.column}`;
    const context = ref.containingSymbol ? ` in ${ref.containingSymbol}()` : "";
    lines.push(`  - ${location}${context}`);
    lines.push(`    ${ref.callSignature}`);
  }
  return lines.join("\n");
}

"use strict";
const LOGGING_PATTERNS = {
  typescript: [
    // Console methods
    /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table|group|groupEnd|time|timeEnd|assert)\s*\(/g,
    // Common logger frameworks
    /\blogger\s*\.\s*(log|info|warn|error|debug|trace|verbose|silly)\s*\(/g,
    /\bwinston\s*\.\s*(log|info|warn|error|debug)\s*\(/g,
    /\bpino\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    /\bbunyan\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    /\blog4js\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    // Debug module
    /\bdebug\s*\(/g
  ],
  javascript: [
    // Console methods
    /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table|group|groupEnd|time|timeEnd|assert)\s*\(/g,
    // Common logger frameworks
    /\blogger\s*\.\s*(log|info|warn|error|debug|trace|verbose|silly)\s*\(/g,
    /\bwinston\s*\.\s*(log|info|warn|error|debug)\s*\(/g,
    /\bpino\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    /\bbunyan\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    /\blog4js\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    // Debug module
    /\bdebug\s*\(/g
  ],
  python: [
    // Built-in print
    /\bprint\s*\(/g,
    // Logging module
    /\blogging\s*\.\s*(info|warning|error|debug|critical|exception|log)\s*\(/g,
    /\blogger\s*\.\s*(info|warning|error|debug|critical|exception|log)\s*\(/g,
    // Common frameworks
    /\bloguru\s*\.\s*(info|warning|error|debug|critical|trace|success)\s*\(/g,
    /\bstructlog\s*\.\s*(info|warning|error|debug|critical)\s*\(/g
  ],
  java: [
    // System.out/err
    /\bSystem\s*\.\s*(out|err)\s*\.\s*(print|println|printf)\s*\(/g,
    // SLF4J / Log4j / java.util.logging
    /\blogger\s*\.\s*(info|warn|error|debug|trace|fatal|log|fine|finer|finest|severe|warning)\s*\(/g,
    /\bLOGGER\s*\.\s*(info|warn|error|debug|trace|fatal|log)\s*\(/g,
    /\blog\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/g,
    // Log4j2
    /\bLogManager\s*\.\s*getLogger\s*\(/g
  ]
};
const ERROR_HANDLING_PATTERNS = {
  typescript: [
    /\btry\s*\{/g,
    /\bcatch\s*\(/g,
    /\bfinally\s*\{/g,
    /\.catch\s*\(/g,
    /\bonError\s*[=:]/g
  ],
  javascript: [
    /\btry\s*\{/g,
    /\bcatch\s*\(/g,
    /\bfinally\s*\{/g,
    /\.catch\s*\(/g,
    /\bonError\s*[=:]/g
  ],
  python: [
    /\btry\s*:/g,
    /\bexcept\s*/g,
    /\bfinally\s*:/g,
    /\braise\s+/g
  ],
  java: [
    /\btry\s*\{/g,
    /\bcatch\s*\(/g,
    /\bfinally\s*\{/g,
    /\bthrows\s+/g
  ]
};
function detectLogging(code, language) {
  const patterns = LOGGING_PATTERNS[language];
  if (!patterns) {
    return false;
  }
  const cleanedCode = removeStringsAndComments$1(code, language);
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(cleanedCode)) {
      return true;
    }
  }
  return false;
}
function detectErrorHandling(code, language) {
  const patterns = ERROR_HANDLING_PATTERNS[language];
  if (!patterns) {
    return false;
  }
  const cleanedCode = removeStringsAndComments$1(code, language);
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(cleanedCode)) {
      return true;
    }
  }
  return false;
}
function countLoggingStatements(code, language) {
  const patterns = LOGGING_PATTERNS[language];
  if (!patterns) {
    return 0;
  }
  const cleanedCode = removeStringsAndComments$1(code, language);
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = cleanedCode.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}
function removeStringsAndComments$1(code, language) {
  let cleaned = code;
  if (language === "python") {
    cleaned = cleaned.replace(/#[^\n]*/g, "");
    cleaned = cleaned.replace(/'''[\s\S]*?'''/g, "");
    cleaned = cleaned.replace(/"""[\s\S]*?"""/g, "");
  } else {
    cleaned = cleaned.replace(/\/\/[^\n]*/g, "");
  }
  if (language !== "python") {
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  }
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return cleaned;
}
function getLoggingPatterns(language) {
  return LOGGING_PATTERNS[language] || [];
}
function getErrorHandlingPatterns(language) {
  return ERROR_HANDLING_PATTERNS[language] || [];
}

"use strict";
class StructuredIndexStore {
  symbols = /* @__PURE__ */ new Map();
  files = /* @__PURE__ */ new Map();
  // Secondary indexes for fast lookups
  symbolsByFile = /* @__PURE__ */ new Map();
  symbolsByName = /* @__PURE__ */ new Map();
  symbolsByKind = /* @__PURE__ */ new Map();
  symbolsByLanguage = /* @__PURE__ */ new Map();
  exportedSymbols = /* @__PURE__ */ new Set();
  stats = {
    totalFiles: 0,
    totalSymbols: 0,
    byLanguage: {},
    byKind: {},
    indexTimeMs: 0,
    lastUpdated: 0
  };
  /**
   * Add or update a symbol in the index
   */
  addSymbol(symbol) {
    const existing = this.symbols.get(symbol.id);
    if (existing) {
      this.removeFromSecondaryIndexes(existing);
    }
    this.symbols.set(symbol.id, symbol);
    this.addToSecondaryIndexes(symbol);
  }
  /**
   * Add multiple symbols at once
   */
  addSymbols(symbols) {
    for (const symbol of symbols) {
      this.addSymbol(symbol);
    }
  }
  /**
   * Add or update a file entry
   */
  addFile(file) {
    this.files.set(file.filePath, file);
  }
  /**
   * Remove all symbols for a file
   */
  removeFile(filePath) {
    const symbolIds = this.symbolsByFile.get(filePath);
    if (symbolIds) {
      for (const id of symbolIds) {
        const symbol = this.symbols.get(id);
        if (symbol) {
          this.removeFromSecondaryIndexes(symbol);
          this.symbols.delete(id);
        }
      }
    }
    this.symbolsByFile.delete(filePath);
    this.files.delete(filePath);
  }
  /**
   * Get a symbol by ID
   */
  getSymbol(id) {
    return this.symbols.get(id);
  }
  /**
   * Get all symbols for a file
   */
  getSymbolsForFile(filePath) {
    const symbolIds = this.symbolsByFile.get(filePath);
    if (!symbolIds) return [];
    const symbols = [];
    for (const id of symbolIds) {
      const symbol = this.symbols.get(id);
      if (symbol) {
        symbols.push(symbol);
      }
    }
    return symbols;
  }
  /**
   * Get file entry
   */
  getFile(filePath) {
    return this.files.get(filePath);
  }
  /**
   * Query symbols with filters
   */
  query(options) {
    let candidates;
    if (options.name) {
      candidates = this.intersect(candidates, this.symbolsByName.get(options.name));
    }
    if (options.filePath) {
      candidates = this.intersect(candidates, this.symbolsByFile.get(options.filePath));
    }
    if (options.kind) {
      const kinds = Array.isArray(options.kind) ? options.kind : [options.kind];
      const kindCandidates = /* @__PURE__ */ new Set();
      for (const kind of kinds) {
        const ids = this.symbolsByKind.get(kind);
        if (ids) {
          for (const id of ids) kindCandidates.add(id);
        }
      }
      candidates = this.intersect(candidates, kindCandidates);
    }
    if (options.language) {
      candidates = this.intersect(candidates, this.symbolsByLanguage.get(options.language));
    }
    if (options.isExported === true) {
      candidates = this.intersect(candidates, this.exportedSymbols);
    }
    const searchSet = candidates ?? new Set(this.symbols.keys());
    const results = [];
    for (const id of searchSet) {
      const symbol = this.symbols.get(id);
      if (!symbol) continue;
      if (options.namePattern && !options.namePattern.test(symbol.symbolName)) continue;
      if (options.hasLogging !== void 0 && symbol.metrics.hasLogging !== options.hasLogging) continue;
      if (options.minComplexity !== void 0 && symbol.metrics.complexity < options.minComplexity) continue;
      if (options.maxComplexity !== void 0 && symbol.metrics.complexity > options.maxComplexity) continue;
      if (options.implementsOrExtends && !symbol.implementsOrExtends?.includes(options.implementsOrExtends)) continue;
      if (options.isExported === false && symbol.isExported) continue;
      results.push(symbol);
      if (options.limit && results.length >= options.limit) break;
    }
    return results;
  }
  /**
   * Find symbols by exact name
   */
  findByName(name) {
    return this.query({ name });
  }
  /**
   * Find symbols by kind
   */
  findByKind(kind) {
    return this.query({ kind });
  }
  /**
   * Find all classes/interfaces that implement or extend a given name
   */
  findImplementors(baseNameOrInterface) {
    return this.query({
      kind: ["class", "abstract_class"],
      implementsOrExtends: baseNameOrInterface
    });
  }
  /**
   * Find all exported symbols
   */
  findExported() {
    return this.query({ isExported: true });
  }
  /**
   * Find high complexity symbols
   */
  findHighComplexity(threshold = 10) {
    return this.query({ minComplexity: threshold });
  }
  /**
   * Find symbols with logging
   */
  findWithLogging() {
    return this.query({ hasLogging: true });
  }
  /**
   * Get all file paths in the index
   */
  getFilePaths() {
    return Array.from(this.files.keys());
  }
  /**
   * Get all symbols
   */
  getAllSymbols() {
    return Array.from(this.symbols.values());
  }
  /**
   * Get index statistics
   */
  getStats() {
    return {
      totalFiles: this.files.size,
      totalSymbols: this.symbols.size,
      byLanguage: this.countByLanguage(),
      byKind: this.countByKind(),
      indexTimeMs: this.stats.indexTimeMs,
      lastUpdated: this.stats.lastUpdated
    };
  }
  /**
   * Update stats after indexing
   */
  updateStats(indexTimeMs) {
    this.stats.indexTimeMs = indexTimeMs;
    this.stats.lastUpdated = Date.now();
  }
  /**
   * Clear the entire index
   */
  clear() {
    this.symbols.clear();
    this.files.clear();
    this.symbolsByFile.clear();
    this.symbolsByName.clear();
    this.symbolsByKind.clear();
    this.symbolsByLanguage.clear();
    this.exportedSymbols.clear();
    this.stats = {
      totalFiles: 0,
      totalSymbols: 0,
      byLanguage: {},
      byKind: {},
      indexTimeMs: 0,
      lastUpdated: 0
    };
  }
  /**
   * Export index to JSON
   */
  exportToJSON() {
    const data = {
      version: 1,
      exportedAt: Date.now(),
      symbols: Array.from(this.symbols.values()),
      files: Array.from(this.files.values()),
      stats: this.getStats()
    };
    return JSON.stringify(data, null, 2);
  }
  /**
   * Import index from JSON
   */
  importFromJSON(json) {
    try {
      const data = JSON.parse(json);
      if (data.version !== 1) {
        throw new Error(`Unsupported index version: ${data.version}`);
      }
      this.clear();
      for (const symbol of data.symbols || []) {
        this.addSymbol(symbol);
      }
      for (const file of data.files || []) {
        this.addFile(file);
      }
      if (data.stats) {
        this.stats.indexTimeMs = data.stats.indexTimeMs || 0;
        this.stats.lastUpdated = data.stats.lastUpdated || Date.now();
      }
      tcAILogger.info(`[StructuredIndexStore] Imported ${this.symbols.size} symbols from ${this.files.size} files`);
    } catch (err) {
      tcAILogger.error(`[StructuredIndexStore] Failed to import index`, { error: err });
      throw err;
    }
  }
  // --- Private helpers ---
  addToSecondaryIndexes(symbol) {
    if (!this.symbolsByFile.has(symbol.filePath)) {
      this.symbolsByFile.set(symbol.filePath, /* @__PURE__ */ new Set());
    }
    this.symbolsByFile.get(symbol.filePath).add(symbol.id);
    if (!this.symbolsByName.has(symbol.symbolName)) {
      this.symbolsByName.set(symbol.symbolName, /* @__PURE__ */ new Set());
    }
    this.symbolsByName.get(symbol.symbolName).add(symbol.id);
    if (!this.symbolsByKind.has(symbol.kind)) {
      this.symbolsByKind.set(symbol.kind, /* @__PURE__ */ new Set());
    }
    this.symbolsByKind.get(symbol.kind).add(symbol.id);
    if (!this.symbolsByLanguage.has(symbol.language)) {
      this.symbolsByLanguage.set(symbol.language, /* @__PURE__ */ new Set());
    }
    this.symbolsByLanguage.get(symbol.language).add(symbol.id);
    if (symbol.isExported) {
      this.exportedSymbols.add(symbol.id);
    }
  }
  removeFromSecondaryIndexes(symbol) {
    this.symbolsByFile.get(symbol.filePath)?.delete(symbol.id);
    this.symbolsByName.get(symbol.symbolName)?.delete(symbol.id);
    this.symbolsByKind.get(symbol.kind)?.delete(symbol.id);
    this.symbolsByLanguage.get(symbol.language)?.delete(symbol.id);
    this.exportedSymbols.delete(symbol.id);
  }
  intersect(a, b) {
    if (!a) return b;
    if (!b) return a;
    const result = /* @__PURE__ */ new Set();
    for (const id of a) {
      if (b.has(id)) {
        result.add(id);
      }
    }
    return result;
  }
  countByLanguage() {
    const counts = {};
    for (const [lang, ids] of this.symbolsByLanguage) {
      counts[lang] = ids.size;
    }
    return counts;
  }
  countByKind() {
    const counts = {};
    for (const [kind, ids] of this.symbolsByKind) {
      counts[kind] = ids.size;
    }
    return counts;
  }
}

"use strict";
class DependencyTracker {
  // file -> files it imports from
  imports = /* @__PURE__ */ new Map();
  // file -> files that import it (reverse mapping)
  dependents = /* @__PURE__ */ new Map();
  // file -> exported symbol names
  exports = /* @__PURE__ */ new Map();
  /**
   * Register file dependencies from indexed file data
   */
  registerFile(file, resolvedImports) {
    const filePath = file.filePath;
    this.clearFile(filePath);
    const importSet = new Set(resolvedImports);
    this.imports.set(filePath, importSet);
    for (const importedFile of resolvedImports) {
      if (!this.dependents.has(importedFile)) {
        this.dependents.set(importedFile, /* @__PURE__ */ new Set());
      }
      this.dependents.get(importedFile).add(filePath);
    }
    const exportSet = new Set(file.exports);
    this.exports.set(filePath, exportSet);
  }
  /**
   * Clear all dependency info for a file
   */
  clearFile(filePath) {
    const oldImports = this.imports.get(filePath);
    if (oldImports) {
      for (const importedFile of oldImports) {
        this.dependents.get(importedFile)?.delete(filePath);
      }
    }
    this.imports.delete(filePath);
    this.exports.delete(filePath);
  }
  /**
   * Get all files that depend on the given file (import from it)
   */
  getDependents(filePath) {
    return Array.from(this.dependents.get(filePath) || []);
  }
  /**
   * Get all files that the given file imports from
   */
  getImports(filePath) {
    return Array.from(this.imports.get(filePath) || []);
  }
  /**
   * Get exported symbols for a file
   */
  getExports(filePath) {
    return Array.from(this.exports.get(filePath) || []);
  }
  /**
   * Get all files that need re-indexing when a file changes.
   * Returns the changed file plus all its dependents (recursively).
   */
  getAffectedFiles(changedFile, maxDepth = 3) {
    const affected = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const traverse = (file, depth) => {
      if (depth > maxDepth || visited.has(file)) return;
      visited.add(file);
      affected.add(file);
      const deps = this.dependents.get(file);
      if (deps) {
        for (const dep of deps) {
          traverse(dep, depth + 1);
        }
      }
    };
    traverse(changedFile, 0);
    return Array.from(affected);
  }
  /**
   * Check if file A depends on file B (directly or indirectly)
   */
  dependsOn(fileA, fileB, maxDepth = 5) {
    const visited = /* @__PURE__ */ new Set();
    const check = (current, depth) => {
      if (depth > maxDepth || visited.has(current)) return false;
      if (current === fileB) return true;
      visited.add(current);
      const imports = this.imports.get(current);
      if (imports) {
        for (const imp of imports) {
          if (check(imp, depth + 1)) return true;
        }
      }
      return false;
    };
    return check(fileA, 0);
  }
  /**
   * Get dependency statistics
   */
  getStats() {
    const totalFiles = this.imports.size;
    let totalImports = 0;
    let totalDependents = 0;
    let maxDeps = { file: "", count: 0 };
    for (const [, imports] of this.imports) {
      totalImports += imports.size;
    }
    for (const [file, deps] of this.dependents) {
      totalDependents += deps.size;
      if (deps.size > maxDeps.count) {
        maxDeps = { file, count: deps.size };
      }
    }
    return {
      totalFiles,
      avgImports: totalFiles > 0 ? totalImports / totalFiles : 0,
      avgDependents: totalFiles > 0 ? totalDependents / totalFiles : 0,
      maxDependents: maxDeps.count > 0 ? maxDeps : null
    };
  }
  /**
   * Clear all tracked dependencies
   */
  clear() {
    this.imports.clear();
    this.dependents.clear();
    this.exports.clear();
  }
  /**
   * Export to JSON for persistence
   */
  exportToJSON() {
    const data = {
      imports: Object.fromEntries(
        Array.from(this.imports.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      exports: Object.fromEntries(
        Array.from(this.exports.entries()).map(([k, v]) => [k, Array.from(v)])
      )
    };
    return JSON.stringify(data, null, 2);
  }
  /**
   * Import from JSON
   */
  importFromJSON(json) {
    try {
      const data = JSON.parse(json);
      this.clear();
      for (const [file, imports] of Object.entries(data.imports || {})) {
        const importSet = new Set(imports);
        this.imports.set(file, importSet);
        for (const importedFile of importSet) {
          if (!this.dependents.has(importedFile)) {
            this.dependents.set(importedFile, /* @__PURE__ */ new Set());
          }
          this.dependents.get(importedFile).add(file);
        }
      }
      for (const [file, exports] of Object.entries(data.exports || {})) {
        this.exports.set(file, new Set(exports));
      }
      tcAILogger.info(`[DependencyTracker] Imported dependencies for ${this.imports.size} files`);
    } catch (err) {
      tcAILogger.error(`[DependencyTracker] Failed to import dependencies`, { error: err });
      throw err;
    }
  }
}
function resolveImportPath(importSource, fromFile, fileExists) {
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null;
  }
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf("/"));
  let resolved = importSource;
  if (importSource.startsWith("./")) {
    resolved = `${fromDir}/${importSource.slice(2)}`;
  } else if (importSource.startsWith("../")) {
    const parts = fromDir.split("/");
    const importParts = importSource.split("/");
    let upCount = 0;
    for (const part of importParts) {
      if (part === "..") upCount++;
      else break;
    }
    const baseParts = parts.slice(0, -upCount);
    const restParts = importParts.slice(upCount);
    resolved = [...baseParts, ...restParts].join("/");
  }
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

"use strict";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = dirname(__filename$1);
const require$1 = createRequire(import.meta.url);
function findPackagePath(packageName) {
  try {
    const packageJsonPath = require$1.resolve(`${packageName}/package.json`);
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}
function findGrammarPath(grammarName) {
  const wasmsPackagePath = findPackagePath("tree-sitter-wasms");
  if (wasmsPackagePath) {
    const wasmPath = resolve(wasmsPackagePath, "out", `${grammarName}.wasm`);
    if (existsSync(wasmPath)) {
      return wasmPath;
    }
  }
  const possiblePaths = [
    // tree-sitter-wasms package (pre-built grammars)
    resolve(__dirname$1, "../../../../node_modules/tree-sitter-wasms/out", `${grammarName}.wasm`),
    // Individual grammar packages
    resolve(__dirname$1, "../../../../node_modules", grammarName, `${grammarName}.wasm`),
    resolve(__dirname$1, "../../../../node_modules", grammarName, "tree-sitter.wasm"),
    // Pre-built grammars directory (if we bundle them)
    resolve(__dirname$1, "../grammars", `${grammarName}.wasm`)
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}
function findTreeSitterWasmPath() {
  const webTreeSitterPath = findPackagePath("web-tree-sitter");
  if (webTreeSitterPath) {
    const wasmPath = resolve(webTreeSitterPath, "tree-sitter.wasm");
    if (existsSync(wasmPath)) {
      return wasmPath;
    }
  }
  const possiblePaths = [
    resolve(__dirname$1, "../../../../node_modules/web-tree-sitter/tree-sitter.wasm"),
    resolve(__dirname$1, "../../../../../node_modules/web-tree-sitter/tree-sitter.wasm")
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}
class TreeSitterRuntime {
  static instance = null;
  initialized = false;
  initializing = null;
  grammars = /* @__PURE__ */ new Map();
  loadingGrammars = /* @__PURE__ */ new Map();
  initTimeMs = 0;
  // Private constructor for singleton pattern
  constructor() {
  }
  /**
   * Get the singleton runtime instance
   */
  static getInstance() {
    if (!TreeSitterRuntime.instance) {
      TreeSitterRuntime.instance = new TreeSitterRuntime();
    }
    return TreeSitterRuntime.instance;
  }
  /**
   * Reset the singleton (primarily for testing)
   */
  static reset() {
    if (TreeSitterRuntime.instance) {
      TreeSitterRuntime.instance.grammars.clear();
      TreeSitterRuntime.instance.loadingGrammars.clear();
      TreeSitterRuntime.instance.initialized = false;
      TreeSitterRuntime.instance.initializing = null;
    }
    TreeSitterRuntime.instance = null;
  }
  /**
   * Initialize the Tree-sitter WASM runtime.
   * Must be called before any parsing operations.
   * Safe to call multiple times - will only initialize once.
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }
    const startTime = performance.now();
    this.initializing = (async () => {
      try {
        const wasmPath = findTreeSitterWasmPath();
        if (!wasmPath) {
          throw new Error("Could not find web-tree-sitter WASM binary. Ensure web-tree-sitter is installed.");
        }
        await Parser.init({
          locateFile: (scriptName) => {
            if (scriptName === "tree-sitter.wasm") {
              return wasmPath;
            }
            return scriptName;
          }
        });
        this.initialized = true;
        this.initTimeMs = performance.now() - startTime;
      } catch (error) {
        this.initializing = null;
        const message = `Failed to initialize Tree-sitter: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(message, { cause: error });
      }
    })();
    return this.initializing;
  }
  /**
   * Check if the runtime is initialized
   */
  isInitialized() {
    return this.initialized;
  }
  /**
   * Get initialization time in milliseconds
   */
  getInitTimeMs() {
    return this.initTimeMs;
  }
  /**
   * Load a grammar for the specified language.
   * Grammars are cached after first load.
   */
  async loadGrammar(language) {
    if (!this.initialized) {
      await this.initialize();
    }
    const cached = this.grammars.get(language);
    if (cached) {
      return cached;
    }
    const loading = this.loadingGrammars.get(language);
    if (loading) {
      return loading;
    }
    const grammarMap = {
      typescript: "tree-sitter-typescript",
      javascript: "tree-sitter-javascript",
      python: "tree-sitter-python",
      java: "tree-sitter-java"
    };
    const grammarName = grammarMap[language];
    const loadPromise = (async () => {
      try {
        const grammarPath = findGrammarPath(grammarName);
        if (!grammarPath) {
          console.warn(`[tree-sitter] Grammar not found for ${language}. Install ${grammarName} package.`);
          return null;
        }
        const grammar = await Parser.Language.load(grammarPath);
        this.grammars.set(language, grammar);
        return grammar;
      } catch (error) {
        console.warn(`[tree-sitter] Failed to load grammar for ${language}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        this.loadingGrammars.delete(language);
      }
    })();
    this.loadingGrammars.set(language, loadPromise);
    return loadPromise;
  }
  /**
   * Create a new parser instance configured for the specified language.
   */
  async createParser(language) {
    const grammar = await this.loadGrammar(language);
    if (!grammar) {
      return null;
    }
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  }
  /**
   * Parse source code and return the syntax tree.
   */
  async parse(sourceCode, language) {
    const parser = await this.createParser(language);
    if (!parser) {
      return null;
    }
    try {
      return parser.parse(sourceCode);
    } catch (error) {
      console.warn(`[tree-sitter] Parse error for ${language}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  /**
   * Get list of loaded grammars
   */
  getLoadedGrammars() {
    return Array.from(this.grammars.keys());
  }
}
function getTreeSitterRuntime() {
  return TreeSitterRuntime.getInstance();
}

"use strict";
const FUNCTION_LIKE_KINDS$1 = /* @__PURE__ */ new Set([
  "function",
  "async_function",
  "arrow_function",
  "generator_function",
  "method",
  "constructor",
  "getter",
  "setter",
  "lambda",
  "iife"
]);
const PROPERTY_LIKE_KINDS$1 = /* @__PURE__ */ new Set(["property", "constant", "variable"]);
const CALL_TARGET_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "function",
  "class",
  "typeof",
  "super",
  "await",
  "yield",
  "throw",
  "else",
  "elif",
  "def",
  "lambda",
  "print"
]);
class BaseParser {
  language;
  parser = null;
  constructor(language) {
    this.language = language;
  }
  /**
   * Initialize the parser with Tree-sitter grammar
   */
  async initialize() {
    const runtime = getTreeSitterRuntime();
    this.parser = await runtime.createParser(this.language);
    return this.parser !== null;
  }
  /**
   * Check if parser is initialized
   */
  isInitialized() {
    return this.parser !== null;
  }
  /**
   * Get the language this parser handles
   */
  getLanguage() {
    return this.language;
  }
  /**
   * Parse source code and extract AST metadata
   */
  async parse(sourceCode) {
    if (!this.parser) {
      const initialized = await this.initialize();
      if (!initialized) {
        return null;
      }
    }
    const startTime = performance.now();
    try {
      const tree = this.parser.parse(sourceCode);
      if (!tree || !tree.rootNode) {
        return null;
      }
      const symbols = this.extractSymbols(tree.rootNode, sourceCode);
      const imports = this.extractImports(tree.rootNode, sourceCode);
      const exports = this.extractExports(tree.rootNode, sourceCode);
      const callSites = this.extractCallSites(tree.rootNode, sourceCode);
      const errors = this.extractErrors(tree.rootNode, sourceCode);
      const parseTimeMs = performance.now() - startTime;
      const totalLines = sourceCode.split("\n").length;
      const functionKinds = /* @__PURE__ */ new Set(["function", "async_function", "arrow_function", "generator_function", "method", "constructor", "lambda"]);
      const classKinds = /* @__PURE__ */ new Set(["class", "abstract_class", "interface"]);
      return {
        language: this.language,
        symbols,
        imports,
        exports,
        callSites: callSites.length > 0 ? callSites : void 0,
        errors: errors.length > 0 ? errors : void 0,
        metrics: {
          totalLines,
          symbolCount: symbols.length,
          functionCount: this.countSymbolsByKind(symbols, functionKinds),
          classCount: this.countSymbolsByKind(symbols, classKinds),
          importCount: imports.length,
          exportCount: exports.length
        },
        parseTimeMs
      };
    } catch (error) {
      console.error(`[${this.language}-parser] Parse error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        language: this.language,
        symbols: [],
        imports: [],
        exports: [],
        errors: [{
          message: error instanceof Error ? error.message : String(error),
          severity: "error"
        }],
        metrics: {
          totalLines: sourceCode.split("\n").length,
          symbolCount: 0,
          functionCount: 0,
          classCount: 0,
          importCount: 0,
          exportCount: 0
        },
        parseTimeMs: performance.now() - startTime
      };
    }
  }
  /**
   * Count symbols by kinds
   */
  countSymbolsByKind(symbols, kinds) {
    let count = 0;
    for (const symbol of symbols) {
      if (kinds.has(symbol.kind)) {
        count++;
      }
      if (symbol.members) {
        count += this.countSymbolsByKind(symbol.members, kinds);
      }
    }
    return count;
  }
  /**
   * Extract location from a Tree-sitter node
   */
  extractLocation(node) {
    return {
      line: node.startPosition.row + 1,
      // Convert to 1-based
      column: node.startPosition.column,
      startByte: node.startIndex,
      endByte: node.endIndex
    };
  }
  /**
   * Get text content of a node
   */
  getNodeText(node, sourceCode) {
    return sourceCode.slice(node.startIndex, node.endIndex);
  }
  /**
   * Normalize source text for compact review summaries.
   */
  normalizeBodyText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  /**
   * Resolve the body node for a declaration.
   */
  findBodyNode(node, fallbackTypes = []) {
    const bodyNode = this.findChildByField(node, "body");
    if (bodyNode) {
      return bodyNode;
    }
    for (const type of fallbackTypes) {
      const child = this.findChild(node, type);
      if (child) {
        return child;
      }
    }
    return null;
  }
  /**
   * Approximate the number of top-level statements in a body node.
   */
  countBodyStatements(bodyNode) {
    const ignoredTypes = /* @__PURE__ */ new Set(["{", "}", "(", ")", ":", ";", ","]);
    const relevantChildren = bodyNode.children.filter((child) => !ignoredTypes.has(child.type));
    return relevantChildren.length > 0 ? relevantChildren.length : this.normalizeBodyText(bodyNode.text).length > 0 ? 1 : 0;
  }
  /**
   * Extract a set of likely call targets from raw body text.
   * Increased limit from 8 to 25 to capture diverse call patterns in large functions
   * (e.g., migration files with op.create_table, op.create_index, etc.)
   */
  extractCallTargetsFromText(bodyText) {
    const matches = bodyText.matchAll(/\b([A-Za-z_][\w.$]*)\s*\(/g);
    const targets = /* @__PURE__ */ new Set();
    for (const match of matches) {
      const candidate = match[1];
      if (!candidate || CALL_TARGET_KEYWORDS.has(candidate)) {
        continue;
      }
      targets.add(candidate);
      if (targets.size >= 25) {
        break;
      }
    }
    return Array.from(targets);
  }
  /**
   * Build deterministic review metadata for function and method bodies.
   */
  buildSymbolBody(node, sourceCode, fallbackBodyTypes = []) {
    const bodyNode = this.findBodyNode(node, fallbackBodyTypes);
    if (!bodyNode) {
      return void 0;
    }
    const declarationText = this.getNodeText(node, sourceCode);
    const bodyText = this.getNodeText(bodyNode, sourceCode);
    const normalizedBodyText = this.normalizeBodyText(bodyText);
    const statementCount = this.countBodyStatements(bodyNode);
    const callTargets = this.extractCallTargetsFromText(bodyText);
    const summaryParts = [];
    summaryParts.push(`Contains ${statementCount} top-level ${statementCount === 1 ? "statement" : "statements"}`);
    if (/\breturn\b|\byield\b/.test(bodyText)) {
      summaryParts.push("returns or yields a value");
    }
    if (/\bif\b|\bswitch\b|\bmatch\b|\belif\b/.test(bodyText)) {
      summaryParts.push("uses branching logic");
    }
    if (/\bfor\b|\bwhile\b/.test(bodyText)) {
      summaryParts.push("uses iteration");
    }
    if (callTargets.length > 0) {
      summaryParts.push(`calls ${callTargets.slice(0, 3).join(", ")}`);
    }
    return {
      declarationText,
      bodyText,
      normalizedBodyText,
      statementCount,
      callTargets: callTargets.length > 0 ? callTargets : void 0,
      rawLogicSummary: summaryParts.join("; ")
    };
  }
  /**
   * Build deterministic review metadata for class, interface, and enum bodies.
   */
  buildClassBody(node, sourceCode, members, fallbackBodyTypes = []) {
    const bodyNode = this.findBodyNode(node, fallbackBodyTypes);
    if (!bodyNode) {
      return void 0;
    }
    const bodyText = this.getNodeText(bodyNode, sourceCode);
    const methodNames = members.filter((member) => FUNCTION_LIKE_KINDS$1.has(member.kind)).map((member) => member.name);
    const methodCount = methodNames.length;
    const propertyCount = members.filter((member) => PROPERTY_LIKE_KINDS$1.has(member.kind)).length;
    const summaryParts = [
      `Defines ${members.length} ${members.length === 1 ? "member" : "members"}`
    ];
    if (methodCount > 0) {
      summaryParts.push(`${methodCount} function-like ${methodCount === 1 ? "member" : "members"}`);
    }
    if (propertyCount > 0) {
      summaryParts.push(`${propertyCount} property-like ${propertyCount === 1 ? "member" : "members"}`);
    }
    if (methodNames.length > 0) {
      summaryParts.push(`key methods: ${methodNames.slice(0, 4).join(", ")}`);
    }
    return {
      bodyText,
      normalizedBodyText: this.normalizeBodyText(bodyText),
      memberCount: members.length,
      methodCount,
      propertyCount,
      methodNames: methodNames.length > 0 ? methodNames : void 0,
      rawLogicSummary: summaryParts.join("; ")
    };
  }
  /**
   * Find child node by type
   */
  findChild(node, type) {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }
  /**
   * Find all children by type
   */
  findChildren(node, type) {
    return node.children.filter((child) => child.type === type);
  }
  /**
   * Find child node by field name
   */
  findChildByField(node, fieldName) {
    return node.childForFieldName(fieldName);
  }
  /**
   * Recursively find all descendant nodes of a specific type
   */
  findDescendants(node, type) {
    const results = [];
    const walk = (n) => {
      if (n.type === type) {
        results.push(n);
      }
      for (const child of n.children) {
        walk(child);
      }
    };
    walk(node);
    return results;
  }
  /**
   * Find all descendant nodes matching any of the given types
   */
  findDescendantsOfTypes(node, types) {
    const typeSet = new Set(types);
    const results = [];
    const walk = (n) => {
      if (typeSet.has(n.type)) {
        results.push(n);
      }
      for (const child of n.children) {
        walk(child);
      }
    };
    walk(node);
    return results;
  }
  /**
   * Check if node has error
   */
  hasError(node) {
    return node.hasError;
  }
  /**
   * Extract syntax errors from the tree
   */
  extractErrors(rootNode, sourceCode) {
    const errors = [];
    const walk = (node) => {
      if (node.type === "ERROR" || node.isMissing) {
        errors.push({
          message: node.isMissing ? `Missing expected token` : `Syntax error at "${this.getNodeText(node, sourceCode).slice(0, 50)}"`,
          location: this.extractLocation(node),
          severity: "error"
        });
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(rootNode);
    return errors;
  }
}

"use strict";
const extensionToLanguage = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".java": "java"
};
class ParserRegistry {
  static instance = null;
  parsers = /* @__PURE__ */ new Map();
  // Private constructor for singleton pattern
  constructor() {
  }
  /**
   * Get the singleton registry instance
   */
  static getInstance() {
    if (!ParserRegistry.instance) {
      ParserRegistry.instance = new ParserRegistry();
    }
    return ParserRegistry.instance;
  }
  /**
   * Reset the singleton (primarily for testing)
   */
  static reset() {
    if (ParserRegistry.instance) {
      ParserRegistry.instance.parsers.clear();
    }
    ParserRegistry.instance = null;
  }
  /**
   * Register a parser for a specific language
   */
  registerParser(language, parser) {
    this.parsers.set(language, parser);
  }
  /**
   * Get parser for a specific language
   */
  getParserForLanguage(language) {
    return this.parsers.get(language) || null;
  }
  /**
   * Detect language from file extension
   */
  detectLanguage(fileExtension) {
    const ext = fileExtension.toLowerCase().startsWith(".") ? fileExtension.toLowerCase() : `.${fileExtension.toLowerCase()}`;
    return extensionToLanguage[ext] || null;
  }
  /**
   * Get language from file path
   */
  getLanguageFromPath(filePath) {
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot === -1 || lastDot === filePath.length - 1) {
      return null;
    }
    const extension = filePath.slice(lastDot).toLowerCase();
    return this.detectLanguage(extension);
  }
  /**
   * Get parser for a file based on extension
   */
  getParser(fileExtension) {
    const language = this.detectLanguage(fileExtension);
    if (!language) {
      console.warn(`[parser-registry] Unsupported file extension: ${fileExtension}`);
      return null;
    }
    const parser = this.parsers.get(language);
    if (!parser) {
      console.warn(`[parser-registry] No parser registered for language: ${language}`);
      return null;
    }
    return parser;
  }
  /**
   * Get parser for a file path
   */
  getParserForPath(filePath) {
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot === -1 || lastDot === filePath.length - 1) {
      console.warn(`[parser-registry] Cannot determine extension for: ${filePath}`);
      return null;
    }
    const extension = filePath.slice(lastDot);
    return this.getParser(extension);
  }
  /**
   * Parse source code from a file path
   */
  async parseFile(filePath, sourceCode) {
    const parser = this.getParserForPath(filePath);
    if (!parser) {
      return null;
    }
    try {
      return await parser.parse(sourceCode);
    } catch (error) {
      console.error(`[parser-registry] Error parsing ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  /**
   * Check if a file extension is supported
   */
  isSupported(fileExtension) {
    return this.detectLanguage(fileExtension) !== null;
  }
  /**
   * Check if a file path is supported
   */
  isPathSupported(filePath) {
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot === -1 || lastDot === filePath.length - 1) {
      return false;
    }
    const extension = filePath.slice(lastDot);
    return this.isSupported(extension);
  }
  /**
   * Get all supported extensions
   */
  getSupportedExtensions() {
    return Object.keys(extensionToLanguage);
  }
  /**
   * Get all registered languages
   */
  getRegisteredLanguages() {
    return Array.from(this.parsers.keys());
  }
  /**
   * Check if a language has a registered parser
   */
  hasParser(language) {
    return this.parsers.has(language);
  }
}
function getParserRegistry() {
  return ParserRegistry.getInstance();
}

"use strict";
class TypeScriptParser extends BaseParser {
  constructor() {
    super("typescript");
  }
  extractSymbols(rootNode, sourceCode) {
    const symbols = [];
    for (const child of rootNode.children) {
      const extracted = this.extractSymbolFromNode(child, sourceCode, false);
      if (extracted) {
        symbols.push(...Array.isArray(extracted) ? extracted : [extracted]);
      }
    }
    return symbols;
  }
  extractSymbolFromNode(node, sourceCode, isExported) {
    if (node.type === "export_statement") {
      const declaration = this.findChild(node, "function_declaration") || this.findChild(node, "class_declaration") || this.findChild(node, "interface_declaration") || this.findChild(node, "type_alias_declaration") || this.findChild(node, "enum_declaration") || this.findChild(node, "lexical_declaration") || this.findChild(node, "variable_declaration") || this.findChild(node, "abstract_class_declaration");
      if (declaration) {
        const extracted = this.extractSymbolFromNode(declaration, sourceCode, true);
        return extracted;
      }
      return null;
    }
    switch (node.type) {
      case "function_declaration":
      case "function_signature":
        return this.extractFunction(node, sourceCode, isExported);
      case "generator_function_declaration":
        return this.extractGeneratorFunction(node, sourceCode, isExported);
      case "class_declaration":
        return this.extractClass(node, sourceCode, isExported, false);
      case "abstract_class_declaration":
        return this.extractClass(node, sourceCode, isExported, true);
      case "interface_declaration":
        return this.extractInterface(node, sourceCode, isExported);
      case "type_alias_declaration":
        return this.extractTypeAlias(node, sourceCode, isExported);
      case "enum_declaration":
        return this.extractEnum(node, sourceCode, isExported);
      case "lexical_declaration":
      case "variable_declaration":
        return this.extractVariables(node, sourceCode, isExported);
      default:
        return null;
    }
  }
  extractFunction(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const isAsync = node.children.some((c) => c.type === "async");
    const typeParams = this.extractTypeParameters(node, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    const returnType = this.extractReturnType(node, sourceCode);
    return {
      name,
      kind: isAsync ? "async_function" : "function",
      location: this.extractLocation(node),
      signature: this.buildFunctionSignature(name, params, returnType, isAsync, typeParams),
      isExported,
      isAsync,
      parameters: params,
      returnType,
      typeParameters: typeParams.length > 0 ? typeParams : void 0,
      body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
    };
  }
  extractGeneratorFunction(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    const returnType = this.extractReturnType(node, sourceCode);
    return {
      name,
      kind: "generator_function",
      location: this.extractLocation(node),
      signature: `function* ${name}(${params.map((p) => p.name).join(", ")})`,
      isExported,
      parameters: params,
      returnType,
      body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
    };
  }
  extractClass(node, sourceCode, isExported, isAbstract) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const typeParams = this.extractTypeParameters(node, sourceCode);
    let extendsType;
    const heritageClause = this.findChild(node, "class_heritage");
    if (heritageClause) {
      const extendsClause = this.findChild(heritageClause, "extends_clause");
      if (extendsClause) {
        const typeNode = extendsClause.children.find((c) => c.type !== "extends");
        if (typeNode) {
          extendsType = this.getNodeText(typeNode, sourceCode);
        }
      }
    }
    const implementsList = [];
    if (heritageClause) {
      const implementsClause = this.findChild(heritageClause, "implements_clause");
      if (implementsClause) {
        for (const child of implementsClause.children) {
          if (child.type !== "implements" && child.type !== ",") {
            implementsList.push(this.getNodeText(child, sourceCode));
          }
        }
      }
    }
    const members = [];
    const bodyNode = this.findChild(node, "class_body");
    if (bodyNode) {
      for (const member of bodyNode.children) {
        const extracted = this.extractClassMember(member, sourceCode);
        if (extracted) {
          members.push(extracted);
        }
      }
    }
    return {
      name,
      kind: isAbstract ? "abstract_class" : "class",
      location: this.extractLocation(node),
      isExported,
      isAbstract,
      typeParameters: typeParams.length > 0 ? typeParams : void 0,
      extends: extendsType,
      implements: implementsList.length > 0 ? implementsList : void 0,
      classBody: this.buildClassBody(node, sourceCode, members, ["class_body"]),
      members: members.length > 0 ? members : void 0
    };
  }
  extractClassMember(node, sourceCode) {
    const visibility = this.extractVisibility(node);
    const isStatic = node.children.some((c) => c.type === "static");
    const isAbstract = node.children.some((c) => c.type === "abstract");
    switch (node.type) {
      case "method_definition":
      case "method_signature": {
        const nameNode = this.findChildByField(node, "name");
        if (!nameNode) return null;
        const name = this.getNodeText(nameNode, sourceCode);
        const isAsync = node.children.some((c) => c.type === "async");
        const isGetter = node.children.some((c) => c.type === "get");
        const isSetter = node.children.some((c) => c.type === "set");
        const params = this.extractParameters(node, sourceCode);
        const returnType = this.extractReturnType(node, sourceCode);
        let kind = "method";
        if (isGetter) kind = "getter";
        else if (isSetter) kind = "setter";
        else if (name === "constructor") kind = "constructor";
        else if (isAsync) kind = "async_function";
        return {
          name,
          kind,
          location: this.extractLocation(node),
          signature: this.buildFunctionSignature(name, params, returnType, isAsync),
          visibility,
          isStatic,
          isAbstract,
          isAsync,
          parameters: params,
          returnType,
          body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
        };
      }
      case "public_field_definition":
      case "property_signature": {
        const nameNode = this.findChildByField(node, "name");
        if (!nameNode) return null;
        const name = this.getNodeText(nameNode, sourceCode);
        const typeAnnotation = this.findChild(node, "type_annotation");
        const type = typeAnnotation ? this.getNodeText(typeAnnotation, sourceCode).replace(/^:\s*/, "") : void 0;
        return {
          name,
          kind: "property",
          location: this.extractLocation(node),
          visibility,
          isStatic,
          returnType: type
        };
      }
      default:
        return null;
    }
  }
  extractInterface(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const typeParams = this.extractTypeParameters(node, sourceCode);
    const extendsList = [];
    const extendsClause = this.findChild(node, "extends_type_clause");
    if (extendsClause) {
      for (const child of extendsClause.children) {
        if (child.type !== "extends" && child.type !== ",") {
          extendsList.push(this.getNodeText(child, sourceCode));
        }
      }
    }
    const members = [];
    const bodyNode = this.findChild(node, "interface_body") || this.findChild(node, "object_type");
    if (bodyNode) {
      for (const member of bodyNode.children) {
        if (member.type === "property_signature" || member.type === "method_signature") {
          const extracted = this.extractClassMember(member, sourceCode);
          if (extracted) {
            members.push(extracted);
          }
        }
      }
    }
    return {
      name,
      kind: "interface",
      location: this.extractLocation(node),
      isExported,
      typeParameters: typeParams.length > 0 ? typeParams : void 0,
      implements: extendsList.length > 0 ? extendsList : void 0,
      classBody: this.buildClassBody(node, sourceCode, members, ["interface_body", "object_type"]),
      members: members.length > 0 ? members : void 0
    };
  }
  extractTypeAlias(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const typeParams = this.extractTypeParameters(node, sourceCode);
    return {
      name,
      kind: "type_alias",
      location: this.extractLocation(node),
      isExported,
      typeParameters: typeParams.length > 0 ? typeParams : void 0
    };
  }
  extractEnum(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    return {
      name,
      kind: "enum",
      location: this.extractLocation(node),
      isExported,
      classBody: this.buildClassBody(node, sourceCode, [], ["enum_body"])
    };
  }
  extractVariables(node, sourceCode, isExported) {
    const symbols = [];
    const isConst = node.children.some((c) => c.type === "const");
    const declarators = this.findChildren(node, "variable_declarator");
    for (const declarator of declarators) {
      const nameNode = this.findChildByField(declarator, "name");
      if (!nameNode) continue;
      const name = this.getNodeText(nameNode, sourceCode);
      const valueNode = this.findChildByField(declarator, "value");
      if (valueNode && valueNode.type === "arrow_function") {
        const isAsync = valueNode.children.some((c) => c.type === "async");
        const params = this.extractArrowFunctionParameters(valueNode, sourceCode);
        const returnType = this.extractReturnType(valueNode, sourceCode);
        symbols.push({
          name,
          kind: isAsync ? "async_function" : "arrow_function",
          location: this.extractLocation(declarator),
          signature: this.buildFunctionSignature(name, params, returnType, isAsync),
          isExported,
          isAsync,
          parameters: params,
          returnType,
          body: this.buildSymbolBody(valueNode, sourceCode, ["statement_block"])
        });
      } else {
        symbols.push({
          name,
          kind: isConst ? "constant" : "variable",
          location: this.extractLocation(declarator),
          isExported
        });
      }
    }
    return symbols;
  }
  extractArrowFunctionParameters(node, sourceCode) {
    const params = [];
    const singleParam = this.findChildByField(node, "parameter");
    if (singleParam && singleParam.type === "identifier") {
      params.push({ name: this.getNodeText(singleParam, sourceCode) });
      return params;
    }
    const paramsNode = this.findChildByField(node, "parameters") || this.findChild(node, "formal_parameters");
    if (paramsNode) {
      return this.extractParametersFromNode(paramsNode, sourceCode);
    }
    return params;
  }
  extractParameters(node, sourceCode) {
    const paramsNode = this.findChildByField(node, "parameters") || this.findChild(node, "formal_parameters");
    if (!paramsNode) return [];
    return this.extractParametersFromNode(paramsNode, sourceCode);
  }
  extractParametersFromNode(paramsNode, sourceCode) {
    const params = [];
    for (const child of paramsNode.children) {
      if (child.type === "required_parameter" || child.type === "optional_parameter" || child.type === "rest_parameter") {
        const pattern = this.findChildByField(child, "pattern") || this.findChild(child, "identifier");
        if (pattern) {
          const name = this.getNodeText(pattern, sourceCode);
          const typeAnnotation = this.findChild(child, "type_annotation");
          const type = typeAnnotation ? this.getNodeText(typeAnnotation, sourceCode).replace(/^:\s*/, "") : void 0;
          params.push({
            name,
            type,
            isOptional: child.type === "optional_parameter",
            isRest: child.type === "rest_parameter"
          });
        }
      } else if (child.type === "identifier") {
        params.push({ name: this.getNodeText(child, sourceCode) });
      }
    }
    return params;
  }
  extractReturnType(node, sourceCode) {
    const returnType = this.findChild(node, "type_annotation");
    if (returnType) {
      return this.getNodeText(returnType, sourceCode).replace(/^:\s*/, "");
    }
    return void 0;
  }
  extractTypeParameters(node, sourceCode) {
    const typeParams = this.findChild(node, "type_parameters");
    if (!typeParams) return [];
    const params = [];
    for (const child of typeParams.children) {
      if (child.type === "type_parameter") {
        const nameNode = this.findChildByField(child, "name") || this.findChild(child, "type_identifier");
        if (nameNode) {
          params.push(this.getNodeText(nameNode, sourceCode));
        }
      }
    }
    return params;
  }
  extractVisibility(node) {
    for (const child of node.children) {
      if (child.type === "accessibility_modifier") {
        const text = child.text;
        if (text === "public") return "public";
        if (text === "private") return "private";
        if (text === "protected") return "protected";
      }
    }
    return void 0;
  }
  buildFunctionSignature(name, params, returnType, isAsync, typeParams) {
    const asyncPrefix = isAsync ? "async " : "";
    const genericPart = typeParams?.length ? `<${typeParams.join(", ")}>` : "";
    const paramsPart = params.map((p) => {
      let str = p.isRest ? `...${p.name}` : p.name;
      if (p.isOptional) str += "?";
      if (p.type) str += `: ${p.type}`;
      return str;
    }).join(", ");
    const returnPart = returnType ? `: ${returnType}` : "";
    return `${asyncPrefix}function ${name}${genericPart}(${paramsPart})${returnPart}`;
  }
  extractImports(rootNode, sourceCode) {
    const imports = [];
    const importNodes = this.findDescendants(rootNode, "import_statement");
    for (const node of importNodes) {
      const importData = this.parseImportStatement(node, sourceCode);
      if (importData) {
        imports.push(importData);
      }
    }
    return imports;
  }
  parseImportStatement(node, sourceCode) {
    const sourceNode = this.findChild(node, "string");
    if (!sourceNode) return null;
    const source = this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "");
    const location = this.extractLocation(node);
    const isRelative = source.startsWith(".") || source.startsWith("/");
    const importClause = this.findChild(node, "import_clause");
    if (!importClause) {
      return {
        source,
        kind: "side_effect",
        location,
        isRelative
      };
    }
    const isTypeOnly = node.children.some((c) => c.type === "type");
    const defaultImport = this.findChild(importClause, "identifier");
    const namedImports = this.findChild(importClause, "named_imports");
    const namespaceImport = this.findChild(importClause, "namespace_import");
    if (namespaceImport) {
      const asNode = this.findChild(namespaceImport, "identifier");
      return {
        source,
        kind: isTypeOnly ? "type_only" : "namespace",
        namespaceName: asNode ? this.getNodeText(asNode, sourceCode) : "*",
        location,
        isRelative
      };
    }
    if (defaultImport && !namedImports) {
      return {
        source,
        kind: isTypeOnly ? "type_only" : "default",
        defaultName: this.getNodeText(defaultImport, sourceCode),
        location,
        isRelative
      };
    }
    const symbols = [];
    if (defaultImport) {
      symbols.push({ name: "default", alias: this.getNodeText(defaultImport, sourceCode) });
    }
    if (namedImports) {
      for (const specifier of namedImports.children) {
        if (specifier.type === "import_specifier") {
          const nameNode = this.findChildByField(specifier, "name");
          const aliasNode = this.findChildByField(specifier, "alias");
          if (nameNode) {
            symbols.push({
              name: this.getNodeText(nameNode, sourceCode),
              alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : void 0
            });
          }
        }
      }
    }
    return {
      source,
      kind: isTypeOnly ? "type_only" : "named",
      symbols: symbols.length > 0 ? symbols : void 0,
      defaultName: defaultImport ? this.getNodeText(defaultImport, sourceCode) : void 0,
      location,
      isRelative
    };
  }
  extractExports(rootNode, sourceCode) {
    const exports = [];
    const exportNodes = this.findDescendants(rootNode, "export_statement");
    for (const node of exportNodes) {
      const exportData = this.parseExportStatement(node, sourceCode);
      if (exportData) {
        exports.push(exportData);
      }
    }
    return exports;
  }
  parseExportStatement(node, sourceCode) {
    const location = this.extractLocation(node);
    const isTypeOnly = node.children.some((c) => c.type === "type");
    const exportClause = this.findChild(node, "export_clause");
    const sourceNode = this.findChild(node, "string");
    if (node.children.some((c) => c.type === "*")) {
      return {
        kind: "re_export",
        source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "") : void 0,
        location
      };
    }
    if (node.children.some((c) => c.type === "default")) {
      const declaration2 = node.children.find(
        (c) => c.type !== "export" && c.type !== "default" && c.type !== ";"
      );
      return {
        kind: "default",
        defaultName: declaration2 ? this.getNodeText(declaration2, sourceCode).slice(0, 50) : "default",
        location
      };
    }
    if (exportClause) {
      const symbols = [];
      for (const specifier of exportClause.children) {
        if (specifier.type === "export_specifier") {
          const nameNode = this.findChildByField(specifier, "name");
          const aliasNode = this.findChildByField(specifier, "alias");
          if (nameNode) {
            symbols.push({
              name: this.getNodeText(nameNode, sourceCode),
              alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : void 0
            });
          }
        }
      }
      return {
        kind: isTypeOnly ? "type_only" : sourceNode ? "re_export" : "named",
        symbols: symbols.length > 0 ? symbols : void 0,
        source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "") : void 0,
        location
      };
    }
    const declaration = this.findChild(node, "function_declaration") || this.findChild(node, "class_declaration") || this.findChild(node, "interface_declaration") || this.findChild(node, "type_alias_declaration") || this.findChild(node, "enum_declaration") || this.findChild(node, "lexical_declaration") || this.findChild(node, "variable_declaration");
    if (declaration) {
      const nameNode = this.findChildByField(declaration, "name");
      if (nameNode) {
        return {
          kind: isTypeOnly ? "type_only" : "named",
          symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
          location
        };
      }
      const declarators = this.findChildren(declaration, "variable_declarator");
      const symbols = declarators.map((d) => this.findChildByField(d, "name")).filter((n) => n !== null).map((n) => ({ name: this.getNodeText(n, sourceCode) }));
      if (symbols.length > 0) {
        return {
          kind: isTypeOnly ? "type_only" : "named",
          symbols,
          location
        };
      }
    }
    return null;
  }
  extractCallSites(rootNode, sourceCode) {
    const callSites = [];
    const callNodes = this.findDescendantsOfTypes(rootNode, ["call_expression", "new_expression"]);
    for (const node of callNodes) {
      const callSite = this.parseCallExpression(node, sourceCode);
      if (callSite) {
        callSites.push(callSite);
      }
    }
    return callSites;
  }
  parseCallExpression(node, sourceCode) {
    const functionNode = this.findChildByField(node, "function");
    if (!functionNode) return null;
    const location = this.extractLocation(node);
    const argsNode = this.findChildByField(node, "arguments");
    const argCount = argsNode ? argsNode.children.filter((c) => c.type !== "(" && c.type !== ")" && c.type !== ",").length : 0;
    if (functionNode.type === "member_expression") {
      const object = this.findChildByField(functionNode, "object");
      const property = this.findChildByField(functionNode, "property");
      if (property) {
        return {
          callee: this.getNodeText(property, sourceCode),
          location,
          isMethodCall: true,
          receiver: object ? this.getNodeText(object, sourceCode) : void 0,
          arguments: argCount
        };
      }
    }
    if (functionNode.type === "identifier") {
      return {
        callee: this.getNodeText(functionNode, sourceCode),
        location,
        isMethodCall: false,
        arguments: argCount
      };
    }
    return null;
  }
}

"use strict";
class JavaScriptParser extends BaseParser {
  constructor() {
    super("javascript");
  }
  extractSymbols(rootNode, sourceCode) {
    const symbols = [];
    for (const child of rootNode.children) {
      const extracted = this.extractSymbolFromNode(child, sourceCode, false);
      if (extracted) {
        symbols.push(...Array.isArray(extracted) ? extracted : [extracted]);
      }
    }
    return symbols;
  }
  extractSymbolFromNode(node, sourceCode, isExported) {
    if (node.type === "export_statement") {
      const declaration = this.findChild(node, "function_declaration") || this.findChild(node, "class_declaration") || this.findChild(node, "lexical_declaration") || this.findChild(node, "variable_declaration");
      if (declaration) {
        return this.extractSymbolFromNode(declaration, sourceCode, true);
      }
      return null;
    }
    switch (node.type) {
      case "function_declaration":
        return this.extractFunction(node, sourceCode, isExported);
      case "generator_function_declaration":
        return this.extractGeneratorFunction(node, sourceCode, isExported);
      case "class_declaration":
        return this.extractClass(node, sourceCode, isExported);
      case "lexical_declaration":
      case "variable_declaration":
        return this.extractVariables(node, sourceCode, isExported);
      case "expression_statement":
        return this.extractExpressionStatement(node, sourceCode);
      default:
        return null;
    }
  }
  extractFunction(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const isAsync = node.children.some((c) => c.type === "async");
    const params = this.extractParameters(node, sourceCode);
    return {
      name,
      kind: isAsync ? "async_function" : "function",
      location: this.extractLocation(node),
      signature: this.buildFunctionSignature(name, params, isAsync),
      isExported,
      isAsync,
      parameters: params,
      body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
    };
  }
  extractGeneratorFunction(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    return {
      name,
      kind: "generator_function",
      location: this.extractLocation(node),
      signature: `function* ${name}(${params.map((p) => p.name).join(", ")})`,
      isExported,
      parameters: params,
      body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
    };
  }
  extractClass(node, sourceCode, isExported) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    let extendsType;
    const heritageNode = this.findChild(node, "class_heritage");
    if (heritageNode) {
      const extendsNode = heritageNode.children.find((c) => c.type !== "extends");
      if (extendsNode) {
        extendsType = this.getNodeText(extendsNode, sourceCode);
      }
    }
    const members = [];
    const bodyNode = this.findChild(node, "class_body");
    if (bodyNode) {
      for (const member of bodyNode.children) {
        const extracted = this.extractClassMember(member, sourceCode);
        if (extracted) {
          members.push(extracted);
        }
      }
    }
    return {
      name,
      kind: "class",
      location: this.extractLocation(node),
      isExported,
      extends: extendsType,
      classBody: this.buildClassBody(node, sourceCode, members, ["class_body"]),
      members: members.length > 0 ? members : void 0
    };
  }
  extractClassMember(node, sourceCode) {
    const isStatic = node.children.some((c) => c.type === "static");
    switch (node.type) {
      case "method_definition": {
        const nameNode = this.findChildByField(node, "name");
        if (!nameNode) return null;
        const name = this.getNodeText(nameNode, sourceCode);
        const isAsync = node.children.some((c) => c.type === "async");
        const isGetter = node.children.some((c) => c.type === "get");
        const isSetter = node.children.some((c) => c.type === "set");
        const isGenerator = node.children.some((c) => c.type === "*");
        const params = this.extractParameters(node, sourceCode);
        let kind = "method";
        if (isGetter) kind = "getter";
        else if (isSetter) kind = "setter";
        else if (name === "constructor") kind = "constructor";
        else if (isGenerator) kind = "generator_function";
        else if (isAsync) kind = "async_function";
        return {
          name,
          kind,
          location: this.extractLocation(node),
          signature: this.buildFunctionSignature(name, params, isAsync),
          isStatic,
          isAsync,
          parameters: params,
          body: this.buildSymbolBody(node, sourceCode, ["statement_block"])
        };
      }
      case "field_definition": {
        const nameNode = this.findChildByField(node, "property");
        if (!nameNode) return null;
        const name = this.getNodeText(nameNode, sourceCode);
        const valueNode = this.findChildByField(node, "value");
        if (valueNode && valueNode.type === "arrow_function") {
          const isAsync = valueNode.children.some((c) => c.type === "async");
          const params = this.extractArrowFunctionParameters(valueNode, sourceCode);
          return {
            name,
            kind: isAsync ? "async_function" : "arrow_function",
            location: this.extractLocation(node),
            signature: this.buildFunctionSignature(name, params, isAsync),
            isStatic,
            isAsync,
            parameters: params,
            body: this.buildSymbolBody(valueNode, sourceCode, ["statement_block"])
          };
        }
        return {
          name,
          kind: "property",
          location: this.extractLocation(node),
          isStatic
        };
      }
      default:
        return null;
    }
  }
  extractVariables(node, sourceCode, isExported) {
    const symbols = [];
    const isConst = node.children.some((c) => c.type === "const");
    const declarators = this.findChildren(node, "variable_declarator");
    for (const declarator of declarators) {
      const nameNode = this.findChildByField(declarator, "name");
      if (!nameNode) continue;
      const name = this.getNodeText(nameNode, sourceCode);
      const valueNode = this.findChildByField(declarator, "value");
      if (valueNode) {
        if (valueNode.type === "arrow_function") {
          const isAsync = valueNode.children.some((c) => c.type === "async");
          const params = this.extractArrowFunctionParameters(valueNode, sourceCode);
          symbols.push({
            name,
            kind: isAsync ? "async_function" : "arrow_function",
            location: this.extractLocation(declarator),
            signature: this.buildFunctionSignature(name, params, isAsync),
            isExported,
            isAsync,
            parameters: params,
            body: this.buildSymbolBody(valueNode, sourceCode, ["statement_block"])
          });
          continue;
        }
        if (valueNode.type === "function" || valueNode.type === "function_expression") {
          const isAsync = valueNode.children.some((c) => c.type === "async");
          const params = this.extractParameters(valueNode, sourceCode);
          symbols.push({
            name,
            kind: isAsync ? "async_function" : "function",
            location: this.extractLocation(declarator),
            signature: this.buildFunctionSignature(name, params, isAsync),
            isExported,
            isAsync,
            parameters: params,
            body: this.buildSymbolBody(valueNode, sourceCode, ["statement_block"])
          });
          continue;
        }
        if (valueNode.type === "call_expression") {
          const funcNode = this.findChildByField(valueNode, "function");
          if (funcNode && (funcNode.type === "arrow_function" || funcNode.type === "function" || funcNode.type === "parenthesized_expression")) {
            symbols.push({
              name,
              kind: "iife",
              location: this.extractLocation(declarator),
              isExported,
              body: this.buildSymbolBody(funcNode.type === "parenthesized_expression" ? funcNode.firstChild ?? funcNode : funcNode, sourceCode, ["statement_block"])
            });
            continue;
          }
        }
      }
      symbols.push({
        name,
        kind: isConst ? "constant" : "variable",
        location: this.extractLocation(declarator),
        isExported
      });
    }
    return symbols;
  }
  extractExpressionStatement(node, sourceCode) {
    const expression = node.children[0];
    if (!expression) return null;
    if (expression.type === "assignment_expression") {
      const left = this.findChildByField(expression, "left");
      if (left && left.type === "member_expression") {
        const leftText = this.getNodeText(left, sourceCode);
        if (leftText === "module.exports" || leftText.startsWith("exports.")) {
          const right = this.findChildByField(expression, "right");
          if (right) {
            if (right.type === "function" || right.type === "arrow_function") {
              const params = right.type === "arrow_function" ? this.extractArrowFunctionParameters(right, sourceCode) : this.extractParameters(right, sourceCode);
              const name = leftText === "module.exports" ? "default" : leftText.replace("exports.", "");
              return {
                name,
                kind: "function",
                location: this.extractLocation(expression),
                signature: this.buildFunctionSignature(name, params, false),
                isExported: true,
                parameters: params,
                body: this.buildSymbolBody(right, sourceCode, ["statement_block"])
              };
            }
            if (right.type === "class") {
              const nameNode = this.findChildByField(right, "name");
              const name = nameNode ? this.getNodeText(nameNode, sourceCode) : leftText === "module.exports" ? "default" : leftText.replace("exports.", "");
              return {
                name,
                kind: "class",
                location: this.extractLocation(expression),
                isExported: true,
                classBody: this.buildClassBody(right, sourceCode, [], ["class_body"])
              };
            }
          }
        }
      }
    }
    return null;
  }
  extractArrowFunctionParameters(node, sourceCode) {
    const params = [];
    const singleParam = this.findChildByField(node, "parameter");
    if (singleParam && singleParam.type === "identifier") {
      params.push({ name: this.getNodeText(singleParam, sourceCode) });
      return params;
    }
    const paramsNode = this.findChildByField(node, "parameters") || this.findChild(node, "formal_parameters");
    if (paramsNode) {
      return this.extractParametersFromNode(paramsNode, sourceCode);
    }
    return params;
  }
  extractParameters(node, sourceCode) {
    const paramsNode = this.findChildByField(node, "parameters") || this.findChild(node, "formal_parameters");
    if (!paramsNode) return [];
    return this.extractParametersFromNode(paramsNode, sourceCode);
  }
  extractParametersFromNode(paramsNode, sourceCode) {
    const params = [];
    for (const child of paramsNode.children) {
      if (child.type === "identifier") {
        params.push({ name: this.getNodeText(child, sourceCode) });
      } else if (child.type === "rest_pattern") {
        const nameNode = this.findChild(child, "identifier");
        if (nameNode) {
          params.push({
            name: this.getNodeText(nameNode, sourceCode),
            isRest: true
          });
        }
      } else if (child.type === "assignment_pattern") {
        const left = this.findChildByField(child, "left");
        const right = this.findChildByField(child, "right");
        if (left) {
          params.push({
            name: this.getNodeText(left, sourceCode),
            defaultValue: right ? this.getNodeText(right, sourceCode) : void 0
          });
        }
      }
    }
    return params;
  }
  buildFunctionSignature(name, params, isAsync) {
    const asyncPrefix = isAsync ? "async " : "";
    const paramsPart = params.map((p) => {
      if (p.isRest) return `...${p.name}`;
      if (p.defaultValue) return `${p.name} = ${p.defaultValue}`;
      return p.name;
    }).join(", ");
    return `${asyncPrefix}function ${name}(${paramsPart})`;
  }
  extractImports(rootNode, sourceCode) {
    const imports = [];
    const importNodes = this.findDescendants(rootNode, "import_statement");
    for (const node of importNodes) {
      const importData = this.parseImportStatement(node, sourceCode);
      if (importData) {
        imports.push(importData);
      }
    }
    const callNodes = this.findDescendants(rootNode, "call_expression");
    for (const node of callNodes) {
      const funcNode = this.findChildByField(node, "function");
      if (funcNode && this.getNodeText(funcNode, sourceCode) === "require") {
        const argsNode = this.findChildByField(node, "arguments");
        if (argsNode) {
          const sourceNode = argsNode.children.find((c) => c.type === "string");
          if (sourceNode) {
            const source = this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "");
            imports.push({
              source,
              kind: "named",
              location: this.extractLocation(node),
              isRelative: source.startsWith(".") || source.startsWith("/")
            });
          }
        }
      }
    }
    return imports;
  }
  parseImportStatement(node, sourceCode) {
    const sourceNode = this.findChild(node, "string");
    if (!sourceNode) return null;
    const source = this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "");
    const location = this.extractLocation(node);
    const isRelative = source.startsWith(".") || source.startsWith("/");
    const importClause = this.findChild(node, "import_clause");
    if (!importClause) {
      return {
        source,
        kind: "side_effect",
        location,
        isRelative
      };
    }
    const defaultImport = this.findChild(importClause, "identifier");
    const namedImports = this.findChild(importClause, "named_imports");
    const namespaceImport = this.findChild(importClause, "namespace_import");
    if (namespaceImport) {
      const asNode = this.findChild(namespaceImport, "identifier");
      return {
        source,
        kind: "namespace",
        namespaceName: asNode ? this.getNodeText(asNode, sourceCode) : "*",
        location,
        isRelative
      };
    }
    if (defaultImport && !namedImports) {
      return {
        source,
        kind: "default",
        defaultName: this.getNodeText(defaultImport, sourceCode),
        location,
        isRelative
      };
    }
    const symbols = [];
    if (defaultImport) {
      symbols.push({ name: "default", alias: this.getNodeText(defaultImport, sourceCode) });
    }
    if (namedImports) {
      for (const specifier of namedImports.children) {
        if (specifier.type === "import_specifier") {
          const nameNode = this.findChildByField(specifier, "name");
          const aliasNode = this.findChildByField(specifier, "alias");
          if (nameNode) {
            symbols.push({
              name: this.getNodeText(nameNode, sourceCode),
              alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : void 0
            });
          }
        }
      }
    }
    return {
      source,
      kind: "named",
      symbols: symbols.length > 0 ? symbols : void 0,
      defaultName: defaultImport ? this.getNodeText(defaultImport, sourceCode) : void 0,
      location,
      isRelative
    };
  }
  extractExports(rootNode, sourceCode) {
    const exports = [];
    const exportNodes = this.findDescendants(rootNode, "export_statement");
    for (const node of exportNodes) {
      const exportData = this.parseExportStatement(node, sourceCode);
      if (exportData) {
        exports.push(exportData);
      }
    }
    const assignmentNodes = this.findDescendants(rootNode, "assignment_expression");
    for (const node of assignmentNodes) {
      const left = this.findChildByField(node, "left");
      if (left && left.type === "member_expression") {
        const leftText = this.getNodeText(left, sourceCode);
        if (leftText === "module.exports") {
          exports.push({
            kind: "default",
            defaultName: "module.exports",
            location: this.extractLocation(node)
          });
        } else if (leftText.startsWith("exports.")) {
          const exportName = leftText.replace("exports.", "");
          exports.push({
            kind: "named",
            symbols: [{ name: exportName }],
            location: this.extractLocation(node)
          });
        }
      }
    }
    return exports;
  }
  parseExportStatement(node, sourceCode) {
    const location = this.extractLocation(node);
    const sourceNode = this.findChild(node, "string");
    if (node.children.some((c) => c.type === "*")) {
      return {
        kind: "re_export",
        source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "") : void 0,
        location
      };
    }
    if (node.children.some((c) => c.type === "default")) {
      const declaration2 = node.children.find(
        (c) => c.type !== "export" && c.type !== "default" && c.type !== ";"
      );
      return {
        kind: "default",
        defaultName: declaration2 ? this.getNodeText(declaration2, sourceCode).slice(0, 50) : "default",
        location
      };
    }
    const exportClause = this.findChild(node, "export_clause");
    if (exportClause) {
      const symbols = [];
      for (const specifier of exportClause.children) {
        if (specifier.type === "export_specifier") {
          const nameNode = this.findChildByField(specifier, "name");
          const aliasNode = this.findChildByField(specifier, "alias");
          if (nameNode) {
            symbols.push({
              name: this.getNodeText(nameNode, sourceCode),
              alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : void 0
            });
          }
        }
      }
      return {
        kind: sourceNode ? "re_export" : "named",
        symbols: symbols.length > 0 ? symbols : void 0,
        source: sourceNode ? this.getNodeText(sourceNode, sourceCode).replace(/^['"]|['"]$/g, "") : void 0,
        location
      };
    }
    const declaration = this.findChild(node, "function_declaration") || this.findChild(node, "class_declaration") || this.findChild(node, "lexical_declaration") || this.findChild(node, "variable_declaration");
    if (declaration) {
      const nameNode = this.findChildByField(declaration, "name");
      if (nameNode) {
        return {
          kind: "named",
          symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
          location
        };
      }
      const declarators = this.findChildren(declaration, "variable_declarator");
      const symbols = declarators.map((d) => this.findChildByField(d, "name")).filter((n) => n !== null).map((n) => ({ name: this.getNodeText(n, sourceCode) }));
      if (symbols.length > 0) {
        return {
          kind: "named",
          symbols,
          location
        };
      }
    }
    return null;
  }
  extractCallSites(rootNode, sourceCode) {
    const callSites = [];
    const callNodes = this.findDescendantsOfTypes(rootNode, ["call_expression", "new_expression"]);
    for (const node of callNodes) {
      const callSite = this.parseCallExpression(node, sourceCode);
      if (callSite) {
        callSites.push(callSite);
      }
    }
    return callSites;
  }
  parseCallExpression(node, sourceCode) {
    const functionNode = this.findChildByField(node, "function");
    if (!functionNode) return null;
    const location = this.extractLocation(node);
    const argsNode = this.findChildByField(node, "arguments");
    const argCount = argsNode ? argsNode.children.filter((c) => c.type !== "(" && c.type !== ")" && c.type !== ",").length : 0;
    if (functionNode.type === "member_expression") {
      const object = this.findChildByField(functionNode, "object");
      const property = this.findChildByField(functionNode, "property");
      if (property) {
        return {
          callee: this.getNodeText(property, sourceCode),
          location,
          isMethodCall: true,
          receiver: object ? this.getNodeText(object, sourceCode) : void 0,
          arguments: argCount
        };
      }
    }
    if (functionNode.type === "identifier") {
      return {
        callee: this.getNodeText(functionNode, sourceCode),
        location,
        isMethodCall: false,
        arguments: argCount
      };
    }
    return null;
  }
}

"use strict";
class PythonParser extends BaseParser {
  constructor() {
    super("python");
  }
  extractSymbols(rootNode, sourceCode) {
    const symbols = [];
    for (const child of rootNode.children) {
      const extracted = this.extractSymbolFromNode(child, sourceCode, []);
      if (extracted) {
        symbols.push(...Array.isArray(extracted) ? extracted : [extracted]);
      }
    }
    return symbols;
  }
  extractSymbolFromNode(node, sourceCode, decorators) {
    if (node.type === "decorated_definition") {
      const collectedDecorators = [];
      for (const child of node.children) {
        if (child.type === "decorator") {
          const decoratorText = this.getNodeText(child, sourceCode).replace(/^@/, "");
          collectedDecorators.push(decoratorText);
        }
      }
      const definition = node.children.find(
        (c) => c.type === "function_definition" || c.type === "class_definition" || c.type === "async_function_definition"
      );
      if (definition) {
        return this.extractSymbolFromNode(definition, sourceCode, collectedDecorators);
      }
      return null;
    }
    switch (node.type) {
      case "function_definition":
        return this.extractFunction(node, sourceCode, false, decorators);
      case "async_function_definition":
        return this.extractFunction(node, sourceCode, true, decorators);
      case "class_definition":
        return this.extractClass(node, sourceCode, decorators);
      case "expression_statement":
        return this.extractAssignment(node, sourceCode);
      default:
        return null;
    }
  }
  extractFunction(node, sourceCode, isAsync, decorators) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    const returnType = this.extractReturnType(node, sourceCode);
    const isLambda = node.type === "lambda";
    let kind = isAsync ? "async_function" : "function";
    if (isLambda) kind = "lambda";
    return {
      name,
      kind,
      location: this.extractLocation(node),
      signature: this.buildFunctionSignature(name, params, returnType, isAsync),
      isAsync,
      parameters: params,
      returnType,
      decorators: decorators.length > 0 ? decorators : void 0,
      body: this.buildSymbolBody(node, sourceCode, ["block"])
    };
  }
  extractClass(node, sourceCode, decorators) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const baseClasses = [];
    const argList = this.findChild(node, "argument_list");
    if (argList) {
      for (const child of argList.children) {
        if (child.type === "identifier" || child.type === "attribute") {
          baseClasses.push(this.getNodeText(child, sourceCode));
        }
      }
    }
    const members = [];
    const bodyNode = this.findChild(node, "block");
    if (bodyNode) {
      for (const child of bodyNode.children) {
        const extracted = this.extractClassMember(child, sourceCode);
        if (extracted) {
          members.push(...Array.isArray(extracted) ? extracted : [extracted]);
        }
      }
    }
    return {
      name,
      kind: "class",
      location: this.extractLocation(node),
      extends: baseClasses.length > 0 ? baseClasses[0] : void 0,
      implements: baseClasses.length > 1 ? baseClasses.slice(1) : void 0,
      decorators: decorators.length > 0 ? decorators : void 0,
      classBody: this.buildClassBody(node, sourceCode, members, ["block"]),
      members: members.length > 0 ? members : void 0
    };
  }
  extractClassMember(node, sourceCode) {
    if (node.type === "decorated_definition") {
      const decorators = [];
      for (const child of node.children) {
        if (child.type === "decorator") {
          decorators.push(this.getNodeText(child, sourceCode).replace(/^@/, ""));
        }
      }
      const definition = node.children.find(
        (c) => c.type === "function_definition" || c.type === "async_function_definition"
      );
      if (definition) {
        const method = this.extractMethod(definition, sourceCode, decorators);
        return method;
      }
      return null;
    }
    if (node.type === "function_definition" || node.type === "async_function_definition") {
      return this.extractMethod(node, sourceCode, []);
    }
    if (node.type === "expression_statement") {
      const assignment = this.findChild(node, "assignment");
      if (assignment) {
        const left = this.findChildByField(assignment, "left");
        if (left && left.type === "identifier") {
          return {
            name: this.getNodeText(left, sourceCode),
            kind: "property",
            location: this.extractLocation(node)
          };
        }
      }
    }
    return null;
  }
  extractMethod(node, sourceCode, decorators) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const isAsync = node.type === "async_function_definition";
    const params = this.extractParameters(node, sourceCode);
    const returnType = this.extractReturnType(node, sourceCode);
    const isStatic = decorators.includes("staticmethod") || decorators.includes("classmethod");
    const isProperty = decorators.includes("property");
    let kind = "method";
    if (name === "__init__") kind = "constructor";
    else if (isProperty) kind = "getter";
    else if (isAsync) kind = "async_function";
    return {
      name,
      kind,
      location: this.extractLocation(node),
      signature: this.buildFunctionSignature(name, params, returnType, isAsync),
      isStatic,
      isAsync,
      parameters: params,
      returnType,
      decorators: decorators.length > 0 ? decorators : void 0,
      body: this.buildSymbolBody(node, sourceCode, ["block"])
    };
  }
  extractAssignment(node, sourceCode) {
    const assignment = this.findChild(node, "assignment");
    if (!assignment) return null;
    const left = this.findChildByField(assignment, "left");
    const right = this.findChildByField(assignment, "right");
    if (!left || left.type !== "identifier") return null;
    const name = this.getNodeText(left, sourceCode);
    if (right && right.type === "lambda") {
      const params = this.extractLambdaParameters(right, sourceCode);
      return {
        name,
        kind: "lambda",
        location: this.extractLocation(assignment),
        parameters: params
      };
    }
    return {
      name,
      kind: "variable",
      location: this.extractLocation(assignment)
    };
  }
  extractParameters(node, sourceCode) {
    const paramsNode = this.findChild(node, "parameters");
    if (!paramsNode) return [];
    return this.extractParametersFromNode(paramsNode, sourceCode);
  }
  extractLambdaParameters(node, sourceCode) {
    const paramsNode = this.findChild(node, "lambda_parameters");
    if (!paramsNode) return [];
    return this.extractParametersFromNode(paramsNode, sourceCode);
  }
  extractParametersFromNode(paramsNode, sourceCode) {
    const params = [];
    for (const child of paramsNode.children) {
      switch (child.type) {
        case "identifier": {
          params.push({ name: this.getNodeText(child, sourceCode) });
          break;
        }
        case "typed_parameter": {
          const nameNode = this.findChild(child, "identifier");
          const typeNode = this.findChildByField(child, "type");
          if (nameNode) {
            params.push({
              name: this.getNodeText(nameNode, sourceCode),
              type: typeNode ? this.getNodeText(typeNode, sourceCode) : void 0
            });
          }
          break;
        }
        case "default_parameter": {
          const nameNode = this.findChildByField(child, "name");
          const valueNode = this.findChildByField(child, "value");
          if (nameNode) {
            params.push({
              name: this.getNodeText(nameNode, sourceCode),
              defaultValue: valueNode ? this.getNodeText(valueNode, sourceCode) : void 0,
              isOptional: true
            });
          }
          break;
        }
        case "typed_default_parameter": {
          const nameNode = this.findChildByField(child, "name");
          const typeNode = this.findChildByField(child, "type");
          const valueNode = this.findChildByField(child, "value");
          if (nameNode) {
            params.push({
              name: this.getNodeText(nameNode, sourceCode),
              type: typeNode ? this.getNodeText(typeNode, sourceCode) : void 0,
              defaultValue: valueNode ? this.getNodeText(valueNode, sourceCode) : void 0,
              isOptional: true
            });
          }
          break;
        }
        case "list_splat_pattern":
        case "dictionary_splat_pattern": {
          const nameNode = this.findChild(child, "identifier");
          if (nameNode) {
            params.push({
              name: this.getNodeText(nameNode, sourceCode),
              isRest: true
            });
          }
          break;
        }
      }
    }
    return params;
  }
  extractReturnType(node, sourceCode) {
    const returnType = this.findChildByField(node, "return_type");
    if (returnType) {
      return this.getNodeText(returnType, sourceCode);
    }
    return void 0;
  }
  buildFunctionSignature(name, params, returnType, isAsync) {
    const asyncPrefix = isAsync ? "async " : "";
    const paramsPart = params.map((p) => {
      let str = p.isRest ? `*${p.name}` : p.name;
      if (p.type) str += `: ${p.type}`;
      if (p.defaultValue) str += ` = ${p.defaultValue}`;
      return str;
    }).join(", ");
    const returnPart = returnType ? ` -> ${returnType}` : "";
    return `${asyncPrefix}def ${name}(${paramsPart})${returnPart}`;
  }
  extractImports(rootNode, sourceCode) {
    const imports = [];
    const importNodes = this.findDescendants(rootNode, "import_statement");
    for (const node of importNodes) {
      const parsed = this.parseImportStatement(node, sourceCode);
      if (parsed) {
        imports.push(...Array.isArray(parsed) ? parsed : [parsed]);
      }
    }
    const fromImportNodes = this.findDescendants(rootNode, "import_from_statement");
    for (const node of fromImportNodes) {
      const parsed = this.parseFromImportStatement(node, sourceCode);
      if (parsed) {
        imports.push(parsed);
      }
    }
    return imports;
  }
  parseImportStatement(node, sourceCode) {
    const imports = [];
    const location = this.extractLocation(node);
    for (const child of node.children) {
      if (child.type === "dotted_name") {
        const name = this.getNodeText(child, sourceCode);
        imports.push({
          source: name,
          kind: "named",
          location,
          isRelative: false
        });
      } else if (child.type === "aliased_import") {
        const nameNode = this.findChildByField(child, "name");
        const aliasNode = this.findChildByField(child, "alias");
        if (nameNode) {
          imports.push({
            source: this.getNodeText(nameNode, sourceCode),
            kind: "named",
            symbols: aliasNode ? [{
              name: this.getNodeText(nameNode, sourceCode),
              alias: this.getNodeText(aliasNode, sourceCode)
            }] : void 0,
            location,
            isRelative: false
          });
        }
      }
    }
    return imports.length > 0 ? imports : null;
  }
  parseFromImportStatement(node, sourceCode) {
    const location = this.extractLocation(node);
    const moduleNode = this.findChild(node, "dotted_name") || this.findChild(node, "relative_import");
    if (!moduleNode) return null;
    const source = this.getNodeText(moduleNode, sourceCode);
    const isRelative = source.startsWith(".");
    if (node.children.some((c) => c.type === "wildcard_import")) {
      return {
        source,
        kind: "namespace",
        namespaceName: "*",
        location,
        isRelative
      };
    }
    const symbols = [];
    for (const child of node.children) {
      if (child.type === "dotted_name" && child !== moduleNode) {
        symbols.push({ name: this.getNodeText(child, sourceCode) });
      } else if (child.type === "aliased_import") {
        const nameNode = this.findChildByField(child, "name");
        const aliasNode = this.findChildByField(child, "alias");
        if (nameNode) {
          symbols.push({
            name: this.getNodeText(nameNode, sourceCode),
            alias: aliasNode ? this.getNodeText(aliasNode, sourceCode) : void 0
          });
        }
      }
    }
    return {
      source,
      kind: "named",
      symbols: symbols.length > 0 ? symbols : void 0,
      location,
      isRelative
    };
  }
  extractExports(rootNode, sourceCode) {
    const exports = [];
    const assignments = this.findDescendants(rootNode, "assignment");
    for (const assignment of assignments) {
      const left = this.findChildByField(assignment, "left");
      if (left && this.getNodeText(left, sourceCode) === "__all__") {
        const right = this.findChildByField(assignment, "right");
        if (right && right.type === "list") {
          const symbols = [];
          for (const item of right.children) {
            if (item.type === "string") {
              const name = this.getNodeText(item, sourceCode).replace(/^['"]|['"]$/g, "");
              symbols.push({ name });
            }
          }
          if (symbols.length > 0) {
            exports.push({
              kind: "named",
              symbols,
              location: this.extractLocation(assignment)
            });
          }
        }
      }
    }
    for (const child of rootNode.children) {
      if (child.type === "function_definition" || child.type === "async_function_definition") {
        const nameNode = this.findChildByField(child, "name");
        if (nameNode) {
          const name = this.getNodeText(nameNode, sourceCode);
          if (!name.startsWith("_")) {
            exports.push({
              kind: "named",
              symbols: [{ name }],
              location: this.extractLocation(child)
            });
          }
        }
      } else if (child.type === "class_definition") {
        const nameNode = this.findChildByField(child, "name");
        if (nameNode) {
          const name = this.getNodeText(nameNode, sourceCode);
          if (!name.startsWith("_")) {
            exports.push({
              kind: "named",
              symbols: [{ name }],
              location: this.extractLocation(child)
            });
          }
        }
      } else if (child.type === "decorated_definition") {
        const definition = child.children.find(
          (c) => c.type === "function_definition" || c.type === "async_function_definition" || c.type === "class_definition"
        );
        if (definition) {
          const nameNode = this.findChildByField(definition, "name");
          if (nameNode) {
            const name = this.getNodeText(nameNode, sourceCode);
            if (!name.startsWith("_")) {
              exports.push({
                kind: "named",
                symbols: [{ name }],
                location: this.extractLocation(child)
              });
            }
          }
        }
      }
    }
    return exports;
  }
  extractCallSites(rootNode, sourceCode) {
    const callSites = [];
    const callNodes = this.findDescendants(rootNode, "call");
    for (const node of callNodes) {
      const callSite = this.parseCallExpression(node, sourceCode);
      if (callSite) {
        callSites.push(callSite);
      }
    }
    return callSites;
  }
  parseCallExpression(node, sourceCode) {
    const functionNode = this.findChildByField(node, "function");
    if (!functionNode) return null;
    const location = this.extractLocation(node);
    const argsNode = this.findChildByField(node, "arguments");
    const argCount = argsNode ? argsNode.children.filter(
      (c) => c.type !== "(" && c.type !== ")" && c.type !== "," && c.type !== "comment"
    ).length : 0;
    if (functionNode.type === "attribute") {
      const object = this.findChildByField(functionNode, "object");
      const attribute = this.findChildByField(functionNode, "attribute");
      if (attribute) {
        return {
          callee: this.getNodeText(attribute, sourceCode),
          location,
          isMethodCall: true,
          receiver: object ? this.getNodeText(object, sourceCode) : void 0,
          arguments: argCount
        };
      }
    }
    if (functionNode.type === "identifier") {
      return {
        callee: this.getNodeText(functionNode, sourceCode),
        location,
        isMethodCall: false,
        arguments: argCount
      };
    }
    return null;
  }
}

"use strict";
class JavaParser extends BaseParser {
  constructor() {
    super("java");
  }
  extractSymbols(rootNode, sourceCode) {
    const symbols = [];
    for (const child of rootNode.children) {
      if (child.type === "class_declaration" || child.type === "interface_declaration" || child.type === "enum_declaration" || child.type === "annotation_type_declaration") {
        const extracted = this.extractTypeDeclaration(child, sourceCode);
        if (extracted) {
          symbols.push(extracted);
        }
      }
    }
    return symbols;
  }
  extractTypeDeclaration(node, sourceCode) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const modifiers = this.extractModifiers(node);
    const annotations = this.extractAnnotations(node, sourceCode);
    const typeParams = this.extractTypeParameters(node, sourceCode);
    let kind;
    switch (node.type) {
      case "interface_declaration":
        kind = "interface";
        break;
      case "enum_declaration":
        kind = "enum";
        break;
      case "annotation_type_declaration":
        kind = "interface";
        break;
      default:
        kind = modifiers.isAbstract ? "abstract_class" : "class";
    }
    let extendsType;
    const superclass = this.findChild(node, "superclass");
    if (superclass) {
      const typeNode = superclass.children.find((c) => c.type !== "extends");
      if (typeNode) {
        extendsType = this.getNodeText(typeNode, sourceCode);
      }
    }
    const implementsList = [];
    const interfaces = this.findChild(node, "super_interfaces");
    if (interfaces) {
      for (const child of interfaces.children) {
        if (child.type === "type_list") {
          for (const typeNode of child.children) {
            if (typeNode.type !== ",") {
              implementsList.push(this.getNodeText(typeNode, sourceCode));
            }
          }
        }
      }
    }
    const members = [];
    const bodyNode = this.findChild(node, "class_body") || this.findChild(node, "interface_body") || this.findChild(node, "enum_body");
    if (bodyNode) {
      for (const member of bodyNode.children) {
        const extracted = this.extractMember(member, sourceCode);
        if (extracted) {
          members.push(...Array.isArray(extracted) ? extracted : [extracted]);
        }
      }
    }
    return {
      name,
      kind,
      location: this.extractLocation(node),
      visibility: modifiers.visibility,
      isAbstract: modifiers.isAbstract,
      isStatic: modifiers.isStatic,
      typeParameters: typeParams.length > 0 ? typeParams : void 0,
      extends: extendsType,
      implements: implementsList.length > 0 ? implementsList : void 0,
      decorators: annotations.length > 0 ? annotations : void 0,
      classBody: this.buildClassBody(node, sourceCode, members, ["class_body", "interface_body", "enum_body"]),
      members: members.length > 0 ? members : void 0
    };
  }
  extractMember(node, sourceCode) {
    switch (node.type) {
      case "method_declaration":
        return this.extractMethod(node, sourceCode);
      case "constructor_declaration":
        return this.extractConstructor(node, sourceCode);
      case "field_declaration":
        return this.extractFields(node, sourceCode);
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
        return this.extractTypeDeclaration(node, sourceCode);
      case "enum_constant":
        return this.extractEnumConstant(node, sourceCode);
      default:
        return null;
    }
  }
  extractMethod(node, sourceCode) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const modifiers = this.extractModifiers(node);
    const annotations = this.extractAnnotations(node, sourceCode);
    const typeParams = this.extractTypeParameters(node, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    const returnType = this.extractReturnType(node, sourceCode);
    const throwsTypes = this.extractThrowsClause(node, sourceCode);
    return {
      name,
      kind: "method",
      location: this.extractLocation(node),
      signature: this.buildMethodSignature(name, params, returnType, typeParams, throwsTypes, modifiers),
      visibility: modifiers.visibility,
      isStatic: modifiers.isStatic,
      isAbstract: modifiers.isAbstract,
      parameters: params,
      returnType,
      typeParameters: typeParams.length > 0 ? typeParams : void 0,
      decorators: annotations.length > 0 ? annotations : void 0,
      body: this.buildSymbolBody(node, sourceCode, ["block"])
    };
  }
  extractConstructor(node, sourceCode) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const name = this.getNodeText(nameNode, sourceCode);
    const modifiers = this.extractModifiers(node);
    const annotations = this.extractAnnotations(node, sourceCode);
    const params = this.extractParameters(node, sourceCode);
    const throwsTypes = this.extractThrowsClause(node, sourceCode);
    return {
      name,
      kind: "constructor",
      location: this.extractLocation(node),
      signature: this.buildMethodSignature(name, params, void 0, [], throwsTypes, modifiers),
      visibility: modifiers.visibility,
      parameters: params,
      decorators: annotations.length > 0 ? annotations : void 0,
      body: this.buildSymbolBody(node, sourceCode, ["constructor_body", "block"])
    };
  }
  extractFields(node, sourceCode) {
    const symbols = [];
    const modifiers = this.extractModifiers(node);
    const annotations = this.extractAnnotations(node, sourceCode);
    const typeNode = this.findChildByField(node, "type");
    const type = typeNode ? this.getNodeText(typeNode, sourceCode) : void 0;
    const declarators = this.findChildren(node, "variable_declarator");
    for (const declarator of declarators) {
      const nameNode = this.findChildByField(declarator, "name");
      if (nameNode) {
        symbols.push({
          name: this.getNodeText(nameNode, sourceCode),
          kind: modifiers.isFinal ? "constant" : "property",
          location: this.extractLocation(declarator),
          visibility: modifiers.visibility,
          isStatic: modifiers.isStatic,
          returnType: type,
          decorators: annotations.length > 0 ? annotations : void 0
        });
      }
    }
    return symbols;
  }
  extractEnumConstant(node, sourceCode) {
    const nameNode = this.findChildByField(node, "name");
    if (!nameNode) return null;
    const annotations = this.extractAnnotations(node, sourceCode);
    return {
      name: this.getNodeText(nameNode, sourceCode),
      kind: "constant",
      location: this.extractLocation(node),
      visibility: "public",
      isStatic: true,
      decorators: annotations.length > 0 ? annotations : void 0
    };
  }
  extractModifiers(node) {
    let visibility;
    let isStatic = false;
    let isAbstract = false;
    let isFinal = false;
    const modifiersNode = this.findChild(node, "modifiers");
    if (modifiersNode) {
      for (const child of modifiersNode.children) {
        switch (child.type) {
          case "public":
            visibility = "public";
            break;
          case "private":
            visibility = "private";
            break;
          case "protected":
            visibility = "protected";
            break;
          case "static":
            isStatic = true;
            break;
          case "abstract":
            isAbstract = true;
            break;
          case "final":
            isFinal = true;
            break;
        }
      }
    }
    return { visibility, isStatic, isAbstract, isFinal };
  }
  extractAnnotations(node, sourceCode) {
    const annotations = [];
    const modifiersNode = this.findChild(node, "modifiers");
    if (modifiersNode) {
      for (const child of modifiersNode.children) {
        if (child.type === "annotation" || child.type === "marker_annotation") {
          annotations.push(this.getNodeText(child, sourceCode));
        }
      }
    }
    return annotations;
  }
  extractTypeParameters(node, sourceCode) {
    const params = [];
    const typeParams = this.findChild(node, "type_parameters");
    if (typeParams) {
      for (const child of typeParams.children) {
        if (child.type === "type_parameter") {
          params.push(this.getNodeText(child, sourceCode));
        }
      }
    }
    return params;
  }
  extractParameters(node, sourceCode) {
    const params = [];
    const paramsNode = this.findChild(node, "formal_parameters");
    if (!paramsNode) return params;
    for (const child of paramsNode.children) {
      if (child.type === "formal_parameter" || child.type === "spread_parameter") {
        const typeNode = this.findChildByField(child, "type");
        const nameNode = this.findChildByField(child, "name");
        if (nameNode) {
          params.push({
            name: this.getNodeText(nameNode, sourceCode),
            type: typeNode ? this.getNodeText(typeNode, sourceCode) : void 0,
            isRest: child.type === "spread_parameter"
          });
        }
      }
    }
    return params;
  }
  extractReturnType(node, sourceCode) {
    const typeNode = this.findChildByField(node, "type");
    if (typeNode) {
      return this.getNodeText(typeNode, sourceCode);
    }
    return void 0;
  }
  extractThrowsClause(node, sourceCode) {
    const throws = [];
    const throwsNode = this.findChild(node, "throws");
    if (throwsNode) {
      for (const child of throwsNode.children) {
        if (child.type !== "throws" && child.type !== ",") {
          throws.push(this.getNodeText(child, sourceCode));
        }
      }
    }
    return throws;
  }
  buildMethodSignature(name, params, returnType, typeParams, throwsTypes, modifiers) {
    const parts = [];
    if (modifiers?.visibility) parts.push(modifiers.visibility);
    if (modifiers?.isStatic) parts.push("static");
    if (modifiers?.isAbstract) parts.push("abstract");
    if (typeParams?.length) {
      parts.push(`<${typeParams.join(", ")}>`);
    }
    if (returnType) parts.push(returnType);
    const paramsPart = params.map((p) => {
      if (p.isRest) return `${p.type}... ${p.name}`;
      return p.type ? `${p.type} ${p.name}` : p.name;
    }).join(", ");
    parts.push(`${name}(${paramsPart})`);
    if (throwsTypes?.length) {
      parts.push(`throws ${throwsTypes.join(", ")}`);
    }
    return parts.join(" ");
  }
  extractImports(rootNode, sourceCode) {
    const imports = [];
    const importNodes = this.findDescendants(rootNode, "import_declaration");
    for (const node of importNodes) {
      const parsed = this.parseImportStatement(node, sourceCode);
      if (parsed) {
        imports.push(parsed);
      }
    }
    return imports;
  }
  parseImportStatement(node, sourceCode) {
    const location = this.extractLocation(node);
    const isStatic = node.children.some((c) => c.type === "static");
    const scopedId = this.findChild(node, "scoped_identifier");
    const asteriskNode = this.findChild(node, "asterisk");
    if (scopedId) {
      const fullPath = this.getNodeText(scopedId, sourceCode);
      if (asteriskNode) {
        return {
          source: fullPath,
          kind: "namespace",
          namespaceName: "*",
          location,
          isRelative: false
        };
      }
      const lastDot = fullPath.lastIndexOf(".");
      const packageName = lastDot > 0 ? fullPath.slice(0, lastDot) : "";
      const className = lastDot > 0 ? fullPath.slice(lastDot + 1) : fullPath;
      return {
        source: packageName || fullPath,
        kind: isStatic ? "named" : "named",
        symbols: [{ name: className }],
        location,
        isRelative: false
      };
    }
    const identifier = this.findChild(node, "identifier");
    if (identifier) {
      return {
        source: this.getNodeText(identifier, sourceCode),
        kind: "named",
        location,
        isRelative: false
      };
    }
    return null;
  }
  extractExports(rootNode, sourceCode) {
    const exports = [];
    for (const child of rootNode.children) {
      if (child.type === "class_declaration" || child.type === "interface_declaration" || child.type === "enum_declaration") {
        const modifiers = this.extractModifiers(child);
        if (modifiers.visibility === "public") {
          const nameNode = this.findChildByField(child, "name");
          if (nameNode) {
            exports.push({
              kind: "named",
              symbols: [{ name: this.getNodeText(nameNode, sourceCode) }],
              location: this.extractLocation(child)
            });
          }
        }
      }
    }
    return exports;
  }
  extractCallSites(rootNode, sourceCode) {
    const callSites = [];
    const callNodes = this.findDescendantsOfTypes(rootNode, ["method_invocation", "object_creation_expression"]);
    for (const node of callNodes) {
      const callSite = this.parseCallExpression(node, sourceCode);
      if (callSite) {
        callSites.push(callSite);
      }
    }
    return callSites;
  }
  parseCallExpression(node, sourceCode) {
    const location = this.extractLocation(node);
    if (node.type === "object_creation_expression") {
      const typeNode = this.findChildByField(node, "type");
      if (typeNode) {
        const argsNode = this.findChildByField(node, "arguments");
        const argCount = argsNode ? argsNode.children.filter(
          (c) => c.type !== "(" && c.type !== ")" && c.type !== ","
        ).length : 0;
        return {
          callee: this.getNodeText(typeNode, sourceCode),
          location,
          isMethodCall: false,
          arguments: argCount
        };
      }
    }
    if (node.type === "method_invocation") {
      const nameNode = this.findChildByField(node, "name");
      const objectNode = this.findChildByField(node, "object");
      if (nameNode) {
        const argsNode = this.findChildByField(node, "arguments");
        const argCount = argsNode ? argsNode.children.filter(
          (c) => c.type !== "(" && c.type !== ")" && c.type !== ","
        ).length : 0;
        return {
          callee: this.getNodeText(nameNode, sourceCode),
          location,
          isMethodCall: objectNode !== null,
          receiver: objectNode ? this.getNodeText(objectNode, sourceCode) : void 0,
          arguments: argCount
        };
      }
    }
    return null;
  }
}

"use strict";
let initialized = false;
async function initializeASTSystem() {
  if (initialized) return;
  const runtime = getTreeSitterRuntime();
  await runtime.initialize();
  const registry = getParserRegistry();
  registry.registerParser("typescript", new TypeScriptParser());
  registry.registerParser("javascript", new JavaScriptParser());
  registry.registerParser("python", new PythonParser());
  registry.registerParser("java", new JavaParser());
  initialized = true;
}
function isASTSystemInitialized() {
  return initialized;
}
function resetASTSystem() {
  getParserRegistry().getRegisteredLanguages().forEach(() => {
  });
  getTreeSitterRuntime();
  initialized = false;
}
async function parseFile(filePath, sourceCode) {
  if (!initialized) {
    await initializeASTSystem();
  }
  const registry = getParserRegistry();
  return registry.parseFile(filePath, sourceCode);
}
async function parseSource(sourceCode, language) {
  if (!initialized) {
    await initializeASTSystem();
  }
  const registry = getParserRegistry();
  const parser = registry.getParserForLanguage(language);
  if (!parser) {
    return null;
  }
  return parser.parse(sourceCode);
}
function isExtensionSupported(extension) {
  const registry = getParserRegistry();
  return registry.isSupported(extension);
}
function getSupportedExtensions() {
  const registry = getParserRegistry();
  return registry.getSupportedExtensions();
}

"use strict";
const locationSchema$1 = z.object({
  line: z.number().int().min(1).describe("1-based line number"),
  column: z.number().int().min(0).describe("0-based column number"),
  startByte: z.number().int().min(0).describe("Start byte offset in source"),
  endByte: z.number().int().min(0).describe("End byte offset in source")
});
const visibilitySchema = z.enum(["public", "private", "protected", "internal", "default"]);
const symbolKindSchema = z.enum([
  "function",
  "async_function",
  "arrow_function",
  "generator_function",
  "method",
  "constructor",
  "getter",
  "setter",
  "class",
  "abstract_class",
  "interface",
  "type_alias",
  "enum",
  "variable",
  "constant",
  "property",
  "parameter",
  "decorator",
  "lambda",
  "iife"
]);
const parameterSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  defaultValue: z.string().optional(),
  isRest: z.boolean().optional(),
  isOptional: z.boolean().optional()
});
const symbolBodySchema = z.object({
  declarationText: z.string().optional().describe("Full declaration text for the symbol"),
  bodyText: z.string().optional().describe("Raw body text for the symbol"),
  normalizedBodyText: z.string().optional().describe("Whitespace-normalized body text for review and comparisons"),
  statementCount: z.number().int().min(0).optional().describe("Approximate number of top-level statements in the body"),
  callTargets: z.array(z.string()).optional().describe("Detected call targets referenced from the body"),
  rawLogicSummary: z.string().optional().describe("Deterministic, review-oriented summary of the body logic")
});
const classBodySchema = z.object({
  bodyText: z.string().optional().describe("Raw body text for the type declaration"),
  normalizedBodyText: z.string().optional().describe("Whitespace-normalized body text for review and comparisons"),
  memberCount: z.number().int().min(0).optional().describe("Total number of members declared in the type body"),
  methodCount: z.number().int().min(0).optional().describe("Number of function-like members declared in the type body"),
  propertyCount: z.number().int().min(0).optional().describe("Number of property-like members declared in the type body"),
  methodNames: z.array(z.string()).optional().describe("Names of function-like members declared in the type body"),
  rawLogicSummary: z.string().optional().describe("Deterministic, review-oriented summary of the class or interface body")
});
const symbolSchema = z.lazy(() => z.object({
  name: z.string().describe("Symbol name"),
  kind: symbolKindSchema.describe("Symbol kind"),
  location: locationSchema$1.describe("Source location"),
  signature: z.string().optional().describe("Full signature (for functions/methods)"),
  visibility: visibilitySchema.optional().describe("Visibility modifier"),
  isExported: z.boolean().optional().describe("Whether symbol is exported"),
  isStatic: z.boolean().optional().describe("Whether symbol is static (for class members)"),
  isAsync: z.boolean().optional().describe("Whether function is async"),
  isAbstract: z.boolean().optional().describe("Whether class/method is abstract"),
  parameters: z.array(parameterSchema).optional().describe("Function/method parameters"),
  returnType: z.string().optional().describe("Return type (if available)"),
  typeParameters: z.array(z.string()).optional().describe("Generic type parameters"),
  decorators: z.array(z.string()).optional().describe("Decorators/annotations"),
  extends: z.string().optional().describe("Parent class (for classes)"),
  implements: z.array(z.string()).optional().describe("Implemented interfaces"),
  body: symbolBodySchema.optional().describe("Review-oriented function or method body metadata"),
  classBody: classBodySchema.optional().describe("Review-oriented class, interface, or enum body metadata"),
  members: z.array(symbolSchema).optional().describe("Child symbols (for classes)")
}));
const importSchema = z.object({
  source: z.string().describe("Import source module/path"),
  kind: z.enum(["named", "default", "namespace", "type_only", "side_effect"]).describe("Import kind"),
  symbols: z.array(z.object({
    name: z.string(),
    alias: z.string().optional()
  })).optional().describe("Imported symbol names (for named imports)"),
  defaultName: z.string().optional().describe("Default import name"),
  namespaceName: z.string().optional().describe("Namespace import name (* as X)"),
  location: locationSchema$1.describe("Source location"),
  isRelative: z.boolean().optional().describe("Whether import is relative path")
});
const exportSchema = z.object({
  kind: z.enum(["named", "default", "re_export", "type_only", "all"]).describe("Export kind"),
  symbols: z.array(z.object({
    name: z.string(),
    alias: z.string().optional()
  })).optional().describe("Exported symbol names (for named exports)"),
  source: z.string().optional().describe("Re-export source module"),
  defaultName: z.string().optional().describe("Default export name/expression"),
  location: locationSchema$1.describe("Source location")
});
const callSiteSchema = z.object({
  callee: z.string().describe("Called function/method name"),
  location: locationSchema$1.describe("Location of the call"),
  isMethodCall: z.boolean().optional().describe("Whether this is a method call (obj.method())"),
  receiver: z.string().optional().describe("Receiver object for method calls"),
  arguments: z.number().optional().describe("Number of arguments")
});
const parseErrorSchema = z.object({
  message: z.string(),
  location: locationSchema$1.optional(),
  severity: z.enum(["error", "warning"]).optional()
});
const languageSchema = z.enum(["typescript", "javascript", "python", "java"]);
const astMetadataSchema = z.object({
  language: languageSchema.describe("Source language"),
  symbols: z.array(symbolSchema).describe("All top-level symbols"),
  imports: z.array(importSchema).describe("All import statements"),
  exports: z.array(exportSchema).describe("All export statements"),
  callSites: z.array(callSiteSchema).optional().describe("Function call sites"),
  errors: z.array(parseErrorSchema).optional().describe("Parsing errors/warnings"),
  metrics: z.object({
    totalLines: z.number().int().min(0).describe("Total lines in file"),
    codeLines: z.number().int().min(0).optional().describe("Non-empty, non-comment lines"),
    symbolCount: z.number().int().min(0).describe("Total symbol count"),
    functionCount: z.number().int().min(0).describe("Function/method count"),
    classCount: z.number().int().min(0).describe("Class/interface count"),
    importCount: z.number().int().min(0).describe("Import count"),
    exportCount: z.number().int().min(0).describe("Export count")
  }).optional().describe("Code metrics"),
  parseTimeMs: z.number().optional().describe("Time taken to parse (milliseconds)")
});
function validateASTMetadata(data) {
  return astMetadataSchema.parse(data);
}
function safeValidateASTMetadata(data) {
  const result = astMetadataSchema.safeParse(data);
  return result.success ? result.data : null;
}

"use strict";
const fileNodeWithASTSchema = z.lazy(
  () => z.object({
    name: z.string().describe("File or directory name"),
    path: z.string().describe("Absolute workspace-relative path"),
    type: z.enum(["file", "directory"]).describe("Entry type"),
    size: z.number().describe("Size in bytes (0 for directories, aggregate for dirs when computed)"),
    modifiedAt: z.string().optional().describe("ISO 8601 last-modified timestamp"),
    content: z.string().optional().describe("Entire file content for human-readable text files; omitted for binary/non-text files and directories"),
    children: z.array(fileNodeWithASTSchema).optional().describe("Child entries (only for directories)"),
    ast: astMetadataSchema.optional().describe("AST metadata for source files; omitted for binary files, directories, and files that failed parsing")
  })
);
const workspaceTreeWithASTSchema = z.object({
  root: z.string().describe("The root path that was scanned"),
  tree: z.array(fileNodeWithASTSchema).describe("Top-level entries in the workspace"),
  summary: z.object({
    totalFiles: z.number().describe("Total number of files found (after exclusions)"),
    totalDirectories: z.number().describe("Total number of directories found (after exclusions)"),
    totalSize: z.number().describe("Aggregate size of all files in bytes (after exclusions)"),
    textFilesWithContent: z.number().describe("Number of text files whose content was successfully indexed"),
    indexedContentChars: z.number().describe("Total number of characters indexed from text file contents"),
    excludedFiles: z.number().describe("Number of files excluded by exclusion patterns"),
    excludedDirectories: z.number().describe("Number of directories excluded by exclusion patterns"),
    excludedFilePaths: z.array(z.string()).describe("Paths of files excluded by exclusion patterns"),
    excludedDirectoryPaths: z.array(z.string()).describe("Paths of directories excluded by exclusion patterns"),
    exclusionPatternsUsed: z.array(z.string()).describe("Exclusion patterns that were applied"),
    astParsedFiles: z.number().optional().describe("Number of files successfully parsed for AST"),
    astParseErrors: z.number().optional().describe("Number of files that failed AST parsing"),
    astTotalParseTimeMs: z.number().optional().describe("Total time spent parsing AST (milliseconds)")
  })
});
const DEFAULT_AST_OPTIONS = {
  enabled: true,
  maxFileSizeBytes: 1024 * 1024,
  // 1MB
  timeoutMs: 5e3,
  languages: ["typescript", "javascript", "python", "java"]
};
async function enrichFileNodeWithAST(node, options = {}) {
  const opts = { ...DEFAULT_AST_OPTIONS, ...options };
  if (!opts.enabled) {
    return node;
  }
  if (node.type === "directory") {
    if (node.children) {
      const enrichedChildren = await Promise.all(
        node.children.map((child) => enrichFileNodeWithAST(child, options))
      );
      return { ...node, children: enrichedChildren };
    }
    return node;
  }
  if (!node.content) {
    return node;
  }
  if (node.size > opts.maxFileSizeBytes) {
    return node;
  }
  if (!getParserRegistry().isPathSupported(node.path)) {
    return node;
  }
  try {
    const ast = await parseFile(node.path, node.content);
    if (ast) {
      return { ...node, ast };
    }
  } catch (error) {
    console.warn(`[ast-integration] Failed to parse ${node.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return node;
}
async function enrichWorkspaceTreeWithAST(tree, options = {}) {
  const opts = { ...DEFAULT_AST_OPTIONS, ...options };
  if (!opts.enabled) {
    return tree;
  }
  let astParsedFiles = 0;
  let astParseErrors = 0;
  let astTotalParseTimeMs = 0;
  const enrichNodeWithTracking = async (node) => {
    if (node.type === "directory") {
      if (node.children) {
        const enrichedChildren = await Promise.all(
          node.children.map(enrichNodeWithTracking)
        );
        return { ...node, children: enrichedChildren };
      }
      return node;
    }
    if (!node.content || node.size > opts.maxFileSizeBytes) {
      return node;
    }
    if (!getParserRegistry().isPathSupported(node.path)) {
      return node;
    }
    const startTime = performance.now();
    try {
      const ast = await parseFile(node.path, node.content);
      const elapsed = performance.now() - startTime;
      astTotalParseTimeMs += elapsed;
      if (ast) {
        astParsedFiles++;
        return { ...node, ast };
      } else {
        astParseErrors++;
      }
    } catch (error) {
      astParseErrors++;
      console.warn(`[ast-integration] Failed to parse ${node.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return node;
  };
  const enrichedTree = await Promise.all(
    tree.tree.map(enrichNodeWithTracking)
  );
  return {
    ...tree,
    tree: enrichedTree,
    summary: {
      ...tree.summary,
      astParsedFiles,
      astParseErrors,
      astTotalParseTimeMs
    }
  };
}
function collectASTMetadata(tree) {
  const results = [];
  const collect = (node) => {
    if (node.type === "file" && node.ast) {
      results.push({ filePath: node.path, ast: node.ast });
    }
    if (node.children) {
      node.children.forEach(collect);
    }
  };
  tree.tree.forEach(collect);
  return results;
}
function getWorkspaceSymbols(tree) {
  const astFiles = collectASTMetadata(tree);
  const functions = [];
  const classes = [];
  const interfaces = [];
  const types = [];
  for (const { filePath, ast } of astFiles) {
    for (const symbol of ast.symbols) {
      switch (symbol.kind) {
        case "function":
        case "async_function":
        case "arrow_function":
        case "generator_function":
          functions.push({
            filePath,
            name: symbol.name,
            signature: symbol.signature,
            isExported: symbol.isExported
          });
          break;
        case "class":
        case "abstract_class":
          classes.push({
            filePath,
            name: symbol.name,
            isExported: symbol.isExported
          });
          break;
        case "interface":
          interfaces.push({
            filePath,
            name: symbol.name,
            isExported: symbol.isExported
          });
          break;
        case "type_alias":
          types.push({
            filePath,
            name: symbol.name
          });
          break;
      }
    }
  }
  return { functions, classes, interfaces, types };
}
function getWorkspaceImports(tree) {
  const astFiles = collectASTMetadata(tree);
  const importsBySource = /* @__PURE__ */ new Map();
  for (const { filePath, ast } of astFiles) {
    for (const imp of ast.imports) {
      const existing = importsBySource.get(imp.source) || [];
      existing.push({
        filePath,
        symbols: imp.symbols
      });
      importsBySource.set(imp.source, existing);
    }
  }
  return importsBySource;
}

"use strict";
const COMPLEXITY_THRESHOLDS = {
  LOW: 5,
  MEDIUM: 10,
  HIGH: 20
};
const CONTROL_FLOW_PATTERNS = {
  typescript: [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bswitch\s*\(/g,
    /\bcase\s+[^:]+:/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+\s*:/g,
    // Ternary operator
    /&&/g,
    // Logical AND
    /\|\|/g,
    // Logical OR
    /\?\?/g,
    // Nullish coalescing
    /\?\./g
    // Optional chaining (can branch)
  ],
  javascript: [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bswitch\s*\(/g,
    /\bcase\s+[^:]+:/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+\s*:/g,
    /&&/g,
    /\|\|/g,
    /\?\?/g,
    /\?\./g
  ],
  python: [
    /\bif\s+/g,
    /\belif\s+/g,
    /\bfor\s+/g,
    /\bwhile\s+/g,
    /\bexcept\s*/g,
    /\band\b/g,
    /\bor\b/g,
    /\bif\b[^:]*\belse\b/g
    // Inline if-else expression
  ],
  java: [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bswitch\s*\(/g,
    /\bcase\s+[^:]+:/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+\s*:/g,
    /&&/g,
    /\|\|/g
  ]
};
function calculateCyclomaticComplexity(functionBody, language) {
  const patterns = CONTROL_FLOW_PATTERNS[language] || CONTROL_FLOW_PATTERNS.javascript;
  const cleanedBody = removeStringsAndComments(functionBody, language);
  let complexity = 1;
  for (const pattern of patterns) {
    const matches = cleanedBody.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }
  return complexity;
}
function removeStringsAndComments(code, language) {
  let cleaned = code.replace(/\/\/[^\n]*/g, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  if (language === "python") {
    cleaned = cleaned.replace(/#[^\n]*/g, "");
    cleaned = cleaned.replace(/'''[\s\S]*?'''/g, "");
    cleaned = cleaned.replace(/"""[\s\S]*?"""/g, "");
  }
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return cleaned;
}
function calculateLinesOfCode(functionBody, language) {
  const lines = functionBody.split("\n");
  let loc = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (language === "python" && trimmed.startsWith("#")) continue;
    loc++;
  }
  return loc;
}
function calculateNestingDepth(functionBody) {
  let maxDepth = 0;
  let currentDepth = 0;
  for (const char of functionBody) {
    if (char === "{" || char === "(") {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === "}" || char === ")") {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }
  if (!functionBody.includes("{")) {
    const lines = functionBody.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const indent = line.match(/^(\s*)/)?.[1].length || 0;
      const depth = Math.floor(indent / 4);
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  return maxDepth;
}
function analyzeSymbolComplexity(filePath, symbol, sourceCode, language) {
  const functionBody = sourceCode.slice(
    symbol.location.startByte,
    symbol.location.endByte
  );
  const cyclomaticComplexity = calculateCyclomaticComplexity(functionBody, language);
  const linesOfCode = calculateLinesOfCode(functionBody, language);
  const nestingDepth = calculateNestingDepth(functionBody);
  const parameterCount = symbol.parameters?.length || 0;
  return {
    filePath,
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    location: {
      line: symbol.location.line,
      column: symbol.location.column
    },
    cyclomaticComplexity,
    linesOfCode,
    parameterCount,
    nestingDepth,
    isHighComplexity: cyclomaticComplexity > COMPLEXITY_THRESHOLDS.MEDIUM
  };
}
function analyzeFileComplexity(filePath, ast, sourceCode) {
  const results = [];
  const functionKinds = /* @__PURE__ */ new Set([
    "function",
    "async_function",
    "arrow_function",
    "generator_function",
    "method",
    "constructor"
  ]);
  const analyzeSymbol = (symbol) => {
    if (functionKinds.has(symbol.kind)) {
      const complexity = analyzeSymbolComplexity(filePath, symbol, sourceCode, ast.language);
      results.push(complexity);
    }
    if (symbol.members) {
      for (const member of symbol.members) {
        analyzeSymbol(member);
      }
    }
  };
  for (const symbol of ast.symbols) {
    analyzeSymbol(symbol);
  }
  return results;
}
function analyzeWorkspaceComplexity(tree, getSourceCode) {
  const astFiles = collectASTMetadata(tree);
  const allResults = [];
  for (const { filePath, ast } of astFiles) {
    const sourceCode = getSourceCode(filePath);
    if (!sourceCode) continue;
    const fileResults = analyzeFileComplexity(filePath, ast, sourceCode);
    allResults.push(...fileResults);
  }
  if (allResults.length === 0) {
    return {
      totalFunctions: 0,
      averageCyclomaticComplexity: 0,
      maxCyclomaticComplexity: 0,
      highComplexityFunctions: 0,
      highComplexityRate: 0,
      functionsByComplexity: [],
      complexityDistribution: { low: 0, medium: 0, high: 0, veryHigh: 0 }
    };
  }
  const complexities = allResults.map((r) => r.cyclomaticComplexity);
  const totalComplexity = complexities.reduce((sum, c) => sum + c, 0);
  const maxComplexity = Math.max(...complexities);
  const highComplexityFunctions = allResults.filter((r) => r.isHighComplexity).length;
  const sorted = [...allResults].sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);
  const distribution = {
    low: allResults.filter((r) => r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.LOW).length,
    medium: allResults.filter(
      (r) => r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.LOW && r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.MEDIUM
    ).length,
    high: allResults.filter(
      (r) => r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.MEDIUM && r.cyclomaticComplexity <= COMPLEXITY_THRESHOLDS.HIGH
    ).length,
    veryHigh: allResults.filter((r) => r.cyclomaticComplexity > COMPLEXITY_THRESHOLDS.HIGH).length
  };
  return {
    totalFunctions: allResults.length,
    averageCyclomaticComplexity: totalComplexity / allResults.length,
    maxCyclomaticComplexity: maxComplexity,
    highComplexityFunctions,
    highComplexityRate: highComplexityFunctions / allResults.length,
    functionsByComplexity: sorted,
    complexityDistribution: distribution
  };
}
function formatComplexitySummary(summary) {
  const lines = [];
  lines.push(`Complexity Analysis Summary:`);
  lines.push(`  Total functions: ${summary.totalFunctions}`);
  lines.push(`  Average cyclomatic complexity: ${summary.averageCyclomaticComplexity.toFixed(2)}`);
  lines.push(`  Max cyclomatic complexity: ${summary.maxCyclomaticComplexity}`);
  lines.push(`  High complexity functions: ${summary.highComplexityFunctions} (${(summary.highComplexityRate * 100).toFixed(1)}%)`);
  lines.push(`
  Complexity distribution:`);
  lines.push(`    Low (1-${COMPLEXITY_THRESHOLDS.LOW}): ${summary.complexityDistribution.low}`);
  lines.push(`    Medium (${COMPLEXITY_THRESHOLDS.LOW + 1}-${COMPLEXITY_THRESHOLDS.MEDIUM}): ${summary.complexityDistribution.medium}`);
  lines.push(`    High (${COMPLEXITY_THRESHOLDS.MEDIUM + 1}-${COMPLEXITY_THRESHOLDS.HIGH}): ${summary.complexityDistribution.high}`);
  lines.push(`    Very High (>${COMPLEXITY_THRESHOLDS.HIGH}): ${summary.complexityDistribution.veryHigh}`);
  if (summary.functionsByComplexity.length > 0) {
    const topComplex = summary.functionsByComplexity.slice(0, 10);
    lines.push(`
  Top complex functions:`);
    for (const func of topComplex) {
      lines.push(`    ${func.symbolName} (${func.filePath}:${func.location.line}): CC=${func.cyclomaticComplexity}, LOC=${func.linesOfCode}`);
    }
  }
  return lines.join("\n");
}

"use strict";
function isLocalImport(importPath) {
  return importPath.startsWith(".") || importPath.startsWith("/");
}
function resolveImportToWorkspacePath(importPath, fromFile, _basePath) {
  const fromDir = path.dirname(fromFile);
  const joined = path.join(fromDir, importPath);
  return path.normalize(joined);
}
function findImportedFile(resolvedPath, indexedFiles) {
  if (indexedFiles.has(resolvedPath)) {
    return resolvedPath;
  }
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const existingExt = path.extname(resolvedPath);
  if (existingExt && extensions.includes(existingExt)) {
    const basePath = resolvedPath.slice(0, -existingExt.length);
    for (const ext of extensions) {
      const withExt = basePath + ext;
      if (indexedFiles.has(withExt)) {
        return withExt;
      }
    }
  }
  for (const ext of extensions) {
    const withExt = resolvedPath + ext;
    if (indexedFiles.has(withExt)) {
      return withExt;
    }
  }
  const indexFiles = ["index.ts", "index.tsx", "index.js", "index.jsx"];
  for (const indexFile of indexFiles) {
    const indexPath = path.join(resolvedPath, indexFile);
    if (indexedFiles.has(indexPath)) {
      return indexPath;
    }
  }
  return null;
}
function parseImportedSymbols(importStatement) {
  const symbols = [];
  const namedMatch = importStatement.match(/\{([^}]+)\}/);
  if (namedMatch) {
    const names = namedMatch[1].split(",").map((s) => s.trim());
    for (const name of names) {
      const asMatch = name.match(/^(\w+)\s+as\s+\w+$/);
      if (asMatch) {
        symbols.push(asMatch[1]);
      } else if (name && /^\w+$/.test(name)) {
        symbols.push(name);
      }
    }
  }
  const defaultMatch = importStatement.match(/import\s+(\w+)\s+from/);
  if (defaultMatch && !importStatement.includes("{")) {
    symbols.push("default");
  }
  if (importStatement.includes("* as")) {
    symbols.push("*");
  }
  return symbols;
}
function findUsedImportedSymbols(importedSymbols, fileSymbols) {
  const usageMap = /* @__PURE__ */ new Map();
  for (const importedSymbol of importedSymbols) {
    const usedBy = [];
    for (const fileSymbol of fileSymbols) {
      if (fileSymbol.callTargets?.includes(importedSymbol)) {
        usedBy.push(fileSymbol.symbolName);
      }
      if (fileSymbol.bodyText?.includes(importedSymbol)) {
        if (!usedBy.includes(fileSymbol.symbolName)) {
          usedBy.push(fileSymbol.symbolName);
        }
      }
    }
    if (usedBy.length > 0) {
      usageMap.set(importedSymbol, usedBy);
    }
  }
  return usageMap;
}
function isSymbolExported(symbolName, targetFile, store) {
  if (targetFile.exports.includes(symbolName)) {
    return true;
  }
  const symbols = store.getSymbolsForFile(targetFile.filePath);
  const symbol = symbols.find((s) => s.symbolName === symbolName);
  if (symbol?.isExported) {
    return true;
  }
  if (symbolName === "default") {
    return targetFile.exports.some(
      (e) => e.includes("default") || e === ""
      // Empty string often means default export
    );
  }
  if (symbolName === "*") {
    return true;
  }
  return false;
}
function validateFileImports(filePath, imports, store, basePath) {
  const brokenImports = [];
  const indexedFiles = new Set(store.getFilePaths());
  const fileSymbols = store.getSymbolsForFile(filePath);
  let totalChecked = 0;
  for (const imp of imports) {
    if (!isLocalImport(imp.source)) {
      continue;
    }
    totalChecked++;
    const resolvedPath = resolveImportToWorkspacePath(imp.source, filePath, basePath);
    const actualFile = findImportedFile(resolvedPath, indexedFiles);
    const importedSymbols = imp.statement ? parseImportedSymbols(imp.statement) : ["*"];
    const usageMap = findUsedImportedSymbols(importedSymbols, fileSymbols);
    if (usageMap.size === 0) {
      continue;
    }
    const usedSymbols = Array.from(usageMap.keys());
    const usedBySymbols = Array.from(new Set(
      Array.from(usageMap.values()).flat()
    ));
    if (!actualFile) {
      brokenImports.push({
        importPath: imp.source,
        resolvedPath,
        importedSymbols: usedSymbols,
        issue: "file_not_found",
        usedBySymbols
      });
      continue;
    }
    const targetFile = store.getFile(actualFile);
    if (!targetFile) {
      continue;
    }
    const missingSymbols = [];
    for (const sym of usedSymbols) {
      if (!isSymbolExported(sym, targetFile, store)) {
        missingSymbols.push(sym);
      }
    }
    if (missingSymbols.length > 0) {
      brokenImports.push({
        importPath: imp.source,
        resolvedPath: actualFile,
        importedSymbols: missingSymbols,
        issue: "symbol_not_exported",
        usedBySymbols
      });
    }
  }
  return {
    filePath,
    brokenImports,
    totalImportsChecked: totalChecked
  };
}
function validateAllImports(store, basePath) {
  const results = [];
  let totalBroken = 0;
  let filesWithBrokenImports = 0;
  for (const filePath of store.getFilePaths()) {
    const file = store.getFile(filePath);
    if (!file) continue;
    const imports = file.imports.map((source) => ({ source }));
    const result = validateFileImports(filePath, imports, store, basePath);
    if (result.brokenImports.length > 0) {
      results.push(result);
      totalBroken += result.brokenImports.length;
      filesWithBrokenImports++;
    }
  }
  return {
    results,
    totalBroken,
    filesWithBrokenImports
  };
}
function getSymbolsUsingBrokenImports(validationResults) {
  const symbolToBrokenImports = /* @__PURE__ */ new Map();
  for (const result of validationResults) {
    for (const broken of result.brokenImports) {
      for (const symbolName of broken.usedBySymbols) {
        const key = `${result.filePath}:${symbolName}`;
        const existing = symbolToBrokenImports.get(key) || [];
        existing.push(broken);
        symbolToBrokenImports.set(key, existing);
      }
    }
  }
  return symbolToBrokenImports;
}

"use strict";
const MOCK_NAME_PATTERNS = [
  /\b(mock|fake|dummy|sample|test|stub|fixture|placeholder)\w*/i
];
const LOREM_PATTERN = /lorem\s+ipsum|dolor\s+sit\s+amet/i;
const TEST_EMAIL_PATTERN = /['"`](test|example|sample|fake|dummy|mock)\S*@(example|test|mock|fake)\.(com|org|net)['"`]/i;
const GENERIC_EMAIL_PATTERN = /['"`]\w+@example\.(com|org|net)['"`]/i;
const TEST_NAME_PATTERNS = [
  /['"`](John|Jane|Bob|Alice|Test|Sample|Example)\s+(Doe|Smith|User|Person|Customer)['"`]/i,
  /['"`](User|Customer|Admin|Test)\s*\d*['"`]/i
];
const PLACEHOLDER_URL_PATTERNS = [
  /['"`]https?:\/\/(www\.)?(example\.com|placeholder\.com|test\.com|localhost)/i,
  /['"`]https?:\/\/github\.com['"`]\s*[,}]/i,
  // Generic github.com without specific path
  /['"`]https?:\/\/api\.example/i,
  /['"`]#['"`]/
  // Placeholder href
];
const HARDCODED_DATE_PATTERNS = [
  /new\s+Date\s*\(\s*['"`]\d{4}-\d{2}-\d{2}/,
  /['"`]\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
  // ISO date strings
  /['"`](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}['"`]/i
];
const MOCK_COMMENT_PATTERNS = [
  /\/\/\s*(mock|fake|dummy|sample|test|placeholder|todo:\s*replace)/i,
  /\/\*\s*(mock|fake|dummy|sample|test|placeholder)/i,
  /\/\/\s*for\s+(demo|poc|testing|development)/i
];
const EXTERNAL_DATA_PATTERNS = [
  /\bfetch\s*\(/,
  /\baxios\s*\./,
  /\.\s*(get|post|put|delete|patch)\s*\(/,
  /\bawait\s+\w+\.(query|find|select|fetch|get|load)/,
  /\bprisma\s*\./,
  /\bdb\s*\./,
  /\bapi\s*\./i,
  /process\.env\./,
  /\bgetenv\s*\(/,
  /\bos\.environ/
];
const COMPUTED_DATA_PATTERNS = [
  /\breturn\s+\w+\s*\(/,
  // Return function call result
  /\breturn\s+await\s+/,
  /\.map\s*\(\s*\(/,
  /\.filter\s*\(\s*\(/,
  /\.reduce\s*\(\s*\(/
];
function countObjectsInArray(content) {
  const objectStartPattern = /\[\s*\{|\},?\s*\{/g;
  const matches = content.match(objectStartPattern);
  return matches ? matches.length : 0;
}
function hasSequentialIds(content) {
  const idMatches = content.match(/['"`]?(?:id|key)['"`]?\s*:\s*['"`]?(\d+|[a-z]\d*)['"`]?/gi);
  if (!idMatches || idMatches.length < 2) return false;
  const ids = [];
  for (const match of idMatches) {
    const numMatch = match.match(/(\d+)/);
    if (numMatch) {
      ids.push(parseInt(numMatch[1], 10));
    }
  }
  if (ids.length >= 2) {
    const sorted = [...ids].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] === 1) {
        return true;
      }
    }
  }
  return false;
}
function isMockVariableName(name) {
  return MOCK_NAME_PATTERNS.some((p) => p.test(name));
}
const MAX_BODY_SIZE_FOR_ANALYSIS = 1e4;
function analyzeMockData(bodyText, symbolName, callTargets = [], _language = "typescript") {
  const indicators = [];
  let confidence = 0;
  let role = "none";
  let dataSource = "unknown";
  const normalizedBody = bodyText && bodyText.length > MAX_BODY_SIZE_FOR_ANALYSIS ? bodyText.slice(0, MAX_BODY_SIZE_FOR_ANALYSIS) : bodyText || "";
  if (isMockVariableName(symbolName)) {
    indicators.push(`mock-like name: ${symbolName}`);
    confidence += 0.25;
    role = "produces";
  }
  if (LOREM_PATTERN.test(normalizedBody)) {
    indicators.push("lorem ipsum placeholder text");
    confidence += 0.35;
    role = "produces";
  }
  if (TEST_EMAIL_PATTERN.test(normalizedBody)) {
    indicators.push("test email pattern (test@example.com)");
    confidence += 0.25;
    role = role === "none" ? "produces" : role;
  } else if (GENERIC_EMAIL_PATTERN.test(normalizedBody)) {
    indicators.push("generic example email");
    confidence += 0.15;
    role = role === "none" ? "produces" : role;
  }
  for (const pattern of TEST_NAME_PATTERNS) {
    if (pattern.test(normalizedBody)) {
      indicators.push("test-like person name (John Doe, Test User)");
      confidence += 0.2;
      role = role === "none" ? "produces" : role;
      break;
    }
  }
  for (const pattern of PLACEHOLDER_URL_PATTERNS) {
    if (pattern.test(normalizedBody)) {
      indicators.push("placeholder URL (example.com, localhost)");
      confidence += 0.15;
      role = role === "none" ? "produces" : role;
      break;
    }
  }
  if (hasSequentialIds(normalizedBody)) {
    indicators.push("sequential IDs (1, 2, 3...)");
    confidence += 0.2;
    role = role === "none" ? "produces" : role;
  }
  const objectCount = countObjectsInArray(normalizedBody);
  if (objectCount >= 3) {
    indicators.push(`hardcoded object array (${objectCount} items)`);
    confidence += 0.25;
    role = role === "none" ? "produces" : role;
    dataSource = "hardcoded";
  } else if (objectCount >= 2) {
    indicators.push(`small object array (${objectCount} items)`);
    confidence += 0.1;
  }
  for (const pattern of HARDCODED_DATE_PATTERNS) {
    if (pattern.test(normalizedBody)) {
      indicators.push("hardcoded date literals");
      confidence += 0.1;
      role = role === "none" ? "produces" : role;
      break;
    }
  }
  for (const pattern of MOCK_COMMENT_PATTERNS) {
    if (pattern.test(normalizedBody)) {
      indicators.push("mock/placeholder comment");
      confidence += 0.2;
      role = role === "none" ? "produces" : role;
      break;
    }
  }
  const mockVarUsage = normalizedBody.match(/\b(mock|fake|dummy|sample|test)\w*\s*[=(.]/gi);
  if (mockVarUsage && mockVarUsage.length > 0) {
    indicators.push(`uses mock-named variables (${mockVarUsage.length} occurrences)`);
    confidence += 0.15;
    role = role === "produces" ? "both" : "consumes";
  }
  let hasExternalSource = false;
  for (const pattern of EXTERNAL_DATA_PATTERNS) {
    if (pattern.test(normalizedBody)) {
      hasExternalSource = true;
      dataSource = "external";
      confidence -= 0.3;
      break;
    }
  }
  const externalCallTargets = callTargets.filter(
    (t) => /fetch|axios|api|service|repository|client/i.test(t)
  );
  if (externalCallTargets.length > 0) {
    hasExternalSource = true;
    dataSource = "external";
    confidence -= 0.25;
  }
  if (!hasExternalSource) {
    for (const pattern of COMPUTED_DATA_PATTERNS) {
      if (pattern.test(normalizedBody)) {
        if (dataSource === "unknown") {
          dataSource = "computed";
        }
        confidence -= 0.15;
        break;
      }
    }
  }
  if (dataSource === "unknown" && indicators.length > 0) {
    dataSource = "hardcoded";
  }
  confidence = Math.max(0, Math.min(1, confidence));
  const hasMockData = confidence > 0.3 && indicators.length > 0;
  if (!hasMockData) {
    role = "none";
  }
  return {
    hasMockData,
    confidence: Math.round(confidence * 100) / 100,
    role,
    indicators,
    dataSource
  };
}
function toMockDataSchema(analysis) {
  return {
    hasMockData: analysis.hasMockData,
    mockDataConfidence: analysis.confidence,
    mockDataRole: analysis.role,
    mockIndicators: analysis.indicators,
    dataSource: analysis.dataSource
  };
}
function shouldAnalyzeMockData(kind) {
  const analyzableKinds = /* @__PURE__ */ new Set([
    "function",
    "async_function",
    "arrow_function",
    "method",
    "constant",
    "variable",
    "property"
  ]);
  return analyzableKinds.has(kind);
}

"use strict";
class ASTIndexerService {
  store;
  dependencyTracker;
  workspace;
  basePath = "";
  fileExistsCache = /* @__PURE__ */ new Map();
  symbolsEmbedded = 0;
  // Store file contents for reference finding
  fileContents = /* @__PURE__ */ new Map();
  constructor() {
    this.store = new StructuredIndexStore();
    this.dependencyTracker = new DependencyTracker();
  }
  /**
   * Index entire workspace
   */
  async indexWorkspace(options) {
    const startTime = Date.now();
    this.basePath = options.basePath;
    this.workspace = options.workspace;
    this.symbolsEmbedded = 0;
    const concurrency = options.concurrency ?? 5;
    tcAILogger.info(`[ASTIndexer] Starting workspace indexing: ${options.basePath}`);
    if (this.workspace) {
      tcAILogger.info(`[ASTIndexer] Vector store indexing enabled`);
    }
    await initializeASTSystem();
    tcAILogger.info(`[ASTIndexer] AST system initialized`);
    const result = {
      filesIndexed: 0,
      symbolsIndexed: 0,
      filesSkipped: 0,
      errors: [],
      durationMs: 0,
      indexedFilesList: [],
      skippedFilesList: []
    };
    this.store.clear();
    this.dependencyTracker.clear();
    this.fileExistsCache.clear();
    this.fileContents.clear();
    const sourceFiles = await this.collectSourceFiles(options.basePath);
    const totalFiles = sourceFiles.length;
    tcAILogger.info(`[ASTIndexer] Found ${totalFiles} source files to index`);
    tcAILogger.info(`[ASTIndexer] Concurrency limit: ${concurrency}`);
    const limit = pLimit(concurrency);
    let processedFiles = 0;
    const indexingPromises = sourceFiles.map(
      (filePath) => limit(async () => {
        try {
          tcAILogger.debug(`[ASTIndexer] Parsing: ${filePath}`);
          const indexed = await this.indexFile(filePath, options);
          processedFiles++;
          if (indexed) {
            result.filesIndexed++;
            result.symbolsIndexed += indexed.symbolCount;
            result.indexedFilesList.push(filePath);
            tcAILogger.info(`[ASTIndexer]   + ${filePath} (${indexed.symbolCount} symbols)`);
          } else {
            result.filesSkipped++;
            result.skippedFilesList.push(filePath);
            tcAILogger.debug(`[ASTIndexer]   - ${filePath} (skipped)`);
          }
        } catch (err) {
          processedFiles++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          result.errors.push({ file: filePath, error: errorMsg });
          tcAILogger.warn(`[ASTIndexer]   ! ${filePath} (error: ${errorMsg})`);
        }
        if (processedFiles % 20 === 0 || processedFiles === totalFiles) {
          const progress = Math.round(processedFiles / totalFiles * 100);
          tcAILogger.info(`[ASTIndexer] Progress: ${progress}% (${result.symbolsIndexed} symbols indexed)`);
        }
      })
    );
    await Promise.all(indexingPromises);
    tcAILogger.info(`[ASTIndexer] Phase 2: Finding references across ${this.fileContents.size} files...`);
    const refStartTime = Date.now();
    const referencesMap = findAllReferences(this.store, this.fileContents);
    tcAILogger.info(`[ASTIndexer] Reference scanning completed in ${Date.now() - refStartTime}ms`);
    tcAILogger.info(`[ASTIndexer] Attaching references to symbols...`);
    attachReferencesToSymbols(this.store, referencesMap);
    let symbolsWithRefs = 0;
    let symbolsWithoutRefs = 0;
    let totalRefs = 0;
    for (const [, refs] of referencesMap) {
      if (refs.length > 0) {
        symbolsWithRefs++;
        totalRefs += refs.length;
      } else {
        symbolsWithoutRefs++;
      }
    }
    tcAILogger.info(`[ASTIndexer] References: ${totalRefs} total, ${symbolsWithRefs} symbols with refs, ${symbolsWithoutRefs} without`);
    tcAILogger.info(`[ASTIndexer] Phase 3: Validating imports...`);
    const importValidation = validateAllImports(this.store, this.basePath);
    this.attachBrokenImportsToSymbols(importValidation.results);
    if (importValidation.totalBroken > 0) {
      tcAILogger.warn(`[ASTIndexer] Found ${importValidation.totalBroken} broken imports in ${importValidation.filesWithBrokenImports} files`);
      for (const result2 of importValidation.results) {
        for (const broken of result2.brokenImports) {
          const issueType = broken.issue === "file_not_found" ? "FILE NOT FOUND" : "SYMBOL NOT EXPORTED";
          tcAILogger.warn(`[ASTIndexer]   ! ${result2.filePath}: ${broken.importedSymbols.join(", ")} from '${broken.importPath}' (${issueType})`);
        }
      }
    } else {
      tcAILogger.info(`[ASTIndexer] All imports validated successfully`);
    }
    result.durationMs = Date.now() - startTime;
    this.store.updateStats(result.durationMs);
    this.logIndexingSummary(result);
    return result;
  }
  /**
   * Attach broken import info to symbols that use them
   */
  attachBrokenImportsToSymbols(validationResults) {
    const symbolToBrokenImports = getSymbolsUsingBrokenImports(validationResults);
    for (const [symbolKey, brokenImports] of symbolToBrokenImports) {
      const [filePath, symbolName] = symbolKey.split(":");
      const symbols = this.store.getSymbolsForFile(filePath);
      const symbol = symbols.find((s) => s.symbolName === symbolName);
      if (symbol) {
        symbol.brokenImports = brokenImports.map((bi) => ({
          importPath: bi.importPath,
          resolvedPath: bi.resolvedPath,
          importedSymbols: bi.importedSymbols,
          issue: bi.issue
        }));
      }
    }
  }
  /**
   * Index a single file
   */
  async indexFile(filePath, options) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.basePath, filePath);
    const relativePath = path.isAbsolute(filePath) ? path.relative(this.basePath, filePath) : filePath;
    tcAILogger.debug(`[ASTIndexer] Processing: ${relativePath}`);
    if (!isExtensionSupported(path.extname(filePath))) {
      tcAILogger.debug(`[ASTIndexer] [${relativePath}] Skipped: unsupported extension`);
      return null;
    }
    if (isExcludedFile(relativePath)) {
      tcAILogger.debug(`[ASTIndexer] [${relativePath}] Skipped: excluded file`);
      return null;
    }
    let sourceCode;
    try {
      sourceCode = await fs.readFile(absolutePath, "utf-8");
    } catch {
      return null;
    }
    const ast = await parseFile(filePath, sourceCode);
    if (!ast) {
      return null;
    }
    this.fileContents.set(relativePath, { sourceCode, language: ast.language });
    const indexedSymbols = this.convertToIndexedSymbols(
      relativePath,
      ast,
      sourceCode,
      options.includeBody ?? false
    );
    this.store.addSymbols(indexedSymbols);
    const indexedFile = {
      filePath: relativePath,
      language: ast.language,
      symbolIds: indexedSymbols.map((s) => s.id),
      imports: ast.imports.map((i) => i.source),
      exports: ast.exports.map((e) => e.defaultName || e.symbols?.map((s) => s.name).join(", ") || ""),
      metrics: {
        totalLines: ast.metrics?.totalLines ?? 0,
        codeLines: ast.metrics?.codeLines ?? 0,
        symbolCount: ast.metrics?.symbolCount ?? 0,
        functionCount: ast.metrics?.functionCount ?? 0,
        classCount: ast.metrics?.classCount ?? 0
      },
      parseTimeMs: ast.parseTimeMs ?? 0,
      indexedAt: Date.now()
    };
    this.store.addFile(indexedFile);
    const resolvedImports = this.resolveImports(ast.imports.map((i) => i.source), relativePath);
    this.dependencyTracker.registerFile(indexedFile, resolvedImports);
    if (this.workspace) {
      await this.indexSymbolsInVectorStore(indexedSymbols, sourceCode);
    }
    tcAILogger.debug(`[ASTIndexer] Indexed: ${relativePath} (${indexedSymbols.length} symbols)`);
    return { symbolCount: indexedSymbols.length };
  }
  /**
   * Update a file and its dependents (for incremental updates)
   */
  async updateFile(filePath, options) {
    const startTime = Date.now();
    const result = {
      filesIndexed: 0,
      symbolsIndexed: 0,
      filesSkipped: 0,
      errors: [],
      durationMs: 0,
      indexedFilesList: [],
      skippedFilesList: []
    };
    const affectedFiles = this.dependencyTracker.getAffectedFiles(filePath);
    tcAILogger.info(`[ASTIndexer] Updating ${affectedFiles.length} affected files`);
    for (const file of affectedFiles) {
      this.store.removeFile(file);
      try {
        const indexed = await this.indexFile(file, options);
        if (indexed) {
          result.filesIndexed++;
          result.symbolsIndexed += indexed.symbolCount;
          result.indexedFilesList.push(file);
        } else {
          result.filesSkipped++;
          result.skippedFilesList.push(file);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ file, error: errorMsg });
      }
    }
    result.durationMs = Date.now() - startTime;
    return result;
  }
  /**
   * Get the structured index store
   */
  getStore() {
    return this.store;
  }
  /**
   * Get dependency tracker
   */
  getDependencyTracker() {
    return this.dependencyTracker;
  }
  /**
   * Get index statistics
   */
  getStats() {
    return this.store.getStats();
  }
  /**
   * Export index to JSON
   */
  exportIndex() {
    return {
      index: this.store.exportToJSON(),
      dependencies: this.dependencyTracker.exportToJSON()
    };
  }
  /**
   * Import index from JSON
   */
  importIndex(data) {
    this.store.importFromJSON(data.index);
    this.dependencyTracker.importFromJSON(data.dependencies);
  }
  /**
   * Clear all indexed data
   */
  clear() {
    this.store.clear();
    this.dependencyTracker.clear();
    this.fileExistsCache.clear();
  }
  // --- Private methods ---
  async collectSourceFiles(basePath) {
    const files = [];
    const walk = async (dir, relativePath) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const entryFullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDED_FILE_PATTERNS.directories.includes(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".github") continue;
          await walk(entryFullPath, entryRelPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (isExtensionSupported(ext) && !isExcludedFile(entryRelPath)) {
            files.push(entryRelPath);
            this.fileExistsCache.set(entryRelPath, true);
          }
        }
      }
    };
    await walk(basePath, "");
    return files;
  }
  convertToIndexedSymbols(filePath, ast, sourceCode, includeBody) {
    const symbols = [];
    const processSymbol = (symbol, parentId, parentName, parentKind) => {
      const id = generateSymbolId(filePath, symbol.name, symbol.kind, symbol.location.line);
      const bodyText = sourceCode.slice(symbol.location.startByte, symbol.location.endByte);
      const metrics = this.computeMetrics(bodyText, ast.language, symbol);
      const propertyMeta = this.extractPropertyMetadata(symbol, bodyText);
      const indexed = {
        id,
        filePath,
        language: ast.language,
        symbolName: symbol.name,
        kind: symbol.kind,
        span: {
          startLine: symbol.location.line,
          endLine: symbol.location.line + bodyText.split("\n").length - 1,
          startCol: symbol.location.column,
          endCol: symbol.location.column,
          // Could be more precise
          startByte: symbol.location.startByte,
          endByte: symbol.location.endByte
        },
        signature: symbol.signature,
        visibility: symbol.visibility,
        isExported: symbol.isExported,
        isAsync: symbol.isAsync,
        isStatic: symbol.isStatic,
        isAbstract: symbol.isAbstract,
        parentSymbolId: parentId,
        parentSymbolName: parentName,
        parentSymbolKind: parentKind,
        childrenIds: symbol.members?.map(
          (m) => generateSymbolId(filePath, m.name, m.kind, m.location.line)
        ),
        // Property-specific fields
        propertyType: propertyMeta.propertyType,
        isOptional: propertyMeta.isOptional,
        isReadonly: propertyMeta.isReadonly,
        hasInitializer: propertyMeta.hasInitializer,
        // Relations
        callTargets: symbol.body?.callTargets,
        implementsOrExtends: [
          ...symbol.extends ? [symbol.extends] : [],
          ...symbol.implements ?? []
        ],
        decorators: symbol.decorators,
        metrics,
        indexedAt: Date.now()
      };
      if (shouldAnalyzeMockData(symbol.kind)) {
        const mockAnalysis = analyzeMockData(
          bodyText,
          symbol.name,
          symbol.body?.callTargets ?? [],
          ast.language
        );
        if (mockAnalysis.hasMockData || mockAnalysis.indicators.length > 0) {
          indexed.mockData = mockAnalysis;
        }
      }
      if (includeBody) {
        indexed.bodyText = bodyText;
      }
      symbols.push(indexed);
      if (symbol.members) {
        for (const member of symbol.members) {
          processSymbol(member, id, symbol.name, symbol.kind);
        }
      }
    };
    for (const symbol of ast.symbols) {
      processSymbol(symbol);
    }
    return symbols;
  }
  /**
   * Extract property-specific metadata from symbol and body text
   */
  extractPropertyMetadata(symbol, bodyText) {
    const propertyKinds = ["property", "field", "property_signature"];
    if (!propertyKinds.includes(symbol.kind)) {
      return {};
    }
    const sig = symbol.signature ?? bodyText;
    const isOptional = /\w+\s*\?:/.test(sig) || /\w+\s*\?\s*=/.test(sig);
    const isReadonly = /\breadonly\b/i.test(sig);
    const hasInitializer = /=\s*[^>]/.test(sig) && !/=>\s*/.test(sig);
    let propertyType;
    const typeMatch = sig.match(/:\s*([^=;]+?)(?:\s*[=;]|$)/);
    if (typeMatch) {
      propertyType = typeMatch[1].trim();
    }
    return {
      propertyType,
      isOptional: isOptional || void 0,
      isReadonly: isReadonly || void 0,
      hasInitializer: hasInitializer || void 0
    };
  }
  computeMetrics(bodyText, language, symbol) {
    const isFunctionLike = [
      "function",
      "async_function",
      "arrow_function",
      "generator_function",
      "method",
      "constructor",
      "getter",
      "setter",
      "lambda"
    ].includes(symbol.kind);
    return {
      complexity: isFunctionLike ? calculateCyclomaticComplexity(bodyText, language) : 0,
      nesting: calculateNestingDepth(bodyText),
      linesOfCode: calculateLinesOfCode(bodyText, language),
      parameterCount: symbol.parameters?.length ?? 0,
      hasLogging: detectLogging(bodyText, language),
      hasErrorHandling: detectErrorHandling(bodyText, language)
    };
  }
  resolveImports(importSources, fromFile) {
    const resolved = [];
    const fileExists = (p) => this.fileExistsCache.has(p);
    for (const source of importSources) {
      const resolvedPath = resolveImportPath(source, fromFile, fileExists);
      if (resolvedPath) {
        resolved.push(resolvedPath);
      }
    }
    return resolved;
  }
  /**
   * Index symbols in the Mastra workspace vector store for semantic search.
   * Creates comprehensive text representations including signature, body, and metrics.
   * Uses parallel embedding with concurrency control from EmbedderService.
   */
  async indexSymbolsInVectorStore(symbols, sourceCode) {
    if (!this.workspace) return;
    if (symbols.length === 0) return;
    const embedder = getReviewEmbedder();
    const embedLimit = pLimit(8);
    const embedPromises = symbols.map(
      (symbol) => embedLimit(async () => {
        const documentPath = `${symbol.filePath}:${symbol.symbolName}`;
        const content = this.createSymbolDocument(symbol, sourceCode);
        try {
          embedder.setEmbedSource(`symbol:${documentPath}`);
          await this.workspace.index(documentPath, content, {
            type: "file",
            metadata: {
              symbolId: symbol.id,
              kind: symbol.kind,
              language: symbol.language,
              filePath: symbol.filePath,
              symbolName: symbol.symbolName,
              line: symbol.span.startLine,
              complexity: symbol.metrics.complexity,
              hasLogging: symbol.metrics.hasLogging,
              hasErrorHandling: symbol.metrics.hasErrorHandling,
              isExported: symbol.isExported ?? false
            }
          });
          this.symbolsEmbedded++;
        } catch (err) {
          tcAILogger.debug(`[ASTIndexer] Failed to embed symbol: ${documentPath}`, { error: err });
        }
      })
    );
    await Promise.all(embedPromises);
  }
  /**
   * Create a comprehensive document for a symbol including all details for search.
   */
  createSymbolDocument(symbol, sourceCode) {
    const sections = [];
    sections.push(`[${symbol.kind.toUpperCase()}] ${symbol.symbolName}`);
    sections.push(`Language: ${symbol.language}`);
    sections.push(`File: ${symbol.filePath}:${symbol.span.startLine}`);
    if (symbol.signature) {
      sections.push(`
Signature:
${symbol.signature}`);
    }
    const modifiers = [];
    if (symbol.visibility) modifiers.push(symbol.visibility);
    if (symbol.isExported) modifiers.push("exported");
    if (symbol.isAsync) modifiers.push("async");
    if (symbol.isStatic) modifiers.push("static");
    if (symbol.isAbstract) modifiers.push("abstract");
    if (modifiers.length > 0) {
      sections.push(`Modifiers: ${modifiers.join(", ")}`);
    }
    if (symbol.implementsOrExtends && symbol.implementsOrExtends.length > 0) {
      sections.push(`Extends/Implements: ${symbol.implementsOrExtends.join(", ")}`);
    }
    if (symbol.decorators && symbol.decorators.length > 0) {
      sections.push(`Decorators: ${symbol.decorators.join(", ")}`);
    }
    sections.push(`
Metrics:`);
    sections.push(`  Complexity: ${symbol.metrics.complexity}`);
    sections.push(`  Nesting depth: ${symbol.metrics.nesting}`);
    sections.push(`  Lines of code: ${symbol.metrics.linesOfCode}`);
    sections.push(`  Parameters: ${symbol.metrics.parameterCount}`);
    sections.push(`  Has logging: ${symbol.metrics.hasLogging ? "yes" : "no"}`);
    sections.push(`  Has error handling: ${symbol.metrics.hasErrorHandling ? "yes" : "no"}`);
    if (symbol.callTargets && symbol.callTargets.length > 0) {
      sections.push(`
Calls: ${symbol.callTargets.join(", ")}`);
    }
    if (symbol.bodyText) {
      sections.push(`
Body:
${symbol.bodyText}`);
    } else {
      const body = sourceCode.slice(symbol.span.startByte, symbol.span.endByte);
      if (body.length <= 4e3) {
        sections.push(`
Body:
${body}`);
      } else {
        sections.push(`
Body (truncated):
${body.slice(0, 4e3)}...`);
      }
    }
    if (symbol.docComment) {
      sections.push(`
Documentation:
${symbol.docComment}`);
    }
    return sections.join("\n");
  }
  logIndexingSummary(result) {
    const stats = this.store.getStats();
    tcAILogger.info(`[ASTIndexer] ========== Indexing Complete ==========`);
    tcAILogger.info(`[ASTIndexer] Duration: ${(result.durationMs / 1e3).toFixed(2)}s`);
    tcAILogger.info(`[ASTIndexer] Files indexed: ${result.filesIndexed}`);
    tcAILogger.info(`[ASTIndexer] Files skipped: ${result.filesSkipped}`);
    tcAILogger.info(`[ASTIndexer] Symbols indexed: ${result.symbolsIndexed}`);
    tcAILogger.info(`[ASTIndexer] Symbols in vector store: ${this.symbolsEmbedded}`);
    tcAILogger.info(`[ASTIndexer] Errors: ${result.errors.length}`);
    if (result.indexedFilesList.length > 0) {
      tcAILogger.info(`[ASTIndexer] Indexed files:`);
      for (const file of result.indexedFilesList) {
        const fileSymbols = this.store.getSymbolsForFile(file);
        tcAILogger.info(`[ASTIndexer]   + ${file} (${fileSymbols.length} symbols)`);
      }
    }
    if (result.skippedFilesList.length > 0) {
      tcAILogger.info(`[ASTIndexer] Skipped files:`);
      for (const file of result.skippedFilesList) {
        tcAILogger.info(`[ASTIndexer]   - ${file}`);
      }
    }
    if (Object.keys(stats.byLanguage).length > 0) {
      tcAILogger.info(`[ASTIndexer] By language:`);
      for (const [lang, count] of Object.entries(stats.byLanguage)) {
        tcAILogger.info(`[ASTIndexer]   - ${lang}: ${count} symbols`);
      }
    }
    if (Object.keys(stats.byKind).length > 0) {
      tcAILogger.info(`[ASTIndexer] By kind (top 5):`);
      const sorted = Object.entries(stats.byKind).sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [kind, count] of sorted) {
        tcAILogger.info(`[ASTIndexer]   - ${kind}: ${count}`);
      }
    }
    const depStats = this.dependencyTracker.getStats();
    tcAILogger.info(`[ASTIndexer] Dependencies: avg ${depStats.avgImports.toFixed(1)} imports/file`);
    if (depStats.maxDependents) {
      tcAILogger.info(`[ASTIndexer] Most depended: ${depStats.maxDependents.file} (${depStats.maxDependents.count} dependents)`);
    }
    if (result.errors.length > 0 && result.errors.length <= 5) {
      tcAILogger.warn(`[ASTIndexer] Error details:`);
      for (const { file, error } of result.errors) {
        tcAILogger.warn(`[ASTIndexer]   ! ${file}: ${error}`);
      }
    }
    tcAILogger.info(`[ASTIndexer] ==========================================`);
  }
}

"use strict";
const locationSchema = z.object({
  file: z.string().describe("Relative file path from workspace root"),
  line: z.number().int().positive().describe("1-based line number where symbol/reference starts"),
  endLine: z.number().int().positive().optional().describe("1-based line number where symbol ends"),
  column: z.number().int().min(0).optional().describe("0-based column offset")
});
const metricsSchema = z.object({
  complexity: z.number().int().min(0).describe(
    "Cyclomatic complexity: number of independent paths through code. 1=linear, 2-5=simple, 6-10=moderate, 11-20=complex, >20=very complex. Counts: if/else, for, while, switch/case, catch, &&, ||, ?:, ??, ?."
  ),
  loc: z.number().int().min(0).describe(
    "Lines of Code: non-empty, non-comment lines. Does not include blank lines or comment-only lines."
  ),
  nesting: z.number().int().min(0).describe(
    "Maximum nesting depth of braces/parentheses. High nesting (>4) suggests refactoring needed."
  ),
  params: z.number().int().min(0).describe(
    "Parameter count for functions/methods. >4 params may indicate need for parameter object."
  )
});
const flagsSchema = z.object({
  hasLogging: z.boolean().describe(
    "Whether symbol contains logging statements (console.*, logger.*, log.*, print, etc.)"
  ),
  hasErrorHandling: z.boolean().describe(
    "Whether symbol contains try/catch, .catch(), or error handling patterns"
  ),
  isExported: z.boolean().describe(
    "Whether symbol is exported/public (accessible outside its module)"
  ),
  isAsync: z.boolean().optional().describe(
    "Whether function/method is async (returns Promise)"
  ),
  isStatic: z.boolean().optional().describe(
    "Whether method is static (belongs to class, not instance)"
  ),
  isAbstract: z.boolean().optional().describe(
    "Whether class/method is abstract (must be implemented by subclass)"
  )
});
const documentationSchema = z.object({
  commentDensity: z.number().min(0).max(1).describe(
    "Ratio of comment lines to total lines (0-1). 0=no comments, 0.1-0.2=sparse, 0.2-0.4=moderate, >0.4=heavily commented"
  ),
  hasApiDoc: z.boolean().describe(
    "Whether the symbol has JSDoc/docstring documentation (for exported symbols)"
  ),
  apiDocQuality: z.enum(["none", "minimal", "partial", "complete"]).optional().describe(
    "Quality of API documentation: none=no doc, minimal=description only, partial=has @param or @returns but not both, complete=has description + @param + @returns"
  ),
  namingQuality: z.enum(["poor", "acceptable", "good"]).describe(
    "Quality of identifier naming: poor=mostly abbreviations/single chars, acceptable=mix of clear and unclear names, good=mostly dictionary words/clear names"
  ),
  namingIssues: z.array(z.string()).optional().describe(
    "List of problematic identifier names found (single chars, unclear abbreviations)"
  ),
  inlineComments: z.number().int().min(0).describe(
    "Count of inline comments within the function body"
  ),
  todoCount: z.number().int().min(0).describe(
    "Count of TODO/FIXME/HACK/XXX comments"
  )
});
const mockDataSchema = z.object({
  hasMockData: z.boolean().describe(
    "Whether the symbol contains or returns hardcoded mock/sample data"
  ),
  mockDataConfidence: z.number().min(0).max(1).describe(
    "Confidence score: 0=definitely real, 1=definitely mock. >0.7 high confidence mock, 0.3-0.7 uncertain, <0.3 likely real"
  ),
  mockDataRole: z.enum(["produces", "consumes", "both", "none"]).describe(
    "produces=returns/assigns mock data, consumes=uses mock variables, both=produces and consumes, none=no mock data detected"
  ),
  mockIndicators: z.array(z.string()).describe(
    'Evidence for mock classification. Examples: "hardcoded object array (3 items)", "test-like IDs (id: 1, 2, 3)", "sample names (John Doe, Jane)", "lorem ipsum text"'
  ),
  dataSource: z.enum(["hardcoded", "computed", "external", "unknown"]).optional().describe(
    "hardcoded=literals in code, computed=derived from inputs, external=fetched from API/DB, unknown=cannot determine"
  )
});
const brokenImportSchema = z.object({
  importPath: z.string().describe("The import path as written in code"),
  resolvedPath: z.string().describe("Resolved path relative to workspace"),
  importedSymbols: z.array(z.string()).describe("Symbols imported that are missing/broken"),
  issue: z.enum(["file_not_found", "symbol_not_exported"]).describe(
    "Type of issue: file_not_found=import file does not exist, symbol_not_exported=file exists but symbol is not exported"
  ),
  usedBySymbols: z.array(z.string()).describe(
    "Symbols in current file that use this broken import"
  )
});
const reviewHintsSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]).describe(
    "Computed risk level based on complexity, error handling, and test coverage. low: simple with good practices, medium: moderate complexity, high: complex or missing safeguards, critical: very complex with no error handling, OR uses missing dependencies"
  ),
  riskFactors: z.array(z.string()).describe(
    'List of specific risk factors identified. Examples: "high complexity (15)", "no error handling", "no logging", "deeply nested (5)", "many parameters (7)", "uses missing dependency: X from Y"'
  ),
  suggestions: z.array(z.string()).optional().describe(
    "Actionable improvement suggestions based on detected issues"
  ),
  testCoverage: z.enum(["none", "partial", "good"]).optional().describe(
    "Inferred test coverage: none=no refs from test files, partial=some test refs, good=multiple test refs"
  ),
  isDeadCode: z.boolean().optional().describe(
    "True if symbol has no references and is not exported (potentially unused code)"
  ),
  isEntryPoint: z.boolean().optional().describe(
    "True if symbol is exported but has no internal callers (API surface)"
  ),
  brokenImports: z.array(brokenImportSchema).optional().describe(
    "Broken imports used by this symbol (file not found or symbol not exported)"
  ),
  usesMissingDependency: z.boolean().optional().describe(
    "True if this symbol uses functionality from a broken import - automatically critical risk"
  ),
  documentation: documentationSchema.optional().describe(
    "Documentation and clarity metrics (only for function-like symbols)"
  ),
  mockData: mockDataSchema.optional().describe(
    "Mock data detection results (for function-like symbols and constants with initializers)"
  )
});
const referenceSchema = z.object({
  file: z.string().describe("File where reference occurs (relative path)"),
  line: z.number().int().positive().describe("Line number of the reference"),
  caller: z.string().optional().describe(
    "Name of the function/method containing this reference, if any"
  ),
  context: z.string().describe(
    "Code snippet showing how the symbol is used (truncated to ~100 chars)"
  ),
  isTest: z.boolean().describe(
    "Whether this reference is in a test file (*.test.*, *.spec.*, __tests__/*, test/*)"
  ),
  isTypeOnly: z.boolean().optional().describe(
    "Whether this is a type-only reference (type annotation, not runtime usage)"
  )
});
const referencesSummarySchema = z.object({
  total: z.number().int().min(0).describe("Total number of references found"),
  inTests: z.number().int().min(0).describe("Number of references in test files"),
  inProduction: z.number().int().min(0).describe("Number of references in non-test files"),
  locations: z.array(referenceSchema).describe("Individual reference locations")
});
const callGraphSchema = z.object({
  calls: z.array(z.string()).optional().describe(
    "Functions/methods this symbol calls (outgoing edges)"
  ),
  calledBy: z.array(z.string()).optional().describe(
    "Functions/methods that call this symbol (incoming edges, derived from references)"
  )
});
const symbolDocumentSchema = z.object({
  // Identity
  symbol: z.string().describe("Symbol name (function, class, variable, etc.)"),
  kind: z.string().describe(
    "Symbol type: function, method, class, interface, type_alias, constant, variable, property, enum, etc."
  ),
  language: z.string().describe("Programming language: typescript, javascript, python, java, etc."),
  // Location
  location: locationSchema.describe("Where the symbol is defined"),
  // Signature and modifiers
  signature: z.string().optional().describe(
    'Full signature including parameters, types, and return type. For functions: "async function name(param: Type): ReturnType". For classes: "class Name extends Base implements Interface".'
  ),
  modifiers: z.array(z.string()).optional().describe(
    "Access modifiers and keywords: public, private, protected, static, async, abstract, readonly, export, etc."
  ),
  visibility: z.enum(["public", "private", "protected", "internal"]).optional().describe(
    "Access level of the symbol"
  ),
  // Hierarchy - for properties/methods, shows containing type
  parentSymbol: z.string().optional().describe(
    "Name of the containing symbol (class, interface, type for properties/methods)"
  ),
  parentKind: z.string().optional().describe(
    "Kind of the parent symbol: class, interface, type_alias, enum, etc."
  ),
  // Property-specific fields
  propertyType: z.string().optional().describe(
    'Type annotation for properties/fields (e.g., "string[]", "number", "UserConfig")'
  ),
  isOptional: z.boolean().optional().describe(
    "Whether the property is optional (has ? modifier)"
  ),
  isReadonly: z.boolean().optional().describe(
    "Whether the property is readonly"
  ),
  hasInitializer: z.boolean().optional().describe(
    "Whether the property has an initializer/default value (class properties)"
  ),
  // Inheritance
  extends: z.string().optional().describe("Parent class this class extends"),
  implements: z.array(z.string()).optional().describe("Interfaces this class implements"),
  decorators: z.array(z.string()).optional().describe(
    "Decorators/annotations applied (@Injectable, @Component, etc.)"
  ),
  // Metrics and flags
  metrics: metricsSchema.describe("Computed code metrics"),
  flags: flagsSchema.describe("Boolean flags indicating code characteristics"),
  // Review-focused analysis
  review: reviewHintsSchema.describe("AI review hints and risk assessment"),
  // Dependencies
  callGraph: callGraphSchema.optional().describe("What this symbol calls and what calls it"),
  // References
  references: referencesSummarySchema.describe("Where this symbol is used across the codebase"),
  // Documentation
  docComment: z.string().optional().describe(
    "JSDoc/docstring comment extracted from source"
  ),
  // Source code
  body: z.string().optional().describe(
    "Full source code of the symbol (may be truncated for large symbols)"
  ),
  bodyTruncated: z.boolean().optional().describe(
    "True if body was truncated due to size limits"
  )
});
const SCHEMA_HINTS = `
## AST Symbol Document Schema

This JSON document describes a code symbol (function, class, variable, etc.) extracted via AST analysis.

### Key Fields:

**Identity & Location:**
- \`symbol\`: The name of the code element
- \`kind\`: What type of element (function, class, method, constant, etc.)
- \`location.file\`: Relative path from workspace root
- \`location.line\`: Starting line number (1-based)

**Metrics (for identifying complex/risky code):**
- \`metrics.complexity\`: Cyclomatic complexity (1=simple, >10=complex, >20=very complex)
- \`metrics.loc\`: Lines of code (non-blank, non-comment)
- \`metrics.nesting\`: Max bracket depth (>4 suggests refactoring)
- \`metrics.params\`: Parameter count (>4 may need parameter object)

**Flags (code quality indicators):**
- \`flags.hasLogging\`: Contains logging statements
- \`flags.hasErrorHandling\`: Has try/catch or .catch()
- \`flags.isExported\`: Publicly accessible

**Review Hints (AI-focused analysis):**
- \`review.riskLevel\`: Overall risk assessment (low/medium/high/critical)
- \`review.riskFactors\`: Specific issues found
- \`review.isDeadCode\`: Unused code candidate
- \`review.isEntryPoint\`: API surface (exported, no internal callers)
- \`review.testCoverage\`: Inferred from test file references
- \`review.mockData\`: Mock/sample data detection for requirement verification

**Mock Data Detection:**
- \`review.mockData.hasMockData\`: Whether symbol uses hardcoded test/sample data
- \`review.mockData.mockDataConfidence\`: 0-1 confidence (>0.7 = likely mock)
- \`review.mockData.mockDataRole\`: produces/consumes/both/none
- \`review.mockData.mockIndicators\`: Evidence list (e.g., "hardcoded array", "test IDs")
- \`review.mockData.dataSource\`: hardcoded/computed/external/unknown

**References (usage tracking):**
- \`references.total\`: How many places use this symbol
- \`references.inTests\`: References from test files
- \`references.locations\`: Specific usage locations with context

**Call Graph:**
- \`callGraph.calls\`: What this symbol calls
- \`callGraph.calledBy\`: What calls this symbol

### Risk Level Calculation:
- \`critical\`: complexity > 20 AND no error handling
- \`high\`: complexity > 10 OR (no error handling AND no logging AND exported)
- \`medium\`: complexity > 5 OR params > 4 OR nesting > 3
- \`low\`: Everything else
`.trim();

"use strict";
const COMMON_WORDS = /* @__PURE__ */ new Set([
  // Verbs
  "get",
  "set",
  "add",
  "remove",
  "delete",
  "create",
  "update",
  "find",
  "search",
  "fetch",
  "load",
  "save",
  "store",
  "read",
  "write",
  "parse",
  "format",
  "convert",
  "transform",
  "map",
  "filter",
  "reduce",
  "sort",
  "merge",
  "split",
  "join",
  "trim",
  "validate",
  "check",
  "verify",
  "test",
  "assert",
  "ensure",
  "require",
  "expect",
  "handle",
  "process",
  "execute",
  "run",
  "start",
  "stop",
  "init",
  "initialize",
  "setup",
  "configure",
  "build",
  "compile",
  "render",
  "display",
  "show",
  "hide",
  "enable",
  "disable",
  "toggle",
  "switch",
  "change",
  "modify",
  "reset",
  "clear",
  "open",
  "close",
  "connect",
  "disconnect",
  "send",
  "receive",
  "emit",
  "listen",
  "subscribe",
  "unsubscribe",
  "publish",
  "dispatch",
  "notify",
  "trigger",
  "fire",
  "log",
  "debug",
  "info",
  "warn",
  "error",
  "throw",
  "catch",
  "try",
  "retry",
  "wait",
  "delay",
  "timeout",
  "cancel",
  "abort",
  "resolve",
  "reject",
  "promise",
  "async",
  "await",
  "sync",
  "lock",
  "unlock",
  "acquire",
  "release",
  "clone",
  "copy",
  "move",
  "swap",
  "replace",
  "insert",
  "append",
  "prepend",
  "push",
  "pop",
  "shift",
  "unshift",
  "slice",
  "splice",
  "concat",
  "flatten",
  "group",
  "chunk",
  "batch",
  "queue",
  "dequeue",
  "enqueue",
  "stack",
  "encode",
  "decode",
  "encrypt",
  "decrypt",
  "hash",
  "sign",
  "verify",
  "serialize",
  "deserialize",
  "stringify",
  "parse",
  "marshal",
  "unmarshal",
  "import",
  "export",
  "include",
  "exclude",
  "inject",
  "extract",
  "embed",
  "mount",
  "unmount",
  "attach",
  "detach",
  "bind",
  "unbind",
  "wrap",
  "unwrap",
  "apply",
  "call",
  "invoke",
  "evaluate",
  "compute",
  "calculate",
  "derive",
  "compare",
  "diff",
  "match",
  "equals",
  "contains",
  "includes",
  "exists",
  "is",
  "has",
  "can",
  "should",
  "will",
  "must",
  "may",
  "might",
  // Nouns
  "data",
  "value",
  "result",
  "output",
  "input",
  "response",
  "request",
  "query",
  "item",
  "element",
  "node",
  "child",
  "parent",
  "sibling",
  "root",
  "leaf",
  "list",
  "array",
  "object",
  "map",
  "set",
  "queue",
  "stack",
  "tree",
  "graph",
  "key",
  "index",
  "id",
  "name",
  "label",
  "title",
  "text",
  "content",
  "body",
  "type",
  "kind",
  "class",
  "interface",
  "struct",
  "enum",
  "union",
  "tuple",
  "function",
  "method",
  "callback",
  "handler",
  "listener",
  "observer",
  "hook",
  "event",
  "action",
  "state",
  "status",
  "mode",
  "flag",
  "option",
  "config",
  "setting",
  "preference",
  "property",
  "attribute",
  "field",
  "member",
  "slot",
  "path",
  "url",
  "uri",
  "file",
  "folder",
  "directory",
  "route",
  "endpoint",
  "user",
  "account",
  "profile",
  "session",
  "token",
  "auth",
  "permission",
  "role",
  "message",
  "notification",
  "alert",
  "warning",
  "error",
  "exception",
  "fault",
  "context",
  "scope",
  "environment",
  "runtime",
  "instance",
  "factory",
  "builder",
  "service",
  "client",
  "server",
  "worker",
  "manager",
  "controller",
  "provider",
  "repository",
  "store",
  "cache",
  "buffer",
  "pool",
  "registry",
  "container",
  "schema",
  "model",
  "entity",
  "record",
  "row",
  "column",
  "table",
  "database",
  "connection",
  "socket",
  "stream",
  "channel",
  "pipe",
  "bridge",
  "adapter",
  "source",
  "target",
  "destination",
  "origin",
  "base",
  "default",
  "fallback",
  "count",
  "size",
  "length",
  "width",
  "height",
  "depth",
  "level",
  "degree",
  "min",
  "max",
  "sum",
  "avg",
  "total",
  "limit",
  "offset",
  "range",
  "bounds",
  "start",
  "end",
  "begin",
  "finish",
  "first",
  "last",
  "next",
  "prev",
  "current",
  "old",
  "new",
  "temp",
  "tmp",
  "local",
  "global",
  "public",
  "private",
  "internal",
  // Adjectives/Modifiers
  "valid",
  "invalid",
  "active",
  "inactive",
  "enabled",
  "disabled",
  "visible",
  "hidden",
  "empty",
  "full",
  "null",
  "undefined",
  "true",
  "false",
  "yes",
  "no",
  "ok",
  "fail",
  "success",
  "failure",
  "pending",
  "complete",
  "done",
  "ready",
  "loading",
  "loaded",
  "async",
  "sync",
  "lazy",
  "eager",
  "static",
  "dynamic",
  "mutable",
  "immutable",
  "optional",
  "required",
  "default",
  "custom",
  "native",
  "external",
  "internal",
  "primary",
  "secondary",
  "main",
  "sub",
  "meta",
  "raw",
  "parsed",
  "formatted",
  // Common abbreviations that are acceptable
  "str",
  "num",
  "int",
  "bool",
  "arr",
  "obj",
  "fn",
  "func",
  "cb",
  "err",
  "res",
  "req",
  "src",
  "dest",
  "dst",
  "opts",
  "args",
  "params",
  "props",
  "attrs",
  "ctx",
  "env",
  "db",
  "api",
  "http",
  "https",
  "tcp",
  "udp",
  "ws",
  "wss",
  "ssh",
  "ftp",
  "json",
  "xml",
  "html",
  "css",
  "sql",
  "jwt",
  "uuid",
  "guid",
  "md5",
  "sha",
  "utf",
  "ascii",
  "base64",
  "gzip",
  "zip",
  "tar",
  "dom",
  "ui",
  "ux",
  "io",
  "fs",
  "os",
  "cpu",
  "gpu",
  "ram",
  "rom",
  "ref",
  "refs",
  "el",
  "elem",
  "doc",
  "docs",
  "spec",
  "specs",
  "impl",
  "info",
  "meta",
  "desc",
  "msg",
  "txt",
  "cfg",
  "conf"
]);
const POOR_NAMING_PATTERNS = [
  /^[a-z]$/,
  // Single lowercase letter
  /^[A-Z]$/,
  // Single uppercase letter
  /^[a-z]{1,2}\d*$/,
  // 1-2 letters optionally with numbers (x1, ab2)
  /^_+$/,
  // Just underscores
  /^temp\d*$/i,
  // temp, temp1, temp2
  /^foo|bar|baz|qux$/i,
  // Placeholder names
  /^test\d*$/i,
  // test, test1 (when not in test file)
  /^xxx+$/i,
  // xxx, xxxx
  /^data\d+$/i,
  // data1, data2 (numbered data)
  /^var\d*$/i,
  // var, var1
  /^val\d*$/i,
  // val, val1
  /^tmp\d*$/i
  // tmp, tmp1
];
const ACCEPTABLE_SHORT_NAMES = /* @__PURE__ */ new Set([
  "i",
  "j",
  "k",
  "n",
  "m",
  // Loop counters
  "x",
  "y",
  "z",
  // Coordinates
  "a",
  "b",
  // Comparison callbacks
  "e",
  "ev",
  // Event
  "t",
  // Time or generic type
  "id",
  // Identifier
  "db",
  // Database
  "fs",
  // Filesystem
  "io",
  // Input/Output
  "os",
  // Operating system
  "ui",
  // User interface
  "el",
  // Element
  "fn",
  // Function
  "cb",
  // Callback
  "_"
  // Unused parameter
]);
function analyzeDocumentation(bodyText, docComment, symbolName, parameterNames, localVariables, _isExported) {
  const body = bodyText ?? "";
  const doc = docComment ?? "";
  const commentDensity = calculateCommentDensity(body);
  const { hasApiDoc, apiDocQuality } = analyzeApiDoc(doc, parameterNames, _isExported);
  const inlineComments = countInlineComments(body);
  const todoCount = countTodoComments(body, doc);
  const allIdentifiers = [symbolName, ...parameterNames, ...localVariables];
  const { quality: namingQuality, issues: namingIssues } = analyzeNamingQuality(allIdentifiers);
  return {
    commentDensity,
    hasApiDoc,
    apiDocQuality,
    namingQuality,
    namingIssues,
    inlineComments,
    todoCount
  };
}
function calculateCommentDensity(code) {
  if (!code || code.trim().length === 0) {
    return 0;
  }
  const lines = code.split("\n");
  let commentLines = 0;
  let codeLines = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (inBlockComment) {
      commentLines++;
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      commentLines++;
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
      commentLines++;
      continue;
    }
    if (trimmed.includes("//") || trimmed.includes("/*")) {
      codeLines++;
      continue;
    }
    codeLines++;
  }
  const total = commentLines + codeLines;
  if (total === 0) {
    return 0;
  }
  return Math.round(commentLines / total * 100) / 100;
}
function analyzeApiDoc(docComment, parameterNames, _isExported) {
  const doc = docComment.trim();
  if (!doc || doc.length < 5) {
    return { hasApiDoc: false, apiDocQuality: "none" };
  }
  const isJsDoc = doc.startsWith("/**") || doc.startsWith("/*");
  const isPythonDoc = doc.startsWith('"""') || doc.startsWith("'''");
  const isHashDoc = doc.startsWith("##") || doc.startsWith("# ");
  if (!isJsDoc && !isPythonDoc && !isHashDoc) {
    return { hasApiDoc: false, apiDocQuality: "none" };
  }
  const hasDescription = doc.length > 20;
  const hasParamDoc = /@param|:param|\* @arg|Args:/i.test(doc);
  const hasReturnDoc = /@returns?|:returns?|Returns:/i.test(doc);
  let allParamsDocumented = true;
  if (parameterNames.length > 0 && hasParamDoc) {
    for (const param of parameterNames) {
      if (param === "this" || param === "self" || param.startsWith("{")) {
        continue;
      }
      const paramPattern = new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${param}\\b|:param\\s+${param}\\b`, "i");
      if (!paramPattern.test(doc)) {
        allParamsDocumented = false;
        break;
      }
    }
  }
  if (hasDescription && hasParamDoc && hasReturnDoc && allParamsDocumented) {
    return { hasApiDoc: true, apiDocQuality: "complete" };
  }
  if (hasDescription && (hasParamDoc || hasReturnDoc)) {
    return { hasApiDoc: true, apiDocQuality: "partial" };
  }
  if (hasDescription) {
    return { hasApiDoc: true, apiDocQuality: "minimal" };
  }
  return { hasApiDoc: true, apiDocQuality: "minimal" };
}
function countInlineComments(code) {
  if (!code) return 0;
  const lines = code.split("\n");
  let count = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.includes("//") && !trimmed.startsWith("//")) {
      const beforeComment = trimmed.split("//")[0];
      const quoteCount = (beforeComment.match(/['"]/g) || []).length;
      if (quoteCount % 2 === 0) {
        count++;
      }
    }
  }
  return count;
}
function countTodoComments(code, docComment) {
  const combined = `${code}
${docComment}`;
  const todoPattern = /\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE|REFACTOR)[\s:]/gi;
  const matches = combined.match(todoPattern);
  return matches ? matches.length : 0;
}
function analyzeNamingQuality(identifiers) {
  if (identifiers.length === 0) {
    return { quality: "good", issues: [] };
  }
  const issues = [];
  let goodNames = 0;
  let poorNames = 0;
  for (const identifier of identifiers) {
    if (!identifier || identifier.startsWith("{") || identifier.startsWith("[")) {
      continue;
    }
    if (ACCEPTABLE_SHORT_NAMES.has(identifier.toLowerCase())) {
      goodNames++;
      continue;
    }
    let isPoor = false;
    for (const pattern of POOR_NAMING_PATTERNS) {
      if (pattern.test(identifier)) {
        isPoor = true;
        issues.push(identifier);
        poorNames++;
        break;
      }
    }
    if (isPoor) continue;
    const words = splitIdentifier(identifier);
    const recognizedWords = words.filter(
      (w) => COMMON_WORDS.has(w.toLowerCase()) || w.length >= 4
      // Longer words are likely meaningful
    );
    if (recognizedWords.length >= words.length * 0.5) {
      goodNames++;
    } else if (words.length === 1 && words[0].length <= 3) {
      issues.push(identifier);
      poorNames++;
    } else {
      goodNames += 0.5;
    }
  }
  const total = goodNames + poorNames;
  if (total === 0) {
    return { quality: "good", issues: [] };
  }
  const ratio = goodNames / total;
  if (ratio >= 0.8) {
    return { quality: "good", issues };
  } else if (ratio >= 0.5) {
    return { quality: "acceptable", issues };
  } else {
    return { quality: "poor", issues };
  }
}
function splitIdentifier(identifier) {
  let clean = identifier.replace(/^_+|_+$/g, "");
  clean = clean.replace(/[-_]/g, " ");
  clean = clean.replace(/([a-z])([A-Z])/g, "$1 $2");
  clean = clean.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return clean.split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length > 0);
}
function extractLocalVariables(bodyText) {
  if (!bodyText) return [];
  const variables = [];
  const patterns = [
    /\b(?:const|let|var)\s+(\w+)/g,
    // const x, let y, var z
    /\b(?:const|let|var)\s+\{([^}]+)\}/g,
    // destructuring { a, b }
    /\bfor\s*\(\s*(?:const|let|var)?\s*(\w+)/g,
    // for (let i ...)
    /\.forEach\s*\(\s*\(?(\w+)/g,
    // .forEach((item) ...)
    /\.map\s*\(\s*\(?(\w+)/g,
    // .map((x) ...)
    /\.filter\s*\(\s*\(?(\w+)/g,
    // .filter((x) ...)
    /\.reduce\s*\(\s*\(?(\w+)/g
    // .reduce((acc) ...)
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      const captured = match[1];
      if (captured.includes(",")) {
        const parts = captured.split(",").map((p) => p.trim().split(":")[0].trim());
        variables.push(...parts.filter((p) => /^\w+$/.test(p)));
      } else if (/^\w+$/.test(captured)) {
        variables.push(captured);
      }
    }
  }
  return [...new Set(variables)];
}
function toDocumentationSchema(analysis) {
  return {
    commentDensity: analysis.commentDensity,
    hasApiDoc: analysis.hasApiDoc,
    apiDocQuality: analysis.apiDocQuality === "none" ? void 0 : analysis.apiDocQuality,
    namingQuality: analysis.namingQuality,
    namingIssues: analysis.namingIssues.length > 0 ? analysis.namingIssues : void 0,
    inlineComments: analysis.inlineComments,
    todoCount: analysis.todoCount
  };
}

"use strict";
const BODY_LIMITS = {
  function: 3e3,
  async_function: 3e3,
  arrow_function: 2e3,
  method: 3e3,
  constructor: 2e3,
  getter: 1e3,
  setter: 1e3,
  class: 1e3,
  // Just signature/outline, not full body
  interface: 2e3,
  // Type definitions are important
  type_alias: 1500,
  constant: 500,
  variable: 500,
  property: 300,
  enum: 1e3,
  default: 2e3
};
function isTestFile(filePath) {
  const testPatterns = [
    /\.test\./i,
    /\.spec\./i,
    /_test\./i,
    /_spec\./i,
    /__tests__[/\\]/i,
    /(^|[/\\])tests?[/\\]/i,
    // test/ or tests/ at start or after separator
    /\.stories\./i
    // Storybook
  ];
  return testPatterns.some((p) => p.test(filePath));
}
function isTypeOnlyReference(context) {
  const typePatterns = [
    /^:\s*\w/,
    // : Type
    /^<\w/,
    // <Generic>
    /\bas\s+\w/,
    // as Type
    /extends\s+\w/,
    // extends Type
    /implements\s+\w/
    // implements Type
  ];
  return typePatterns.some((p) => p.test(context.trim()));
}
function calculateRiskLevel(metrics, flags, refSummary, hasBrokenImports) {
  const { complexity, nesting, params } = metrics;
  const { hasErrorHandling, hasLogging, isExported } = flags;
  if (hasBrokenImports) {
    return "critical";
  }
  if (complexity > 20 && !hasErrorHandling) {
    return "critical";
  }
  if (complexity > 10) {
    return "high";
  }
  if (!hasErrorHandling && !hasLogging && isExported && complexity > 3) {
    return "high";
  }
  if (complexity > 5 || params > 4 || nesting > 3) {
    return "medium";
  }
  return "low";
}
function generateRiskFactors(metrics, flags, refSummary, brokenImports) {
  const factors = [];
  if (brokenImports && brokenImports.length > 0) {
    for (const broken of brokenImports) {
      const symbols = broken.importedSymbols.join(", ");
      const issueDesc = broken.issue === "file_not_found" ? "file not found" : "symbol not exported";
      factors.push(`uses missing dependency: ${symbols} from '${broken.importPath}' (${issueDesc})`);
    }
  }
  if (metrics.complexity > 20) {
    factors.push(`very high complexity (${metrics.complexity})`);
  } else if (metrics.complexity > 10) {
    factors.push(`high complexity (${metrics.complexity})`);
  } else if (metrics.complexity > 5) {
    factors.push(`moderate complexity (${metrics.complexity})`);
  }
  if (metrics.nesting > 4) {
    factors.push(`deeply nested (depth ${metrics.nesting})`);
  } else if (metrics.nesting > 3) {
    factors.push(`nested code (depth ${metrics.nesting})`);
  }
  if (metrics.params > 6) {
    factors.push(`too many parameters (${metrics.params})`);
  } else if (metrics.params > 4) {
    factors.push(`many parameters (${metrics.params})`);
  }
  if (!flags.hasErrorHandling && metrics.complexity > 1) {
    factors.push("no error handling");
  }
  if (!flags.hasLogging && flags.isExported) {
    factors.push("no logging in public API");
  }
  if (refSummary.inTests === 0 && refSummary.total > 0) {
    factors.push("no test coverage");
  }
  if (metrics.loc > 100) {
    factors.push(`long function (${metrics.loc} lines)`);
  } else if (metrics.loc > 50) {
    factors.push(`consider splitting (${metrics.loc} lines)`);
  }
  return factors;
}
function generateSuggestions(riskFactors, kind, brokenImports) {
  const suggestions = [];
  if (brokenImports && brokenImports.length > 0) {
    for (const broken of brokenImports) {
      if (broken.issue === "file_not_found") {
        suggestions.push(`Create missing file: ${broken.resolvedPath}`);
        suggestions.push(`Or update import path '${broken.importPath}' to point to existing module`);
      } else {
        suggestions.push(`Export '${broken.importedSymbols.join(", ")}' from ${broken.resolvedPath}`);
        suggestions.push(`Or import from a module that exports these symbols`);
      }
    }
  }
  for (const factor of riskFactors) {
    if (factor.includes("complexity")) {
      suggestions.push("Consider breaking into smaller functions");
    }
    if (factor.includes("nested")) {
      suggestions.push("Consider early returns or extracting nested logic");
    }
    if (factor.includes("parameters")) {
      suggestions.push("Consider using a parameter object or builder pattern");
    }
    if (factor.includes("no error handling")) {
      suggestions.push("Add try/catch for error handling");
    }
    if (factor.includes("no logging")) {
      suggestions.push("Add logging for observability");
    }
    if (factor.includes("no test coverage")) {
      suggestions.push("Add unit tests");
    }
    if (factor.includes("long function")) {
      suggestions.push("Extract helper functions to improve readability");
    }
  }
  return [...new Set(suggestions)];
}
function determineTestCoverage(refSummary) {
  if (refSummary.inTests === 0) return "none";
  if (refSummary.inTests >= 3 || refSummary.inTests >= refSummary.inProduction) return "good";
  return "partial";
}
function formatReference(ref) {
  return {
    file: ref.filePath,
    line: ref.line,
    caller: ref.containingSymbol,
    context: ref.callSignature,
    isTest: isTestFile(ref.filePath),
    isTypeOnly: isTypeOnlyReference(ref.callSignature)
  };
}
function buildReferencesSummary(refs) {
  const locations = (refs || []).map(formatReference);
  const inTests = locations.filter((r) => r.isTest).length;
  return {
    total: locations.length,
    inTests,
    inProduction: locations.length - inTests,
    locations
  };
}
function truncateBody(body, kind) {
  if (!body) return { text: "", truncated: false };
  const limit = BODY_LIMITS[kind] || BODY_LIMITS.default;
  if (body.length <= limit) {
    return { text: body, truncated: false };
  }
  let truncateAt = limit;
  const lastNewline = body.lastIndexOf("\n", limit);
  if (lastNewline > limit * 0.7) {
    truncateAt = lastNewline;
  }
  return {
    text: body.slice(0, truncateAt) + "\n// ... [truncated]",
    truncated: true
  };
}
function extractCalledBy(refs) {
  if (!refs) return [];
  const callers = /* @__PURE__ */ new Set();
  for (const ref of refs) {
    if (ref.containingSymbol) {
      callers.add(ref.containingSymbol);
    }
  }
  return Array.from(callers);
}
const FUNCTION_LIKE_KINDS = /* @__PURE__ */ new Set([
  "function",
  "async_function",
  "arrow_function",
  "method",
  "async_method",
  "constructor",
  "getter",
  "setter",
  "generator",
  "async_generator"
]);
const PROPERTY_LIKE_KINDS = /* @__PURE__ */ new Set([
  "property",
  "field",
  "property_signature",
  "public_field_definition",
  "class_property",
  "enum_member",
  "enum_variant"
]);
function analyzeDocumentationIfApplicable(symbol) {
  if (!FUNCTION_LIKE_KINDS.has(symbol.kind)) {
    return void 0;
  }
  const parameterNames = extractParameterNames(symbol.signature ?? "");
  const localVariables = extractLocalVariables(symbol.bodyText ?? "");
  const analysis = analyzeDocumentation(
    symbol.bodyText,
    symbol.docComment,
    symbol.symbolName,
    parameterNames,
    localVariables,
    symbol.isExported ?? false
  );
  return toDocumentationSchema(analysis);
}
function extractParameterNames(signature) {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match) return [];
  const paramsStr = match[1].trim();
  if (!paramsStr) return [];
  const params = [];
  let depth = 0;
  let current = "";
  for (const char of paramsStr) {
    if (char === "<" || char === "{" || char === "[" || char === "(") {
      depth++;
      current += char;
    } else if (char === ">" || char === "}" || char === "]" || char === ")") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      if (current.trim()) {
        params.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    params.push(current.trim());
  }
  return params.map((p) => {
    if (p.startsWith("{") || p.startsWith("[")) {
      return p;
    }
    if (p.startsWith("...")) {
      p = p.slice(3);
    }
    const colonIndex = p.indexOf(":");
    if (colonIndex > 0) {
      p = p.slice(0, colonIndex);
    }
    const eqIndex = p.indexOf("=");
    if (eqIndex > 0) {
      p = p.slice(0, eqIndex);
    }
    p = p.replace("?", "");
    return p.trim();
  }).filter((p) => p.length > 0);
}
function formatSymbolAsJSON(symbol, sourceCode) {
  const metrics = {
    complexity: symbol.metrics.complexity,
    loc: symbol.metrics.linesOfCode,
    nesting: symbol.metrics.nesting,
    params: symbol.metrics.parameterCount
  };
  const flags = {
    hasLogging: symbol.metrics.hasLogging,
    hasErrorHandling: symbol.metrics.hasErrorHandling,
    isExported: symbol.isExported ?? false,
    isAsync: symbol.isAsync,
    isStatic: symbol.isStatic,
    isAbstract: symbol.isAbstract
  };
  const refSummary = buildReferencesSummary(symbol.references);
  const callGraph = {
    calls: symbol.callTargets,
    calledBy: extractCalledBy(symbol.references)
  };
  const hasBrokenImports = (symbol.brokenImports?.length ?? 0) > 0;
  const brokenImportsList = symbol.brokenImports;
  const riskLevel = calculateRiskLevel(metrics, flags, refSummary, hasBrokenImports);
  const riskFactors = generateRiskFactors(metrics, flags, refSummary, brokenImportsList);
  let mockData;
  if (symbol.mockData) {
    mockData = toMockDataSchema(symbol.mockData);
    if (symbol.mockData.hasMockData && !isTestFile(symbol.filePath)) {
      riskFactors.push(`uses mock/hardcoded data (confidence: ${Math.round(symbol.mockData.confidence * 100)}%)`);
    }
  }
  const suggestions = generateSuggestions(riskFactors, symbol.kind, brokenImportsList);
  const documentation = analyzeDocumentationIfApplicable(symbol);
  const isPropertyLike = PROPERTY_LIKE_KINDS.has(symbol.kind);
  const isDeadCode = isPropertyLike ? void 0 : !symbol.isExported && refSummary.total === 0 ? true : void 0;
  const review = {
    riskLevel,
    riskFactors,
    suggestions: suggestions.length > 0 ? suggestions : void 0,
    testCoverage: isPropertyLike ? void 0 : determineTestCoverage(refSummary),
    isDeadCode,
    isEntryPoint: symbol.isExported && callGraph.calledBy?.length === 0 ? true : void 0,
    brokenImports: brokenImportsList?.map((bi) => ({
      importPath: bi.importPath,
      resolvedPath: bi.resolvedPath,
      importedSymbols: bi.importedSymbols,
      issue: bi.issue,
      usedBySymbols: [symbol.symbolName]
    })),
    usesMissingDependency: hasBrokenImports || void 0,
    documentation,
    mockData
  };
  const modifiers = [];
  if (symbol.visibility) modifiers.push(symbol.visibility);
  if (symbol.isExported) modifiers.push("export");
  if (symbol.isAsync) modifiers.push("async");
  if (symbol.isStatic) modifiers.push("static");
  if (symbol.isAbstract) modifiers.push("abstract");
  let bodyText = symbol.bodyText;
  if (!bodyText && sourceCode) {
    bodyText = sourceCode.slice(symbol.span.startByte, symbol.span.endByte);
  }
  const { text: body, truncated: bodyTruncated } = truncateBody(bodyText, symbol.kind);
  let extendsClass;
  const implementsList = [];
  if (symbol.implementsOrExtends) {
    for (const item of symbol.implementsOrExtends) {
      if (!extendsClass && symbol.kind === "class") {
        extendsClass = item;
      } else {
        implementsList.push(item);
      }
    }
  }
  const doc = {
    symbol: symbol.symbolName,
    kind: symbol.kind,
    language: symbol.language,
    location: {
      file: symbol.filePath,
      line: symbol.span.startLine,
      endLine: symbol.span.endLine,
      column: symbol.span.startCol
    },
    // Parent context (for properties/methods)
    parentSymbol: symbol.parentSymbolName,
    parentKind: symbol.parentSymbolKind,
    // Property-specific fields
    propertyType: isPropertyLike ? symbol.propertyType : void 0,
    isOptional: isPropertyLike ? symbol.isOptional : void 0,
    isReadonly: isPropertyLike ? symbol.isReadonly : void 0,
    hasInitializer: isPropertyLike ? symbol.hasInitializer : void 0,
    // Signature and modifiers
    signature: symbol.signature,
    modifiers: modifiers.length > 0 ? modifiers : void 0,
    visibility: symbol.visibility,
    extends: extendsClass,
    implements: implementsList.length > 0 ? implementsList : void 0,
    decorators: symbol.decorators,
    metrics,
    flags,
    review,
    callGraph: callGraph.calls?.length || callGraph.calledBy?.length ? callGraph : void 0,
    references: refSummary,
    docComment: symbol.docComment,
    body: body || void 0,
    bodyTruncated: bodyTruncated || void 0
  };
  return doc;
}
function formatSymbolAsJSONString(symbol, sourceCode) {
  const doc = formatSymbolAsJSON(symbol, sourceCode);
  return JSON.stringify(doc);
}
function formatSymbolAsJSONPretty(symbol, sourceCode) {
  const doc = formatSymbolAsJSON(symbol, sourceCode);
  return JSON.stringify(doc, null, 2);
}
function formatSymbolsAsJSON(symbols, sourceCodeMap) {
  return symbols.map((s) => formatSymbolAsJSON(s, sourceCodeMap?.get(s.filePath)));
}

"use strict";

"use strict";
const EMBEDDER_CONFIG = {
  model: "nomic-embed-text-v2-moe:latest",
  dimensions: 768
};
const workspacePath$1 = process.env.WORKSPACE_PATH || process.cwd();
tcAILogger.info(`[ReviewWorkspace] Initializing workspace at: ${workspacePath$1}`);
const embedderService = getReviewEmbedder(EMBEDDER_CONFIG);
const astIndexerService = new ASTIndexerService();
const vectorStore = new LibSQLVector({
  id: "review-workspace-vector-store",
  url: "file:./review-workspace-vector-store.db"
});
const REVIEW_VECTOR_STORE_INDEX_NAME = "review_vector_index";
tcAILogger.info(`[ReviewWorkspace] Deleting existing vector index: ${REVIEW_VECTOR_STORE_INDEX_NAME}`);
await vectorStore.deleteIndex({
  indexName: REVIEW_VECTOR_STORE_INDEX_NAME
});
tcAILogger.info(`[ReviewWorkspace] Vector index deleted`);
tcAILogger.info(`[ReviewWorkspace] Creating vector index: ${REVIEW_VECTOR_STORE_INDEX_NAME} (dimension: ${EMBEDDER_CONFIG.dimensions})`);
await vectorStore.createIndex({
  indexName: REVIEW_VECTOR_STORE_INDEX_NAME,
  dimension: EMBEDDER_CONFIG.dimensions
});
tcAILogger.info(`[ReviewWorkspace] Vector index created`);
const reviewFilesystem = new FilteredLocalFilesystem({
  basePath: workspacePath$1,
  readOnly: true,
  // Set to false to allow paths outside basePath if needed for cross-directory access
  // Set to true (default) to restrict all access within basePath for security
  contained: process.env.FILESYSTEM_CONTAINED !== "false"
});
const reviewWorkspace = new Workspace({
  filesystem: reviewFilesystem,
  bm25: true,
  // skills: ['skills'], // Relative path without leading slash
  vectorStore,
  embedder: embedderService.getEmbedder(),
  tools: {
    enabled: false
  }
});
tcAILogger.info(`[ReviewWorkspace] Initializing workspace...`);
await reviewWorkspace.init();
tcAILogger.info(`[ReviewWorkspace] Workspace initialized successfully`);
tcAILogger.info(`[ReviewWorkspace] Starting background text indexing...`);
const textIndexingPromise = startBackgroundIndexing(
  reviewWorkspace,
  { basePath: workspacePath$1 }
).then(async (stats) => {
  tcAILogger.info(`[ReviewWorkspace] Text indexing completed: ${stats.indexedFiles} files indexed`);
  if (stats.indexedFiles === 0) {
    tcAILogger.warn(`[ReviewWorkspace] No files indexed - creating placeholder to initialize BM25 table`);
    try {
      await reviewWorkspace.index("__placeholder__", "Placeholder document to initialize search index", {
        type: "text",
        metadata: { placeholder: true }
      });
      tcAILogger.info(`[ReviewWorkspace] BM25 search table initialized with placeholder`);
    } catch (placeholderErr) {
      tcAILogger.error(`[ReviewWorkspace] Failed to create placeholder index entry`, { error: placeholderErr });
    }
  }
  return stats;
}).catch((err) => {
  tcAILogger.error(`[ReviewWorkspace] Text indexing failed`, { error: err });
  throw err;
});
tcAILogger.info(`[ReviewWorkspace] Starting background AST indexing...`);
const astIndexingPromise = astIndexerService.indexWorkspace({
  basePath: workspacePath$1,
  workspace: reviewWorkspace,
  includeBody: true,
  concurrency: 8
}).then((result) => {
  tcAILogger.info(`[ReviewWorkspace] AST indexing completed: ${result.symbolsIndexed} symbols from ${result.filesIndexed} files`);
  reviewFilesystem.setSymbolResolver((filePath, symbolName) => {
    const store = astIndexerService.getStore();
    const symbols = store.getSymbolsForFile(filePath);
    const symbol = symbols.find((s) => s.symbolName === symbolName);
    if (!symbol) return null;
    return formatSymbolAsJSONPretty(symbol);
  });
  tcAILogger.debug(`[ReviewWorkspace] Symbol JSON schema:
${SCHEMA_HINTS}`);
  return result;
}).catch((err) => {
  tcAILogger.error(`[ReviewWorkspace] AST indexing failed`, { error: err });
  throw err;
});
let workspaceIndexingComplete = false;
let indexedDocumentPaths = [];
const indexingPromise = Promise.all([
  textIndexingPromise,
  astIndexingPromise
]).then(([text, ast]) => {
  tcAILogger.info(`[ReviewWorkspace] ========== All Indexing Completed ==========`);
  tcAILogger.info(`[ReviewWorkspace] Text indexer: ${text.indexedFiles} files indexed`);
  tcAILogger.info(`[ReviewWorkspace] AST indexer: ${ast.symbolsIndexed} symbols from ${ast.filesIndexed} files`);
  tcAILogger.info(`[ReviewWorkspace] Total duration: text=${(text.durationMs / 1e3).toFixed(2)}s, ast=${(ast.durationMs / 1e3).toFixed(2)}s`);
  embedderService.logUsageSummary();
  tcAILogger.info(`[ReviewWorkspace] =============================================`);
  workspaceIndexingComplete = true;
  tcAILogger.info(`[ReviewWorkspace] workspaceIndexingComplete = true`);
  indexedDocumentPaths = text.indexedFilesList;
  tcAILogger.info(`[ReviewWorkspace] Stored ${indexedDocumentPaths.length} document paths for suggestions`);
  return { text, ast };
});
async function waitForWorkspaceIndexing() {
  if (workspaceIndexingComplete) {
    tcAILogger.info(`[ReviewWorkspace] Workspace indexing already complete`);
    return;
  }
  tcAILogger.info(`[ReviewWorkspace] Waiting for workspace indexing to complete...`);
  await indexingPromise;
}

var review = /*#__PURE__*/Object.freeze({
  __proto__: null,
  astIndexerService: astIndexerService,
  astIndexingPromise: astIndexingPromise,
  embedderService: embedderService,
  get indexedDocumentPaths () { return indexedDocumentPaths; },
  indexingPromise: indexingPromise,
  reviewWorkspace: reviewWorkspace,
  textIndexingPromise: textIndexingPromise,
  waitForWorkspaceIndexing: waitForWorkspaceIndexing,
  get workspaceIndexingComplete () { return workspaceIndexingComplete; }
});

"use strict";

"use strict";
function normalizeSubmissionPath$3(filePath) {
  if (filePath.startsWith("submission/")) {
    return filePath.slice("submission/".length);
  }
  return filePath;
}
function extractSnippet$1(content, lineRange, maxLength = 100) {
  const lines = content.split("\n");
  if (lineRange) {
    const start = Math.max(0, lineRange.start - 1);
    const end = Math.min(lines.length, lineRange.end);
    const relevantLines = lines.slice(start, end).join("\n");
    if (relevantLines.length <= maxLength) {
      return relevantLines.trim();
    }
    return relevantLines.slice(0, maxLength).trim() + "...";
  }
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  let snippet = "";
  for (const line of nonEmptyLines) {
    if (snippet.length + line.length + 1 > maxLength) break;
    snippet += (snippet ? "\n" : "") + line;
  }
  return snippet || content.slice(0, maxLength).trim() + "...";
}
function parseSymbolPath$1(id) {
  const colonIndex = id.lastIndexOf(":");
  if (colonIndex === -1) return null;
  const lastPart = id.slice(colonIndex + 1);
  const isLineRange = /^\d+-\d+$/.test(lastPart);
  if (isLineRange) {
    const beforeLineRange = id.slice(0, colonIndex);
    const secondColonIndex = beforeLineRange.lastIndexOf(":");
    if (secondColonIndex === -1) return null;
    return {
      filePath: beforeLineRange.slice(0, secondColonIndex),
      symbolName: beforeLineRange.slice(secondColonIndex + 1),
      lineRange: lastPart
    };
  }
  return {
    filePath: id.slice(0, colonIndex),
    symbolName: lastPart
  };
}
const submissionSearchTool = createTool({
  id: "submission_search",
  description: `Search the submission for code symbols AND documents (configs, docs, etc.).

Returns:

**files[]** - Code symbols (functions, classes, methods):
- symbolPath: Use with submission_read for full details
- kind, signature, exported
- loc, complexity, risk (only for function/method kinds)
- calls: Functions this symbol calls (outgoing edges)
- calledBy: Functions that call this symbol (incoming edges) - USE THIS TO TRACE IMPLEMENTATION CHAINS
- line: Line number where symbol is defined
- hasLogging, hasErrorHandling: Quality indicators

**documents[]** - Non-code files (configs, docs, scripts):
- filePath: Path to the matched document
- snippet: ~100 chars of content around the match
- lineRange: { start, end } - Lines where match was found in the document

**DEDUPLICATION:** Results are deduplicated across steps to save context.
- _skippedSymbols: Symbols already shown - check _seeAlso for where (e.g., "search(query='auth') in step 0")
- _skippedDocuments: Documents already shown - check _seeAlso for where
- When you see _seeAlso, the full data is in a PREVIOUS tool result - don't re-search, use that context!

**IMPORTANT:** When investigating an implementation, check the 'calledBy' field to discover parent functions that orchestrate the found symbol.

Use submission_read(path) to read file contents or inspect code symbols in detail.`,
  inputSchema: z.object({
    query: z.string().describe("Search query - use symbol names, function names, technical terms")
  }),
  outputSchema: z.object({
    files: z.array(z.object({
      filePath: z.string(),
      language: z.string(),
      symbols: z.array(z.object({
        symbolPath: z.string(),
        kind: z.string(),
        signature: z.string().optional(),
        loc: z.number().optional(),
        complexity: z.number().optional(),
        risk: z.string().optional(),
        calls: z.array(z.string()).optional(),
        calledBy: z.array(z.string()).optional(),
        exported: z.boolean(),
        line: z.number().optional(),
        hasLogging: z.boolean().optional(),
        hasErrorHandling: z.boolean().optional()
      }))
    })),
    documents: z.array(z.object({
      filePath: z.string(),
      snippet: z.string(),
      lineRange: z.object({
        start: z.number(),
        end: z.number()
      }).optional()
    }))
  }),
  execute: async ({ query }) => {
    const mode = "hybrid";
    const topK = 7;
    const minScore = 0.15;
    tcAILogger.info(`[submission_search] Searching: "${query}"`);
    try {
      const searchResults = await reviewWorkspace.search(query, {
        mode,
        topK,
        minScore
      });
      tcAILogger.info(`[submission_search] Raw results: ${searchResults.length}`);
      const store = astIndexerService.getStore();
      const fileGroups = /* @__PURE__ */ new Map();
      const documents = [];
      for (const result of searchResults) {
        const parsed = parseSymbolPath$1(result.id);
        if (!parsed) {
          const normalizedPath = normalizeSubmissionPath$3(result.id);
          const docMatch = {
            filePath: normalizedPath,
            score: Math.round(result.score * 100) / 100,
            snippet: extractSnippet$1(result.content, result.lineRange),
            // Include line range if provided (indicates where the match was found)
            ...result.lineRange && { lineRange: result.lineRange }
          };
          documents.push(docMatch);
          tcAILogger.info(`[submission_search] Document match: ${result.id} -> ${normalizedPath}`, { lineRange: result.lineRange });
          continue;
        }
        const { filePath, symbolName } = parsed;
        const normalizedFilePath = normalizeSubmissionPath$3(filePath);
        const symbols = store.getSymbolsForFile(filePath);
        const symbol = symbols.find((s) => s.symbolName === symbolName);
        if (!symbol) {
          tcAILogger.info(`[submission_search] Symbol not found in store: ${filePath}:${symbolName}`);
          continue;
        }
        const symbolDoc = formatSymbolAsJSON(symbol);
        const metadata = result.metadata;
        const excludeMetrics = ["property", "constant", "type_alias", "abstract_class", "interface", "class"].includes(symbolDoc.kind);
        const summary = {
          // Use normalized path for cleaner display to agent
          symbolPath: `${normalizedFilePath}:${symbolName}`,
          score: Math.round(result.score * 100) / 100,
          kind: symbolDoc.kind,
          signature: symbolDoc.signature,
          exported: symbolDoc.flags?.isExported || false,
          // Include line number from metadata (falls back to symbolDoc.location.line)
          line: metadata?.line ?? symbolDoc.location?.line,
          ...excludeMetrics ? {} : {
            loc: symbolDoc.metrics?.loc || 0,
            complexity: metadata?.complexity ?? symbolDoc.metrics?.complexity ?? 0,
            risk: symbolDoc.review?.riskLevel || "low",
            calls: (symbolDoc.callGraph?.calls || []).slice(0, 10),
            // Top 10 calls - increased to capture diverse patterns
            calledBy: (symbolDoc.callGraph?.calledBy || []).slice(0, 5),
            // Top 5 callers - helps trace implementation chains
            // Include quality indicators from metadata (falls back to symbolDoc.flags)
            hasLogging: metadata?.hasLogging ?? symbolDoc.flags?.hasLogging,
            hasErrorHandling: metadata?.hasErrorHandling ?? symbolDoc.flags?.hasErrorHandling
          }
        };
        if (!fileGroups.has(normalizedFilePath)) {
          fileGroups.set(normalizedFilePath, {
            filePath: normalizedFilePath,
            language: symbol.language || "unknown",
            symbols: []
          });
        }
        fileGroups.get(normalizedFilePath).symbols.push(summary);
      }
      const sortedFiles = Array.from(fileGroups.values()).sort((a, b) => {
        const bestA = Math.max(...a.symbols.map((s) => s.score));
        const bestB = Math.max(...b.symbols.map((s) => s.score));
        return bestB - bestA;
      });
      for (const file of sortedFiles) {
        file.symbols.sort((a, b) => b.score - a.score);
      }
      documents.sort((a, b) => b.score - a.score);
      const symbolCount = sortedFiles.reduce((sum, f) => sum + f.symbols.length, 0);
      const stripSymbolScore = ({ score: _, ...rest }) => rest;
      const stripDocScore = ({ score: _, ...rest }) => rest;
      const response = {
        files: sortedFiles.map((f) => ({
          ...f,
          symbols: f.symbols.map(stripSymbolScore)
        })),
        documents: documents.map(stripDocScore)
      };
      tcAILogger.info(`[submission_search] Returning ${symbolCount} symbols from ${sortedFiles.length} files + ${documents.length} documents`);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("no such table") && errorMessage.includes("_search")) {
        tcAILogger.error(`[submission_search] Search table not found - workspace may not have been indexed. Returning empty results.`);
        return { files: [], documents: [] };
      }
      tcAILogger.error(`[submission_search] Search failed`, { error });
      throw error;
    }
  }
});

"use strict";
const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
function normalizeSubmissionPath$2(filePath) {
  if (filePath.startsWith("submission/")) {
    return filePath.slice("submission/".length);
  }
  return filePath;
}
async function resolveSubmissionPath(inputPath) {
  const directPath = path.isAbsolute(inputPath) ? inputPath : path.join(workspacePath, inputPath);
  try {
    await fs.access(directPath);
    return inputPath;
  } catch {
  }
  const tryPath = "submission/" + inputPath;
  const fullPath = path.join(workspacePath, tryPath);
  try {
    await fs.access(fullPath);
    tcAILogger.debug(`[submission_read] Resolved path: ${inputPath} -> ${tryPath}`);
    return tryPath;
  } catch {
  }
  return inputPath;
}
async function readAndPreprocessFile(filePath) {
  const rawContent = await fs.readFile(filePath, "utf-8");
  return preprocessFileContent(filePath, rawContent);
}
const MAX_DOCUMENT_CHARS = 2e4;
function findSimilarPaths$1(requestedPath, indexedPaths, maxSuggestions = 3) {
  const requestedFileName = path.basename(requestedPath);
  const requestedSegments = requestedPath.split("/").filter(Boolean);
  const scored = [];
  for (const indexedPath of indexedPaths) {
    const indexedFileName = path.basename(indexedPath);
    const indexedSegments = indexedPath.split("/").filter(Boolean);
    let score = 0;
    if (indexedFileName === requestedFileName) {
      score += 10;
    } else if (indexedFileName.toLowerCase() === requestedFileName.toLowerCase()) {
      score += 8;
    } else if (indexedFileName.includes(requestedFileName) || requestedFileName.includes(indexedFileName)) {
      score += 5;
    }
    for (const segment of requestedSegments) {
      if (indexedSegments.includes(segment)) {
        score += 2;
      }
    }
    const lengthDiff = Math.abs(indexedSegments.length - requestedSegments.length);
    score -= lengthDiff * 0.5;
    if (score > 0) {
      scored.push({ path: indexedPath, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSuggestions).map((s) => normalizeSubmissionPath$2(s.path));
}
function stripReferences(sym) {
  const { references, ...rest } = sym;
  return rest;
}
function getDocumentType(filePath) {
  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split("/").pop() || "";
  if (fileName.endsWith(".json") || fileName.endsWith(".yaml") || fileName.endsWith(".yml") || fileName.endsWith(".toml")) {
    return "config";
  }
  if (fileName.startsWith(".") || fileName.includes("rc") || fileName.includes("config")) {
    return "config";
  }
  if (["dockerfile", "makefile", "docker-compose"].some((n) => fileName.includes(n))) {
    return "config";
  }
  if (fileName.endsWith(".md") || fileName.endsWith(".txt") || fileName.endsWith(".rst")) {
    return "doc";
  }
  if (["readme", "changelog", "contributing", "license"].some((n) => fileName.includes(n))) {
    return "doc";
  }
  if (fileName.includes(".env") || fileName.includes("secret")) {
    return "env";
  }
  if (fileName.endsWith(".sh") || fileName.endsWith(".bash") || fileName.endsWith(".zsh")) {
    return "script";
  }
  return "file";
}
function isCodeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return false;
  return isExtensionSupported(ext);
}
const submissionReadTool = createTool({
  id: "submission_read",
  description: `Read content from the submission. Returns complete symbol data with body, metrics, and call graph.

**For a code symbol** (path:symbolName format):
- Returns full symbol details including body, metrics, and call graph

**For a code file** (just file path like "src/app.ts"):
- Returns all symbol details with full bodies

**For a document** (config, doc, script - like "package.json"):
- Returns entire file content (automatically truncated if exceeds limit)

**DEDUPLICATION:** Results are deduplicated across steps to save context.
- _seeAlso: Points to where full data was shown (e.g., "submission_read('src/db.ts') in step 1")
- _skippedSymbols: Array of symbols already read - each has _seeAlso pointer
- When you see _seeAlso, DON'T re-read! The full content is already in your context from the referenced step.
- Search snippets do NOT block reads - you'll always get full content on first read.`,
  inputSchema: z.object({
    path: z.string().describe('Symbol path ("file.ts:symbolName"), code file ("file.ts"), or document ("package.json")')
  }),
  outputSchema: z.union([
    // Single symbol
    z.object({
      symbolPath: z.string(),
      symbol: z.any()
    }),
    // File symbols
    z.object({
      filePath: z.string(),
      language: z.string(),
      symbols: z.array(z.any())
    }),
    // Document
    z.object({
      filePath: z.string(),
      type: z.string(),
      size: z.number(),
      totalLines: z.number(),
      content: z.string(),
      truncated: z.boolean()
    }),
    // Error with optional suggestions
    z.object({
      error: z.string(),
      path: z.string(),
      suggestions: z.array(z.string()).optional()
    })
  ]),
  execute: async ({ path: inputPath }) => {
    tcAILogger.info(`[submission_read] Reading: "${inputPath}"`);
    try {
      const store = astIndexerService.getStore();
      const colonIndex = inputPath.lastIndexOf(":");
      const hasSymbolName = colonIndex > 0 && !inputPath.slice(colonIndex + 1).includes("/");
      if (hasSymbolName) {
        const rawFilePath = inputPath.slice(0, colonIndex);
        const symbolName = inputPath.slice(colonIndex + 1);
        const filePath = await resolveSubmissionPath(rawFilePath);
        if (filePath !== rawFilePath) {
          tcAILogger.info(`[submission_read] File path resolved: "${rawFilePath}" -> "${filePath}"`);
        }
        const normalizedFilePath = normalizeSubmissionPath$2(filePath);
        const symbols = store.getSymbolsForFile(filePath);
        const symbol = symbols.find((s) => s.symbolName === symbolName);
        if (!symbol) {
          tcAILogger.warn(`[submission_read] Symbol not found: ${filePath}:${symbolName}`);
          return {
            error: `Symbol "${symbolName}" not found in file "${normalizedFilePath}"`,
            path: inputPath
          };
        }
        let sourceCode;
        if (!symbol.bodyText) {
          try {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
            sourceCode = await readAndPreprocessFile(absolutePath);
          } catch {
          }
        }
        const symbolDoc = formatSymbolAsJSON(symbol, sourceCode);
        tcAILogger.info(`[submission_read] Found symbol: ${symbol.kind} ${symbolName}`);
        return {
          // Return normalized path for cleaner output
          symbolPath: `${normalizedFilePath}:${symbolName}`,
          symbol: stripReferences(symbolDoc)
        };
      } else {
        const candidatePaths = [
          path.join(workspacePath, "submission", inputPath),
          // submission/data/seed-data.json
          path.join(workspacePath, inputPath)
          // data/seed-data.json (if already has prefix)
        ];
        const isCode = isCodeFile(inputPath);
        if (!isCode) {
          for (const candidatePath of candidatePaths) {
            try {
              const fullContent = await readAndPreprocessFile(candidatePath);
              const stats = await fs.stat(candidatePath);
              const docType = getDocumentType(inputPath);
              const normalizedFilePath2 = normalizeSubmissionPath$2(inputPath);
              const totalLines = fullContent.split("\n").length;
              const truncated = fullContent.length > MAX_DOCUMENT_CHARS;
              const content = truncated ? fullContent.slice(0, MAX_DOCUMENT_CHARS) : fullContent;
              tcAILogger.info(`[submission_read] Direct read success: ${candidatePath} (${docType}, ${totalLines} lines, truncated=${truncated})`);
              return {
                filePath: normalizedFilePath2,
                type: docType,
                size: stats.size,
                totalLines,
                content,
                truncated
              };
            } catch {
              continue;
            }
          }
          tcAILogger.debug(`[submission_read] Direct read failed for all candidates, falling back to index lookup`);
        }
        const filePath = await resolveSubmissionPath(inputPath);
        if (filePath !== inputPath) {
          tcAILogger.info(`[submission_read] File path resolved: "${inputPath}" -> "${filePath}"`);
        }
        const normalizedFilePath = normalizeSubmissionPath$2(filePath);
        const symbols = store.getSymbolsForFile(filePath);
        if (symbols.length > 0) {
          const language = symbols[0].language;
          tcAILogger.info(`[submission_read] Found ${symbols.length} symbols in code file`);
          let sourceCode;
          try {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
            sourceCode = await readAndPreprocessFile(absolutePath);
          } catch {
          }
          const sourceCodeMap = sourceCode ? /* @__PURE__ */ new Map([[filePath, sourceCode]]) : void 0;
          const symbolDocs = formatSymbolsAsJSON(symbols, sourceCodeMap);
          const strippedSymbolDocs = symbolDocs.map(stripReferences);
          return {
            filePath: normalizedFilePath,
            language,
            symbols: strippedSymbolDocs
          };
        }
        for (const candidatePath of candidatePaths) {
          try {
            const fullContent = await readAndPreprocessFile(candidatePath);
            const stats = await fs.stat(candidatePath);
            const docType = getDocumentType(inputPath);
            const totalLines = fullContent.split("\n").length;
            const truncated = fullContent.length > MAX_DOCUMENT_CHARS;
            const content = truncated ? fullContent.slice(0, MAX_DOCUMENT_CHARS) : fullContent;
            tcAILogger.info(`[submission_read] Fallback read success: ${candidatePath} (${docType}, ${totalLines} lines, truncated=${truncated})`);
            return {
              filePath: normalizedFilePath,
              type: docType,
              size: stats.size,
              totalLines,
              content,
              truncated
            };
          } catch {
            continue;
          }
        }
        const codeFilePaths = store.getFilePaths();
        const allIndexedPaths = [.../* @__PURE__ */ new Set([...codeFilePaths, ...indexedDocumentPaths])];
        const suggestions = findSimilarPaths$1(inputPath, allIndexedPaths);
        let errorMsg = isCode ? `No symbols found in file "${normalizedFilePath}". File may not be indexed or may not exist.` : `Could not read file "${normalizedFilePath}". File may not exist.`;
        if (suggestions.length > 0) {
          errorMsg += ` Did you mean: ${suggestions.join(", ")}?`;
        }
        tcAILogger.warn(`[submission_read] ${errorMsg}`, { suggestions });
        return {
          error: errorMsg,
          path: inputPath,
          suggestions: suggestions.length > 0 ? suggestions : void 0
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      tcAILogger.error(`[submission_read] Read failed`, { error });
      return {
        error: errorMsg,
        path: inputPath
      };
    }
  }
});

"use strict";
const DEFAULT_MAX_TOOL_INVOCATIONS = 50;
const threadCaches = /* @__PURE__ */ new Map();
const DEFAULT_THREAD_ID = "__default__";
const CACHE_TTL_MS = 30 * 60 * 1e3;
function getThreadCache(threadId = DEFAULT_THREAD_ID) {
  let threadCache = threadCaches.get(threadId);
  if (!threadCache) {
    threadCache = {
      cache: /* @__PURE__ */ new Map(),
      invocationCount: 0,
      toolInvocationCounts: /* @__PURE__ */ new Map(),
      createdAt: Date.now(),
      lastAccessedAt: Date.now()
    };
    threadCaches.set(threadId, threadCache);
    tcAILogger.debug(`[ToolCache] Created new cache for thread: ${threadId}`);
  } else {
    threadCache.lastAccessedAt = Date.now();
  }
  return threadCache;
}
function incrementToolInvocationCount(toolId, threadId = DEFAULT_THREAD_ID) {
  const threadCache = getThreadCache(threadId);
  const currentCount = threadCache.toolInvocationCounts.get(toolId) ?? 0;
  const newCount = currentCount + 1;
  threadCache.toolInvocationCounts.set(toolId, newCount);
  threadCache.invocationCount++;
  return newCount;
}
function getToolInvocationCount(toolId, threadId) {
  const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
  return tc?.toolInvocationCounts.get(toolId) ?? 0;
}
function getInvocationCount(threadId) {
  const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
  return tc?.invocationCount ?? 0;
}
function getLimitExceededInfo(threadId) {
  const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
  if (!tc) return null;
  const tcAny = tc;
  if (tcAny.limitExceededAt && tcAny.limitExceededTool) {
    return {
      tool: tcAny.limitExceededTool,
      timestamp: tcAny.limitExceededAt
    };
  }
  return null;
}
function getAllToolInvocationCounts(threadId) {
  const tc = threadCaches.get(threadId || DEFAULT_THREAD_ID);
  if (!tc) return {};
  const result = {};
  for (const [toolId, count] of tc.toolInvocationCounts.entries()) {
    result[toolId] = count;
  }
  return result;
}
function isToolInvocationLimitExceeded(toolId, threadId = DEFAULT_THREAD_ID, maxInvocations = DEFAULT_MAX_TOOL_INVOCATIONS) {
  const count = getToolInvocationCount(toolId, threadId);
  return count >= maxInvocations;
}
function cleanupStaleCaches() {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [threadId, threadCache] of threadCaches.entries()) {
    if (now - threadCache.lastAccessedAt > CACHE_TTL_MS) {
      threadCaches.delete(threadId);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    tcAILogger.debug(`[ToolCache] Cleaned up ${cleanedCount} stale thread caches`);
  }
}
function resetToolCache(threadId) {
  if (threadId) {
    threadCaches.delete(threadId);
    tcAILogger.debug(`[ToolCache] Cache cleared for thread: ${threadId}`);
  } else {
    threadCaches.clear();
    tcAILogger.debug("[ToolCache] All caches cleared");
  }
}
function getToolCacheStats(threadId) {
  cleanupStaleCaches();
  const threadStats = {};
  let totalEntries = 0;
  let totalInvocations = 0;
  for (const [tid, threadCache] of threadCaches.entries()) {
    if (!threadId || tid === threadId) {
      threadStats[tid] = {
        size: threadCache.cache.size,
        invocations: threadCache.invocationCount,
        entries: Array.from(threadCache.cache.keys())
      };
      totalEntries += threadCache.cache.size;
      totalInvocations += threadCache.invocationCount;
    }
  }
  return {
    threadCount: threadCaches.size,
    totalEntries,
    totalInvocations,
    defaultMaxInvocations: DEFAULT_MAX_TOOL_INVOCATIONS,
    threadStats
  };
}
function sortObject(obj) {
  if (obj === null || obj === void 0) return obj;
  if (Array.isArray(obj)) return obj.map((item) => sortObject(item));
  if (typeof obj !== "object") return obj;
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject(obj[key]);
  }
  return sorted;
}
function getToolCacheKey(toolId, params) {
  const sortedParams = sortObject(params);
  const normalized = JSON.stringify({ tool: toolId, params: sortedParams });
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${toolId}:${hash}`;
}
function getCachedResult(toolId, params, threadId) {
  const threadCache = getThreadCache(threadId);
  const key = getToolCacheKey(toolId, params);
  const entry = threadCache.cache.get(key);
  if (entry) {
    tcAILogger.info(`[ToolCache] Cache HIT for ${toolId} (thread: ${threadId || DEFAULT_THREAD_ID})`);
    return entry.result;
  }
  return void 0;
}
function cacheResult(toolId, params, result, threadId) {
  const threadCache = getThreadCache(threadId);
  const key = getToolCacheKey(toolId, params);
  const hash = key.split(":")[1];
  threadCache.cache.set(key, {
    result,
    timestamp: Date.now(),
    hash
  });
  tcAILogger.debug(`[ToolCache] Cached result for ${toolId} (thread: ${threadId || DEFAULT_THREAD_ID})`);
}
function extractThreadId(context) {
  if (!context || typeof context !== "object") return void 0;
  const ctx = context;
  if (ctx.agent && typeof ctx.agent === "object") {
    const agentCtx = ctx.agent;
    if (typeof agentCtx.threadId === "string") {
      return agentCtx.threadId;
    }
  }
  if (typeof ctx.threadId === "string") {
    return ctx.threadId;
  }
  return void 0;
}
function cachedExecute(toolId, executeFn) {
  return async (params) => {
    const cached = getCachedResult(toolId, params);
    if (cached !== void 0) {
      if (cached && typeof cached === "object" && !Array.isArray(cached)) {
        return {
          ...cached,
          _cached: true,
          _cacheNote: "Result from cache - tool was not re-executed."
        };
      }
      return cached;
    }
    const result = await executeFn(params);
    cacheResult(toolId, params, result);
    return result;
  };
}
function wrapToolWithCache(tool, options = {}) {
  if (!tool.execute || typeof tool.execute !== "function") {
    return tool;
  }
  const {
    maxInvocations = DEFAULT_MAX_TOOL_INVOCATIONS,
    enableCache = true
  } = options;
  const originalExecute = tool.execute;
  const toolId = tool.id;
  const wrappedExecute = async (params, context) => {
    const threadId = extractThreadId(context);
    const threadLabel = threadId || DEFAULT_THREAD_ID;
    cleanupStaleCaches();
    if (isToolInvocationLimitExceeded(toolId, threadId, maxInvocations)) {
      const currentCount = getToolInvocationCount(toolId, threadId);
      tcAILogger.error(
        `[ToolCache] INVOCATION LIMIT EXCEEDED: ${toolId} (thread: ${threadLabel}, count: ${currentCount}/${maxInvocations})`
      );
      const threadCache = getThreadCache(threadId);
      threadCache.limitExceededAt = Date.now();
      threadCache.limitExceededTool = toolId;
      return {
        error: `BUDGET_EXHAUSTED (${currentCount}/${maxInvocations}). Produce final report now.`
      };
    }
    if (enableCache) {
      const cached = getCachedResult(toolId, params, threadId);
      if (cached !== void 0) {
        tcAILogger.warn(
          `[ToolCache] DUPLICATE CALL BLOCKED: ${toolId} (thread: ${threadLabel}) - tool was already called with these parameters`
        );
        return {
          error: `DUPLICATE_CALL: ${toolId} already called with same params. Use previous result.`
        };
      }
    }
    const invocationNum = incrementToolInvocationCount(toolId, threadId);
    tcAILogger.debug(
      `[ToolCache] Executing ${toolId} (thread: ${threadLabel}, invocation: ${invocationNum}/${maxInvocations})`
    );
    const result = await originalExecute(params, context);
    if (enableCache) {
      cacheResult(toolId, params, result, threadId);
    }
    return result;
  };
  return {
    ...tool,
    execute: wrappedExecute
  };
}
function wrapToolsWithCache(tools, options) {
  const result = {};
  for (const [key, tool] of Object.entries(tools)) {
    const toolOptions = typeof options === "function" ? options(tool.id) : options;
    result[key] = wrapToolWithCache(tool, toolOptions);
  }
  return result;
}

"use strict";
const submissionToolsRaw = {
  submission_search: submissionSearchTool,
  submission_read: submissionReadTool
};
const submissionTools = {
  submission_search: wrapToolWithCache(submissionSearchTool, { maxInvocations: 20 }),
  submission_read: wrapToolWithCache(submissionReadTool, { maxInvocations: 20 })
};

"use strict";
function normalizeSubmissionPath$1(filePath) {
  if (filePath.startsWith("submission/")) {
    return filePath.slice("submission/".length);
  }
  return filePath;
}
function parseSymbolPath(id) {
  const colonIndex = id.lastIndexOf(":");
  if (colonIndex === -1) return null;
  const lastPart = id.slice(colonIndex + 1);
  const isLineRange = /^\d+-\d+$/.test(lastPart);
  if (isLineRange) {
    const beforeLineRange = id.slice(0, colonIndex);
    const secondColonIndex = beforeLineRange.lastIndexOf(":");
    if (secondColonIndex === -1) return null;
    return {
      filePath: beforeLineRange.slice(0, secondColonIndex),
      symbolName: beforeLineRange.slice(secondColonIndex + 1)
    };
  }
  return {
    filePath: id.slice(0, colonIndex),
    symbolName: lastPart
  };
}
function extractSnippet(content, lineRange, maxLength = 100) {
  const lines = content.split("\n");
  if (lineRange) {
    const start = Math.max(0, lineRange.start - 1);
    const end = Math.min(lines.length, lineRange.end);
    const relevantLines = lines.slice(start, end).join("\n");
    if (relevantLines.length <= maxLength) return relevantLines.trim();
    return relevantLines.slice(0, maxLength).trim() + "...";
  }
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  let snippet = "";
  for (const line of nonEmptyLines) {
    if (snippet.length + line.length + 1 > maxLength) break;
    snippet += (snippet ? "\n" : "") + line;
  }
  return snippet || content.slice(0, maxLength).trim() + "...";
}
const submissionSearchTermsTool = createTool({
  id: "submission_search_terms",
  description: `Search the submission with MULTIPLE related terms in a single call and get MERGED, deduplicated results.

Use this when investigating a domain concept that has multiple naming conventions - e.g. for "authentication"
search ["auth", "login", "session", "jwt"] in one call instead of 4 separate submission_search calls.

Returns merged files/symbols/documents, each annotated with which query term(s) matched, plus a per-query
result-count summary so you can see which terms found nothing (helping you spot gaps before concluding
"not implemented").

**Use this INSTEAD OF multiple submission_search calls when:**
- The requirement maps to a well-known concept with synonyms (auth, cache, multi-tenant, rate limit, etc.)
- You want to verify a "not found" conclusion by trying several literal code patterns at once

Still use plain submission_search for a single specific symbol/file name lookup.`,
  inputSchema: z.object({
    queries: z.array(z.string()).min(2).max(6).describe('2-6 related search terms (e.g. ["auth", "login", "session", "jwt"])')
  }),
  outputSchema: z.object({
    files: z.array(z.object({
      filePath: z.string(),
      language: z.string(),
      symbols: z.array(z.object({
        symbolPath: z.string(),
        kind: z.string(),
        signature: z.string().optional(),
        exported: z.boolean(),
        line: z.number().optional(),
        matchedQueries: z.array(z.string())
      }))
    })),
    documents: z.array(z.object({
      filePath: z.string(),
      snippet: z.string(),
      matchedQueries: z.array(z.string())
    })),
    perQuery: z.array(z.object({
      query: z.string(),
      fileCount: z.number(),
      symbolCount: z.number(),
      documentCount: z.number()
    })),
    zeroResultQueries: z.array(z.string())
  }),
  execute: async ({ queries }) => {
    const mode = "hybrid";
    const topK = 5;
    const minScore = 0.15;
    tcAILogger.info(`[submission_search_terms] Multi-query search: ${JSON.stringify(queries)}`);
    const store = astIndexerService.getStore();
    const fileMap = /* @__PURE__ */ new Map();
    const docMap = /* @__PURE__ */ new Map();
    const perQuery = [];
    const zeroResultQueries = [];
    for (const query of queries) {
      let fileCount = 0;
      let symbolCount = 0;
      let documentCount = 0;
      try {
        const searchResults = await reviewWorkspace.search(query, { mode, topK, minScore });
        for (const result of searchResults) {
          const parsed = parseSymbolPath(result.id);
          if (!parsed) {
            const normalizedPath = normalizeSubmissionPath$1(result.id);
            documentCount++;
            const existing = docMap.get(normalizedPath);
            if (existing) {
              if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
            } else {
              docMap.set(normalizedPath, {
                filePath: normalizedPath,
                snippet: extractSnippet(result.content, result.lineRange),
                matchedQueries: [query]
              });
            }
            continue;
          }
          const { filePath, symbolName } = parsed;
          const normalizedFilePath = normalizeSubmissionPath$1(filePath);
          const symbols = store.getSymbolsForFile(filePath);
          const symbol = symbols.find((s) => s.symbolName === symbolName);
          if (!symbol) continue;
          const symbolDoc = formatSymbolAsJSON(symbol);
          const symbolPath = `${normalizedFilePath}:${symbolName}`;
          symbolCount++;
          let fileEntry = fileMap.get(normalizedFilePath);
          if (!fileEntry) {
            fileEntry = { filePath: normalizedFilePath, language: symbol.language || "unknown", symbols: [] };
            fileMap.set(normalizedFilePath, fileEntry);
            fileCount++;
          }
          const existingSymbol = fileEntry.symbols.find((s) => s.symbolPath === symbolPath);
          if (existingSymbol) {
            if (!existingSymbol.matchedQueries.includes(query)) existingSymbol.matchedQueries.push(query);
          } else {
            fileEntry.symbols.push({
              symbolPath,
              kind: symbolDoc.kind,
              signature: symbolDoc.signature,
              exported: symbolDoc.flags?.isExported || false,
              line: symbolDoc.location?.line,
              matchedQueries: [query]
            });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        tcAILogger.warn(`[submission_search_terms] Query "${query}" failed: ${errorMessage}`);
      }
      perQuery.push({ query, fileCount, symbolCount, documentCount });
      if (fileCount === 0 && symbolCount === 0 && documentCount === 0) {
        zeroResultQueries.push(query);
      }
    }
    const files = [...fileMap.values()];
    const documents = [...docMap.values()];
    tcAILogger.info(`[submission_search_terms] Merged results: ${files.length} files, ${documents.length} documents; zero-result queries: ${zeroResultQueries.join(", ") || "none"}`);
    return { files, documents, perQuery, zeroResultQueries };
  }
});

"use strict";
function normalizeSubmissionPath(filePath) {
  if (filePath.startsWith("submission/")) {
    return filePath.slice("submission/".length);
  }
  return filePath;
}
function findSimilarPaths(requestedPath, indexedPaths, maxSuggestions = 3) {
  const requestedFileName = path.basename(requestedPath.split(":")[0]);
  const requestedSegments = requestedPath.split(":")[0].split("/").filter(Boolean);
  const scored = [];
  for (const indexedPath of indexedPaths) {
    const indexedFileName = path.basename(indexedPath);
    const indexedSegments = indexedPath.split("/").filter(Boolean);
    let score = 0;
    if (indexedFileName === requestedFileName) score += 10;
    else if (indexedFileName.toLowerCase() === requestedFileName.toLowerCase()) score += 8;
    else if (indexedFileName.includes(requestedFileName) || requestedFileName.includes(indexedFileName)) score += 5;
    for (const segment of requestedSegments) {
      if (indexedSegments.includes(segment)) score += 2;
    }
    const lengthDiff = Math.abs(indexedSegments.length - requestedSegments.length);
    score -= lengthDiff * 0.5;
    if (score > 0) scored.push({ path: indexedPath, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSuggestions).map((s) => normalizeSubmissionPath(s.path));
}
function tokenize(text) {
  const STOPWORDS = /* @__PURE__ */ new Set(["the", "a", "an", "and", "or", "of", "to", "is", "in", "for", "on", "with", "must", "should", "be", "this", "that"]);
  return new Set(
    text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}
function tokenOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
const verifyConstraintTool = createTool({
  id: "verify_constraint",
  description: `Sanity-check a candidate symbol/file against a constraint BEFORE citing it as evidence in your report.

Given a constraint description (e.g. "Multi-tenant isolation enforced via row-level security policies") and a
candidatePath (e.g. "backbone/db/policies.sql" or "src/auth/session.ts:createSession"), this tool:
- Confirms the path EXISTS in the index (catches typos/hallucinated paths cheaply)
- Returns call-graph info (calls/calledBy), complexity, hasErrorHandling/hasLogging flags
- Returns a keywordOverlapScore (0-1) estimating how related the constraint text is to the symbol's
  signature/name - LOW scores (< 0.1) are a signal you may have the WRONG symbol
- If the path doesn't exist, returns "suggestions" of similar indexed paths

Use this to cheaply validate candidates from submission_search results before spending a submission_read call,
and before citing a path in your final report. Does NOT count toward the submission_read evidence requirement -
you still must submission_read the symbol to quote it.`,
  inputSchema: z.object({
    constraintText: z.string().describe("The constraint or requirement text being verified"),
    candidatePath: z.string().describe('Candidate path: "file.ext" or "file.ext:symbolName"')
  }),
  outputSchema: z.object({
    exists: z.boolean(),
    normalizedPath: z.string(),
    kind: z.string().optional(),
    signature: z.string().optional(),
    complexity: z.number().optional(),
    hasErrorHandling: z.boolean().optional(),
    hasLogging: z.boolean().optional(),
    calls: z.array(z.string()).optional(),
    calledBy: z.array(z.string()).optional(),
    keywordOverlapScore: z.number().optional(),
    keywordOverlapNote: z.string().optional(),
    suggestions: z.array(z.string()).optional()
  }),
  execute: async ({ constraintText, candidatePath }) => {
    tcAILogger.info(`[verify_constraint] Checking "${candidatePath}" against constraint`, { constraintText: constraintText.slice(0, 80) });
    const store = astIndexerService.getStore();
    const colonIndex = candidatePath.lastIndexOf(":");
    const hasSymbolName = colonIndex > 0 && !candidatePath.slice(colonIndex + 1).includes("/");
    if (hasSymbolName) {
      const rawFilePath = candidatePath.slice(0, colonIndex);
      const symbolName = candidatePath.slice(colonIndex + 1);
      const candidates2 = [rawFilePath, `submission/${rawFilePath}`, rawFilePath.replace(/^submission\//, "")];
      let foundFilePath = null;
      let symbol = null;
      for (const fp of candidates2) {
        const symbols = store.getSymbolsForFile(fp);
        const found = symbols.find((s) => s.symbolName === symbolName);
        if (found) {
          foundFilePath = fp;
          symbol = found;
          break;
        }
      }
      if (!symbol || !foundFilePath) {
        const codeFilePaths2 = store.getFilePaths();
        const allIndexedPaths2 = [.../* @__PURE__ */ new Set([...codeFilePaths2, ...indexedDocumentPaths])];
        const suggestions2 = findSimilarPaths(candidatePath, allIndexedPaths2);
        return {
          exists: false,
          normalizedPath: normalizeSubmissionPath(candidatePath),
          suggestions: suggestions2.length > 0 ? suggestions2 : void 0
        };
      }
      const symbolDoc = formatSymbolAsJSON(symbol);
      const normalizedFilePath = normalizeSubmissionPath(foundFilePath);
      const constraintTokens = tokenize(constraintText);
      const symbolTokens = tokenize(`${symbolName} ${symbolDoc.signature || ""}`);
      const overlap = tokenOverlap(constraintTokens, symbolTokens);
      return {
        exists: true,
        normalizedPath: `${normalizedFilePath}:${symbolName}`,
        kind: symbolDoc.kind,
        signature: symbolDoc.signature,
        complexity: symbolDoc.metrics?.complexity,
        hasErrorHandling: symbolDoc.flags?.hasErrorHandling,
        hasLogging: symbolDoc.flags?.hasLogging,
        calls: (symbolDoc.callGraph?.calls || []).slice(0, 10),
        calledBy: (symbolDoc.callGraph?.calledBy || []).slice(0, 5),
        keywordOverlapScore: Math.round(overlap * 100) / 100,
        keywordOverlapNote: overlap < 0.1 ? "LOW overlap between constraint text and symbol name/signature - double-check this is the right symbol before citing it." : void 0
      };
    }
    const candidates = [candidatePath, `submission/${candidatePath}`, candidatePath.replace(/^submission\//, "")];
    for (const fp of candidates) {
      const symbols = store.getSymbolsForFile(fp);
      if (symbols.length > 0) {
        return {
          exists: true,
          normalizedPath: normalizeSubmissionPath(fp),
          kind: "file"
        };
      }
    }
    const codeFilePaths = store.getFilePaths();
    const allIndexedPaths = [.../* @__PURE__ */ new Set([...codeFilePaths, ...indexedDocumentPaths])];
    if (allIndexedPaths.some((p) => normalizeSubmissionPath(p) === normalizeSubmissionPath(candidatePath))) {
      return { exists: true, normalizedPath: normalizeSubmissionPath(candidatePath), kind: "document" };
    }
    const suggestions = findSimilarPaths(candidatePath, allIndexedPaths);
    return {
      exists: false,
      normalizedPath: normalizeSubmissionPath(candidatePath),
      suggestions: suggestions.length > 0 ? suggestions : void 0
    };
  }
});

"use strict";
const REQUIREMENT_ANALYZER_OUTPUT = `# Requirement **ID:** [requirement ID or "N/A"] -Analysis Report

## 1. Requirement Summary

**ID:** [requirement ID or "N/A"]

**Title:** [requirement title]

**Constraints:** [list any constraints from the requirement, or "None specified"]
- [constraint 1]
- [etc.]

## 2. Implementation Evidence

### Core Implementation
[Describe the main code that implements this requirement]
- **File:** [path]
- **Symbol:** [function/class name]
- **How it covers the requirement:** [brief explanation]

### Dependencies & Integrations
- [List key dependencies used: Prisma, Kafka, etc.]
- [List external services or APIs called]
- [List database tables/models accessed]

## 3. Constraint Verification

| Constraint | Status | Evidence |
|------------|--------|----------|
| [constraint text] | \u2705 Verified / \u26A0\uFE0F Partial / \u274C Not Found | [specific evidence - keep it short] |

## 4. Coverage Assessment

**Overall Coverage Score:** [0.0 - 1.0]

**Verdict:** [COVERED / PARTIAL / MISSING]

**Justification:**
[1-2 sentences explaining the verdict with specific references to evidence]

### What's Missing or Unclear:
- [bullet point for each gap, or "None identified" if fully covered]

## 5. Quality Observations

**Code Quality Indicators:**
- Complexity: [low/medium/high] - [brief note]
- Error Handling: [present/missing] - [brief note]
- Test Coverage: [observed/not observed]

**Potential Concerns:**
- [Any broken imports, missing dependencies, or risks observed]
- [Or "No concerns identified"]`;

"use strict";
const DOMAIN_CONCEPTS = [
  { concept: "Database indexing", badExample: "indexing strategy", patterns: ["Index(", "index=True", "create_index", "CREATE INDEX"] },
  { concept: "Error handling", badExample: "error handling approach", patterns: ["try", "catch", "except", "rescue", "error_handler"] },
  { concept: "Caching", badExample: "caching mechanism", patterns: ["@cache", "Redis", "lru_cache", "memcached"] },
  { concept: "Validation", badExample: "input validation", patterns: ["validate", "validator", "Zod", "yup", "Pydantic", "schema"] },
  { concept: "Rate limiting", badExample: "rate limiting", patterns: ["ratelimit", "rate_limit", "throttle", "@RateLimit"] },
  { concept: "Authentication", badExample: "auth strategy", patterns: ["jwt", "OAuth", "@authenticated", "passport", "auth", "login", "session"] },
  { concept: "Authorization", badExample: "permission strategy", patterns: ["authorize", "permission", "role", "rbac", "policy", "acl"] },
  { concept: "Logging", badExample: "logging implementation", patterns: ["logger.", "console.log", "logging.info"] },
  { concept: "Multi-tenancy", badExample: "tenant isolation", patterns: ["tenantId", "TenantContext", "rls", "row level security", "tenant"] },
  { concept: "Database security", badExample: "access control", patterns: ["policy", "RLS", "row level", "ENABLE ROW LEVEL"] },
  { concept: "Seed/demo data", badExample: "demo environment", patterns: ["seed", "seed-data", "fixtures", "demo", "sample-data"] },
  { concept: "Automated tests", badExample: "tests exist", patterns: [".test.", ".spec.", "describe(", "test(", "pytest", "unittest"] },
  { concept: "Migration", badExample: "schema migration approach", patterns: ["migration", "migrate", "alembic", "prisma migrate"] },
  { concept: "Queue/async jobs", badExample: "async job processing", patterns: ["queue", "kafka", "rabbitmq", "sqs", "celery", "arq"] },
  { concept: "Webhooks", badExample: "webhook handling", patterns: ["webhook", "callback", "hook"] },
  { concept: "Retry/backoff", badExample: "retry strategy", patterns: ["retry", "backoff", "exponential", "tenacity"] },
  { concept: "Pagination", badExample: "pagination support", patterns: ["paginate", "pagination", "cursor", "offset", "limit"] },
  { concept: "Notifications", badExample: "notification system", patterns: ["notify", "notification", "email", "sms", "push"] },
  { concept: "Agent prompts", badExample: "agent instructions", patterns: ["PROMPT", "system_prompt", "prompt_template", "AGENT_INSTRUCTIONS", "instruction"] },
  { concept: "Performance metrics", badExample: "cost and latency", patterns: ["cost", "latency", "measured", "p50", "p95", "benchmark", "duration_ms"] },
  { concept: "AI model config", badExample: "model settings", patterns: ["model", "temperature", "max_tokens", "llm", "claude", "gpt", "anthropic", "openai"] },
  { concept: "Feature flags", badExample: "feature toggles", patterns: ["feature_flag", "featureFlag", "toggle", "FEATURE_", "isEnabled"] },
  { concept: "Configuration", badExample: "app config", patterns: [".env", "config.ts", "settings", "CONFIG", "dotenv", "process.env"] },
  { concept: "Type definitions", badExample: "type system", patterns: ["interface ", "type ", "enum ", "z.object", "zod", "schema"] }
];
function renderDomainConceptsTable() {
  const header = "| Concept | BAD (semantic) | GOOD (literal code pattern) |\n|---------|----------------|----------------------------|";
  const rows = DOMAIN_CONCEPTS.map(
    (e) => `| ${e.concept} | "${e.badExample}" | ${e.patterns.map((p) => `"${p}"`).join(", ")} |`
  );
  return [header, ...rows].join("\n");
}
function buildSynonymLookup() {
  const lookup = {};
  for (const entry of DOMAIN_CONCEPTS) {
    const key = entry.concept.toLowerCase();
    lookup[key] = entry.patterns;
    for (const word of key.split(/[\s/-]+/)) {
      if (word.length > 3 && !lookup[word]) {
        lookup[word] = entry.patterns;
      }
    }
  }
  return lookup;
}

"use strict";
const AGENT_INSTRUCTIONS = `You are a code requirement analyzer that maps software requirements to codebase implementations.

## Your Task

Analyze whether a SPECIFIC REQUIREMENT is implemented in the codebase.
Produce a comprehensive, human-readable analysis report with clear, traceable evidences.

## Available Tools

### submission_search(query)
Search for code symbols AND documents. Use to DISCOVER relevant files and symbols.

Parameters:
- query: Search terms (function names, class names, technical terms)

Returns:
- **files[]**: Code symbols with symbolPath, kind, signature, exported
- **documents[]**: Non-code files with filePath, snippet

**IMPORTANT: submission_search is for DISCOVERY, not for reading file contents!**
- WRONG: submission_search(query="account") \u274C
- RIGHT: submission_read("schema.prisma") \u2705

Once you discover a file path from search results, use submission_read to read its contents.

### submission_search_terms(queries)
Run MULTIPLE related search terms in ONE call and get merged, deduplicated results.

Parameters:
- queries: array of 2\u20136 related terms (e.g. ["auth", "login", "session", "jwt"])

Returns:
- files[]/documents[] merged across all queries, each tagged with matchedQueries[]
- perQuery[] summary showing how many results each term found
- zeroResultQueries[] listing which terms found nothing

**Use INSTEAD OF multiple submission_search calls when:**
- The requirement maps to a domain concept with synonyms (auth, cache, rate-limit, multi-tenant, etc.)
- You want to verify a "not found" conclusion by trying several literal patterns at once
- Before concluding MISSING, run submission_search_terms with 4\u20136 synonyms from the domain table

Still use plain submission_search for a single specific symbol/file name lookup.

### verify_constraint(constraintText, candidatePath)
Sanity-check a candidate symbol/file against a constraint BEFORE citing it in your report.

Parameters:
- constraintText: the constraint or requirement text being verified
- candidatePath: "file.ext" or "file.ext:symbolName"

Returns:
- exists (bool): whether the path is in the AST index (catches hallucinated/typo paths cheaply)
- kind, signature, complexity, hasErrorHandling, hasLogging, calls[], calledBy[]
- keywordOverlapScore (0\u20131): LOW (< 0.1) means you may have the WRONG symbol
- suggestions[]: similar indexed paths if the path doesn't exist

**Use this to cheaply validate a candidate before submission_read.**
Does NOT count as evidence \u2014 you still must submission_read to quote code in the report.

### submission_read(path)
Read content from files or symbols. Returns complete symbol data with body, metrics, and call graph.

Parameters:
- path: "file.ts:symbolName" (symbol) or "file.ts" (file) or "package.json" (document)

**CRITICAL: Use EXACT file paths from search results!**
- Copy paths EXACTLY as returned by submission_search - do not modify, shorten, or infer paths!
- WRONG: Search returns "backbone/db/prisma/schema.prisma" \u2192 Read "backbone/prisma/schema.prisma" \u274C
- RIGHT: Search returns "backbone/db/prisma/schema.prisma" \u2192 Read "backbone/db/prisma/schema.prisma" \u2705
- If you get a "File may not exist" error, double-check you used the EXACT path from search results

## Runtime Context: File Inventory From ToolResultManager

At each step, the runtime injects a system message like:
"The following files are available for requirement review..."

Treat this list as a repository-wide inventory for review.

- Use this inventory to pick candidate files for direct submission_read calls.
- Do NOT waste turns rediscovering obvious files that are already listed in this inventory.
- When the requirement mentions a specific file name/path, read that file immediately if it appears in the inventory.
- If path ambiguity exists (same filename in multiple folders), resolve with targeted submission_search, then read exact paths.

## Understanding Deduplicated Results

To save context space, results are deduplicated across steps. When you see these fields:

**_seeAlso**: Points to where full data was already shown
- Example: \`_seeAlso: "search(query='auth') in step 0"\` \u2192 Look back at step 0's auth search
- Example: \`_seeAlso: "read('src/db.ts') in step 1"\` \u2192 Full content is in step 1's read result

**_skippedSymbols / _skippedDocuments**: Items filtered because already shown
- Each entry has its own _seeAlso pointer
- DON'T re-search or re-read these - the data is already in your context!

**How to use dedup pointers:**
1. When you see _seeAlso, recall the referenced tool result from earlier in the conversation
2. The full symbol body, document content, or search metadata is ALREADY available
3. Use this existing context instead of making redundant tool calls

**Note:** Search snippets do NOT block full reads. If you searched for a file and now need full content, submission_read will return the complete data.

## Workflow

1. **PLAN** - Break the requirement into verifiable constraints.
2. **USE INVENTORY FIRST** - Check the ToolResultManager file inventory and read obvious candidate files directly.
3. **SEARCH** - Run targeted submission_search for symbols, synonyms, and code patterns.
4. **READ** - Use submission_read on key files/symbols before making claims.
5. **VERIFY** - Confirm each constraint with concrete evidence from read content.
6. **REPORT** - Produce the required output template with file/symbol evidence.

**KEY PRINCIPLE: Search discovers, Read verifies.**
- submission_search \u2192 finds file paths
- submission_read \u2192 reads actual content (THIS IS WHERE EVIDENCE COMES FROM!)

**CRITICAL: Read files mentioned in the requirement FIRST!**
If the requirement title/description contains a file path like "/docs/agents.md" or "schema.prisma":
- That file IS the subject of the requirement
- READ IT IMMEDIATELY with submission_read() - don't search for it first!
- Snippets from search results are NOT a substitute for reading the full file

## Verification Standard (Required Before Verdict)

**DO NOT conclude your analysis until you have:**

1. **Covered discovery breadth** with at least 2-3 targeted searches across different aspects.
2. **Read implementation evidence** from at least 1 key file/symbol (not only search snippets).
3. **Verified every constraint** with read content, not file names or assumptions.

**Search snippets are NOT sufficient evidence.** You MUST read the actual implementation code to verify:
- The function/class actually does what its name suggests
- The integration actually calls the expected APIs
- Error handling and edge cases are properly implemented

### Before "PARTIAL" or "MISSING"

- Search for the exact missing term/pattern you are about to claim is absent.
- Read relevant implementations and follow call chains (use calls/calledBy).
- Check both files[] and documents[] search outputs.
- Record search attempts used to justify the gap.

### Exhaustive Search Checklist For Missing Claims

1. Run at least 3 distinct query styles:
   - Exact literal/code pattern terms from the constraint.
   - Synonyms/alternative implementation terms.
   - Domain-specific technical terms (migration, policy, fixture, etc.).
2. Check common locations/patterns:
   - Tests may be co-located ("*.test.*", "*.spec.*") and not in a dedicated tests folder.
   - Security/data often appears in migrations, policies, seed, and config files.
3. Read at least one plausible full candidate file before concluding not found.
4. Document what was searched and why the conclusion is justified.

**CRITICAL: Search for CODE PATTERNS, not just concepts!**
Semantic searches like "indexing strategy" or "error handling approach" often return nothing because code doesn't contain these phrases. Instead, search for the ACTUAL CODE PATTERNS:

${renderDomainConceptsTable()}

## CRITICAL: Verify ALL Aspects of the Requirement

**Before concluding, check if you've verified EVERY aspect mentioned:**

Example requirement: "Multi-tenant with isolation tests and seeded demo"
You must verify:
1. \u2705 Multi-tenant implementation exists
2. \u2705 Isolation is enforced (read the actual isolation code!)
3. \u2705 Tests verify isolation (find and READ *.test.ts files!)
4. \u2705 Seeded demo exists (find and READ seed data files!)

**Don't mark PARTIAL if you simply didn't search for something!**

## REQUIRED Output Format

After your analysis, you MUST produce a report following this EXACT template.
Fill in ALL sections - do not skip any section.

---

${REQUIREMENT_ANALYZER_OUTPUT}

---

## Coverage Verdict Guidelines

- **COVERED** (score >= 0.7): Clear evidence requirement is fully implemented
- **PARTIAL** (score 0.3-0.7): Some aspects implemented but gaps exist  
- **MISSING** (score < 0.3): No evidence found or critical constraints unmet

## Important Notes

- Fill ALL sections of the template - use "N/A" or "None" if section doesn't apply
- Include actual code snippets as evidence (keep them brief: 10 lines max)
- Be specific in your evidence - cite exact file paths and symbol names
- For constraints, provide concrete evidence (e.g., "calls PrismaClient.query at line 45")
- The quality observations section helps reviewers understand code health`;

"use strict";
const MAX_STEPS = 25;
const EARLY_WARNING_THRESHOLD = 20;
const SUGGESTED_NEXT_STEPS = [
  "Increase maxSteps if the requirement is complex and needs more tool calls",
  "Break down the requirement into smaller, more focused sub-requirements",
  "Pre-filter the search scope by specifying relevant file paths or patterns",
  "Review the partial output and manually verify the remaining constraints",
  "Consider using a more specific search query based on the partial results"
];
function getToolNameFromCall(tc) {
  const tcRecord = tc;
  if (tcRecord.toolName) return String(tcRecord.toolName);
  if (tcRecord.payload && typeof tcRecord.payload === "object") {
    const payload = tcRecord.payload;
    if (payload.toolName) return String(payload.toolName);
  }
  if (tcRecord.name) return String(tcRecord.name);
  if (tcRecord.function && typeof tcRecord.function === "object") {
    const fn = tcRecord.function;
    if (fn.name) return String(fn.name);
  }
  return void 0;
}
function summarizeGatheredContext(toolCalls) {
  const summary = [];
  const toolCounts = {};
  for (const tc of toolCalls) {
    const toolName = getToolNameFromCall(tc) || "unknown";
    let category;
    if (toolName.includes("search")) {
      category = "search";
    } else if (toolName.includes("read")) {
      category = "read";
    } else {
      category = toolName;
    }
    toolCounts[category] = (toolCounts[category] || 0) + 1;
  }
  if (toolCounts.search) summary.push(`${toolCounts.search} search operations`);
  if (toolCounts.read) summary.push(`${toolCounts.read} file reads`);
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (tool !== "search" && tool !== "read" && tool !== "unknown") {
      summary.push(`${count} ${tool} calls`);
    }
  }
  if (toolCounts.unknown) {
    summary.push(`${toolCounts.unknown} unidentified tool calls`);
  }
  return summary.length > 0 ? summary.join(", ") : "No tool calls recorded";
}

"use strict";
const currentRunId = "";
const onIterationComplete = (context) => {
  const { iteration, maxIterations, text, toolCalls, finishReason, isFinal } = context;
  tcAILogger.debug("[RequirementAnalyzer] Iteration complete", {
    iteration,
    maxIterations,
    finishReason,
    isFinal,
    toolCallsCount: toolCalls?.length || 0,
    textLength: text?.length || 0
  });
  const hasTextOutput = !!text?.trim();
  if (maxIterations && iteration >= EARLY_WARNING_THRESHOLD && !hasTextOutput) {
    const remainingSteps = maxIterations - iteration;
    tcAILogger.info(`[RequirementAnalyzer] Approaching maxSteps limit without output`, {
      iteration,
      maxIterations,
      remainingSteps,
      hasTextOutput
    });
    return {
      feedback: `IMPORTANT: You have used ${iteration} of ${maxIterations} iterations. You MUST produce your final JSON output in the next ${remainingSteps} iterations. Do not make more tool calls - synthesize your findings NOW. Based on the evidence gathered, produce the complete JSON response with requirementId, matches, coverageScore, coverageVerdict, and constraints.`
    };
  }
  if (isFinal && !hasTextOutput) {
    tcAILogger.warn("[RequirementAnalyzer] Final iteration reached without output", {
      iteration,
      maxIterations,
      finishReason
    });
  }
  return void 0;
};
function getToolName(tc) {
  if (tc.toolName) return tc.toolName;
  if (tc.payload?.toolName) return tc.payload.toolName;
  if (tc.name) return tc.name;
  if (tc.function?.name) return tc.function.name;
  tcAILogger.debug("[RequirementAnalyzer] Unknown tool call structure", {
    keys: Object.keys(tc),
    sample: JSON.stringify(tc).slice(0, 500)
  });
  return "unknown";
}
function analyzeSteps(steps) {
  const stepBreakdown = { initial: 0, continue: 0, toolResult: 0, unknown: 0 };
  const toolUsage = {};
  const totalToolTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toolCallOrder = [];
  for (const step of steps) {
    const stepType = step.stepType;
    if (stepType === "initial") stepBreakdown.initial++;
    else if (stepType === "continue") stepBreakdown.continue++;
    else if (stepType === "tool-result") stepBreakdown.toolResult++;
    else stepBreakdown.unknown++;
    const stepToolCalls = step.toolCalls || [];
    const stepUsage = step.usage || {};
    for (const tc of stepToolCalls) {
      const toolName = getToolName(tc);
      toolCallOrder.push(toolName);
      if (!toolUsage[toolName]) {
        toolUsage[toolName] = { count: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      toolUsage[toolName].count++;
    }
    if (stepToolCalls.length > 0) {
      const inputTokens = stepUsage.inputTokens || stepUsage.promptTokens || 0;
      const outputTokens = stepUsage.outputTokens || stepUsage.completionTokens || 0;
      const totalTokens = stepUsage.totalTokens || inputTokens + outputTokens;
      const tokensPerTool = {
        inputTokens: Math.round(inputTokens / stepToolCalls.length),
        outputTokens: Math.round(outputTokens / stepToolCalls.length),
        totalTokens: Math.round(totalTokens / stepToolCalls.length)
      };
      for (const tc of stepToolCalls) {
        const toolName = getToolName(tc);
        toolUsage[toolName].inputTokens += tokensPerTool.inputTokens;
        toolUsage[toolName].outputTokens += tokensPerTool.outputTokens;
        toolUsage[toolName].totalTokens += tokensPerTool.totalTokens;
      }
      totalToolTokens.inputTokens += inputTokens;
      totalToolTokens.outputTokens += outputTokens;
      totalToolTokens.totalTokens += totalTokens;
    }
  }
  return { stepBreakdown, toolUsage, totalToolTokens, toolCallOrder };
}
const onFinish = (result) => {
  const usage = result.usage || {};
  const steps = result.steps;
  const stepsCount = steps?.length || 0;
  const hasOutput = !!(result.text?.trim() || result.object);
  const maxStepsReached = stepsCount >= MAX_STEPS;
  const stepsAnalysis = steps ? analyzeSteps(steps) : null;
  const toolsSummary = stepsAnalysis ? Object.entries(stepsAnalysis.toolUsage).map(([name, stats]) => ({
    tool: name,
    calls: stats.count,
    tokens: stats.totalTokens,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens
  })) : [];
  tcAILogger.info(`[RequirementAnalyzer] Run completed`, {
    runId: currentRunId,
    totalSteps: stepsCount,
    stepBreakdown: stepsAnalysis?.stepBreakdown || null,
    totalUsage: {
      inputTokens: usage.inputTokens || usage.promptTokens || 0,
      outputTokens: usage.outputTokens || usage.completionTokens || 0,
      totalTokens: usage.totalTokens || 0
    },
    toolUsage: {
      tools: toolsSummary,
      totalToolCalls: toolsSummary.reduce((sum, t) => sum + t.calls, 0),
      totalToolTokens: stepsAnalysis?.totalToolTokens || null,
      callOrder: stepsAnalysis?.toolCallOrder || []
    },
    finishReason: result.finishReason,
    hasObject: !!result.object,
    textLength: result.text?.length || 0,
    maxStepsReached,
    hasOutput
  });
  const toolCalls = result.toolCalls;
  const gatheredContext = summarizeGatheredContext(toolCalls || []);
  if (maxStepsReached && !hasOutput) {
    tcAILogger.error("[RequirementAnalyzer] MaxSteps reached without any output", {
      stepsExecuted: stepsCount,
      maxSteps: MAX_STEPS,
      finishReason: result.finishReason,
      gatheredContext,
      message: "Agent stopped before producing output. Consider increasing maxSteps or simplifying the requirement.",
      suggestedNextSteps: SUGGESTED_NEXT_STEPS
    });
  } else if (maxStepsReached && hasOutput) {
    tcAILogger.warn("[RequirementAnalyzer] MaxSteps reached but output was generated", {
      stepsExecuted: stepsCount,
      maxSteps: MAX_STEPS,
      finishReason: result.finishReason,
      gatheredContext,
      message: "Output generated based on partial analysis. Results may be incomplete.",
      suggestedNextSteps: SUGGESTED_NEXT_STEPS.slice(0, 3)
    });
  }
};

"use strict";
const MAX_ITERATIONS_BEFORE_FORCE_COMPLETE = 10;
const MIN_SEARCH_QUERIES = 1;
function isCompletionContext(input) {
  if (!input || typeof input !== "object") return false;
  const ctx = input;
  return typeof ctx.primitiveResult === "string" && typeof ctx.originalTask === "string" && Array.isArray(ctx.messages);
}
function extractToolInvocationsFromContext(ctx) {
  const invocations = [];
  for (const msg of ctx.messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (content && typeof content === "object" && "parts" in content) {
      const parts = content.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.type === "tool-invocation" && part.toolInvocation) {
            invocations.push(part.toolInvocation);
          }
        }
      }
    }
  }
  return invocations;
}
function extractSearchQueries(invocations) {
  const queries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const inv of invocations) {
    if (inv.toolName === "submission_search" && inv.args?.query) {
      const query = String(inv.args.query);
      if (!seen.has(query)) {
        seen.add(query);
        queries.push(query);
      }
    }
  }
  return queries;
}
function extractFinalReport(ctx) {
  if (ctx.primitiveResult?.includes("# Requirement Analysis Report")) {
    return ctx.primitiveResult;
  }
  for (const msg of ctx.messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string" && content.includes("# Requirement Analysis Report")) {
      return content;
    }
    if (content && typeof content === "object" && "parts" in content) {
      const parts = content.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.type === "text" && part.text?.includes("# Requirement Analysis Report")) {
            return part.text;
          }
        }
      }
    }
  }
  return null;
}
function extractVerdictFromReport(report) {
  if (!report) return null;
  const verdictPatterns = [
    // Standard formats
    /\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED|IMPLEMENTED|NOT IMPLEMENTED)/i,
    /VERDICT:\s*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED|IMPLEMENTED|NOT IMPLEMENTED)/i,
    /Coverage Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY COVERED|PARTIALLY COVERED|NOT COVERED)/i,
    // Alternative section headers
    /#+\s*(?:Final\s+)?Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY|PARTIALLY|NOT)/i,
    /#+\s*(?:Coverage\s+)?(?:Assessment|Conclusion)[:\s\S]{0,50}(COVERED|PARTIAL|MISSING|FULLY|PARTIALLY)/i,
    // Inline mentions
    /(?:overall|final|coverage)\s+(?:verdict|assessment|conclusion)[:\s]*(COVERED|PARTIAL|MISSING)/i,
    /requirement\s+is\s+(COVERED|PARTIAL(?:LY)?|MISSING|NOT\s+(?:COVERED|IMPLEMENTED))/i,
    /implementation\s+is\s+(COMPLETE|PARTIAL|MISSING|INCOMPLETE)/i,
    // Score-based verdicts
    /coverage[:\s]+(\d+(?:\.\d+)?)\s*%/i,
    // Risk-level based verdicts (for quality/risk analysis reports)
    /Overall Risk Level[:\s]*(Low|Medium|High|Critical)/i,
    /Risk (?:Level|Assessment)[:\s]*(Low|Medium|High|Critical)/i,
    // Conclusion section verdicts
    /#+\s*\d*\.?\s*Conclusion[\s\S]{0,200}(?:Overall|Final|Risk)[:\s]*(Low|Medium|High|Critical|COVERED|PARTIAL|MISSING)/i
  ];
  for (const pattern of verdictPatterns) {
    const match = report.match(pattern);
    if (match) {
      let verdict = match[1].toLowerCase().trim();
      if (verdict.includes("fully") || verdict === "complete" || verdict === "implemented") verdict = "covered";
      if (verdict.includes("partial") || verdict === "incomplete") verdict = "partial";
      if (verdict.includes("not") || verdict.includes("missing")) verdict = "missing";
      if (verdict === "low") verdict = "covered";
      if (verdict === "medium") verdict = "partial";
      if (verdict === "high" || verdict === "critical") verdict = "partial";
      if (/^\d+/.test(verdict)) {
        const pct = parseFloat(verdict);
        verdict = pct >= 80 ? "covered" : pct >= 40 ? "partial" : "missing";
      }
      const scoreMatch = report.match(/(?:Overall\s+)?(?:Coverage\s+)?Score:?\s*([0-9.]+)/i) || report.match(/SCORE:\s*([0-9.]+)/i) || report.match(/coverage[:\s]+(\d+(?:\.\d+)?)\s*%/i);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) / (scoreMatch[1].includes(".") || parseFloat(scoreMatch[1]) <= 1 ? 1 : 100) : verdict === "covered" ? 0.85 : verdict === "partial" ? 0.5 : 0;
      return { verdict, score };
    }
  }
  return null;
}
function extractRequirementFromContext(ctx) {
  const jsonMatch = ctx.originalTask.match(/\{[\s\S]*"id"[\s\S]*"title"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const req = JSON.parse(jsonMatch[0]);
      if (req.id && req.title) {
        return { id: req.id, title: req.title, description: req.description, constraints: req.constraints || [] };
      }
    } catch {
    }
  }
  const report = extractFinalReport(ctx);
  if (report) {
    const idMatch = report.match(/\*\*ID:\*\*\s*([^\n*]+)/i);
    const titleMatch = report.match(/\*\*Title:\*\*\s*([^\n*]+)/i);
    if (idMatch || titleMatch) {
      return {
        id: idMatch ? idMatch[1].trim().replace(/[`[\]"]/g, "") : "from-report",
        title: titleMatch ? titleMatch[1].trim() : "Unknown Requirement",
        constraints: []
      };
    }
  }
  return { id: "from-task", title: ctx.originalTask.slice(0, 100), constraints: [] };
}
function checkReportCompleteness(report) {
  if (!report) {
    return {
      hasRequirementSummary: false,
      hasSearchStrategy: false,
      hasCodeMatches: false,
      hasConstraintVerification: false,
      hasCoverageAssessment: false,
      hasVerdict: false
    };
  }
  const hasVerdict = /Verdict[:\s]*(COVERED|PARTIAL|MISSING|FULLY|NOT)/i.test(report) || /(?:overall|final|coverage)\s+(?:verdict|assessment|conclusion)/i.test(report) || /requirement\s+is\s+(COVERED|PARTIAL|MISSING|NOT)/i.test(report) || /implementation\s+is\s+(COMPLETE|PARTIAL|MISSING|INCOMPLETE)/i.test(report) || /#+\s*(?:Final\s+)?(?:Verdict|Conclusion|Assessment)/i.test(report) || /Overall Risk Level[:\s]*(Low|Medium|High|Critical)/i.test(report) || /#+\s*\d*\.?\s*Conclusion/i.test(report);
  return {
    hasRequirementSummary: /Requirement Summary|## 1\./i.test(report),
    hasSearchStrategy: /Search Strategy|Queries Executed|## 2\./i.test(report),
    hasCodeMatches: /Code Matches|Primary Matches|## 3\./i.test(report),
    hasConstraintVerification: /Constraint Verification|## 5\./i.test(report),
    hasCoverageAssessment: /Coverage Assessment|## 6\./i.test(report),
    hasVerdict
  };
}
function preprocessFn(run) {
  tcAILogger.debug("[TaskCompletionScorer] Starting preprocess step");
  if (!isCompletionContext(run.input)) {
    tcAILogger.warn("[TaskCompletionScorer] Input is not CompletionContext format");
    return {
      iteration: 0,
      maxIterations: 10,
      requirement: { id: "unknown", title: "Unknown", constraints: [] },
      searchQueriesCount: 0,
      hasReport: false,
      reportVerdict: null,
      reportCompleteness: checkReportCompleteness(null),
      shouldForceComplete: false,
      forceCompleteReason: null
    };
  }
  const ctx = run.input;
  const invocations = extractToolInvocationsFromContext(ctx);
  const searchQueries = extractSearchQueries(invocations);
  const report = extractFinalReport(ctx);
  const reportVerdict = extractVerdictFromReport(report);
  const requirement = extractRequirementFromContext(ctx);
  const reportCompleteness = checkReportCompleteness(report);
  const maxIterations = ctx.maxIterations ?? 10;
  let shouldForceComplete = false;
  let forceCompleteReason = null;
  if (report && reportVerdict) {
    shouldForceComplete = true;
    forceCompleteReason = `Report generated with verdict: ${reportVerdict.verdict.toUpperCase()}`;
  } else if (ctx.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE) {
    shouldForceComplete = true;
    forceCompleteReason = `Max iterations (${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}) reached`;
  } else if (report && reportCompleteness.hasVerdict && reportCompleteness.hasCoverageAssessment) {
    shouldForceComplete = true;
    forceCompleteReason = "Report has verdict and coverage assessment";
  }
  tcAILogger.info("[TaskCompletionScorer] Preprocess complete", {
    iteration: ctx.iteration,
    maxIterations,
    requirementId: requirement.id,
    searchQueriesCount: searchQueries.length,
    hasReport: !!report,
    reportVerdict: reportVerdict?.verdict ?? "none",
    reportVerdictScore: reportVerdict?.score?.toFixed(2) ?? "N/A",
    shouldForceComplete,
    forceCompleteReason,
    reportCompleteness: JSON.stringify(reportCompleteness)
  });
  return {
    iteration: ctx.iteration,
    maxIterations,
    requirement,
    searchQueriesCount: searchQueries.length,
    hasReport: !!report,
    reportVerdict,
    reportCompleteness,
    shouldForceComplete,
    forceCompleteReason
  };
}
const analyzeOutputSchema = z.object({
  searchStrategyScore: z.number().min(0).max(1).describe("Did the agent use appropriate search queries? (0-1)"),
  reportCompletenessScore: z.number().min(0).max(1).describe("Does the report have all required sections? (0-1)"),
  verdictClarityScore: z.number().min(0).max(1).describe("Is the coverage verdict clear and justified? (0-1)"),
  constraintAnalysisScore: z.number().min(0).max(1).describe("Were constraints properly analyzed (verified or noted as unverifiable)? (0-1)"),
  analysisComplete: z.boolean().describe("Is the analysis task complete regardless of the verdict?"),
  reasoning: z.string().describe("Brief explanation of the analysis completeness")
});
const SCORER_INSTRUCTIONS = `You evaluate whether a requirement ANALYSIS task is complete.

IMPORTANT: The agent's task is to ANALYZE requirement coverage in a codebase, NOT to implement features.
Finding that a requirement is MISSING is a VALID and COMPLETE analysis result!

A task is COMPLETE when:
1. The agent executed search queries to investigate the codebase
2. The agent generated a structured report with a clear verdict (COVERED, PARTIAL, or MISSING)
3. The verdict is justified with evidence or clear explanation of what's missing
4. Constraints were analyzed (verified or explicitly noted as not found)

A MISSING verdict with good justification = COMPLETE TASK
A COVERED verdict with evidence = COMPLETE TASK
A PARTIAL verdict with gaps identified = COMPLETE TASK

The task is INCOMPLETE only if:
- No search queries were executed
- No report was generated
- The report lacks a clear verdict
- The analysis is obviously unfinished`;
function analyzePromptFn(prep) {
  const completeness = prep.reportCompleteness;
  return `Evaluate if this requirement analysis task is COMPLETE (iteration ${prep.iteration}/${prep.maxIterations}):

REQUIREMENT BEING ANALYZED:
- ID: ${prep.requirement.id}
- Title: ${prep.requirement.title}

ANALYSIS ACTIVITY:
- Search queries executed: ${prep.searchQueriesCount}
- Report generated: ${prep.hasReport ? "YES" : "NO"}
- Report verdict: ${prep.reportVerdict?.verdict?.toUpperCase() ?? "NONE"}
- Verdict score: ${prep.reportVerdict?.score?.toFixed(2) ?? "N/A"}

REPORT SECTIONS PRESENT:
- Requirement Summary: ${completeness.hasRequirementSummary ? "\u2713" : "\u2717"}
- Search Strategy: ${completeness.hasSearchStrategy ? "\u2713" : "\u2717"}
- Code Matches: ${completeness.hasCodeMatches ? "\u2713" : "\u2717"}
- Constraint Verification: ${completeness.hasConstraintVerification ? "\u2713" : "\u2717"}
- Coverage Assessment: ${completeness.hasCoverageAssessment ? "\u2713" : "\u2717"}
- Clear Verdict: ${completeness.hasVerdict ? "\u2713" : "\u2717"}

FORCE COMPLETION CHECK:
- Should force complete: ${prep.shouldForceComplete ? "YES" : "NO"}
- Reason: ${prep.forceCompleteReason ?? "N/A"}

REMEMBER: A MISSING verdict is a valid analysis result! The task is complete if the agent properly investigated and concluded that the requirement is not implemented.

Score each dimension from 0 to 1:
- searchStrategyScore: Were search queries executed and appropriate?
- reportCompletenessScore: Does the report have the key sections?
- verdictClarityScore: Is the verdict clear and justified?
- constraintAnalysisScore: Were constraints analyzed?
- analysisComplete: true if the analysis task is done (regardless of verdict)
- reasoning: Brief explanation`;
}
function generateScoreFn(analysis, prep) {
  const hasExtractedVerdict = prep.reportVerdict !== null && prep.reportVerdict.verdict !== "";
  const completenessScore = [
    prep.reportCompleteness.hasRequirementSummary,
    prep.reportCompleteness.hasSearchStrategy,
    prep.reportCompleteness.hasCodeMatches,
    prep.reportCompleteness.hasConstraintVerification,
    prep.reportCompleteness.hasCoverageAssessment,
    prep.reportCompleteness.hasVerdict
  ].filter(Boolean).length;
  const hasValidReport = prep.hasReport && (hasExtractedVerdict || prep.reportCompleteness.hasVerdict || completenessScore >= 5);
  const hasMinimalReport = prep.hasReport && (hasExtractedVerdict || prep.reportCompleteness.hasVerdict || prep.reportCompleteness.hasCoverageAssessment || completenessScore >= 4);
  if (prep.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE) {
    if (hasValidReport) {
      tcAILogger.info("[TaskCompletionScorer] Max iterations reached WITH valid report - completing successfully", {
        iteration: prep.iteration,
        maxIterations: MAX_ITERATIONS_BEFORE_FORCE_COMPLETE,
        verdict: prep.reportVerdict?.verdict ?? "none",
        hasExtractedVerdict,
        completenessScore,
        hasValidReport
      });
    } else {
      tcAILogger.error("[TaskCompletionScorer] FORCED TERMINATION: Max iterations reached WITHOUT valid report", {
        iteration: prep.iteration,
        maxIterations: MAX_ITERATIONS_BEFORE_FORCE_COMPLETE,
        hasReport: prep.hasReport,
        hasExtractedVerdict,
        completenessScore,
        reportVerdictValue: prep.reportVerdict?.verdict ?? "null",
        hasCompletenessVerdict: prep.reportCompleteness.hasVerdict
      });
    }
    return 1;
  }
  if (prep.shouldForceComplete && hasValidReport) {
    tcAILogger.info("[TaskCompletionScorer] Force completing task with valid report", {
      reason: prep.forceCompleteReason,
      verdict: prep.reportVerdict?.verdict ?? "none",
      analysisComplete: analysis.analysisComplete
    });
    return 1;
  }
  if (analysis.analysisComplete && hasValidReport) {
    tcAILogger.info("[TaskCompletionScorer] LLM determined analysis is complete", {
      searchStrategyScore: analysis.searchStrategyScore.toFixed(3),
      reportCompletenessScore: analysis.reportCompletenessScore.toFixed(3),
      verdictClarityScore: analysis.verdictClarityScore.toFixed(3),
      reasoning: analysis.reasoning
    });
    return 1;
  }
  const weightedScore = analysis.searchStrategyScore * 0.25 + analysis.reportCompletenessScore * 0.35 + analysis.verdictClarityScore * 0.25 + analysis.constraintAnalysisScore * 0.15;
  const isComplete = weightedScore >= 0.7 && hasMinimalReport ? 1 : 0;
  tcAILogger.info("[TaskCompletionScorer] Generated score", {
    searchStrategyScore: analysis.searchStrategyScore.toFixed(3),
    reportCompletenessScore: analysis.reportCompletenessScore.toFixed(3),
    verdictClarityScore: analysis.verdictClarityScore.toFixed(3),
    constraintAnalysisScore: analysis.constraintAnalysisScore.toFixed(3),
    weightedScore: weightedScore.toFixed(3),
    analysisComplete: analysis.analysisComplete,
    hasReport: prep.hasReport,
    hasValidReport,
    hasMinimalReport,
    binaryScore: isComplete,
    iteration: prep.iteration
  });
  return isComplete;
}
const taskCompletionScorer = createScorer({
  id: "task-completion",
  description: "Determines if the requirement ANALYSIS task is complete (not implementation coverage)",
  judge: {
    model: ollama("qwen3.5:latest"),
    instructions: SCORER_INSTRUCTIONS
  }
}).preprocess(({ run }) => preprocessFn({ input: run.input, output: run.output })).analyze({
  description: "Analyze if the requirement analysis task is complete",
  outputSchema: analyzeOutputSchema,
  createPrompt: ({ results }) => analyzePromptFn(results.preprocessStepResult)
}).generateScore(({ results }) => generateScoreFn(
  results.analyzeStepResult,
  results.preprocessStepResult
)).generateReason({
  description: "Explain why the analysis task is complete or incomplete",
  createPrompt: ({ results, score }) => {
    const _analysis = results.analyzeStepResult;
    const prep = results.preprocessStepResult;
    const isComplete = score === 1;
    const hasExtractedVerdict = prep.reportVerdict !== null && prep.reportVerdict.verdict !== "";
    const completenessScore = [
      prep.reportCompleteness.hasRequirementSummary,
      prep.reportCompleteness.hasSearchStrategy,
      prep.reportCompleteness.hasCodeMatches,
      prep.reportCompleteness.hasConstraintVerification,
      prep.reportCompleteness.hasCoverageAssessment,
      prep.reportCompleteness.hasVerdict
    ].filter(Boolean).length;
    const hasValidReport = prep.hasReport && (hasExtractedVerdict || prep.reportCompleteness.hasVerdict || completenessScore >= 5);
    const isForcedTermination = prep.iteration >= MAX_ITERATIONS_BEFORE_FORCE_COMPLETE && !hasValidReport;
    if (isForcedTermination) {
      const missingElements = [];
      if (!prep.hasReport) {
        missingElements.push("No analysis report was generated");
      } else {
        if (!prep.reportCompleteness.hasVerdict) missingElements.push("Report missing verdict (COVERED/PARTIAL/MISSING)");
        if (!prep.reportCompleteness.hasRequirementSummary) missingElements.push("Report missing requirement summary section");
        if (!prep.reportCompleteness.hasCoverageAssessment) missingElements.push("Report missing coverage assessment");
        if (!prep.reportCompleteness.hasCodeMatches) missingElements.push("Report missing code matches section");
      }
      if (prep.searchQueriesCount === 0) {
        missingElements.push("No search queries were executed");
      }
      const likelyCause = prep.searchQueriesCount >= 3 && !prep.hasReport ? "Context overflow - agent likely ran out of context window before generating report" : prep.searchQueriesCount === 0 ? "Agent failed to start analysis - no searches executed" : prep.hasReport && !prep.reportCompleteness.hasVerdict ? "Report generated but missing required verdict declaration" : "Agent iteration loop exhausted without completing analysis";
      return `\u26A0\uFE0F FORCED TERMINATION - ANALYSIS INCOMPLETE

The analysis task was TERMINATED after reaching the maximum iteration limit (${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}) without producing a valid report.

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4CA} EXECUTION SUMMARY
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u2022 Iterations completed: ${prep.iteration}/${MAX_ITERATIONS_BEFORE_FORCE_COMPLETE}
\u2022 Search queries executed: ${prep.searchQueriesCount}
\u2022 Report generated: ${prep.hasReport ? "Yes (incomplete)" : "No"}
\u2022 Valid verdict found: No

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u274C FAILURE DIAGNOSTICS
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${missingElements.map((e) => `\u2022 ${e}`).join("\n")}

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F50D} LIKELY CAUSE
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${likelyCause}

Write exactly: "\u26A0\uFE0F ANALYSIS TERMINATED: Failed to produce valid report after ${prep.iteration} iterations. ${likelyCause}."`;
    }
    if (isComplete) {
      const verdict = prep.reportVerdict?.verdict?.toUpperCase() ?? "DETERMINED";
      const verdictEmoji = verdict === "COVERED" ? "\u2705" : verdict === "PARTIAL" ? "\u26A0\uFE0F" : verdict === "MISSING" ? "\u274C" : "\u{1F4CB}";
      const reason = prep.shouldForceComplete ? prep.forceCompleteReason : "Agent completed the analysis with a structured report";
      const sectionsPresent = [
        prep.reportCompleteness.hasRequirementSummary,
        prep.reportCompleteness.hasSearchStrategy,
        prep.reportCompleteness.hasCodeMatches,
        prep.reportCompleteness.hasConstraintVerification,
        prep.reportCompleteness.hasCoverageAssessment,
        prep.reportCompleteness.hasVerdict
      ].filter(Boolean).length;
      return `\u2705 ANALYSIS COMPLETE

The requirement analysis task finished successfully with a valid report.

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4CA} ANALYSIS RESULTS
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u2022 Verdict: ${verdictEmoji} ${verdict}
\u2022 Coverage Score: ${prep.reportVerdict?.score !== void 0 ? (prep.reportVerdict.score * 100).toFixed(0) + "%" : "N/A"}
\u2022 Iterations used: ${prep.iteration}
\u2022 Search queries: ${prep.searchQueriesCount}
\u2022 Report sections: ${sectionsPresent}/6

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4DD} COMPLETION REASON
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${reason}

Write exactly: "\u2705 Analysis complete. Verdict: ${verdict}${prep.reportVerdict?.score !== void 0 ? ` (${(prep.reportVerdict.score * 100).toFixed(0)}% coverage)` : ""}."`;
    } else {
      const likelyContextOverflow = prep.searchQueriesCount >= 3 && !prep.hasReport && prep.iteration >= 3;
      const contextManagementTip = likelyContextOverflow ? `

CONTEXT MANAGEMENT TIP: The agent made ${prep.searchQueriesCount} searches but did not generate a report. This may indicate context overflow from large tool outputs. On retry:
1. Use submission_search to identify relevant files first
2. Read specific symbols: submission_read(path="file.ts:symbolName") for targeted analysis
3. Generate the report EARLY before context fills up` : "";
      return `The analysis task is INCOMPLETE.

FACTS:
- Report generated: ${prep.hasReport ? "YES" : "NO"}
- Report verdict: ${prep.reportVerdict?.verdict?.toUpperCase() ?? "NONE"}
- Search queries: ${prep.searchQueriesCount}
- Iteration: ${prep.iteration}

Missing elements:
${!prep.hasReport ? "- NO REPORT GENERATED (critical failure)\n" : ""}${!prep.reportCompleteness.hasVerdict ? "- No clear verdict (COVERED/PARTIAL/MISSING)\n" : ""}${!prep.reportCompleteness.hasRequirementSummary ? "- No requirement summary section\n" : ""}${!prep.reportCompleteness.hasCoverageAssessment ? "- No coverage assessment\n" : ""}${prep.searchQueriesCount === 0 ? "- No search queries executed\n" : ""}${contextManagementTip}

Write a 1-2 sentence explanation of what the agent should do next.
${!prep.hasReport ? 'CRITICAL: The agent MUST generate a "# Requirement Analysis Report" with a verdict!' : ""}
Start your response with "The analysis task is incomplete."`;
    }
  }
});

"use strict";

"use strict";
const isTaskComplete = {
  scorers: [taskCompletionScorer],
  strategy: "all",
  timeout: 12e4,
  // 2 minutes for scorer evaluation
  suppressFeedback: false,
  // Include feedback for debugging
  onComplete: (results) => {
    tcAILogger.info("[isTaskComplete] Completion check finished", {
      complete: results.complete,
      completionReason: results.completionReason ?? "none",
      totalDuration: `${results.totalDuration}ms`,
      timedOut: results.timedOut,
      scorerCount: results.scorers.length
    });
    for (const scorer of results.scorers) {
      tcAILogger.info("[isTaskComplete] Scorer result", {
        scorerId: scorer.scorerId,
        scorerName: scorer.scorerName,
        score: scorer.score,
        passed: scorer.passed,
        duration: `${scorer.duration}ms`,
        reason: scorer.reason?.slice(0, 200) ?? "none"
      });
    }
    if (!results.complete) {
      tcAILogger.warn("[isTaskComplete] Task incomplete - agent will continue", {
        failedScorers: results.scorers.filter((s) => !s.passed).map((s) => s.scorerId)
      });
    } else {
      tcAILogger.info("[isTaskComplete] Task marked as COMPLETE");
    }
  }
};
const defaultOptions = {
  activeTools: ["submission_search", "submission_read"],
  maxSteps: MAX_STEPS,
  onIterationComplete,
  onFinish
  // isTaskComplete,
};

"use strict";
const REQUIREMENT_ANALYZER_WORKING_MEMORY_TEMPLATE = `# Current Requirement Analysis

## Active Requirement
- **Requirement ID**: [The ID of the requirement being analyzed]
- **Requirement Text**: [The exact text of the requirement to analyze]
- **Analysis Status**: [not_started | in_progress | completed]

## Search Progress
- **Queries Executed**: [List of search queries performed]
- **Total Matches Found**: [Number of relevant matches]
- **Files Examined**: [List of files containing matches]

## Key Findings
- **Primary Implementation**: [Main symbol/function that implements the requirement]
- **Supporting Code**: [Related symbols that support the implementation]
- **Missing Elements**: [What's missing or not found]

## Constraints Verification
- **Verified Constraints**: [List of constraints that have evidence]
- **Unverified Constraints**: [Constraints lacking evidence]
- **Constraint Evidence**: [Brief notes on evidence found]

## Analysis Notes
- **Current Step**: [What the agent is currently doing]
- **Next Action**: [What needs to be done next]
- **Blockers**: [Any issues preventing progress]

## Output Draft
- **Coverage Score**: [0.0-1.0]
- **Coverage Verdict**: [missing | partial | covered]
- **Confidence Level**: [low | medium | high]
`;
const requirementAnalyzerAgentMemory = new Memory({
  storage: new LibSQLStore({
    id: "requirement-analyzer-memory",
    url: "file:./requirement-analyzer-memory.db"
  })
  // Disabled persistent long-term memory to prevent context pollution
  // options: {
  //     workingMemory: {
  //         enabled: true,
  //         scope: 'thread',
  //         template: REQUIREMENT_ANALYZER_WORKING_MEMORY_TEMPLATE,
  //     },
  // },
});

"use strict";
const DEFAULT_CONFIG$5 = {
  // Set a high token limit for tool results to allow deep analysis, but prevent OOM.
  // Based on MAX_CONTEXT_SIZE env var minus a buffer for the prompt, system messages, and LLM response (default 8K).
  maxToolResultTokens: process.env.MAX_CONTEXT_SIZE ? parseInt(process.env.MAX_CONTEXT_SIZE, 10) - 8e3 : 43960
};
function createDedupState() {
  return { symbols: /* @__PURE__ */ new Map(), searchedDocs: /* @__PURE__ */ new Map(), readDocs: /* @__PURE__ */ new Map() };
}
function snapshotState(state) {
  return {
    symbols: new Map(state.symbols),
    searchedDocs: new Map(state.searchedDocs),
    readDocs: new Map(state.readDocs)
  };
}
class ToolResultManager {
  id = "tool-result-manager";
  config;
  state = createDedupState();
  snapshot = createDedupState();
  stats = { tokensSaved: 0, dedupCount: 0, droppedCount: 0, summaryCycles: 0 };
  currentStep = 0;
  currentQuery = "";
  currentToolCallId = "";
  // Token limiting
  toolInvocations = [];
  totalToolTokens = 0;
  // Summarization state
  phase = "normal";
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG$5, ...config };
  }
  // ==========================================================================
  // Input Step: Deduplication
  // ==========================================================================
  async processInputStep(args) {
    const { messageList, stepNumber, systemMessages } = args;
    this.currentStep = stepNumber;
    this.snapshot = snapshotState(this.state);
    this.processDeduplication(messageList);
    const store = astIndexerService.getStore();
    const codeFilePaths = store.getFilePaths();
    const allIndexedPaths = [.../* @__PURE__ */ new Set([...codeFilePaths, ...indexedDocumentPaths])];
    const cleanedPaths = allIndexedPaths.map((path) => path.replace(/^submission\//, ""));
    const filteredSystemMessages = systemMessages.filter((msg) => {
      if (!msg.content) return true;
      if (typeof msg.content === "string" && msg.content.includes("Local filesystem at")) return false;
      return true;
    });
    tcAILogger.info(`[${this.id}] Step ${stepNumber} | Phase: ${this.phase} | Tokens: ${this.totalToolTokens}/${this.config.maxToolResultTokens}`);
    return {
      messageList,
      systemMessages: [
        ...filteredSystemMessages,
        {
          role: "system",
          content: `The following files are available for requirement review. Read them using submission_read tool when needed:
${cleanedPaths.join("\n")}

`
        }
      ]
    };
  }
  // ==========================================================================
  // Deduplication
  // ==========================================================================
  processDeduplication(messageList) {
    for (const msg of messageList.get.all.db()) {
      if (!Array.isArray(msg.content?.parts)) continue;
      for (const part of msg.content.parts) {
        if (part.type !== "tool-invocation") continue;
        const { toolInvocation } = part;
        if (!toolInvocation?.result || toolInvocation.state !== "result") continue;
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
  trackToolInvocation(msg, inv, result) {
    const tokens = estimateTokenCount(JSON.stringify(result));
    const paths = this.getPathsFromResult(inv.toolName, result);
    this.toolInvocations.push({
      messageId: msg.id,
      toolCallId: inv.toolCallId,
      tokens,
      step: this.currentStep,
      paths
    });
    this.totalToolTokens += tokens;
  }
  getPathsFromResult(toolName, result) {
    const paths = [];
    const r = result;
    if (toolName === "submission_search") {
      for (const file of r.files || []) {
        for (const sym of file.symbols || []) {
          if (sym.symbolPath) paths.push(`sym:${sym.symbolPath}`);
        }
      }
      for (const doc of r.documents || []) {
        paths.push(`searchDoc:${doc.filePath}`);
      }
    } else if (toolName === "submission_read") {
      if (r.symbolPath) paths.push(`sym:${r.symbolPath}`);
      if (r.filePath && r.content !== void 0) paths.push(`readDoc:${r.filePath}`);
      if (r.symbols && r.filePath) {
        for (const sym of r.symbols) {
          const name = sym.symbolName || sym.symbol;
          if (name) paths.push(`sym:${r.filePath}:${name}`);
        }
      }
    }
    return paths;
  }
  applyTokenLimit(messageList) {
    if (this.totalToolTokens <= this.config.maxToolResultTokens) return;
    const sorted = [...this.toolInvocations].sort((a, b) => a.step - b.step);
    while (this.totalToolTokens > this.config.maxToolResultTokens && sorted.length > 0) {
      const oldest = sorted.shift();
      this.dropToolInvocation(messageList, oldest);
    }
  }
  dropToolInvocation(messageList, info) {
    for (const pathKey of info.paths) {
      if (pathKey.startsWith("sym:")) {
        this.state.symbols.delete(pathKey.slice(4));
      } else if (pathKey.startsWith("searchDoc:")) {
        this.state.searchedDocs.delete(pathKey.slice(10));
      } else if (pathKey.startsWith("readDoc:")) {
        this.state.readDocs.delete(pathKey.slice(8));
      }
    }
    const droppedResult = {
      _dropped: true,
      _reason: "Token limit exceeded",
      _tokens: info.tokens,
      _step: info.step
    };
    for (const msg of messageList.get.all.db()) {
      if (msg.id !== info.messageId) continue;
      if (!Array.isArray(msg.content?.parts)) continue;
      for (const part of msg.content.parts) {
        if (part.type !== "tool-invocation") continue;
        const { toolInvocation } = part;
        if (toolInvocation?.toolCallId !== info.toolCallId) continue;
        messageList.updateToolInvocation({
          type: "tool-invocation",
          toolInvocation: { ...toolInvocation, result: droppedResult }
        });
        break;
      }
    }
    this.totalToolTokens -= info.tokens;
    this.toolInvocations = this.toolInvocations.filter((i) => i.toolCallId !== info.toolCallId);
    this.stats.droppedCount++;
    tcAILogger.info(`[${this.id}] Dropped tool ${info.toolCallId.slice(0, 8)} (${info.tokens} tokens, step ${info.step})`);
  }
  // ==========================================================================
  // Deduplication Logic
  // ==========================================================================
  isDeduped(result) {
    return typeof result === "object" && result !== null && ("_deduped" in result || "_dropped" in result || "_compressed" in result);
  }
  processToolResult(inv) {
    const { toolName, result, args } = inv;
    if (toolName === "submission_search") {
      this.currentQuery = args?.query || "";
      return this.dedupeSearch(result);
    }
    if (toolName === "submission_read") {
      const path = args?.path || "";
      return this.dedupeRead(result, path);
    }
    return void 0;
  }
  dedupeSearch(result) {
    const { files = [], documents = [] } = result;
    const dedupedSymbolRefs = [];
    const dedupedDocRefs = [];
    const sourceRef = {
      tool: "search",
      query: this.currentQuery,
      step: this.currentStep,
      toolCallId: this.currentToolCallId
    };
    const filteredFiles = files.map((file) => {
      const newSymbols = file.symbols.filter((sym) => {
        const path = sym.symbolPath;
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
    const filteredDocs = documents.filter((doc) => {
      const { filePath } = doc;
      const existingSearch = this.snapshot.searchedDocs.get(filePath);
      const existingRead = this.snapshot.readDocs.get(filePath);
      if (existingSearch || existingRead) {
        dedupedDocRefs.push({ path: filePath, seenIn: existingRead || existingSearch });
        return false;
      }
      this.state.searchedDocs.set(filePath, sourceRef);
      return true;
    });
    return {
      files: filteredFiles,
      documents: filteredDocs,
      _deduped: true,
      ...dedupedSymbolRefs.length > 0 && {
        _skippedSymbols: dedupedSymbolRefs.map((r) => ({
          symbolPath: r.path,
          _seeAlso: this.formatSourceRef(r.seenIn)
        }))
      },
      ...dedupedDocRefs.length > 0 && {
        _skippedDocuments: dedupedDocRefs.map((r) => ({
          filePath: r.path,
          _seeAlso: this.formatSourceRef(r.seenIn)
        }))
      }
    };
  }
  dedupeRead(result, requestPath) {
    if ("error" in result) return void 0;
    const sourceRef = {
      tool: "read",
      path: requestPath,
      step: this.currentStep,
      toolCallId: this.currentToolCallId
    };
    if (result.symbolPath) {
      return this.dedupeSymbol(result.symbolPath, result, sourceRef);
    }
    if (result.symbols && result.filePath) {
      return this.dedupeFileSymbols(result, sourceRef);
    }
    if (result.content !== void 0 && result.filePath) {
      return this.dedupeDocument(result, sourceRef);
    }
    return void 0;
  }
  dedupeSymbol(path, result, sourceRef) {
    const existing = this.snapshot.symbols.get(path);
    if (existing) {
      return { symbolPath: path, _deduped: true, _seeAlso: this.formatSourceRef(existing) };
    }
    this.state.symbols.set(path, sourceRef);
    return { ...result, _deduped: true };
  }
  dedupeFileSymbols(result, sourceRef) {
    const { filePath, language, symbols = [] } = result;
    const newSymbols = [];
    const skippedSymbols = [];
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
        filePath,
        language,
        _deduped: true,
        _note: `All ${symbols.length} symbols already seen`,
        _skippedSymbols: skippedSymbols
      };
    }
    return {
      filePath,
      language,
      symbols: newSymbols,
      _deduped: true,
      ...skippedSymbols.length > 0 && { _skippedSymbols: skippedSymbols }
    };
  }
  dedupeDocument(result, sourceRef) {
    const { filePath, type, size, totalLines } = result;
    const existing = this.snapshot.readDocs.get(filePath);
    if (existing) {
      return { filePath, type, size, totalLines, _deduped: true, _seeAlso: this.formatSourceRef(existing) };
    }
    this.state.readDocs.set(filePath, sourceRef);
    return { ...result, _deduped: true };
  }
  // ==========================================================================
  // Helpers
  // ==========================================================================
  formatSourceRef(ref) {
    if (ref.tool === "search") {
      return `submission_search(query="${ref.query}") in step ${ref.step}`;
    }
    return `submission_read("${ref.path}") in step ${ref.step}`;
  }
  trackTokenSavings(original, managed) {
    const saved = estimateTokenCount(JSON.stringify(original)) - estimateTokenCount(JSON.stringify(managed));
    if (saved > 0) {
      this.stats.tokensSaved += saved;
      this.stats.dedupCount++;
    }
  }
  updateInvocation(messageList, inv, result) {
    messageList.updateToolInvocation({
      type: "tool-invocation",
      toolInvocation: { ...inv, result }
    });
  }
}

"use strict";
const DEFAULT_CONFIG$4 = {
  maxEmptyResponseRetries: 2
};
class OutputQualityProcessor {
  id = "output-quality-processor";
  config;
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG$4, ...config };
  }
  processOutputStep(args) {
    const text = args.text?.trim() ?? "";
    const hasToolCalls = Array.isArray(args.toolCalls) && args.toolCalls.length > 0;
    const retryLimitReached = args.retryCount >= this.config.maxEmptyResponseRetries;
    if (text.length === 0 && !hasToolCalls) {
      const reason = "The previous response was empty (no text or tool calls). Regenerate the step with a complete response.";
      tcAILogger.warn(`[${this.id}] Empty AI response detected at step ${args.stepNumber}`, {
        retryCount: args.retryCount,
        finishReason: args.finishReason,
        toolCalls: args.toolCalls?.length ?? 0,
        usage: args.usage
      });
      args.abort(reason, { retry: !retryLimitReached });
    }
    return args.messageList;
  }
}

"use strict";

"use strict";
class RunStateStore {
  states = /* @__PURE__ */ new Map();
  lastAccess = /* @__PURE__ */ new Map();
  maxEntries;
  factory;
  constructor(factory, maxEntries = 200) {
    this.factory = factory;
    this.maxEntries = maxEntries;
  }
  /** Get (creating if absent) the state for a given threadId. */
  get(threadId) {
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
  clear(threadId) {
    this.states.delete(threadId);
    this.lastAccess.delete(threadId);
  }
  evictIfNeeded() {
    if (this.states.size <= this.maxEntries) return;
    let oldestKey = null;
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
function getRunKey(args) {
  const ctx = args.requestContext;
  if (!ctx) return "default";
  if (typeof ctx.get === "function") {
    const rc = ctx;
    return rc.get("mastra__threadId") || rc.get("mastra__resourceId") || "default";
  }
  const plain = ctx;
  return plain.threadId || plain.resourceId || "default";
}

"use strict";
const DOMAIN_SYNONYMS = buildSynonymLookup();
const DEFAULT_CONFIG$3 = {
  minSearchAttempts: 3,
  minReadAttempts: 1,
  maxRetries: 2
};
function createFalseNegativeRunState() {
  return {
    searchAttempts: [],
    readAttempts: [],
    currentStep: 0,
    inventorySize: 0,
    requirementText: null
  };
}
function extractConcepts(requirementText) {
  const lower = requirementText.toLowerCase();
  const found = /* @__PURE__ */ new Set();
  for (const concept of Object.keys(DOMAIN_SYNONYMS)) {
    if (lower.includes(concept)) {
      found.add(concept);
    }
  }
  return [...found];
}
function findMissingSynonymSearches(concepts, executedQueries) {
  const executedLower = executedQueries.map((q) => q.toLowerCase());
  const missing = /* @__PURE__ */ new Set();
  for (const concept of concepts) {
    const synonyms = DOMAIN_SYNONYMS[concept] || [];
    const anyTried = synonyms.some(
      (syn) => executedLower.some((q) => q.includes(syn.toLowerCase()))
    );
    if (!anyTried) {
      synonyms.slice(0, 3).forEach((s) => missing.add(s));
    }
  }
  return [...missing];
}
const FILE_REF_RE = /([a-zA-Z0-9_\-./[\]]+\.(?:ts|tsx|js|jsx|py|md|prisma|json|sql|yaml|yml|toml))/g;
function extractFileReferences(requirementText) {
  const refs = /* @__PURE__ */ new Set();
  for (const m of requirementText.matchAll(FILE_REF_RE)) {
    refs.add(m[1].replace(/^\.?\//, ""));
  }
  return [...refs];
}
function normalizeForCompare(p) {
  return p.trim().replace(/^submission\//, "").replace(/^\.\//, "");
}
function declaresMissingVerdict(text) {
  return /\*\*?Verdict:?\*\*?\s*MISSING/i.test(text) || /Coverage Verdict[:\s]*MISSING/i.test(text) || /requirement\s+is\s+(NOT\s+(IMPLEMENTED|FOUND|COVERED))/i.test(text);
}
function declaresNonCoveredVerdict(text) {
  return /\*\*?Verdict:?\*\*?\s*(MISSING|PARTIAL)/i.test(text) || declaresMissingVerdict(text);
}
function looksLikeFinalReport$3(text) {
  return /#\s*Requirement.*Analysis Report/i.test(text) || /##\s*4\.\s*Coverage Assessment/i.test(text) || /\*\*?Verdict:?\*\*?/i.test(text);
}
class FalseNegativeGuardrail {
  id = "false-negative-guardrail";
  config;
  runStates = new RunStateStore(createFalseNegativeRunState);
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG$3, ...config };
  }
  // --------------------------------------------------------------------
  // Input step: passive tracking of tool invocations + inventory size
  // --------------------------------------------------------------------
  async processInputStep(args) {
    const { messageList, stepNumber, systemMessages } = args;
    const state = this.runStates.get(getRunKey(args));
    state.currentStep = stepNumber;
    if (!state.requirementText) {
      for (const msg of messageList.get.all.db()) {
        if (msg.role !== "user") continue;
        const parts = msg.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (part.type === "text" && typeof part.text === "string" && part.text.length > 20) {
            state.requirementText = part.text;
            break;
          }
        }
        if (state.requirementText) break;
      }
    }
    for (const msg of systemMessages) {
      if (typeof msg.content !== "string") continue;
      const m = msg.content.match(/The following files are available for requirement review[^:]*:\n([\s\S]*)/i);
      if (m) {
        const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
        state.inventorySize = lines.length;
      }
    }
    for (const msg of messageList.get.all.db()) {
      if (!Array.isArray(msg.content?.parts)) continue;
      for (const part of msg.content.parts) {
        if (part.type !== "tool-invocation") continue;
        const { toolInvocation } = part;
        if (!toolInvocation?.result || toolInvocation.state !== "result") continue;
        const result = toolInvocation.result;
        if (result._dropped || result._compressed) continue;
        if (toolInvocation.toolName === "submission_search") {
          const query = toolInvocation.args?.query || "";
          const alreadyTracked = state.searchAttempts.some(
            (a) => a.query === query
          );
          if (!alreadyTracked && query) {
            const files = result.files || [];
            const documents = result.documents || [];
            const skippedSymbols = result._skippedSymbols || [];
            const skippedDocs = result._skippedDocuments || [];
            const resultCount = files.length + documents.length + skippedSymbols.length + skippedDocs.length;
            state.searchAttempts.push({ query, step: state.currentStep, resultCount });
          }
        }
        if (toolInvocation.toolName === "submission_search_terms") {
          const queries = toolInvocation.args?.queries || [];
          const perQuery = result.perQuery || [];
          for (const q of queries) {
            const alreadyTracked = state.searchAttempts.some((a) => a.query === q);
            if (!alreadyTracked && q) {
              const pq = perQuery.find((p) => p.query === q);
              const resultCount = (pq?.fileCount ?? 0) + (pq?.symbolCount ?? 0) + (pq?.documentCount ?? 0);
              state.searchAttempts.push({ query: q, step: state.currentStep, resultCount });
            }
          }
        }
        if (toolInvocation.toolName === "submission_read") {
          const path = toolInvocation.args?.path || "";
          const alreadyTracked = state.readAttempts.some(
            (a) => a.path === path
          );
          if (!alreadyTracked && path) {
            const hadError = typeof result.error === "string";
            const truncated = result.truncated === true;
            const filePath = result.filePath || path;
            state.readAttempts.push({ path, step: state.currentStep, hadError, truncated, filePath });
          }
        }
      }
    }
    const distinctQueries = [...new Set(state.searchAttempts.map((s) => s.query))];
    if (distinctQueries.length >= 2 && state.readAttempts.length === 0) {
      const concepts = state.requirementText ? extractConcepts(state.requirementText) : [];
      const missingSynonyms = findMissingSynonymSearches(concepts, distinctQueries);
      if (missingSynonyms.length > 0) {
        const guidance = `[Search Guidance] You have run ${distinctQueries.length} search(es) but haven't yet tried these domain-specific code patterns for this requirement: ${missingSynonyms.slice(0, 5).map((s) => `"${s}"`).join(", ")}. Try submission_search_terms([${missingSynonyms.slice(0, 4).map((s) => `"${s}"`).join(", ")}]) before concluding not implemented. Also, use submission_read on any promising file paths before finalizing your verdict.`;
        return {
          systemMessages: [
            ...systemMessages,
            { role: "system", content: guidance }
          ]
        };
      }
    }
    if (state.requirementText) {
      const referencedFiles = extractFileReferences(state.requirementText);
      const truncatedReferenced = referencedFiles.filter((ref) => {
        const normalizedRef = normalizeForCompare(ref);
        return state.readAttempts.some(
          (r) => r.truncated && !r.hadError && (normalizeForCompare(r.filePath || r.path) === normalizedRef || normalizeForCompare(r.filePath || r.path).endsWith(normalizedRef))
        );
      });
      if (truncatedReferenced.length > 0) {
        const warning = `[Truncation Warning] The following file(s) referenced in the requirement were read but TRUNCATED: ${truncatedReferenced.map((f) => `"${f}"`).join(", ")}. The relevant content may be in the unread portion. Use submission_read("file.ext:specificSymbol") to read specific sections, or use submission_search_terms to locate the specific content before concluding MISSING or PARTIAL.`;
        return {
          systemMessages: [
            ...systemMessages,
            { role: "system", content: warning }
          ]
        };
      }
    }
    return void 0;
  }
  // --------------------------------------------------------------------
  // Output step: validate MISSING verdicts against search/read effort
  // --------------------------------------------------------------------
  processOutputStep(args) {
    const text = args.text?.trim() ?? "";
    if (!looksLikeFinalReport$3(text)) {
      return args.messageList;
    }
    const state = this.runStates.get(getRunKey(args));
    const retryLimitReached = args.retryCount >= this.config.maxRetries;
    if (declaresNonCoveredVerdict(text) && !retryLimitReached) {
      const referencedFiles = state.requirementText ? extractFileReferences(state.requirementText) : [];
      const unreadReferencedFiles = [];
      const truncatedReferencedFiles = [];
      for (const ref of referencedFiles) {
        const normalizedRef = normalizeForCompare(ref);
        const matchingReads = state.readAttempts.filter((r) => {
          const candidate = normalizeForCompare(r.filePath || r.path);
          return candidate === normalizedRef || candidate.endsWith(normalizedRef) || normalizedRef.endsWith(candidate);
        });
        if (matchingReads.length === 0) {
          unreadReferencedFiles.push(ref);
        } else if (matchingReads.some((r) => r.truncated && !r.hadError)) {
          truncatedReferencedFiles.push(ref);
        }
      }
      if (unreadReferencedFiles.length > 0 || truncatedReferencedFiles.length > 0) {
        const lines = [
          "The requirement text explicitly references the following file(s), which the instructions require you to read FULLY before concluding this requirement is not covered:"
        ];
        if (unreadReferencedFiles.length > 0) {
          lines.push(
            `- NOT YET READ: ${unreadReferencedFiles.map((f) => `"${f}"`).join(", ")}. Use submission_read on each of these before finalizing your verdict.`
          );
        }
        if (truncatedReferencedFiles.length > 0) {
          lines.push(
            `- READ BUT TRUNCATED: ${truncatedReferencedFiles.map((f) => `"${f}"`).join(", ")}. Your previous submission_read of this file was truncated and may not contain the section relevant to this requirement. Try reading specific SYMBOLS within this file ("file.ext:symbolName") to get untruncated content for the relevant section, or use submission_search_terms with terms from the requirement to locate the specific section.`
          );
        }
        lines.push(
          "After reading the full content of these files, re-evaluate whether the requirement is actually COVERED or PARTIAL before reporting MISSING/PARTIAL."
        );
        tcAILogger.warn(`[${this.id}] Non-COVERED verdict but requirement-referenced file(s) unread/truncated - requesting retry`, {
          unreadReferencedFiles,
          truncatedReferencedFiles,
          retryCount: args.retryCount
        });
        args.abort(lines.join("\n"), { retry: true });
        return args.messageList;
      }
    }
    if (!declaresMissingVerdict(text)) {
      return args.messageList;
    }
    const distinctQueries = [...new Set(state.searchAttempts.map((s) => s.query))];
    const successfulReads = state.readAttempts.filter((r) => !r.hadError);
    const allSearchesEmpty = state.searchAttempts.length > 0 && state.searchAttempts.every((s) => s.resultCount === 0);
    if (state.inventorySize <= 1 && allSearchesEmpty && distinctQueries.length >= this.config.minSearchAttempts) {
      tcAILogger.info(`[${this.id}] Empty/junk submission detected - accepting MISSING verdict without further retries`, {
        inventorySize: state.inventorySize,
        distinctQueries: distinctQueries.length
      });
      return args.messageList;
    }
    const searchDeficit = Math.max(0, this.config.minSearchAttempts - distinctQueries.length);
    const readDeficit = Math.max(0, this.config.minReadAttempts - successfulReads.length);
    const concepts = state.requirementText ? extractConcepts(state.requirementText) : [];
    const missingSynonyms = findMissingSynonymSearches(concepts, distinctQueries);
    const hasDeficiency = searchDeficit > 0 || readDeficit > 0 || missingSynonyms.length > 0;
    if (!hasDeficiency) {
      tcAILogger.info(`[${this.id}] MISSING verdict validated - sufficient search/read effort`, {
        distinctQueries: distinctQueries.length,
        successfulReads: successfulReads.length,
        concepts
      });
      return args.messageList;
    }
    if (retryLimitReached) {
      tcAILogger.warn(`[${this.id}] MISSING verdict has search deficiencies but retry limit reached - accepting`, {
        searchDeficit,
        readDeficit,
        missingSynonyms,
        retryCount: args.retryCount
      });
      return args.messageList;
    }
    const feedbackLines = [
      'Your conclusion is "MISSING / not implemented", but your search effort so far is insufficient to be confident the requirement is truly absent. Before finalizing MISSING, do ALL of the following:'
    ];
    if (searchDeficit > 0) {
      const MAX_LISTED = 8;
      const shownQueries = distinctQueries.slice(-MAX_LISTED);
      const omitted = distinctQueries.length - shownQueries.length;
      feedbackLines.push(
        `- Run at least ${searchDeficit} more DIFFERENT submission_search queries (you have run ${distinctQueries.length}/${this.config.minSearchAttempts} distinct queries so far` + (omitted > 0 ? `, most recent ${shownQueries.length}` : "") + `: ${shownQueries.map((q) => `"${q}"`).join(", ") || "none"}).`
      );
    }
    if (readDeficit > 0) {
      feedbackLines.push(
        `- Use submission_read on at least ${this.config.minReadAttempts} concrete file(s)/symbol(s) that plausibly relate to this requirement before concluding it is missing (successful reads so far: ${successfulReads.length}).`
      );
    }
    if (missingSynonyms.length > 0) {
      feedbackLines.push(
        `- Search for these domain-specific code patterns you haven't tried yet: ` + missingSynonyms.slice(0, 6).map((s) => `"${s}"`).join(", ") + "."
      );
    }
    feedbackLines.push(
      'After these additional searches/reads, if you STILL find no evidence, you may report MISSING \u2014 but include the additional queries/reads in your "What was searched" notes.'
    );
    const reason = feedbackLines.join("\n");
    tcAILogger.warn(`[${this.id}] MISSING verdict rejected - insufficient search effort, requesting retry`, {
      searchDeficit,
      readDeficit,
      missingSynonyms,
      retryCount: args.retryCount
    });
    args.abort(reason, { retry: true });
    return args.messageList;
  }
  /**
   * Expose a summary of tool-call history for a given run, useful for
   * debugging / for the Output Quality Guardrail to reuse.
   */
  getToolCallHistory(threadId) {
    const state = this.runStates.get(threadId);
    const fromSearches = state.searchAttempts.map((s) => ({
      tool: "submission_search",
      query: s.query,
      step: s.step,
      resultCount: s.resultCount
    }));
    const fromReads = state.readAttempts.map((r) => ({
      tool: "submission_read",
      path: r.path,
      step: r.step
    }));
    return [...fromSearches, ...fromReads].sort((a, b) => a.step - b.step);
  }
  /** Clear accumulated state for a finished run (call when a thread completes). */
  clearRun(threadId) {
    this.runStates.clear(threadId);
  }
}

"use strict";
const NO_OP_AST_INDEXER = async () => ({});
let _astIndexerService = null;
async function getAstIndexer() {
  if (_astIndexerService !== null) return _astIndexerService;
  try {
    const mod = await Promise.resolve().then(function () { return review; });
    _astIndexerService = mod.astIndexerService ?? {};
  } catch {
    _astIndexerService = {};
  }
  return _astIndexerService;
}
const HALLUCINATION_PATTERNS = [
  /\blikely\s+implement/i,
  /\bprobably\s+implement/i,
  /\bappears\s+to\s+implement/i,
  /\bseems\s+to\s+implement/i,
  /\bshould\s+implement/i,
  /\bmay\s+implement/i,
  /\bimplicit(?:ly)?\s+(?:implement|cover|handle)/i,
  /\bassume[sd]?\s+(?:to\s+be\s+)?implement/i,
  /\binferred?\s+(?:from|to\s+be)/i,
  /\bstandard\s+(?:pattern|practice)\s+(?:would|should)/i
];
const QUANTITATIVE_CLAIM_RE = /\b(?:at least|minimum|≥|>=|exactly|creates?\s+\d+|\d+\s+(?:record|row|entr|item|compan|user|contact))/i;
const DOCUMENT_BY_DESCRIPTION_RE = new RegExp("\\bthe\\s+(\\w+(?:\\s+\\w+){0,2})\\s+(?:document|docs|doc|file|readme)\\s+(?:explicitly\\s+)?(?:states?|says?|confirms?|mentions?|notes?)\\b", "gi");
const DEFAULT_CONFIG$2 = {
  minEvidenceLength: 10,
  maxRetries: 2,
  validateAstSymbols: true
};
function normalizePath(p) {
  return p.trim().replace(/^submission\//, "").replace(/^\.\//, "").replace(/\/+$/, "");
}
function fileOnly(p) {
  const idx = p.lastIndexOf(":");
  if (idx === -1) return p;
  const rest = p.slice(idx + 1);
  if (/^[A-Za-z0-9_$]+(\:\d+-\d+)?$/.test(rest) || /^\d+-\d+$/.test(rest)) {
    return p.slice(0, idx);
  }
  return p;
}
function symbolOnly(p) {
  const idx = p.lastIndexOf(":");
  if (idx === -1) return null;
  const rest = p.slice(idx + 1);
  if (/^[A-Za-z0-9_$]+$/.test(rest)) return rest;
  return null;
}
const FILE_PATH_RE = /([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs|prisma|sql|json|yaml|yml|md|toml|sh|env|cfg|ini|txt))(?::[A-Za-z0-9_$]+)?/g;
function extractClaimedPaths(text) {
  const claimed = /* @__PURE__ */ new Set();
  const fileLineRe = /\*\*File:?\*\*\s*`?([^\n`]+)`?/gi;
  for (const m of text.matchAll(fileLineRe)) {
    const candidate = m[1].trim();
    if (candidate && candidate.toLowerCase() !== "n/a" && candidate.toLowerCase() !== "none") {
      claimed.add(normalizePath(fileOnly(candidate)));
    }
  }
  const inlineCodeRe = /`([^`]+)`/g;
  for (const m of text.matchAll(inlineCodeRe)) {
    const content = m[1].trim();
    const fileMatches = content.matchAll(FILE_PATH_RE);
    for (const fm of fileMatches) {
      claimed.add(normalizePath(fileOnly(fm[1])));
    }
  }
  const bareMatches = text.matchAll(FILE_PATH_RE);
  for (const m of bareMatches) {
    claimed.add(normalizePath(fileOnly(m[1])));
  }
  return [...claimed].filter((p) => p.length > 0 && p !== "n/a");
}
function extractClaimedSymbols(text) {
  const results = [];
  const inlineCodeRe = /`([^`]+)`/g;
  for (const m of text.matchAll(inlineCodeRe)) {
    const content = m[1].trim();
    const symRe = /([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs)):([A-Za-z0-9_$]+)/g;
    for (const sm of content.matchAll(symRe)) {
      results.push({ filePath: normalizePath(sm[1]), symbolName: sm[2] });
    }
  }
  const bareSymRe = /\b([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|java|go|rb|rs)):([A-Za-z0-9_$]+)\b/g;
  for (const m of text.matchAll(bareSymRe)) {
    results.push({ filePath: normalizePath(m[1]), symbolName: m[2] });
  }
  return results;
}
function extractVerdict$1(text) {
  const m = text.match(/\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING)/i);
  if (!m) return null;
  return m[1].toUpperCase();
}
function looksLikeFinalReport$2(text) {
  return /#\s*Requirement.*Analysis Report/i.test(text) || /##\s*4\.\s*Coverage Assessment/i.test(text) || /\*\*?Verdict:?\*\*?/i.test(text);
}
function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    blocks.push(m[1]);
  }
  return blocks;
}
function detectHallucinationPhrases(text) {
  const found = [];
  for (const pattern of HALLUCINATION_PATTERNS) {
    const m = text.match(pattern);
    if (m) found.push(m[0]);
  }
  return found;
}
function findUnverifiedDocumentCitations(text, readPaths) {
  const unverified = [];
  const readPathsLower = readPaths.map((p) => p.toLowerCase());
  for (const m of text.matchAll(DOCUMENT_BY_DESCRIPTION_RE)) {
    const nounPhrase = m[1].toLowerCase();
    if (["this", "that", "the", "above", "same", "said"].includes(nounPhrase)) continue;
    const words = nounPhrase.split(/\s+/).filter((w) => w.length > 2);
    const backedByRead = words.some(
      (word) => readPathsLower.some((p) => p.includes(word))
    );
    if (!backedByRead) {
      unverified.push(m[0]);
    }
  }
  return unverified;
}
function createFalsePositiveRunState() {
  return { verifiedPaths: /* @__PURE__ */ new Set(), readContents: [] };
}
class FalsePositiveGuardrail {
  id = "false-positive-guardrail";
  config;
  runStates = new RunStateStore(createFalsePositiveRunState);
  /** Optional override for the AST indexer lookup, used by unit tests to avoid the real workspace-loading import. */
  astIndexerOverride;
  constructor(config = {}, astIndexerOverride) {
    this.config = { ...DEFAULT_CONFIG$2, ...config };
    this.astIndexerOverride = astIndexerOverride;
  }
  getAstIndexer() {
    return this.astIndexerOverride ? this.astIndexerOverride() : getAstIndexer();
  }
  // --------------------------------------------------------------------
  // Input step: track verified (actually-read) paths
  // --------------------------------------------------------------------
  async processInputStep(args) {
    const { messageList } = args;
    const state = this.runStates.get(getRunKey(args));
    for (const msg of messageList.get.all.db()) {
      if (!Array.isArray(msg.content?.parts)) continue;
      for (const part of msg.content.parts) {
        if (part.type !== "tool-invocation") continue;
        const { toolInvocation } = part;
        if (toolInvocation?.toolName !== "submission_read") continue;
        if (!toolInvocation.result || toolInvocation.state !== "result") continue;
        const result = toolInvocation.result;
        if (typeof result.error === "string") continue;
        const truncated = result.truncated === true;
        if (typeof result.symbolPath === "string") {
          const filePath = normalizePath(fileOnly(result.symbolPath));
          state.verifiedPaths.add(filePath);
          state.verifiedPaths.add(normalizePath(result.symbolPath));
          const symbol = result.symbol;
          const body = symbol?.bodyText;
          if (typeof body === "string" && body.length > 0 && !result._deduped) {
            state.readContents.push({ path: filePath, content: body, truncated });
          }
        }
        if (typeof result.filePath === "string" && Array.isArray(result.symbols)) {
          const filePath = normalizePath(result.filePath);
          state.verifiedPaths.add(filePath);
          for (const sym of result.symbols) {
            const name = sym.symbolName || sym.symbol;
            if (name) state.verifiedPaths.add(`${filePath}:${name}`);
            const body = sym.bodyText;
            if (typeof body === "string" && body.length > 0) {
              state.readContents.push({ path: filePath, content: body, truncated });
            }
          }
        }
        if (typeof result.filePath === "string" && typeof result.content === "string") {
          const filePath = normalizePath(result.filePath);
          state.verifiedPaths.add(filePath);
          if (!result._deduped) {
            state.readContents.push({ path: filePath, content: result.content, truncated });
          }
        }
      }
    }
    return void 0;
  }
  // --------------------------------------------------------------------
  // Output step: validate claimed evidence against verifiedPaths
  // --------------------------------------------------------------------
  processOutputStep(args) {
    const text = args.text?.trim() ?? "";
    if (!looksLikeFinalReport$2(text)) {
      return args.messageList;
    }
    const verdict = extractVerdict$1(text);
    if (verdict !== "COVERED" && verdict !== "PARTIAL") {
      return args.messageList;
    }
    return this._processOutputStepAsync(args, text, verdict);
  }
  async _processOutputStepAsync(args, text, verdict) {
    const state = this.runStates.get(getRunKey(args));
    const retryLimitReached = args.retryCount >= this.config.maxRetries;
    const feedbackLines = [];
    const claimedPaths = extractClaimedPaths(text);
    const unverified = [];
    for (const claimed of claimedPaths) {
      if (state.verifiedPaths.has(claimed)) continue;
      const fuzzyMatch = [...state.verifiedPaths].some(
        (verified) => verified.endsWith(claimed) || claimed.endsWith(verified) || verified.includes(claimed) || claimed.includes(verified)
      );
      if (fuzzyMatch) continue;
      unverified.push(claimed);
    }
    if (unverified.length > 0) {
      const MAX_LISTED = 8;
      const shown = unverified.slice(0, MAX_LISTED);
      const remainder = unverified.length - shown.length;
      feedbackLines.push(
        `Your report has a verdict of ${verdict} but cites file(s)/symbol(s) you never actually read with submission_read. Search snippets alone are NOT sufficient evidence.
The following path(s) referenced in your evidence were never read via submission_read: ` + shown.map((p) => `"${p}"`).join(", ") + (remainder > 0 ? `, and ${remainder} more` : "") + ".\nFor each of these, either: (a) call submission_read on the exact path and incorporate the real content into your evidence, or (b) remove the claim and adjust the verdict/score accordingly."
      );
    }
    if (verdict === "COVERED" && state.readContents.length === 0) {
      feedbackLines.push(
        "You declared the requirement COVERED but have not performed any successful submission_read calls. A COVERED verdict requires reading actual implementation code as evidence."
      );
    }
    const codeBlocks = extractCodeBlocks(text).filter((b) => b.trim().length >= this.config.minEvidenceLength);
    const untraceableBlocks = codeBlocks.filter((block) => {
      const normalizedBlock = block.replace(/\s+/g, " ").trim();
      if (normalizedBlock.length === 0) return false;
      const sample = normalizedBlock.slice(0, Math.min(40, normalizedBlock.length));
      return !state.readContents.some((rc) => rc.content.replace(/\s+/g, " ").includes(sample));
    });
    if (untraceableBlocks.length > 0 && state.readContents.length > 0) {
      feedbackLines.push(
        `${untraceableBlocks.length} code snippet(s) in your report cannot be traced to any content returned by submission_read. These snippets appear to be fabricated or copied from search snippets (which are not sufficient evidence). Either (a) perform submission_read on the relevant file(s) so you have the actual code, or (b) remove the unverifiable snippet(s) and adjust your verdict/score.`
      );
    }
    const allReadsTruncated = state.readContents.length > 0 && state.readContents.every((r) => r.truncated);
    if (allReadsTruncated && QUANTITATIVE_CLAIM_RE.test(text)) {
      feedbackLines.push(
        'Your report makes quantitative claims (counts, thresholds, "at least N") but ALL of your submission_read results were truncated \u2014 you cannot reliably count records or verify thresholds from incomplete file content. Either read specific symbols/sections to get the full content, or remove the quantitative claims and base your verdict on what you actually verified.'
      );
    }
    const hallucinationPhrases = detectHallucinationPhrases(text);
    if (hallucinationPhrases.length > 0 && state.readContents.length === 0) {
      feedbackLines.push(
        `Your report uses speculative language ("${hallucinationPhrases[0]}" and similar) to justify a ${verdict} verdict, but contains no code evidence from submission_read. Speculative claims without read evidence are not acceptable. Read the relevant files and provide actual code snippets, or downgrade the verdict to MISSING.`
      );
    }
    const unverifiedDocCitations = findUnverifiedDocumentCitations(text, [...state.verifiedPaths]);
    if (unverifiedDocCitations.length > 0 && feedbackLines.length === 0) {
      const MAX_SHOWN = 3;
      const shown = unverifiedDocCitations.slice(0, MAX_SHOWN);
      const remainder = unverifiedDocCitations.length - shown.length;
      feedbackLines.push(
        `Your report attributes evidence to a document by description rather than by reading it: ` + shown.map((s) => `"${s}"`).join(", ") + (remainder > 0 ? ` (and ${remainder} more)` : "") + `. This evidence cannot be verified because the document was never read via submission_read. Either: (a) call submission_read on the actual file (e.g. docs/architecture.md, README.md) and quote the relevant content directly, or (b) remove the constraint-verification claim and adjust the verdict/score to reflect only what you can actually cite from code you read.`
      );
    }
    if (this.config.validateAstSymbols && unverified.length === 0 && feedbackLines.length === 0) {
      const claimedSymbols = extractClaimedSymbols(text);
      if (claimedSymbols.length > 0) {
        try {
          const indexer = await this.getAstIndexer();
          const store = indexer?.getStore?.();
          if (store?.getSymbolsForFile) {
            const notInAst = [];
            for (const { filePath, symbolName } of claimedSymbols) {
              try {
                const symbols = store.getSymbolsForFile(filePath) ?? [];
                const found = symbols.some((s) => (s.name ?? s.symbolName) === symbolName);
                if (!found) notInAst.push(`${filePath}:${symbolName}`);
              } catch {
              }
            }
            if (notInAst.length > 0) {
              feedbackLines.push(
                `Your report cites the following symbol(s) that do not exist in the AST index for the file(s) you read: ${notInAst.map((s) => `"${s}"`).join(", ")}. This usually means the symbol name is wrong, was renamed, or doesn't exist in the actual file. Use verify_constraint to confirm the correct symbol name before citing it, or remove the reference and adjust your evidence/verdict accordingly.`
              );
              tcAILogger.warn(`[false-positive-guardrail] AST symbol validation failed - requesting retry`, {
                notInAst,
                verdict
              });
            }
          }
        } catch {
        }
      }
    }
    if (feedbackLines.length === 0) {
      tcAILogger.info(`[false-positive-guardrail] Evidence validated`, {
        verdict,
        claimedPaths: claimedPaths.length,
        verifiedPaths: state.verifiedPaths.size
      });
      return args.messageList;
    }
    if (retryLimitReached) {
      tcAILogger.warn(`[false-positive-guardrail] Evidence issues found but retry limit reached - accepting`, {
        verdict,
        issues: feedbackLines.length,
        retryCount: args.retryCount
      });
      return args.messageList;
    }
    const reason = feedbackLines.join("\n\n");
    tcAILogger.warn(`[false-positive-guardrail] Unverified/speculative evidence in ${verdict} report - requesting retry`, {
      unverified,
      untraceableBlocks: untraceableBlocks.length,
      hallucinationPhrases,
      retryCount: args.retryCount
    });
    args.abort(reason, { retry: true });
    return args.messageList;
  }
  /** Snapshot of currently verified paths for a run (for tests / debugging). */
  getVerifiedPaths(threadId) {
    return new Set(this.runStates.get(threadId).verifiedPaths);
  }
  /** Clear accumulated state for a finished run. */
  clearRun(threadId) {
    this.runStates.clear(threadId);
  }
}

"use strict";
const DEFAULT_REQUIRED_SECTIONS = [
  "1. Requirement Summary",
  "2. Implementation Evidence",
  "3. Constraint Verification",
  "4. Coverage Assessment",
  "5. Quality Observations"
];
const DEFAULT_CONFIG$1 = {
  requiredSections: DEFAULT_REQUIRED_SECTIONS,
  minConstraintRows: 0,
  // dynamically derived from the requirement when possible
  maxRetries: 2
};
const reportFieldsSchema = z.object({
  requirementId: z.string().min(1),
  title: z.string().min(1),
  verdict: z.enum(["COVERED", "PARTIAL", "MISSING"]),
  coverageScore: z.number().min(0).max(1),
  constraintRows: z.array(z.object({
    constraint: z.string(),
    status: z.enum(["verified", "partial", "not-found"]),
    evidence: z.string()
  })),
  justification: z.string().min(10)
});
function looksLikeFinalReport$1(text) {
  return /#\s*Requirement.*Analysis Report/i.test(text) || /##\s*4\.\s*Coverage Assessment/i.test(text) || /\*\*?Verdict:?\*\*?/i.test(text);
}
function extractSectionsPresent(text, requiredSections) {
  const present = [];
  const missing = [];
  for (const section of requiredSections) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`##\\s*${escaped}`, "i");
    const descPart = section.replace(/^\d+\.\s*/, "");
    const escapedDesc = descPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reDesc = new RegExp(`##\\s*(?:\\d+\\.\\s*)?${escapedDesc}`, "i");
    if (re.test(text) || reDesc.test(text)) {
      present.push(section);
    } else {
      missing.push(section);
    }
  }
  return { present, missing };
}
function sectionHasContent(text, sectionHeaderFragment) {
  const escaped = sectionHeaderFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`##\\s*(?:\\d+\\.\\s*)?${escaped}([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const m = text.match(re);
  if (!m) return false;
  const body = m[1].trim();
  if (body.length < 5) return false;
  const placeholderOnly = /^\[[^\]]*\]$/.test(body) || /^[\s\-*\[\]A-Za-z]*\[.*\]\s*$/.test(body.split("\n")[0] || "");
  return !placeholderOnly || body.length > 60;
}
function extractVerdict(text) {
  const m = text.match(/\*\*?Verdict:?\*\*?\s*(COVERED|PARTIAL|MISSING)/i);
  if (!m) return null;
  return m[1].toUpperCase();
}
function extractCoverageScore(text) {
  const m = text.match(/\*\*?Overall Coverage Score:?\*\*?\s*([0-9](?:\.[0-9]+)?)/i) || text.match(/Coverage Score:?\s*([0-9](?:\.[0-9]+)?)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (Number.isNaN(val)) return null;
  return val;
}
function extractConstraintRows(text) {
  const sectionMatch = text.match(/##\s*(?:\d+\.\s*)?Constraint Verification([\s\S]*?)(?=\n##\s|$)/i);
  if (!sectionMatch) return [];
  const rows = [];
  const lines = sectionMatch[1].split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length < 3) continue;
    const [constraint, statusRaw, evidence] = cells;
    if (/^-+$/.test(constraint) || /constraint/i.test(constraint) && /status/i.test(statusRaw)) continue;
    if (!constraint || constraint.toLowerCase() === "constraint") continue;
    let status = "not-found";
    if (/✅|verified/i.test(statusRaw)) status = "verified";
    else if (/⚠️|partial/i.test(statusRaw)) status = "partial";
    else if (/❌|not found/i.test(statusRaw)) status = "not-found";
    rows.push({ constraint, status, evidence: evidence || "" });
  }
  return rows;
}
function extractJustification(text) {
  const m = text.match(/\*\*?Justification:?\*\*?\s*\n?([\s\S]*?)(?=\n###|\n##|$)/i);
  return m ? m[1].trim() : "";
}
function extractRequirementId(text) {
  const m = text.match(/^\*\*ID:\*\*\s*([^\n*]+?)\s*$/im);
  return m ? m[1].trim().replace(/[`[\]"]/g, "") : "";
}
function extractTitle(text) {
  const m = text.match(/^\*\*Title:\*\*\s*([^\n*]+?)\s*$/im);
  return m ? m[1].trim() : "";
}
function extractConstraintCountFromRequirement(messageList) {
  for (const msg of messageList.get.all.db()) {
    if (msg.role !== "user") continue;
    let text = "";
    const parts = msg.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
    } else if (typeof msg.content === "string") {
      text = msg.content;
    }
    if (!text) continue;
    const sectionMatch = text.match(/###\s*Constraints to Verify([\s\S]*?)(?=\n###|\n##|$)/i);
    if (sectionMatch) {
      const lines = sectionMatch[1].split("\n");
      const constraintLines = lines.filter((l) => /^\s*\d+\.\s*\[/.test(l));
      if (constraintLines.length > 0) return constraintLines.length;
    }
    const allConstraintIds = text.match(/\[CON_\w+\]/g) || [];
    if (allConstraintIds.length > 0) return allConstraintIds.length;
  }
  return 0;
}
class OutputQualityGuardrail {
  id = "output-quality-guardrail";
  config;
  /**
   * Number of constraints declared in the requirement, keyed by threadId.
   *
   * This guardrail is instantiated ONCE at module load and shared across
   * every requirement thread for the lifetime of the server process (see
   * run-state.ts for why per-thread isolation matters). Storing this as a
   * plain instance field would mean the FIRST requirement's constraint
   * count silently "sticks" for every subsequent requirement with a
   * different number of constraints - this directly undermines the
   * "Constraint Verification" row-count check and violates the
   * "one requirement per agent thread" isolation guarantee.
   *
   * Optional `defaultExpectedConstraintCount` constructor arg is used as a
   * fallback when dynamic extraction from the requirement message fails
   * (e.g. ad-hoc studio chat sessions without a structured requirement JSON).
   */
  expectedConstraintCounts = new RunStateStore(() => ({ count: null }));
  defaultExpectedConstraintCount;
  constructor(config = {}, defaultExpectedConstraintCount = null) {
    this.config = { ...DEFAULT_CONFIG$1, ...config };
    this.defaultExpectedConstraintCount = defaultExpectedConstraintCount;
  }
  processOutputStep(args) {
    const text = args.text?.trim() ?? "";
    if (!looksLikeFinalReport$1(text)) {
      return args.messageList;
    }
    const retryLimitReached = args.retryCount >= this.config.maxRetries;
    const issues = [];
    const threadState = this.expectedConstraintCounts.get(getRunKey(args));
    if (threadState.count === null) {
      const dynamicConstraintCount = extractConstraintCountFromRequirement(
        args.messageList
      );
      threadState.count = dynamicConstraintCount > 0 ? dynamicConstraintCount : this.defaultExpectedConstraintCount;
    }
    const expectedConstraintCount = threadState.count;
    const { present, missing } = extractSectionsPresent(text, this.config.requiredSections);
    if (missing.length > 0) {
      issues.push(`Missing required section(s): ${missing.join(", ")}.`);
    }
    for (const section of present) {
      const desc = section.replace(/^\d+\.\s*/, "");
      if (!sectionHasContent(text, desc)) {
        issues.push(`Section "${section}" is present but appears empty or left as a placeholder (e.g. still contains "[...]"). Fill it with real content or "None"/"N/A" as appropriate.`);
      }
    }
    const verdict = extractVerdict(text);
    const score = extractCoverageScore(text);
    if (!verdict) {
      issues.push('No valid Verdict found. The report must include "**Verdict:** COVERED" / "PARTIAL" / "MISSING" in section 4.');
    }
    if (score === null) {
      issues.push('No valid "Overall Coverage Score" (0.0-1.0) found in section 4.');
    } else if (score < 0 || score > 1) {
      issues.push(`Coverage Score (${score}) is out of the valid 0.0-1.0 range.`);
    }
    if (verdict && score !== null) {
      const expectedRange = verdict === "COVERED" ? [0.7, 1] : verdict === "PARTIAL" ? [0.3, 0.7] : [0, 0.3];
      const [lo, hi] = expectedRange;
      const inRange = verdict === "PARTIAL" ? score >= lo && score <= hi : score >= lo && score <= hi;
      if (!inRange) {
        issues.push(
          `Verdict "${verdict}" is inconsistent with Coverage Score ${score}. Per the guidelines: COVERED >= 0.7, PARTIAL 0.3-0.7, MISSING < 0.3. Adjust either the verdict or the score so they agree.`
        );
      }
    }
    const justification = extractJustification(text);
    if (justification.length < 10 || /^\[.*\]$/.test(justification)) {
      issues.push('The "Justification" under Coverage Assessment is missing or is still a placeholder. Provide 1-2 sentences referencing specific evidence.');
    }
    const constraintRows = extractConstraintRows(text);
    const requiredRows = expectedConstraintCount ?? this.config.minConstraintRows;
    if (constraintRows.length === 0 && requiredRows > 0) {
      issues.push('Section "3. Constraint Verification" has no table rows. Add one row per constraint with Status and Evidence.');
    } else if (requiredRows > 0 && constraintRows.length < requiredRows) {
      issues.push(`Section "3. Constraint Verification" has ${constraintRows.length} row(s) but the requirement defines ${requiredRows} constraint(s). Add a row for each constraint.`);
    }
    if (!extractRequirementId(text)) {
      issues.push('Missing "**ID:**" in section 1 (Requirement Summary).');
    }
    if (!extractTitle(text)) {
      issues.push('Missing "**Title:**" in section 1 (Requirement Summary).');
    }
    if (issues.length === 0) {
      tcAILogger.info(`[${this.id}] Report passed quality validation`, {
        verdict,
        score,
        sectionsPresent: present.length,
        constraintRows: constraintRows.length
      });
      return args.messageList;
    }
    if (retryLimitReached) {
      tcAILogger.warn(`[${this.id}] Report has quality issues but retry limit reached - accepting as-is`, {
        issues,
        retryCount: args.retryCount
      });
      return args.messageList;
    }
    const reason = [
      "Your final report does not meet the required output quality standard. Fix the following issue(s) and regenerate the COMPLETE report (do not omit any section):",
      ...issues.map((i) => `- ${i}`)
    ].join("\n");
    tcAILogger.warn(`[${this.id}] Report failed quality validation - requesting retry`, {
      issues,
      retryCount: args.retryCount
    });
    args.abort(reason, { retry: true });
    return args.messageList;
  }
  /**
   * Parse a final report's structurally-extractable fields. Returns null if
   * the text doesn't look like a final report or fails schema validation.
   * Exposed for use by the scoring-distiller / result-consistency guardrail.
   */
  static parseReportFields(text) {
    if (!looksLikeFinalReport$1(text)) return null;
    const verdict = extractVerdict(text);
    const score = extractCoverageScore(text);
    const requirementId = extractRequirementId(text);
    const title = extractTitle(text);
    const constraintRows = extractConstraintRows(text);
    const justification = extractJustification(text);
    const candidate = {
      requirementId,
      title,
      verdict,
      coverageScore: score,
      constraintRows,
      justification
    };
    const parsed = reportFieldsSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
}

"use strict";
const DEFAULT_CONFIG = {
  scoreTolerance: 0.15,
  maxRetries: 1
  // consistency retries are expensive - keep tight
};
class InMemoryConsistencyStore {
  map = /* @__PURE__ */ new Map();
  async get(fingerprint) {
    return this.map.get(fingerprint);
  }
  async set(fingerprint, result) {
    this.map.set(fingerprint, result);
  }
  /** Clear all stored results. Used in tests for isolation between test cases. */
  clearAll() {
    this.map.clear();
  }
}
function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
function looksLikeFinalReport(text) {
  return /#\s*Requirement.*Analysis Report/i.test(text) || /##\s*4\.\s*Coverage Assessment/i.test(text) || /\*\*?Verdict:?\*\*?/i.test(text);
}
function buildConstraintStatusMap(fields) {
  const map = {};
  for (const row of fields.constraintRows) {
    const key = row.constraint.trim().toLowerCase().slice(0, 80);
    map[key] = row.status;
  }
  return map;
}
function diffConstraintStatuses(prev, next) {
  const changed = [];
  for (const [key, prevStatus] of Object.entries(prev)) {
    const nextStatus = next[key];
    if (nextStatus && nextStatus !== prevStatus) {
      changed.push(key);
    }
  }
  return changed;
}
function createConsistencyRunState() {
  return { requirementId: null, inventoryPaths: [], readHashes: /* @__PURE__ */ new Map() };
}
class ResultConsistencyGuardrail {
  id = "result-consistency-guardrail";
  config;
  store;
  runStates = new RunStateStore(createConsistencyRunState);
  constructor(config = {}, store = new InMemoryConsistencyStore()) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store;
  }
  // --------------------------------------------------------------------
  // Input step: track inventory + read content hashes, extract requirementId
  // --------------------------------------------------------------------
  async processInputStep(args) {
    const { messageList, systemMessages } = args;
    const state = this.runStates.get(getRunKey(args));
    if (!state.requirementId) {
      for (const msg of messageList.get.all.db()) {
        if (msg.role !== "user") continue;
        const parts = msg.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (part.type !== "text" || typeof part.text !== "string") continue;
          const m = part.text.match(/\*\*Requirement ID:\*\*\s*([^\n*]+)/i) || part.text.match(/"id"\s*:\s*"([^"]+)"/);
          if (m) {
            state.requirementId = m[1].trim();
            break;
          }
        }
        if (state.requirementId) break;
      }
    }
    if (state.inventoryPaths.length === 0) {
      for (const msg of systemMessages) {
        if (typeof msg.content !== "string") continue;
        const m = msg.content.match(/The following files are available for requirement review[^:]*:\n([\s\S]*)/i);
        if (m) {
          state.inventoryPaths = m[1].split("\n").map((l) => l.trim()).filter(Boolean).sort();
        }
      }
    }
    for (const msg of messageList.get.all.db()) {
      if (!Array.isArray(msg.content?.parts)) continue;
      for (const part of msg.content.parts) {
        if (part.type !== "tool-invocation") continue;
        const { toolInvocation } = part;
        if (toolInvocation?.toolName !== "submission_read") continue;
        if (!toolInvocation.result || toolInvocation.state !== "result") continue;
        const result = toolInvocation.result;
        if (typeof result.error === "string") continue;
        const path = result.filePath || result.symbolPath;
        if (!path) continue;
        const content = JSON.stringify(result);
        state.readHashes.set(path, hashContent(content));
      }
    }
    return void 0;
  }
  // --------------------------------------------------------------------
  // Output step: compare against stored result for this fingerprint
  // --------------------------------------------------------------------
  async processOutputStep(args) {
    const text = args.text?.trim() ?? "";
    if (!looksLikeFinalReport(text)) {
      return args.messageList;
    }
    const fields = OutputQualityGuardrail.parseReportFields(text);
    if (!fields) {
      return args.messageList;
    }
    const state = this.runStates.get(getRunKey(args));
    const requirementId = state.requirementId || fields.requirementId || "unknown";
    const fingerprint = this.computeFingerprint(requirementId, state);
    const prior = await this.store.get(fingerprint);
    const retryLimitReached = args.retryCount >= this.config.maxRetries;
    if (!prior) {
      await this.store.set(fingerprint, {
        verdict: fields.verdict,
        coverageScore: fields.coverageScore,
        constraintStatuses: buildConstraintStatusMap(fields),
        sampleCount: 1,
        updatedAt: Date.now()
      });
      tcAILogger.info(`[${this.id}] Stored baseline result for ${requirementId}`, {
        fingerprint,
        verdict: fields.verdict,
        coverageScore: fields.coverageScore
      });
      return args.messageList;
    }
    const scoreDiff = Math.abs(prior.coverageScore - fields.coverageScore);
    const verdictChanged = prior.verdict !== fields.verdict;
    const scoreOutOfTolerance = scoreDiff > this.config.scoreTolerance;
    if (!verdictChanged && !scoreOutOfTolerance) {
      const n = prior.sampleCount;
      const newScore = (prior.coverageScore * n + fields.coverageScore) / (n + 1);
      await this.store.set(fingerprint, {
        verdict: fields.verdict,
        coverageScore: newScore,
        constraintStatuses: buildConstraintStatusMap(fields),
        sampleCount: n + 1,
        updatedAt: Date.now()
      });
      tcAILogger.info(`[${this.id}] Result consistent with prior runs`, {
        requirementId,
        priorScore: prior.coverageScore,
        newScore: fields.coverageScore,
        scoreDiff,
        sampleCount: n + 1
      });
      return args.messageList;
    }
    if (retryLimitReached) {
      const n = prior.sampleCount;
      const newScore = (prior.coverageScore * n + fields.coverageScore) / (n + 1);
      await this.store.set(fingerprint, {
        verdict: fields.verdict,
        coverageScore: newScore,
        constraintStatuses: buildConstraintStatusMap(fields),
        sampleCount: n + 1,
        updatedAt: Date.now()
      });
      tcAILogger.warn(`[${this.id}] Inconsistent result vs prior run, retry limit reached - accepting`, {
        requirementId,
        priorVerdict: prior.verdict,
        newVerdict: fields.verdict,
        priorScore: prior.coverageScore,
        newScore: fields.coverageScore,
        scoreDiff
      });
      return args.messageList;
    }
    const changedConstraints = diffConstraintStatuses(prior.constraintStatuses, buildConstraintStatusMap(fields));
    const feedbackLines = [
      `A previous analysis of this SAME requirement against this codebase reached verdict "${prior.verdict}" with coverage score ${prior.coverageScore.toFixed(2)}, but this run produced "${fields.verdict}" with score ${fields.coverageScore.toFixed(2)} (difference: ${scoreDiff.toFixed(2)}, tolerance: ${this.config.scoreTolerance}).`,
      "Before finalizing, re-verify your conclusion:",
      "- Re-check the constraints below using submission_read on the relevant files - confirm whether they are actually verified, partial, or not found based on the CURRENT evidence (the prior run may have been wrong)."
    ];
    if (changedConstraints.length > 0) {
      const MAX_LISTED = 8;
      const shown = changedConstraints.slice(0, MAX_LISTED);
      const remainder = changedConstraints.length - shown.length;
      feedbackLines.push(
        `- Constraint(s) whose status changed between runs: ${shown.map((c) => `"${c}"`).join(", ")}` + (remainder > 0 ? `, and ${remainder} more` : "") + ". Double-check these specifically."
      );
    }
    feedbackLines.push(
      `If, after re-verification, you are confident in your NEW result, keep it and explain the discrepancy briefly in "What's Missing or Unclear". If the PRIOR result was more accurate, revise your verdict/score to match it.`
    );
    const reason = feedbackLines.join("\n");
    tcAILogger.warn(`[${this.id}] Inconsistent result vs prior run - requesting re-verification`, {
      requirementId,
      priorVerdict: prior.verdict,
      newVerdict: fields.verdict,
      priorScore: prior.coverageScore,
      newScore: fields.coverageScore,
      scoreDiff,
      changedConstraints
    });
    args.abort(reason, { retry: true });
    return args.messageList;
  }
  // --------------------------------------------------------------------
  // Fingerprint computation
  // --------------------------------------------------------------------
  /**
   * Fingerprint = hash(requirementId + sorted inventory paths + sorted
   * read-content hashes). Two runs with the same requirement against the
   * same codebase state will have the same inventory; if the agent reads
   * the same files, the read-hashes match too, yielding the same
   * fingerprint and enabling a direct comparison.
   *
   * If the agent reads a DIFFERENT set of files on the second run, the
   * fingerprint will differ and no comparison is made (treated as a fresh
   * baseline) - this is intentional: we only compare "apples to apples"
   * runs that examined the same evidence.
   */
  computeFingerprint(requirementId, state) {
    const sortedReadHashes = [...state.readHashes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${path}:${hash}`);
    const payload = JSON.stringify({
      requirementId,
      inventory: state.inventoryPaths,
      reads: sortedReadHashes
    });
    return hashContent(payload);
  }
  /** Clear accumulated per-run tracking state for a finished run (does NOT touch the persisted ConsistencyStore). */
  clearRun(threadId) {
    this.runStates.clear(threadId);
  }
}

"use strict";
const TABLE_NAME = "requirement_consistency_results";
class LibSQLConsistencyStore {
  store;
  initialized = false;
  client = null;
  constructor(store) {
    this.store = store;
  }
  /** Create the backing table if it doesn't exist. Call once at startup. */
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const rawStore = this.store;
      const client = rawStore.client || rawStore.db;
      if (!client) {
        tcAILogger.warn("[LibSQLConsistencyStore] No raw client found on LibSQLStore - consistency will be in-memory only");
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
  async get(fingerprint) {
    await this.init();
    if (!this.client) return void 0;
    try {
      const result = await this.client.execute({
        sql: `SELECT verdict, coverage_score, constraint_statuses, sample_count, updated_at FROM ${TABLE_NAME} WHERE fingerprint = ?`,
        args: [fingerprint]
      });
      const row = result.rows?.[0];
      if (!row) return void 0;
      return {
        verdict: row.verdict,
        coverageScore: row.coverage_score,
        constraintStatuses: JSON.parse(row.constraint_statuses),
        sampleCount: row.sample_count,
        updatedAt: row.updated_at
      };
    } catch (err) {
      tcAILogger.warn(`[LibSQLConsistencyStore] get() failed: \${err}`);
      return void 0;
    }
  }
  async set(fingerprint, result) {
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
          result.updatedAt
        ]
      });
    } catch (err) {
      tcAILogger.warn(`[LibSQLConsistencyStore] set() failed: ${err}`);
    }
  }
}

"use strict";

"use strict";
const IS_LOCAL_DEV$1 = process.env.LOCAL_DEV === "true";
const DEFAULT_MODEL$2 = "qwen3:4b-instruct";
const MODEL_ID$2 = process.env.LLM_MODEL_NAME || DEFAULT_MODEL$2;
const PROVIDER_NAME$2 = process.env.LLM_PROVIDER_NAME || "TC-Ollama";
const toolResultManager = new ToolResultManager();
const outputQualityProcessor = new OutputQualityProcessor();
const falseNegativeGuardrail = new FalseNegativeGuardrail({
  minSearchAttempts: 3,
  minReadAttempts: 1,
  maxRetries: 2
});
const falsePositiveGuardrail = new FalsePositiveGuardrail({
  minEvidenceLength: 10,
  maxRetries: 2
});
const outputQualityGuardrail = new OutputQualityGuardrail({
  maxRetries: 2
});
const consistencyStore = new LibSQLConsistencyStore(
  new LibSQLStore({
    id: "requirement-analyzer-consistency",
    url: process.env.CONSISTENCY_DB_URL || "file:./requirement-analyzer-consistency.db"
  })
);
consistencyStore.init().catch((err) => {
  console.warn("[agent] LibSQLConsistencyStore init() failed - consistency will be in-memory only:", err);
});
const resultConsistencyGuardrail = new ResultConsistencyGuardrail(
  { scoreTolerance: 0.15, maxRetries: 1 },
  consistencyStore
);
const requirementAnalyzerTools = {
  ...submissionToolsRaw,
  submission_search_terms: submissionSearchTermsTool,
  verify_constraint: verifyConstraintTool
};
const requirementAnalyzerAgent = new Agent({
  id: "requirement-analyzer-agent",
  name: "Requirement Analyzer",
  description: "Analyzes a SINGLE requirement against submission code. Call with a specific requirement description. Returns: detailed analysis report with code evidence, coverage score (0-1), and implementation verification. Use for each requirement separately.",
  instructions: AGENT_INSTRUCTIONS,
  model: createModel(PROVIDER_NAME$2, MODEL_ID$2),
  tools: requirementAnalyzerTools,
  memory: IS_LOCAL_DEV$1 ? requirementAnalyzerAgentMemory : void 0,
  scorers: IS_LOCAL_DEV$1 ? {} : void 0,
  defaultOptions: {
    ...defaultOptions,
    activeTools: ["submission_search", "submission_read", "submission_search_terms", "verify_constraint"]
  },
  // Input processors run before each LLM step (order matters: dedup/token
  // management first, then guardrails that read tool-call history).
  inputProcessors: [
    toolResultManager,
    falseNegativeGuardrail,
    falsePositiveGuardrail,
    resultConsistencyGuardrail
  ],
  // Output processors validate the model's response for THIS step.
  // Order: empty-response check first (cheapest), then structural
  // quality, then the evidence-based guardrails which require a
  // well-formed report to inspect.
  outputProcessors: [
    outputQualityProcessor,
    outputQualityGuardrail,
    falseNegativeGuardrail,
    falsePositiveGuardrail,
    resultConsistencyGuardrail
  ],
  maxProcessorRetries: 2,
  // Max retries for processors before failing the agent run
  errorProcessors: [
    new APIErrorProcessor({
      maxRetries: 2,
      retryablePatterns: [
        "timeout",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "socket hang up",
        "503",
        "502",
        "504",
        "rate limit",
        "overloaded",
        /context.*length.*exceeded/i,
        /model.*busy/i
      ]
    })
  ]
});

"use strict";
function buildRequirementAnalysisPrompt(context, requirement) {
  const constraintsSection = requirement.constraints.length > 0 ? requirement.constraints.map((c, i) => `  ${i + 1}. [${c.id}] ${c.text}`).join("\n") : "  None specified";
  return `**Requirement ID:** ${requirement.id}
**Title:** ${requirement.title}
**Priority:** ${requirement.priority.toUpperCase()}

### Description
${requirement.description}

### Constraints to Verify
${constraintsSection}`;
}
function buildAllRequirementPrompts(context) {
  return context.requirements.map((requirement) => ({
    requirement,
    prompt: buildRequirementAnalysisPrompt(context, requirement)
  }));
}

"use strict";

"use strict";
const readChallengeContextFromWorkspaceInputSchema = z$1.object({
  rootPath: z$1.string().default("submission").describe("Workspace-relative root path for the submission")
});
const readChallengeContextFromWorkspace = createStep({
  id: "read-workspace-challenge-context",
  description: "Reads challenge-context.json from the workspace root folder to load the pre-computed unified challenge context.",
  inputSchema: readChallengeContextFromWorkspaceInputSchema,
  outputSchema: unifiedContextSchema,
  execute: async () => {
    const challengeContextPath = path$1.resolve(process.env.WORKSPACE_PATH, "challenge-context.json");
    tcAILogger.info(`[ai-reviewer:read-context] Reading challenge-context.json from: ${challengeContextPath}`);
    try {
      const content = await readFile(challengeContextPath, "utf-8");
      const challengeContext = JSON.parse(content);
      tcAILogger.info(`[ai-reviewer:read-context] Challenge context loaded: "${challengeContext.title ?? "Untitled"}" (${content.length} chars)`);
      return { ...challengeContext };
    } catch (error) {
      tcAILogger.error(`[ai-reviewer:read-context] Failed to read ${challengeContextPath}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
});

"use strict";

"use strict";
const ConstraintResultSchema = z.object({
  id: z.string().describe('Constraint ID from the requirement (e.g., "C1", "C2")'),
  text: z.string().describe("Brief constraint description"),
  status: z.enum(["Verified", "Partial", "NotFound"]).describe("Verification status"),
  evidence: z.string().describe("File:line reference or code evidence proving status")
});
const ImplementationEvidenceSchema = z.object({
  file: z.string().describe("File path"),
  symbol: z.string().describe("Function/class/method name"),
  line: z.number().optional().describe("Line number"),
  relevance: z.string().describe("How this proves implementation")
});
const ScoringDistillerSchema = z.object({
  // Identification
  requirementId: z.string().describe("Requirement ID from report"),
  title: z.string().describe("Requirement title"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level"),
  // Summary & Verdict
  status: z.enum(["Implemented", "Partial", "Missing"]).describe("Implementation verdict"),
  coverageScore: z.number().min(0).max(1).describe("Coverage score (0.0-1.0)"),
  confidenceScore: z.number().int().min(1).max(5).describe("Confidence in this assessment (1-5)"),
  // Justification & Evidence
  justification: z.string().describe("Why this verdict was given - cite specific evidence"),
  keyEvidence: z.array(ImplementationEvidenceSchema).describe("Top implementation evidence proving the verdict"),
  // Constraints
  constraints: z.array(ConstraintResultSchema).describe("Per-constraint verification with evidence"),
  // Gaps & Feedback
  gapSummary: z.string().describe("What is missing or incomplete"),
  feedback: z.string().describe("Actionable feedback for the submitter"),
  // Quality & Risks
  evidenceDensity: z.enum(["High", "Med", "Low"]).describe("Quality of code evidence"),
  riskFlags: z.array(z.string()).describe("Potential concerns or issues"),
  qualityIndicators: z.object({
    complexity: z.enum(["Low", "Medium", "High"]).describe("Code complexity"),
    errorHandling: z.boolean().describe("Error handling present"),
    testCoverage: z.boolean().describe("Tests observed")
  }).describe("Code quality signals")
});
const SCHEMA_DESCRIPTION = formatSchemaForInstructions(ScoringDistillerSchema);
const SCORING_DISTILLER_AGENT_INSTRUCTIONS = `You are a Scoring Distiller agent that performs lossy compression on Requirement Analyzer reports.

## Your Task

Extract and distill Requirement Analyzer report into a comprehensive JSON object (<1K tokens) that preserves key evidence, justification, and actionable feedback for scoring and review.

## Input

You will receive a complete Requirement Analyzer report containing:

${REQUIREMENT_ANALYZER_OUTPUT}

---

## Output Requirements

**You MUST output ONLY valid JSON matching this exact schema - no markdown, no explanations, no code fences:**

${SCHEMA_DESCRIPTION}

---

## Extraction Rules

### Status Mapping
- COVERED verdict (score >= 7) \u2192 "Implemented"
- PARTIAL verdict (score 0.3-0.7) \u2192 "Partial"
- MISSING verdict (score < 0.3) \u2192 "Missing"

### Evidence Density Assessment
- **High**: Multiple code snippets shown, clear data flow, specific line references
- **Med**: Some code evidence but incomplete verification, partial snippets
- **Low**: Mostly search results without read verification, guessed implementations

### Confidence Score Guidelines
- **5**: All sections complete, clear evidence, no ambiguity
- **4**: Most sections clear, minor gaps in evidence
- **3**: Moderate evidence, some uncertainty in constraint verification
- **2**: Limited evidence, significant gaps in analysis
- **1**: Minimal evidence, analysis appears incomplete or rushed

### Gap Summary Rules
- Combine multiple gaps into 1-2 concise sentences (max 200 chars)

### Key Symbols Extraction
- Prioritize symbols from "Core Implementation" section
- Include primary matches with score >= 0.5
- List function/class names without file paths
- Maximum 5 symbols

### Constraints Extraction
- Extract from "Constraint Verification" table in the report
- Map each constraint row to an object with:
  - id: The constraint ID (e.g., "C1", "C2", or full ID like "REQ-01-C1")
  - status: Map \u2705 \u2192 "Verified", \u26A0\uFE0F \u2192 "Partial", \u274C \u2192 "NotFound"
  - evidence: Brief evidence text (max 100 chars) or omit if none

### Risk Flags Extraction
- Include broken imports, missing dependencies, complexity issues
- If "No concerns identified", use empty array []
- Maximum 3 flags

### Justification Extraction
- Cite specific files, functions, and evidence
- Explain WHY the verdict was given (max 300 chars)

### Key Evidence Extraction
- Include file path, symbol name, line number when available
- Brief relevance note explaining what this proves
- Maximum 4 evidence items

### Feedback Extraction
- Keep constructive and specific (max 200 chars)

## CRITICAL CONSTRAINTS

1. **Output ONLY the JSON object** - no surrounding text or formatting
2. **All fields are required** - never omit any field
3. **Strict type adherence** - enums must match exactly
4. **Token budget** - keep total output under 1K tokens
5. **Preserve accuracy** - extract from report, don't invent
6. **Evidence is key** - always include file:line references when available
`;

"use strict";
const DEFAULT_TIMEOUT_MS$1 = 3 * 60 * 1e3;
const ITERATION_TIMEOUT_MS = parseInt(process.env.REQUIREMENT_ANALYZER_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS$1;
const SCORING_TIMEOUT_MS = parseInt(process.env.SCORING_DISTILLER_TIMEOUT_MS || "", 10) || 6e4;
const MAX_RETRIES$1 = 1;
const SCORING_MAX_RETRIES = 1;
const MAX_CONCURRENT_ANALYSES = parseInt(process.env.REQUIREMENT_ANALYZER_BATCH_SIZE || "", 10) || 2;
const MAX_CONCURRENT_SCORING_DISTILLERS = parseInt(process.env.SCORING_DISTILLER_BATCH_SIZE || "", 10) || 2;
const requirementsAnalyzerWorkflowInputSchema = z$1.object({
  rootPath: z$1.string().default("submission").describe("Workspace-relative root path for the submission")
});
const tokenUsageSchema$1 = z$1.object({
  inputTokens: z$1.number().describe("Number of tokens in the prompt/input"),
  outputTokens: z$1.number().describe("Number of tokens in the completion/output"),
  totalTokens: z$1.number().describe("Total tokens used (inputTokens + outputTokens)"),
  cachedInputTokens: z$1.number().optional().describe("Number of input tokens read from cache"),
  cacheCreationInputTokens: z$1.number().optional().describe("Number of input tokens written to cache"),
  reasoningTokens: z$1.number().optional().describe("Number of tokens used for reasoning (chain-of-thought)")
});
const toolCallRecordSchema$1 = z$1.object({
  toolCallId: z$1.string().describe("Unique identifier for the tool call"),
  toolName: z$1.string().describe("Name of the tool that was called"),
  args: z$1.record(z$1.string(), z$1.unknown()).optional().describe("Arguments passed to the tool"),
  durationMs: z$1.number().optional().describe("Execution duration in milliseconds"),
  success: z$1.boolean().optional().describe("Whether the tool call succeeded"),
  error: z$1.string().optional().describe("Error message if the tool call failed")
});
const toolUsageSchema$1 = z$1.object({
  totalCalls: z$1.number().describe("Total number of tool calls made"),
  uniqueTools: z$1.array(z$1.string()).describe("List of unique tool names used"),
  callsByTool: z$1.record(z$1.string(), z$1.number()).describe("Number of calls per tool name"),
  totalDurationMs: z$1.number().optional().describe("Total time spent in tool executions"),
  successCount: z$1.number().describe("Number of successful tool calls"),
  errorCount: z$1.number().describe("Number of failed tool calls"),
  calls: z$1.array(toolCallRecordSchema$1).optional().describe("Detailed log of each tool call")
});
const requirementAnalysisResultSchema = unifiedContextSchema.shape.requirements.element.extend({
  requirementAnalyzer: z$1.string().describe("Result of the requirement analyzer agent run for this requirement"),
  scoring: ScoringDistillerSchema.optional().describe("Distilled scoring data from the scoring-distiller agent"),
  scoringError: z$1.string().optional().describe("Error message if scoring distillation failed"),
  tokenUsage: tokenUsageSchema$1.optional().describe("Combined token usage for requirement analysis + scoring"),
  toolUsage: toolUsageSchema$1.optional().describe("Tool usage statistics for this requirement analysis"),
  durationMs: z$1.number().optional().describe("Total duration of analysis + scoring in milliseconds"),
  retryCount: z$1.number().optional().describe("Number of retries needed for requirement analysis"),
  scoringRetryCount: z$1.number().optional().describe("Number of retries needed for scoring distillation"),
  error: z$1.string().optional().describe("Error message if analysis failed")
});
const requirementsAnalyzerOutputSchema = z$1.array(requirementAnalysisResultSchema);
async function executeWithTimeout$1(operation, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    tcAILogger.warn(`[ai-reviewer:requirements-analyzer] ${label} - Timeout after ${timeoutMs}ms`);
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}
function normalizeToolCall(raw) {
  const data = raw.payload ?? raw;
  const toolCallId = data.toolCallId ?? "";
  const toolName = data.toolName ?? data.name ?? "";
  const args = data.args;
  if (!toolName) {
    return null;
  }
  return { toolCallId, toolName, args };
}
function normalizeToolResult(raw) {
  const data = raw.payload ?? raw;
  const toolCallId = data.toolCallId ?? "";
  const toolName = data.toolName ?? data.name ?? "";
  const result = data.result;
  const isError = data.isError;
  return { toolCallId, toolName, result, isError };
}
function extractToolUsage(toolCalls, toolResults) {
  const rawCalls = toolCalls ?? [];
  const rawResults = toolResults ?? [];
  const calls = rawCalls.map(normalizeToolCall).filter((c) => c !== null);
  const results = rawResults.map(normalizeToolResult).filter((r) => r !== null);
  const resultMap = new Map(results.map((r) => [r.toolCallId, r]));
  const callsByTool = {};
  for (const call of calls) {
    callsByTool[call.toolName] = (callsByTool[call.toolName] ?? 0) + 1;
  }
  const callRecords = calls.map((call) => {
    const result = resultMap.get(call.toolCallId);
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      success: result ? !result.isError : void 0,
      error: result?.isError ? String(result.result) : void 0
    };
  });
  const successCount = results.filter((r) => !r.isError).length;
  const errorCount = results.filter((r) => r.isError).length;
  return {
    totalCalls: calls.length,
    uniqueTools: [...new Set(calls.map((c) => c.toolName))],
    callsByTool,
    successCount,
    errorCount,
    calls: callRecords.length > 0 ? callRecords : void 0
  };
}
async function runScoringDistiller(agent, requirementAnalyzerOutput, requirementId, logPrefix) {
  let retryCount = 0;
  let lastError = null;
  const startTime = Date.now();
  while (retryCount <= SCORING_MAX_RETRIES) {
    const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${SCORING_MAX_RETRIES})` : "";
    tcAILogger.info(`${logPrefix} [scoring] Starting distillation${attemptLabel}`);
    try {
      const rawResult = await executeWithTimeout$1(
        async (_signal) => {
          return agent.generate(requirementAnalyzerOutput);
        },
        SCORING_TIMEOUT_MS,
        `${logPrefix} [scoring] Agent execution`
      );
      const result = rawResult;
      const durationMs2 = Date.now() - startTime;
      const tokenUsage = {
        inputTokens: result.totalUsage?.inputTokens ?? 0,
        outputTokens: result.totalUsage?.outputTokens ?? 0,
        totalTokens: result.totalUsage?.totalTokens ?? 0
      };
      if (result.error) {
        tcAILogger.error(`${logPrefix} [scoring] Agent error: ${result.error.message}`);
        throw new Error(result.error.message);
      }
      if (result.object) {
        tcAILogger.info(`${logPrefix} [scoring] Distillation complete in ${durationMs2}ms`);
        tcAILogger.info(`${logPrefix} [scoring] Tokens: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}`);
        tcAILogger.debug(`${logPrefix} [scoring] Status: ${result.object.status}, Coverage: ${result.object.coverageScore}`);
        return { scoring: result.object, tokenUsage, retryCount, durationMs: durationMs2 };
      }
      if (result.text) {
        try {
          const parsed = JSON.parse(result.text);
          const validated = ScoringDistillerSchema.parse(parsed);
          tcAILogger.info(`${logPrefix} [scoring] Parsed from text output in ${durationMs2}ms`);
          return { scoring: validated, tokenUsage, retryCount, durationMs: durationMs2 };
        } catch (parseError) {
          tcAILogger.warn(`${logPrefix} [scoring] Failed to parse text output: ${parseError}`);
          throw new Error("Failed to parse scoring output as JSON", { cause: parseError });
        }
      }
      throw new Error("No structured output or text returned from scoring agent");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError" || lastError.message.includes("abort");
      tcAILogger.error(`${logPrefix} [scoring] Failed: ${lastError.message}`);
      if (retryCount < SCORING_MAX_RETRIES) {
        retryCount++;
        const retryReason = isTimeout ? "timeout" : "error";
        tcAILogger.info(`${logPrefix} [scoring] Retrying due to ${retryReason}`);
        continue;
      }
      const durationMs2 = Date.now() - startTime;
      tcAILogger.error(`${logPrefix} [scoring] All retries exhausted`);
      return { error: lastError.message, retryCount, durationMs: durationMs2 };
    }
  }
  const durationMs = Date.now() - startTime;
  return { error: lastError?.message || "Unknown error", retryCount, durationMs };
}
function combineTokenUsage$1(a, b) {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0) || void 0,
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0) || void 0,
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0) || void 0
  };
}
async function analyzeRequirementOnly(requirementAgent, challengeId, requirement, prompt, index, total) {
  const logPrefix = `[ai-reviewer:requirements-analyzer] [${index + 1}/${total}] [${requirement.id}]`;
  let retryCount = 0;
  let lastError = null;
  while (retryCount <= MAX_RETRIES$1) {
    const startTime = Date.now();
    const threadId = `${challengeId}-req-${requirement.id}-${process.env.SUBMISSION_ID || "SUB_ID_UNKNOWN"}-${Date.now()}`;
    resetToolCache(threadId);
    const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES$1})` : "";
    tcAILogger.info(`${logPrefix} Starting analysis${attemptLabel} (thread: ${threadId})`);
    tcAILogger.debug(`${logPrefix} Priority: ${requirement.priority}, Constraints: ${requirement.constraints.length}`);
    try {
      const rawResult = await executeWithTimeout$1(
        async (_signal) => {
          return requirementAgent.generate(prompt, {
            memory: {
              thread: threadId,
              resource: `${challengeId}-req-${requirement.id}`
            }
          });
        },
        ITERATION_TIMEOUT_MS,
        `${logPrefix} Requirement analyzer execution`
      );
      const analysisResult = rawResult;
      const analyzerDurationMs = Date.now() - startTime;
      const tokenUsage = {
        inputTokens: analysisResult.totalUsage?.inputTokens ?? 0,
        outputTokens: analysisResult.totalUsage?.outputTokens ?? 0,
        totalTokens: analysisResult.totalUsage?.totalTokens ?? 0,
        cachedInputTokens: analysisResult.totalUsage?.cachedInputTokens,
        cacheCreationInputTokens: analysisResult.totalUsage?.cacheCreationInputTokens,
        reasoningTokens: analysisResult.totalUsage?.reasoningTokens
      };
      const toolUsage = extractToolUsage(analysisResult.toolCalls, analysisResult.toolResults);
      tcAILogger.info(`${logPrefix} === REQUIREMENT ANALYSIS COMPLETE ===`);
      tcAILogger.info(`${logPrefix} Duration: ${analyzerDurationMs}ms`);
      tcAILogger.info(`${logPrefix} Token Usage: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}, total=${tokenUsage.totalTokens}`);
      tcAILogger.info(`${logPrefix} Tool Usage: calls=${toolUsage.totalCalls}, success=${toolUsage.successCount}, errors=${toolUsage.errorCount}`);
      tcAILogger.info(`${logPrefix} Tools Used: ${toolUsage.uniqueTools.join(", ") || "none"}`);
      if (Object.keys(toolUsage.callsByTool).length > 0) {
        tcAILogger.info(`${logPrefix} Calls by Tool: ${JSON.stringify(toolUsage.callsByTool)}`);
      }
      tcAILogger.info(`${logPrefix} Finish Reason: ${analysisResult.finishReason}`);
      tcAILogger.info(`${logPrefix} Output Length: ${analysisResult.text?.length || 0} chars`);
      tcAILogger.info(`${logPrefix} Run ID: ${analysisResult.runId}`);
      if (analysisResult.error) {
        tcAILogger.error(`${logPrefix} Agent Error: ${analysisResult.error.message}`);
      }
      if (analysisResult.tripwire) {
        tcAILogger.warn(`${logPrefix} Tripwire: ${JSON.stringify(analysisResult.tripwire)}`);
      }
      if (analysisResult.warnings?.length) {
        tcAILogger.warn(`${logPrefix} Warnings: ${JSON.stringify(analysisResult.warnings)}`);
      }
      return {
        requirement,
        analyzerOutput: analysisResult.text,
        tokenUsage,
        toolUsage,
        durationMs: analyzerDurationMs,
        retryCount,
        index
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError" || lastError.message.includes("abort");
      tcAILogger.error(`${logPrefix} Failed after ${durationMs}ms: ${lastError.message}`);
      if (retryCount < MAX_RETRIES$1) {
        retryCount++;
        const retryReason = isTimeout ? "timeout" : "error";
        tcAILogger.info(`${logPrefix} Retrying due to ${retryReason} (attempt ${retryCount + 1}/${MAX_RETRIES$1 + 1})`);
        continue;
      }
      tcAILogger.error(`${logPrefix} All retries exhausted. Returning error result.`);
      return {
        requirement,
        analyzerOutput: `Analysis failed after ${MAX_RETRIES$1 + 1} attempts: ${lastError.message}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
        durationMs,
        retryCount,
        error: lastError.message,
        index
      };
    }
  }
  return {
    requirement,
    analyzerOutput: `Unexpected state: ${lastError?.message || "Unknown error"}`,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
    durationMs: 0,
    retryCount,
    error: lastError?.message,
    index
  };
}
async function processScoringQueue(scoringAgent, tasks) {
  const results = /* @__PURE__ */ new Map();
  if (tasks.length === 0) {
    return results;
  }
  const limit = pLimit(MAX_CONCURRENT_SCORING_DISTILLERS);
  let completedCount = 0;
  tcAILogger.info(`[ai-reviewer:scoring-pipeline] === STARTING STREAMING SCORING PIPELINE ===`);
  tcAILogger.info(`[ai-reviewer:scoring-pipeline] Total scoring tasks: ${tasks.length}`);
  tcAILogger.info(`[ai-reviewer:scoring-pipeline] Concurrency limit: ${MAX_CONCURRENT_SCORING_DISTILLERS}`);
  const scoringPromises = tasks.map(
    (task) => limit(async () => {
      const { analysisResult, total } = task;
      const logPrefix = `[ai-reviewer:requirements-analyzer] [${analysisResult.index + 1}/${total}] [${analysisResult.requirement.id}]`;
      if (analysisResult.error) {
        tcAILogger.info(`${logPrefix} [scoring] Skipping - analysis failed`);
        completedCount++;
        tcAILogger.info(`[ai-reviewer:scoring-pipeline] Progress: ${completedCount}/${tasks.length} completed`);
        return {
          requirementId: analysisResult.requirement.id,
          result: { error: "Skipped due to analysis failure", retryCount: 0, durationMs: 0 }
        };
      }
      const scoringResult = await runScoringDistiller(
        scoringAgent,
        analysisResult.analyzerOutput,
        analysisResult.requirement.id,
        logPrefix
      );
      completedCount++;
      tcAILogger.info(`[ai-reviewer:scoring-pipeline] Progress: ${completedCount}/${tasks.length} completed`);
      return {
        requirementId: analysisResult.requirement.id,
        result: scoringResult
      };
    })
  );
  const allResults = await Promise.all(scoringPromises);
  for (const { requirementId, result } of allResults) {
    results.set(requirementId, result);
  }
  tcAILogger.info(`[ai-reviewer:scoring-pipeline] === SCORING PIPELINE COMPLETE ===`);
  return results;
}
const processChallengeContextWithRequirementsAnalyzer = createStep({
  id: "process-challenge-context-with-requirements-analyzer",
  description: "Processes the unified challenge context with the requirements analyzer agent and scoring distiller to produce enriched requirement analysis results.",
  inputSchema: unifiedContextSchema,
  outputSchema: requirementsAnalyzerOutputSchema,
  execute: async ({ mastra, inputData }) => {
    const requirementAnalyzerAgent = mastra.getAgentById("requirement-analyzer-agent");
    if (!requirementAnalyzerAgent) {
      throw new Error("Requirement Analyzer Agent not found in Mastra");
    }
    const scoringDistillerAgent = mastra.getAgentById("scoring-distiller-agent");
    if (!scoringDistillerAgent) {
      throw new Error("Scoring Distiller Agent not found in Mastra");
    }
    const requirementPrompts = buildAllRequirementPrompts(inputData);
    const totalRequirements = requirementPrompts.length;
    if (totalRequirements === 0) {
      tcAILogger.warn("[ai-reviewer:requirements-analyzer] No requirements found in challenge context.");
      return [];
    }
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === STARTING DECOUPLED REQUIREMENTS ANALYSIS ===`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] LLM Configuration for Requirement Analyzer Agent: ${JSON.stringify(requirementAnalyzerAgent.model, null, 2)}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] LLM Configuration for Scoring Distiller Agent: ${JSON.stringify(scoringDistillerAgent.model, null, 2)}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Challenge: ${inputData.challengeId}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Requirements: ${totalRequirements}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Timeout: ${ITERATION_TIMEOUT_MS}ms, Scoring Timeout: ${SCORING_TIMEOUT_MS}ms`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Retries: ${MAX_RETRIES$1}, Scoring Retries: ${SCORING_MAX_RETRIES}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analyzer Batch Size: ${MAX_CONCURRENT_ANALYSES}, Scoring Batch Size: ${MAX_CONCURRENT_SCORING_DISTILLERS}`);
    const pipelineStartTime = Date.now();
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 1: REQUIREMENT ANALYSIS ===`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Concurrency limit: ${MAX_CONCURRENT_ANALYSES}`);
    const analysisLimit = pLimit(MAX_CONCURRENT_ANALYSES);
    let analysisCompletedCount = 0;
    const analysisPromises = requirementPrompts.map(
      ({ requirement, prompt }, globalIndex) => analysisLimit(async () => {
        tcAILogger.info(`[ai-reviewer:requirements-analyzer] [${globalIndex + 1}/${totalRequirements}] [${requirement.id}] Starting analysis`);
        try {
          const result = await analyzeRequirementOnly(
            requirementAnalyzerAgent,
            inputData.challengeId,
            requirement,
            prompt,
            globalIndex,
            totalRequirements
          );
          analysisCompletedCount++;
          tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis progress: ${analysisCompletedCount}/${totalRequirements} completed`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          tcAILogger.error(`[ai-reviewer:requirements-analyzer] [${globalIndex + 1}/${totalRequirements}] [${requirement.id}] Unexpected error: ${errorMessage}`);
          analysisCompletedCount++;
          tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis progress: ${analysisCompletedCount}/${totalRequirements} completed`);
          return {
            requirement,
            analyzerOutput: `Analysis failed with unexpected error: ${errorMessage}`,
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            toolUsage: { totalCalls: 0, uniqueTools: [], callsByTool: {}, successCount: 0, errorCount: 0 },
            durationMs: 0,
            retryCount: 0,
            error: errorMessage,
            index: globalIndex
          };
        }
      })
    );
    const analysisResults = await Promise.all(analysisPromises);
    const analysisPhaseTime = Date.now() - pipelineStartTime;
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 1 COMPLETE === (${analysisPhaseTime}ms)`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 2: SCORING DISTILLATION ===`);
    const scoringStartTime = Date.now();
    const scoringTasks = analysisResults.map((result) => ({
      analysisResult: result,
      total: totalRequirements
    }));
    const scoringResults = await processScoringQueue(scoringDistillerAgent, scoringTasks);
    const scoringPhaseTime = Date.now() - scoringStartTime;
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 2 COMPLETE === (${scoringPhaseTime}ms)`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === PHASE 3: MERGING RESULTS ===`);
    const results = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalAnalysisDurationMs = 0;
    let totalScoringDurationMs = 0;
    let totalToolCalls = 0;
    let totalToolSuccess = 0;
    let totalToolErrors = 0;
    const aggregatedToolCalls = {};
    let analysisSuccessCount = 0;
    let analysisErrorCount = 0;
    let scoringSuccessCount = 0;
    let scoringErrorCount = 0;
    for (const analysisResult of analysisResults) {
      const scoringResult = scoringResults.get(analysisResult.requirement.id);
      const combinedTokenUsage = combineTokenUsage$1(analysisResult.tokenUsage, scoringResult?.tokenUsage);
      const totalDurationMs = analysisResult.durationMs + (scoringResult?.durationMs ?? 0);
      const finalResult = {
        ...analysisResult.requirement,
        requirementAnalyzer: analysisResult.analyzerOutput,
        scoring: scoringResult?.scoring,
        scoringError: scoringResult?.error,
        scoringRetryCount: scoringResult?.retryCount,
        tokenUsage: combinedTokenUsage,
        toolUsage: analysisResult.toolUsage,
        durationMs: totalDurationMs,
        retryCount: analysisResult.retryCount,
        error: analysisResult.error
      };
      results.push(finalResult);
      if (analysisResult.error) {
        analysisErrorCount++;
      } else {
        analysisSuccessCount++;
      }
      if (scoringResult?.scoring) {
        scoringSuccessCount++;
      } else if (scoringResult?.error) {
        scoringErrorCount++;
      }
      totalInputTokens += combinedTokenUsage.inputTokens;
      totalOutputTokens += combinedTokenUsage.outputTokens;
      totalAnalysisDurationMs += analysisResult.durationMs;
      totalScoringDurationMs += scoringResult?.durationMs ?? 0;
      totalToolCalls += analysisResult.toolUsage.totalCalls;
      totalToolSuccess += analysisResult.toolUsage.successCount;
      totalToolErrors += analysisResult.toolUsage.errorCount;
      for (const [tool, count] of Object.entries(analysisResult.toolUsage.callsByTool)) {
        aggregatedToolCalls[tool] = (aggregatedToolCalls[tool] ?? 0) + count;
      }
    }
    const totalPipelineTime = Date.now() - pipelineStartTime;
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === DECOUPLED PIPELINE SUMMARY ===`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Processed: ${totalRequirements} requirements`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis: success=${analysisSuccessCount}, errors=${analysisErrorCount}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Scoring: success=${scoringSuccessCount}, errors=${scoringErrorCount}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Tokens: input=${totalInputTokens}, output=${totalOutputTokens}, total=${totalInputTokens + totalOutputTokens}`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Tool Calls: ${totalToolCalls} (success=${totalToolSuccess}, errors=${totalToolErrors})`);
    if (Object.keys(aggregatedToolCalls).length > 0) {
      tcAILogger.info(`[ai-reviewer:requirements-analyzer] Tool Call Distribution: ${JSON.stringify(aggregatedToolCalls)}`);
    }
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] === TIMING BREAKDOWN ===`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Analysis Phase (wall clock): ${analysisPhaseTime}ms (${(analysisPhaseTime / 1e3).toFixed(1)}s)`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Scoring Phase (wall clock): ${scoringPhaseTime}ms (${(scoringPhaseTime / 1e3).toFixed(1)}s)`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Total Pipeline (wall clock): ${totalPipelineTime}ms (${(totalPipelineTime / 1e3).toFixed(1)}s)`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Cumulative Analysis Time: ${totalAnalysisDurationMs}ms`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Cumulative Scoring Time: ${totalScoringDurationMs}ms`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Avg Analysis per Requirement: ${totalRequirements > 0 ? (totalAnalysisDurationMs / totalRequirements).toFixed(0) : 0}ms`);
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Avg Scoring per Requirement: ${totalRequirements > 0 ? (totalScoringDurationMs / totalRequirements).toFixed(0) : 0}ms`);
    const sequentialTime = totalAnalysisDurationMs + totalScoringDurationMs;
    const parallelismSpeedup = sequentialTime > 0 ? (sequentialTime / totalPipelineTime).toFixed(2) : "N/A";
    tcAILogger.info(`[ai-reviewer:requirements-analyzer] Parallelism Speedup: ${parallelismSpeedup}x (sequential would be ${(sequentialTime / 1e3).toFixed(1)}s)`);
    return results;
  }
});
const requirementsAnalyzerWorkflow = createWorkflow({
  id: "requirements-analyzer",
  description: "Reads the challenge context from the workspace and executes the requirements analyzer agent over it.",
  inputSchema: requirementsAnalyzerWorkflowInputSchema,
  outputSchema: requirementsAnalyzerOutputSchema
}).then(readChallengeContextFromWorkspace).then(processChallengeContextWithRequirementsAnalyzer);

"use strict";
const DEFAULT_MODEL$1 = "qwen3.5:latest";
const MODEL_ID$1 = process.env.LLM_MODEL_NAME || DEFAULT_MODEL$1;
const PROVIDER_NAME$1 = process.env.LLM_PROVIDER_NAME || "TC-Ollama";
const scoringDistillerAgent = new Agent({
  id: "scoring-distiller-agent",
  name: "Scoring Distiller",
  description: "Extracts and distills scoring rationale from the Requirement Analyzer's analysis report, focusing on coverage and implementation verification.",
  instructions: SCORING_DISTILLER_AGENT_INSTRUCTIONS,
  // Model with extended context and timeout-friendly settings
  // Override model via LLM_MODEL_NAME env var (see recommendations above)
  model: createModel(PROVIDER_NAME$1, MODEL_ID$1),
  defaultOptions: {
    activeTools: [],
    maxSteps: 1,
    structuredOutput: {
      schema: ScoringDistillerSchema
      // jsonPromptInjection: true,
    }
  },
  // Error processors handle API failures with retry
  errorProcessors: [
    new APIErrorProcessor({
      maxRetries: 2,
      retryablePatterns: [
        "timeout",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "socket hang up",
        "503",
        "502",
        "504",
        "rate limit",
        "overloaded",
        /context.*length.*exceeded/i,
        /model.*busy/i
      ]
    })
  ]
});

"use strict";
const ScorerSchema = z.object({
  score: z.number().int().min(0).max(5).describe("Final score for the submission (0-5) based on the evaluation of the requirement-analysis report."),
  report: z.string().describe("Detailed reviewreport. Providing rationale for the assigned score, citing specific evidence from the distillation, and actionable feedback for improvement, if applicable.")
});
const SCORER_SCHEMA_DESCRIPTION = formatSchemaForInstructions(ScorerSchema);
const SCORER_INPUT_SCHEMA_DESCRIPTION = formatSchemaForInstructions(z.object({
  question: z.string().describe('The evaluation question being answered, e.g. "How well does the implementation meet the requirements?"'),
  guidelines: z.string().describe("Any specific guidelines or criteria to consider when evaluating the requirement-analysis report."),
  "requirement-analysis": z.array(ScoringDistillerSchema).describe("The requirement-analysis report generated by the Scoring Distiller Agent. This includes the comprehensive summary, evidence, justification, and feedback for each requirement.")
}).describe('Input JSON containing the requirement-analysis report to be scored. The "question" field provides context for the evaluation, the "guidelines" field provides specific criteria for evaluation, and the "requirement-analysis" field contains the detailed analysis report generated by the Scoring Distiller Agent.'));
const SCORER_AGENT_INSTRUCTIONS = `You are a Scorer agent that determines the final score for a codebase review based.

## Task Workflow

1. Review the provided requirement-analysis JSON, which contains a comprehensive summary, including evidence, justification, and feedback.
2. Based on this information, assign a final score that reflects the overall quality and completeness of the implementation.
3. Provide a rationale for the assigned score, citing specific evidence from the requirement-analysis to support your assessment.
4. Offer actionable feedback for improvement, if applicable.

## Input

You will receive a JSON object that adheres to the following schema:

${SCORER_INPUT_SCHEMA_DESCRIPTION}

---

## Output Requirements

Your output should be a JSON object that adheres to the following schema:

${SCORER_SCHEMA_DESCRIPTION}

---

## Important Guidelines
1. Output ONLY valid JSON matching the above schema - no markdown, no explanations, no code fences.
2. Base your score on the evidence and justification provided in the requirement-analysis, not on assumptions or external knowledge. Ground your evaluation strictly in the provided information.
3. Generate the report in markdown format, using bullet points, headings, and code snippets as needed to clearly communicate your rationale and feedback.
4. For binary questions (e.g. "Is the implementation complete?"), assign a score of 5 for "YES" and 0 for "NO", with rationale explaining the decision.`;

"use strict";
const DEFAULT_MODEL = "qwen3.5:9b";
const MODEL_ID = process.env.SCORER_LLM_MODEL_NAME || DEFAULT_MODEL;
const PROVIDER_NAME = process.env.LLM_PROVIDER_NAME || "TC-Ollama";
const scorerAgent = new Agent({
  id: "scorer-agent",
  name: "Scorer",
  description: "Determines the final score of the Requirement Analysis processing the scoring distillation JSON, and produces a final score with rationale and feedback.",
  instructions: SCORER_AGENT_INSTRUCTIONS,
  // Model with extended context and timeout-friendly settings
  // Override model via SCORER_LLM_MODEL_NAME env var (see recommendations above)
  model: createModel(PROVIDER_NAME, MODEL_ID),
  defaultOptions: {
    activeTools: [],
    maxSteps: 1,
    structuredOutput: {
      schema: ScorerSchema
      // jsonPromptInjection: true,
    }
  },
  // Error processors handle API failures with retry
  errorProcessors: [
    new APIErrorProcessor({
      maxRetries: 2,
      retryablePatterns: [
        "timeout",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "socket hang up",
        "503",
        "502",
        "504",
        "rate limit",
        "overloaded",
        /context.*length.*exceeded/i,
        /model.*busy/i
      ]
    })
  ]
});

"use strict";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1e3;
const SCORER_TIMEOUT_MS = parseInt(process.env.SCORER_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;
const MAX_RETRIES = 1;
const MAX_CONCURRENT_SCORERS = parseInt(process.env.MAX_CONCURRENT_SCORERS || "", 10) || 2;
const scorerWorkflowInputSchema = z$1.object({
  aiWorkflowPath: z$1.string().describe("Absolute path to the AI workflow JSON file"),
  requirementAnalysis: z$1.array(ScoringDistillerSchema).describe("The requirement-analysis report generated by the Scoring Distiller Agent")
});
const tokenUsageSchema = z$1.object({
  inputTokens: z$1.number().describe("Number of tokens in the prompt/input"),
  outputTokens: z$1.number().describe("Number of tokens in the completion/output"),
  totalTokens: z$1.number().describe("Total tokens used (inputTokens + outputTokens)"),
  cachedInputTokens: z$1.number().optional().describe("Number of input tokens read from cache"),
  cacheCreationInputTokens: z$1.number().optional().describe("Number of input tokens written to cache"),
  reasoningTokens: z$1.number().optional().describe("Number of tokens used for reasoning (chain-of-thought)")
});
const toolCallRecordSchema = z$1.object({
  toolCallId: z$1.string().describe("Unique identifier for the tool call"),
  toolName: z$1.string().describe("Name of the tool that was called"),
  args: z$1.record(z$1.string(), z$1.unknown()).optional().describe("Arguments passed to the tool"),
  durationMs: z$1.number().optional().describe("Execution duration in milliseconds"),
  success: z$1.boolean().optional().describe("Whether the tool call succeeded"),
  error: z$1.string().optional().describe("Error message if the tool call failed")
});
const toolUsageSchema = z$1.object({
  totalCalls: z$1.number().describe("Total number of tool calls made"),
  uniqueTools: z$1.array(z$1.string()).describe("List of unique tool names used"),
  callsByTool: z$1.record(z$1.string(), z$1.number()).describe("Number of calls per tool name"),
  totalDurationMs: z$1.number().optional().describe("Total time spent in tool executions"),
  successCount: z$1.number().describe("Number of successful tool calls"),
  errorCount: z$1.number().describe("Number of failed tool calls"),
  calls: z$1.array(toolCallRecordSchema).optional().describe("Detailed log of each tool call")
});
const questionScoreResultSchema = z$1.object({
  questionId: z$1.string().describe("Scorecard question ID"),
  questionDescription: z$1.string().describe("Question description/text"),
  questionType: z$1.enum(["SCALE", "YES_NO", "TEST_CASE"]).describe("Question type"),
  weight: z$1.number().describe("Question weight"),
  scorer: ScorerSchema.describe("Scorer agent output"),
  tokenUsage: tokenUsageSchema.optional().describe("Token usage for this question scoring"),
  toolUsage: toolUsageSchema.optional().describe("Tool usage statistics for this question"),
  durationMs: z$1.number().optional().describe("Duration of scoring in milliseconds"),
  retryCount: z$1.number().optional().describe("Number of retries needed"),
  error: z$1.string().optional().describe("Error message if scoring failed")
});
const sectionScoreResultSchema = z$1.object({
  sectionId: z$1.string().describe("Scorecard section ID"),
  sectionName: z$1.string().describe("Section name"),
  weight: z$1.number().describe("Section weight"),
  questions: z$1.array(questionScoreResultSchema).describe("Question results in this section")
});
const groupScoreResultSchema = z$1.object({
  groupId: z$1.string().describe("Scorecard group ID"),
  groupName: z$1.string().describe("Group name"),
  weight: z$1.number().describe("Group weight"),
  sections: z$1.array(sectionScoreResultSchema).describe("Section results in this group")
});
const scorerWorkflowOutputSchema = z$1.object({
  scorecard: z$1.array(groupScoreResultSchema).describe("Full scorecard results organized by groups, sections, and questions"),
  totalUsage: tokenUsageSchema.describe("Aggregated token usage across all question scorings"),
  toolUsage: toolUsageSchema.describe("Aggregated tool usage across all question scorings"),
  summary: z$1.object({
    totalQuestions: z$1.number().describe("Total number of questions scored"),
    successCount: z$1.number().describe("Number of successfully scored questions"),
    errorCount: z$1.number().describe("Number of failed question scorings"),
    totalDurationMs: z$1.number().describe("Total duration of all scorings")
  }).describe("Summary statistics")
});
async function executeWithTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    tcAILogger.warn(`[scorer-workflow] ${label} - Timeout after ${timeoutMs}ms`);
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}
function combineTokenUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0) || void 0,
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0) || void 0,
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0) || void 0
  };
}
function combineToolUsage(a, b) {
  const callsByTool = { ...a?.callsByTool ?? {} };
  for (const [tool, count] of Object.entries(b?.callsByTool ?? {})) {
    callsByTool[tool] = (callsByTool[tool] ?? 0) + count;
  }
  const allCalls = [...a?.calls ?? [], ...b?.calls ?? []];
  return {
    totalCalls: (a?.totalCalls ?? 0) + (b?.totalCalls ?? 0),
    uniqueTools: [.../* @__PURE__ */ new Set([...a?.uniqueTools ?? [], ...b?.uniqueTools ?? []])],
    callsByTool,
    totalDurationMs: (a?.totalDurationMs ?? 0) + (b?.totalDurationMs ?? 0) || void 0,
    successCount: (a?.successCount ?? 0) + (b?.successCount ?? 0),
    errorCount: (a?.errorCount ?? 0) + (b?.errorCount ?? 0),
    calls: allCalls.length > 0 ? allCalls : void 0
  };
}
function buildScorerPrompt(question, guidelines, requirementAnalysis) {
  const input = {
    question,
    guidelines,
    "requirement-analysis": requirementAnalysis
  };
  return JSON.stringify(input);
}
async function scoreQuestion(scorerAgent, question, requirementAnalysis, logPrefix) {
  let retryCount = 0;
  let lastError = null;
  while (retryCount <= MAX_RETRIES) {
    const startTime = Date.now();
    const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : "";
    tcAILogger.info(`${logPrefix} Starting scoring${attemptLabel}`);
    try {
      const prompt = buildScorerPrompt(question.description, question.guidelines, requirementAnalysis);
      const rawResult = await executeWithTimeout(
        async (_signal) => scorerAgent.generate(prompt),
        SCORER_TIMEOUT_MS,
        `${logPrefix} Scorer execution`
      );
      const result = rawResult;
      const durationMs = Date.now() - startTime;
      const tokenUsage = {
        inputTokens: result.totalUsage?.inputTokens ?? 0,
        outputTokens: result.totalUsage?.outputTokens ?? 0,
        totalTokens: result.totalUsage?.totalTokens ?? 0,
        cachedInputTokens: result.totalUsage?.cachedInputTokens,
        cacheCreationInputTokens: result.totalUsage?.cacheCreationInputTokens,
        reasoningTokens: result.totalUsage?.reasoningTokens
      };
      const toolUsage = {
        totalCalls: 0,
        uniqueTools: [],
        callsByTool: {},
        successCount: 0,
        errorCount: 0
      };
      if (result.error) {
        throw new Error(result.error.message);
      }
      let scorerOutput;
      if (result.object) {
        scorerOutput = result.object;
      } else if (result.text) {
        try {
          const parsed = JSON.parse(result.text);
          scorerOutput = ScorerSchema.parse(parsed);
        } catch (parseError) {
          throw new Error(`Failed to parse scorer output: ${parseError}`, { cause: parseError });
        }
      } else {
        throw new Error("No structured output or text returned from scorer agent");
      }
      tcAILogger.info(`${logPrefix} Scoring complete in ${durationMs}ms`);
      tcAILogger.info(`${logPrefix} Score: ${scorerOutput.score}/5, Tokens: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}`);
      return {
        questionId: question.id,
        questionDescription: question.description,
        questionType: question.type,
        weight: question.weight,
        scorer: scorerOutput,
        tokenUsage,
        toolUsage,
        durationMs,
        retryCount
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTimeout = lastError.name === "AbortError" || lastError.message.includes("abort");
      tcAILogger.error(`${logPrefix} Failed after ${durationMs}ms: ${lastError.message}`);
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        const retryReason = isTimeout ? "timeout" : "error";
        tcAILogger.info(`${logPrefix} Retrying due to ${retryReason}`);
        continue;
      }
      return {
        questionId: question.id,
        questionDescription: question.description,
        questionType: question.type,
        weight: question.weight,
        scorer: { score: 0, report: `Scoring failed: ${lastError.message}` },
        durationMs,
        retryCount,
        error: lastError.message
      };
    }
  }
  return {
    questionId: question.id,
    questionDescription: question.description,
    questionType: question.type,
    weight: question.weight,
    scorer: { score: 0, report: `Unexpected error: ${lastError?.message || "Unknown"}` },
    retryCount,
    error: lastError?.message
  };
}
const readAndProcessScorecard = createStep({
  id: "read-and-process-scorecard",
  description: "Reads the AI workflow JSON and iterates over scorecard groups, sections, and questions, prompting the scorer agent for each question.",
  inputSchema: scorerWorkflowInputSchema,
  outputSchema: scorerWorkflowOutputSchema,
  execute: async ({ mastra, inputData }) => {
    const { aiWorkflowPath, requirementAnalysis } = inputData;
    tcAILogger.info(`[scorer-workflow] Reading AI workflow from: ${aiWorkflowPath}`);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(aiWorkflowPath, "utf-8");
    const aiWorkflow = JSON.parse(content);
    tcAILogger.info(`[scorer-workflow] AI workflow loaded successfully (${content.length} chars)`);
    const scorerAgent = mastra.getAgentById("scorer-agent");
    if (!scorerAgent) {
      throw new Error("Scorer Agent not found in Mastra");
    }
    const scorecard = aiWorkflow.scorecard;
    const groups = scorecard.scorecardGroups;
    tcAILogger.info(`[scorer-workflow] === STARTING SCORECARD PROCESSING ===`);
    tcAILogger.info(`[scorer-workflow] LLM Configuration for Scorer Agent: ${JSON.stringify(scorerAgent.model, null, 2)}`);
    tcAILogger.info(`[scorer-workflow] Scorecard: ${scorecard.name} (v${scorecard.version})`);
    tcAILogger.info(`[scorer-workflow] Groups: ${groups.length}`);
    tcAILogger.info(`[scorer-workflow] Requirement Analysis Items: ${requirementAnalysis.length}`);
    tcAILogger.info(`[scorer-workflow] Scorer Timeout: ${SCORER_TIMEOUT_MS}ms, Max Retries: ${MAX_RETRIES}, Concurrency: ${MAX_CONCURRENT_SCORERS}`);
    tcAILogger.info(`[scorer-workflow] ========== REQUIREMENTS JSON ANALYSIS INPUT ==========`);
    tcAILogger.info(`[scorer-workflow] ${JSON.stringify(requirementAnalysis, null, 2)}`);
    tcAILogger.info(`[scorer-workflow] ======================================================`);
    let totalQuestions = 0;
    for (const group of groups) {
      for (const section of group.sections) {
        totalQuestions += section.questions.length;
      }
    }
    tcAILogger.info(`[scorer-workflow] Total Questions: ${totalQuestions}`);
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let totalToolUsage = {
      totalCalls: 0,
      uniqueTools: [],
      callsByTool: {},
      successCount: 0,
      errorCount: 0
    };
    let successCount = 0;
    let errorCount = 0;
    let totalDurationMs = 0;
    const allQuestions = [];
    let globalIndex = 0;
    for (const group of groups) {
      for (const section of group.sections) {
        const questions = section.questions;
        for (const question of questions) {
          allQuestions.push({
            groupId: group.id,
            groupName: group.name,
            groupWeight: group.weight,
            sectionId: section.id,
            sectionName: section.name,
            sectionWeight: section.weight,
            question,
            globalIndex: globalIndex++
          });
        }
      }
    }
    tcAILogger.info(`[scorer-workflow] Collected ${allQuestions.length} questions across ${groups.length} groups`);
    tcAILogger.info(`[scorer-workflow] Concurrency limit: ${MAX_CONCURRENT_SCORERS}`);
    const allResults = /* @__PURE__ */ new Map();
    const limit = pLimit(MAX_CONCURRENT_SCORERS);
    let completedCount = 0;
    const scoringPromises = allQuestions.map(
      (item) => limit(async () => {
        const currentIndex = item.globalIndex + 1;
        const logPrefix = `[scorer-workflow] [${currentIndex}/${totalQuestions}] [${item.question.id}]`;
        const result = await scoreQuestion(
          scorerAgent,
          {
            id: item.question.id,
            description: item.question.description,
            guidelines: item.question.guidelines,
            type: item.question.type,
            weight: item.question.weight
          },
          requirementAnalysis,
          logPrefix
        );
        completedCount++;
        tcAILogger.info(`[scorer-workflow] Progress: ${completedCount}/${totalQuestions} completed`);
        return { questionId: item.question.id, result };
      })
    );
    const allBatchResults = await Promise.all(scoringPromises);
    for (const { questionId, result } of allBatchResults) {
      allResults.set(questionId, result);
      if (result.tokenUsage) {
        totalUsage = combineTokenUsage(totalUsage, result.tokenUsage);
      }
      if (result.toolUsage) {
        totalToolUsage = combineToolUsage(totalToolUsage, result.toolUsage);
      }
      if (result.durationMs) {
        totalDurationMs += result.durationMs;
      }
      if (result.error) {
        errorCount++;
      } else {
        successCount++;
      }
    }
    const scorecardResults = [];
    for (const group of groups) {
      const sectionResults = [];
      for (const section of group.sections) {
        const questions = section.questions;
        const questionResults = questions.map((q) => {
          const result = allResults.get(q.id);
          if (!result) {
            throw new Error(`Missing result for question ${q.id}`);
          }
          return result;
        });
        sectionResults.push({
          sectionId: section.id,
          sectionName: section.name,
          weight: section.weight,
          questions: questionResults
        });
      }
      scorecardResults.push({
        groupId: group.id,
        groupName: group.name,
        weight: group.weight,
        sections: sectionResults
      });
    }
    tcAILogger.info(`[scorer-workflow] === SCORECARD PROCESSING COMPLETE ===`);
    tcAILogger.info(`[scorer-workflow] Questions Processed: ${totalQuestions}`);
    tcAILogger.info(`[scorer-workflow] Success: ${successCount}, Errors: ${errorCount}`);
    tcAILogger.info(`[scorer-workflow] Total Tokens: input=${totalUsage.inputTokens}, output=${totalUsage.outputTokens}, total=${totalUsage.totalTokens}`);
    tcAILogger.info(`[scorer-workflow] Total Duration: ${totalDurationMs}ms (${(totalDurationMs / 1e3).toFixed(1)}s)`);
    tcAILogger.info(`[scorer-workflow] Avg Duration per Question: ${totalQuestions > 0 ? (totalDurationMs / totalQuestions).toFixed(0) : 0}ms`);
    return {
      scorecard: scorecardResults,
      totalUsage,
      toolUsage: totalToolUsage,
      summary: {
        totalQuestions,
        successCount,
        errorCount,
        totalDurationMs
      }
    };
  }
});
const scorerWorkflow = createWorkflow({
  id: "scorer-workflow",
  description: "Reads the AI workflow scorecard and processes each question with the scorer agent, producing a full scorecard report.",
  inputSchema: scorerWorkflowInputSchema,
  outputSchema: scorerWorkflowOutputSchema
}).then(readAndProcessScorecard);

"use strict";
const IS_LOCAL_DEV = process.env.LOCAL_DEV === "true";
const mastra = new Mastra({
  agents: {
    requirementAnalyzerAgent,
    scoringDistillerAgent,
    scorerAgent
  },
  workflows: {
    requirementsAnalyzerWorkflow,
    scorerWorkflow
  },
  scorers: IS_LOCAL_DEV ? {} : void 0,
  storage: IS_LOCAL_DEV ? new LibSQLStore({
    id: "ai-review-libsql-storage",
    url: "file:./ai-review-libsql-storage.db"
  }) : void 0,
  logger: tcAILogger,
  observability: IS_LOCAL_DEV ? new Observability({
    configs: {
      default: {
        serviceName: "tc-ai-reviewer",
        exporters: [new DefaultExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()]
      }
    }
  }) : void 0,
  bundler: {
    transpilePackages: ["@topcoder/wipro-ai-sdk-provider"]
  },
  server: {
    port: Number(process.env.PORT || 3e3),
    studioBase: "/studio",
    build: {
      apiReqLogs: true
    }
  },
  workspace: reviewWorkspace
});

export { mastra };
