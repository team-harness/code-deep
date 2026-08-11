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
import { CODE_INTEL_VERSION } from './version.js';

const ExploreInput = z.object({
  query: z.string().min(1),
  projectPath: z.string().min(1).optional(),
  maxFiles: z.number().int().min(1).max(50).default(12),
});

const ReviewInput = z.object({
  projectPath: z.string().min(1).optional(),
  diff: z.string().optional(),
  base: z.string().trim().min(1).optional(),
  head: z.string().trim().min(1).optional(),
  maxFiles: z.number().int().min(1).max(100).optional(),
  maxSymbols: z.number().int().min(1).max(50).optional(),
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const REVIEW_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  description: 'Versioned review report. Read reviewItems in array order (highest risk first), then inspect warnings and truncation counters before making findings.',
  properties: {
    schemaVersion: { type: 'number', const: 1 },
    summary: {
      type: 'object',
      description: 'Global diff totals and risk, including files/symbols omitted only from deep graph analysis.',
      properties: {
        filesChanged: { type: 'number' },
        filesAnalyzed: { type: 'number' },
        filesOmitted: { type: 'number' },
        symbolsMapped: { type: 'number' },
        symbolsAnalyzed: { type: 'number' },
        symbolsOmitted: { type: 'number' },
        riskScore: { type: 'number' },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      required: [
        'filesChanged', 'filesAnalyzed', 'filesOmitted',
        'symbolsMapped', 'symbolsAnalyzed', 'symbolsOmitted',
        'riskScore', 'riskLevel',
      ],
      additionalProperties: true,
    },
    reviewItems: {
      type: 'array',
      description: 'Changed symbols sorted by descending risk. Verify each candidate against the diff and source before emitting a comment.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          mappingConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          symbol: { type: 'object' },
          impact: { type: 'object' },
          tests: {
            type: 'object',
            description: 'status is linked, changed, missing, or unknown; unknown means evidence was insufficient.',
          },
          risk: { type: 'object' },
        },
        required: ['id', 'file', 'symbol', 'mappingConfidence', 'impact', 'tests', 'risk'],
        additionalProperties: true,
      },
    },
    files: {
      type: 'array',
      description: 'Deeply analyzed changed files. Per-file graphWarnings identify symbol mapping degradation.',
      items: { type: 'object' },
    },
    impacts: {
      type: 'array',
      description: 'Compatibility view of raw per-symbol impact results.',
      items: { type: 'object' },
    },
    riskSignals: {
      type: 'array',
      description: 'Explainable global risk contributions, including truncation and incomplete graph analysis.',
      items: { type: 'object' },
    },
    graphContext: { type: 'string', description: 'Focused CodeGraph exploration context.' },
    markdown: { type: 'string', description: 'Human-readable rendering of this report.' },
  },
  required: [
    'schemaVersion', 'summary', 'files', 'impacts', 'reviewItems',
    'riskSignals', 'graphContext', 'markdown',
  ],
  additionalProperties: true,
};

const TOOLS: Tool[] = [
  {
    name: 'explore',
    description: 'Explore focused source, call paths, and blast radius before broad reading or editing. State the task goal, symbols/files, and relationship to trace; use targeted follow-ups when review reports warnings or omissions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task goal plus relevant symbols/files and the relationship to trace, such as callers, callees, data flow, or blast radius.' },
        projectPath: { type: 'string', description: 'The absolute Git root. Always provide it when the MCP server is installed globally or can serve multiple repositories.' },
        maxFiles: { type: 'number', minimum: 1, maximum: 50, default: 12, description: 'Maximum focused source files returned.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'review',
    description: 'Build a structured, diff-aware review. Process reviewItems in descending risk order, inspect warnings/omissions, use targeted explore follow-ups, and verify a concrete failure path before emitting a review comment.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute Git root. Use the same projectPath supplied to explore.' },
        diff: { type: 'string', description: 'Caller-supplied unified diff. Cannot be combined with base or head; omit to read Git.' },
        base: { type: 'string', description: 'Git base revision. Omit for the current working tree.' },
        head: { type: 'string', description: 'Git head revision; requires base and defaults to HEAD.' },
        maxFiles: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        maxSymbols: { type: 'number', minimum: 1, maximum: 50, default: 12 },
      },
      allOf: [
        { not: { required: ['diff', 'base'] } },
        { not: { required: ['diff', 'head'] } },
        { if: { required: ['head'] }, then: { required: ['base'] } },
      ],
      additionalProperties: false,
    },
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    annotations: READ_ONLY,
  },
];

export interface CodeIntelServerOptions {
  projectPath: string;
  bridge: GraphReader;
}

export function createCodeIntelServer(options: CodeIntelServerOptions): Server {
  const server = new Server(
    { name: 'code-intel', version: CODE_INTEL_VERSION },
    {
      capabilities: { tools: {} },
      instructions: 'Use explore before broad reading/editing, with an absolute Git root and a query containing the task goal, symbols/files, and relationship to trace. After changes use review for the working tree or a base/head range. Process reviewItems in descending risk order. Warnings, low confidence, or omitted files/symbols require targeted explore follow-ups. Risk prioritizes attention and does not prove a bug; verify a concrete failure path before emitting a comment. Both tools are read-only and share one persistent CodeGraph connection.',
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
