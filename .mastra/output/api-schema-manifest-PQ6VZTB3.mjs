import { S as SERVER_ROUTES, s as schemaToJsonSchema } from './index.mjs';
import '@mastra/core/evals/scoreTraces';
import '@mastra/core';
import '@mastra/observability';
import '@mastra/libsql';
import '@mastra/core/workflows';
import 'zod';
import 'p-limit';
import 'node:fs/promises';
import 'node:path';
import '@mastra/loggers';
import '@mastra/core/agent';
import 'ai-sdk-ollama';
import '@topcoder/wipro-ai-sdk-provider';
import '@ai-sdk/amazon-bedrock';
import '@aws-sdk/credential-providers';
import '@ai-sdk/openai';
import '@mastra/core/workspace';
import 'path';
import 'fs/promises';
import 'ai';
import 'web-tree-sitter';
import 'url';
import 'fs';
import 'module';
import '@mastra/core/tools';
import '@mastra/memory';
import 'crypto';
import 'tokenx';
import 'https';
import 'http';
import 'http2';
import 'stream';
import 'process';
import 'zod/v4';
import 'zod/v3';
import '@mastra/core/schema';
import '@mastra/core/utils/zod-to-json';
import '@mastra/core/auth/ee';
import '@mastra/core/request-context';
import '@mastra/core/processors';
import '@mastra/core/features';
import '@mastra/core/error';
import '@mastra/core/llm';
import '@mastra/core/memory';
import '@mastra/core/agent/durable';
import '@mastra/core/di';
import '@mastra/core/observability';
import '@mastra/core/storage';
import '@mastra/core/evals';
import '@mastra/core/utils';
import 'util';
import '@mastra/core/a2a';
import 'dns/promises';
import 'net';
import '@mastra/core/stream';
import 'stream/promises';
import '@mastra/core/server';
import 'buffer';
import './tools.mjs';

// src/server/server-adapter/api-schema-manifest.ts
function convertSchema(schema) {
  return schema ? schemaToJsonSchema(schema) : void 0;
}
function asJsonSchema(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function schemaType(schema) {
  const type = schema?.type;
  return Array.isArray(type) ? type.find(Boolean) : type;
}
function inferResponseShape(responseSchema) {
  if (!responseSchema) return { kind: "unknown" };
  const type = schemaType(responseSchema);
  if (type === "array") return { kind: "array" };
  if (type !== "object") return { kind: "single" };
  const properties = responseSchema.properties && !Array.isArray(responseSchema.properties) ? responseSchema.properties : {};
  const propertyNames = Object.keys(properties);
  const paginationProperty = "page" in properties ? "page" : "pagination" in properties ? "pagination" : void 0;
  const listProperty = Object.entries(properties).find(
    ([, property]) => schemaType(asJsonSchema(property)) === "array"
  )?.[0];
  if (listProperty && (paginationProperty || propertyNames.length <= 2)) {
    return { kind: "object-property", listProperty, paginationProperty };
  }
  if (responseSchema.additionalProperties && propertyNames.length === 0) return { kind: "record" };
  return { kind: "single" };
}
function isManifestRoute(route) {
  return route.responseType === "json" && !route.deprecated;
}
function buildApiSchemaManifest(routes = SERVER_ROUTES) {
  return {
    version: 1,
    routes: routes.filter(isManifestRoute).map((route) => {
      const responseSchema = convertSchema(route.responseSchema);
      return {
        method: route.method,
        path: route.path,
        responseType: route.responseType,
        pathParamSchema: convertSchema(route.pathParamSchema),
        queryParamSchema: convertSchema(route.queryParamSchema),
        bodySchema: convertSchema(route.bodySchema),
        responseSchema,
        responseShape: inferResponseShape(responseSchema)
      };
    })
  };
}

export { buildApiSchemaManifest };
