import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GraphReader, ReviewReport } from './review.js';
import { ReviewAnalyzer } from './review.js';

const ExploreInput = z.object({
  query: z.string().min(1),
  projectPath: z.string().min(1).optional(),
  maxFiles: z.number().int().min(1).max(50).default(12),
});

const ReviewInput = z.object({
  projectPath: z.string().min(1).optional(),
  diff: z.string().optional(),
  base: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  maxFiles: z.number().int().min(1).max(100).optional(),
  maxSymbols: z.number().int().min(1).max(50).optional(),
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOLS: Tool[] = [
  {
    name: 'explore',
    description: 'Explore source, call paths, and blast radius through the persistent CodeGraph connection. Use before reading indexed source or editing code.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or symbol/file names.' },
        projectPath: { type: 'string', description: 'Override the server project path.' },
        maxFiles: { type: 'number', minimum: 1, maximum: 50, default: 12 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'review',
    description: 'Build a structured code-review brief from a diff: changed files and symbols, graph impact, explainable risk signals, and focused source context. Defaults to the current working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Override the server project path.' },
        diff: { type: 'string', description: 'Unified diff. Omit to read the current Git working tree.' },
        base: { type: 'string', description: 'Git base revision. Omit for the current working tree.' },
        head: { type: 'string', description: 'Git head revision; requires base and defaults to HEAD.' },
        maxFiles: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        maxSymbols: { type: 'number', minimum: 1, maximum: 50, default: 12 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

export interface CodeIntelServerOptions {
  projectPath: string;
  bridge: GraphReader;
}

export function createCodeIntelServer(options: CodeIntelServerOptions): Server {
  const server = new Server(
    { name: 'code-intel', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use explore for code discovery and review for diff-aware impact analysis. Both are read-only and backed by one persistent CodeGraph connection.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'explore') {
        const input = ExploreInput.parse(request.params.arguments ?? {});
        const text = await options.bridge.callText('codegraph_explore', {
          query: input.query,
          maxFiles: input.maxFiles,
          projectPath: input.projectPath ?? options.projectPath,
        });
        return textResult(text);
      }

      if (request.params.name === 'review') {
        const input = ReviewInput.parse(request.params.arguments ?? {});
        const report = await new ReviewAnalyzer(options.bridge).analyze({
          ...input,
          projectPath: input.projectPath ?? options.projectPath,
        });
        return reportResult(report);
      }

      return errorResult(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function reportResult(report: ReviewReport): CallToolResult {
  return {
    content: [{ type: 'text', text: report.markdown }],
    structuredContent: JSON.parse(JSON.stringify(report)) as Record<string, unknown>,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
