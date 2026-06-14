import { Mastra } from '@mastra/core';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { tcAILogger } from '../utils';
import { reviewWorkspace } from './workspaces';
import { LibSQLStore } from '@mastra/libsql';
import { requirementAnalyzerAgent } from './agents/requirement-analyzer';
import { requirementsAnalyzerWorkflow } from './workflows/requirements-analyzer';
import { scoringDistillerAgent } from './agents/scoring-distiller/agent';
import { scorerAgent } from './agents/scorer/agent';
import { scorerWorkflow } from './workflows/scorer';

// Feature flag: Enable storage, observability, and scorers only in local dev
// These components can keep the Node.js event loop alive and cause hangs in CI
const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';

export const mastra = new Mastra({
  agents: { requirementAnalyzerAgent, scoringDistillerAgent, scorerAgent },
  workflows: { requirementsAnalyzerWorkflow, scorerWorkflow },
  scorers: IS_LOCAL_DEV ? {} : undefined,
  storage: IS_LOCAL_DEV
    ? new LibSQLStore({
      id: 'ai-review-libsql-storage',
      url: 'file:./ai-review-libsql-storage.db',
    })
    : undefined,
  logger: tcAILogger,
  observability: IS_LOCAL_DEV
    ? new Observability({
      configs: {
        default: {
          serviceName: 'tc-ai-reviewer',
          exporters: [new DefaultExporter()],
          spanOutputProcessors: [new SensitiveDataFilter()],
        },
      },
    })
    : undefined,
  bundler: {
    transpilePackages: ['@topcoder/wipro-ai-sdk-provider'],
  },
  server: {
    port: Number(process.env.PORT || 3000),
    studioBase: '/studio',
    build: {
      apiReqLogs: true,
    },
  },
  workspace: reviewWorkspace,
});
