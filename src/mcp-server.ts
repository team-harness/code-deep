import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GraphReader, ReviewReport } from './review.js';
import { renderReviewMarkdown, ReviewAnalyzer, validateReviewRequest } from './review.js';
import { ensureProjectIndex } from './project-index.js';
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
  detailLevel: z.enum(['minimal', 'standard']).default('minimal'),
});

const MAY_INITIALIZE_INDEX = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SERVER_INSTRUCTIONS = [
  'Prefer these code-intel MCP tools over shell commands.',
  'Do not probe the code-intel CLI when MCP tools are available.',
  'Refer to this capability as code-intel in user-facing messages. Do not tell the user you are switching to CodeGraph, which is only the internal backend.',
  'Use explore before broad reading/editing, with an absolute Git root and a query containing the task goal, symbols/files, and relationship to trace.',
  'Missing Git worktree indexes are initialized automatically before either tool runs.',
  'After changes use review for the working tree or a base/head range.',
  'Review defaults to detailLevel minimal; request standard when you need the bounded diff, complete review items, impact compatibility view, or graph context.',
  'Process reviewItems in descending risk order. Warnings, low confidence, or omitted files/symbols require targeted explore follow-ups.',
  'Risk prioritizes attention and does not prove a bug; verify a concrete failure path before emitting a comment.',
  'Both tools leave source files unchanged and share one persistent internal backend connection.',
].join(' ');

const REVIEW_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  description: 'Versioned review report. Read reviewItems in array order (highest risk first), then inspect warnings and truncation counters before making findings.',
  properties: {
    schemaVersion: { type: 'number', const: 2 },
    detailLevel: {
      type: 'string',
      enum: ['minimal', 'standard'],
      description: 'Response detail level selected by the caller.',
    },
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
      description: 'Changed symbols sorted by descending risk. Minimal detail returns the top three and reports the remainder in reviewItemsOmitted.',
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
    reviewItemsOmitted: {
      type: 'number',
      description: 'Review items omitted only from this response projection; zero for standard detail.',
    },
    files: {
      type: 'array',
      description: 'Deeply analyzed changed files. Changed lines are represented as compact inclusive ranges; per-file graphWarnings identify symbol mapping degradation.',
      items: {
        type: 'object',
        properties: {
          changedLineCount: { type: 'number' },
          changedLineRanges: {
            type: 'array',
            description: 'Inclusive changed-line ranges sorted by start line.',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number' },
                end: { type: 'number' },
              },
              required: ['start', 'end'],
              additionalProperties: false,
            },
          },
        },
        required: ['changedLineCount', 'changedLineRanges'],
        additionalProperties: true,
      },
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
    ignoredPaths: {
      type: 'array',
      description: 'Tool-generated working-tree paths excluded from an implicit review. Empty for caller-supplied diffs and Git ranges.',
      items: { type: 'string' },
    },
    graphContext: { type: 'string', description: 'Focused CodeGraph exploration context.' },
  },
  required: [
    'schemaVersion', 'detailLevel', 'summary', 'files', 'reviewItems',
    'reviewItemsOmitted', 'riskSignals', 'ignoredPaths',
  ],
  additionalProperties: true,
};

const TOOLS: Tool[] = [
  {
    name: 'explore',
    description: 'Use code-intel to explore focused source, call paths, and blast radius before broad reading or editing. Automatically initializes a missing worktree index. State the task goal, symbols/files, and relationship to trace; use targeted follow-ups when review reports warnings or omissions.',
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
    annotations: MAY_INITIALIZE_INDEX,
  },
  {
    name: 'review',
    description: 'Use code-intel to build a structured, diff-aware review and automatically initialize a missing worktree index. Process reviewItems in descending risk order, inspect warnings/omissions, use targeted explore follow-ups, and verify a concrete failure path before emitting a review comment.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute Git root. Use the same projectPath supplied to explore.' },
        diff: { type: 'string', description: 'Caller-supplied unified diff. Cannot be combined with base or head; omit to read Git.' },
        base: { type: 'string', description: 'Git base revision. Omit for the current working tree.' },
        head: { type: 'string', description: 'Git head revision; requires base and defaults to HEAD.' },
        maxFiles: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        maxSymbols: { type: 'number', minimum: 1, maximum: 50, default: 12 },
        detailLevel: {
          type: 'string',
          enum: ['minimal', 'standard'],
          default: 'minimal',
          description: 'minimal returns priorities and risk without diff/context; standard adds the complete report and bounded diff.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    annotations: MAY_INITIALIZE_INDEX,
  },
];

export interface CodeIntelServerOptions {
  projectPath: string;
  bridge: GraphReader & { ensureProjectIndex?: (projectPath?: string) => Promise<void> };
  ensureIndex?: (projectPath: string) => Promise<void>;
}

export function createCodeIntelServer(options: CodeIntelServerOptions): Server {
  const server = new Server(
    { name: 'code-intel', version: CODE_INTEL_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'explore') {
        const input = ExploreInput.parse(request.params.arguments ?? {});
        const projectPath = input.projectPath ?? options.projectPath;
        await indexEnsurer(options)(projectPath);
        const text = await options.bridge.callText('codegraph_explore', {
          query: input.query,
          maxFiles: input.maxFiles,
          projectPath,
        });
        return textResult(text);
      }

      if (request.params.name === 'review') {
        const input = ReviewInput.parse(request.params.arguments ?? {});
        const { detailLevel, ...reviewInput } = input;
        const reviewRequest = {
          ...reviewInput,
          projectPath: input.projectPath ?? options.projectPath,
        };
        validateReviewRequest(reviewRequest);
        await indexEnsurer(options)(reviewRequest.projectPath);
        const report = await new ReviewAnalyzer(options.bridge).analyze(reviewRequest);
        return reportResult(report, detailLevel);
      }

      return errorResult(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function indexEnsurer(options: CodeIntelServerOptions): (projectPath: string) => Promise<void> {
  if (options.ensureIndex) return options.ensureIndex;
  if (options.bridge.ensureProjectIndex) {
    return (projectPath) => options.bridge.ensureProjectIndex!(projectPath);
  }
  return ensureProjectIndex;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function reportResult(
  report: ReviewReport,
  detailLevel: 'minimal' | 'standard',
): CallToolResult {
  const { markdown: _markdown, ...structuredReport } = report;
  const structuredContent = JSON.parse(JSON.stringify(structuredReport)) as Record<string, unknown>;
  structuredContent.schemaVersion = 2;
  structuredContent.detailLevel = detailLevel;
  structuredContent.files = report.files.map(({
    changedLines,
    patch: _patch,
    graphSummary: _graphSummary,
    ...file
  }) => ({
    ...file,
    changedLineCount: changedLines.length,
    changedLineRanges: compactLineRanges(changedLines),
  }));
  if (detailLevel === 'minimal') {
    delete structuredContent.impacts;
    delete structuredContent.graphContext;
    structuredContent.reviewItems = report.reviewItems.slice(0, 3);
    structuredContent.reviewItemsOmitted = Math.max(0, report.reviewItems.length - 3);
  } else {
    structuredContent.reviewItemsOmitted = 0;
  }
  return {
    content: [{
      type: 'text',
      text: detailLevel === 'minimal'
        ? renderReviewMarkdown(report, { detailLevel })
        : report.markdown,
    }],
    structuredContent,
  };
}

function compactLineRanges(lines: number[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of lines) {
    const current = ranges.at(-1);
    if (current && line <= current.end + 1) {
      current.end = Math.max(current.end, line);
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
