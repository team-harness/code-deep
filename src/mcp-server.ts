import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectExploreText, type ExploreDetailLevel } from './explore-projection.js';
import type { GraphReader, ReviewReport } from './review.js';
import { renderReviewMarkdown, ReviewAnalyzer, validateReviewRequest } from './review.js';
import { ensureProjectIndex } from './project-index.js';
import { CODE_DEEP_VERSION } from './version.js';

const EXPLORE_MAX_FILES = { min: 1, max: 50, default: 12 } as const;
const REVIEW_MAX_FILES = { min: 1, max: 100, default: 20 } as const;
const REVIEW_MAX_SYMBOLS = { min: 1, max: 50, default: 12 } as const;
const REVIEW_RESPONSE_ITEMS = { minimal: 3, standard: 10 } as const;
const REVIEW_RESPONSE_NESTED_ITEMS = { minimal: 3, standard: 3 } as const;
const REVIEW_RESPONSE_FILE_SYMBOLS = { minimal: 3, standard: 5 } as const;

const ExploreInput = z.object({
  query: z.string().min(1),
  projectPath: z.string().min(1).optional(),
  maxFiles: z.number().int().min(EXPLORE_MAX_FILES.min).max(EXPLORE_MAX_FILES.max).default(EXPLORE_MAX_FILES.default),
  detailLevel: z.enum(['minimal', 'standard']).default('minimal'),
});

const ReviewInput = z.object({
  projectPath: z.string().min(1).optional(),
  diff: z.string().optional(),
  base: z.string().trim().min(1).optional(),
  head: z.string().trim().min(1).optional(),
  maxFiles: z.number().int().min(REVIEW_MAX_FILES.min).max(REVIEW_MAX_FILES.max).optional(),
  maxSymbols: z.number().int().min(REVIEW_MAX_SYMBOLS.min).max(REVIEW_MAX_SYMBOLS.max).optional(),
  detailLevel: z.enum(['minimal', 'standard']).default('minimal'),
});

const MAY_INITIALIZE_INDEX = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SERVER_INSTRUCTIONS = [
  'Prefer these code-deep MCP tools over shell commands.',
  'Do not probe the code-deep CLI when MCP tools are available.',
  'Refer to this capability as code-deep in user-facing messages. Do not tell the user you are switching to CodeGraph, which is only the internal backend.',
  'Use explore before broad reading/editing, with an absolute Git root and a query containing the task goal, symbols/files, and relationship to trace.',
  'Explore defaults to detailLevel minimal, which returns structural context plus the most relevant bounded source file. standard returns at most three bounded source files. Both expose explicit omission metadata and next source targets; use targeted follow-up queries for omitted source.',
  'Missing Git worktree indexes are initialized automatically before either tool runs.',
  'After changes use review for the working tree or a base/head range.',
  'Review defaults to detailLevel minimal. minimal returns the top three priorities; standard returns the top ten. Both are progressive projections without raw diff, impact text, or graph context; use targeted explore calls to verify a concrete failure path. Review projectPath is an absolute Git root and defaults to the server project when omitted. Choose exactly one source mode: omit diff/base/head for the current working tree, provide diff for a caller-supplied unified diff, or provide base with optional head for a Git range; diff cannot be combined with base/head and head requires base. Review maxFiles is an integer from 1 to 100 (default 20) and limits deeply analyzed changed files. Review maxSymbols is an integer from 1 to 50 (default 12) and limits mapped changed symbols queried for impact; do not send values above these hard limits. Both limits affect deep analysis only; response limits are independent, and global diff totals and risk signals still use the complete diff.',
  'Process reviewItems in descending risk order. Warnings, low confidence, or omitted files/symbols require targeted explore follow-ups.',
  'Risk prioritizes attention and does not prove a bug; verify a concrete failure path before emitting a comment.',
  'Both tools leave source files unchanged and share one persistent internal backend connection.',
].join(' ');

const EXPLORE_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  description: 'Progressive explore response metadata. The projected text is returned in content; these counters make response-only omissions explicit.',
  properties: {
    schemaVersion: { type: 'number', const: 1 },
    detailLevel: { type: 'string', enum: ['minimal', 'standard'] },
    originalCharacters: { type: 'number' },
    returnedCharacters: { type: 'number' },
    charactersOmitted: { type: 'number' },
    sourceFilesFound: { type: 'number' },
    sourceFilesReturned: { type: 'number' },
    sourceFilesOmitted: { type: 'number' },
    returnedSourceFiles: { type: 'array', items: { type: 'string' } },
    omittedSourceFiles: {
      type: 'array',
      description: 'Up to three omitted source files suitable for targeted follow-up queries.',
      items: { type: 'string' },
    },
    omittedSourceFilesUnlisted: { type: 'number' },
    truncated: { type: 'boolean' },
  },
  required: [
    'schemaVersion', 'detailLevel', 'originalCharacters', 'returnedCharacters',
    'charactersOmitted', 'sourceFilesFound', 'sourceFilesReturned',
    'sourceFilesOmitted', 'returnedSourceFiles', 'omittedSourceFiles',
    'omittedSourceFilesUnlisted', 'truncated',
  ],
  additionalProperties: false,
};

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
      description: 'Changed symbols sorted by descending risk. Minimal returns the top three and standard returns the top ten; reviewItemsOmitted reports the remainder.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          mappingConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          symbol: { type: 'object' },
          impact: {
            type: 'object',
            description: 'Compact impact evidence. affectedSymbols and testFiles are capped at three; matching *Omitted counters report projection truncation.',
          },
          tests: {
            type: 'object',
            description: 'Compact test evidence. status is linked, changed, missing, or unknown; file arrays are capped at three with matching *Omitted counters.',
          },
          risk: { type: 'object' },
        },
        required: ['id', 'file', 'symbol', 'mappingConfidence', 'impact', 'tests', 'risk'],
        additionalProperties: true,
      },
    },
    reviewItemsOmitted: {
      type: 'number',
      description: 'Review items omitted only from this response projection. Analysis coverage remains available in summary.symbolsAnalyzed.',
    },
    files: {
      type: 'array',
      description: 'Deeply analyzed changed files. Changed lines are represented as compact inclusive ranges; per-file graphWarnings identify symbol mapping degradation.',
      items: {
        type: 'object',
        properties: {
          changedLineCount: { type: 'number' },
          symbols: {
            type: 'array',
            description: 'Mapped changed symbols, capped at three for minimal and five for standard.',
            items: { type: 'object' },
          },
          symbolsOmitted: {
            type: 'number',
            description: 'Mapped symbols omitted from this file projection.',
          },
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
        required: ['symbols', 'symbolsOmitted', 'changedLineCount', 'changedLineRanges'],
        additionalProperties: true,
      },
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
    description: 'Use code-deep to explore focused source, call paths, and blast radius before broad reading or editing. Automatically initializes a missing worktree index. State the task goal, symbols/files, and relationship to trace. The progressive response always includes bounded source; use omission metadata for targeted follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Required focused exploration goal. Include relevant symbols/files and the relationship to trace, such as callers, callees, data flow, or blast radius.' },
        projectPath: { type: 'string', minLength: 1, description: 'Path to the absolute Git root. Defaults to the server project when omitted; provide it explicitly when the MCP server is installed globally or can serve multiple repositories.' },
        maxFiles: { type: 'number', minimum: EXPLORE_MAX_FILES.min, maximum: EXPLORE_MAX_FILES.max, default: EXPLORE_MAX_FILES.default, description: 'Maximum focused source files analyzed by the underlying exploration. Integer 1-50; default 12. MCP response projection is controlled independently by detailLevel.' },
        detailLevel: {
          type: 'string',
          enum: ['minimal', 'standard'],
          default: 'minimal',
          description: 'Response projection, not analysis scope. minimal returns structural context plus the most relevant bounded source file, capped at 8,000 characters; standard returns at most three bounded source files, capped at 20,000 characters.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: EXPLORE_OUTPUT_SCHEMA,
    annotations: MAY_INITIALIZE_INDEX,
  },
  {
    name: 'review',
    description: 'Use code-deep to build a structured, diff-aware review and automatically initialize a missing worktree index. Choose exactly one source mode (current working tree, caller-supplied diff, or base/head range); diff cannot be combined with base/head and head requires base. Process reviewItems in descending risk order, inspect warnings/omissions, use targeted explore follow-ups, and verify a concrete failure path before emitting a review comment.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', minLength: 1, description: 'Absolute Git root. Defaults to the server project when omitted; use the same projectPath supplied to explore.' },
        diff: { type: 'string', description: 'Caller-supplied unified diff. Use this as the only source selector; it cannot be combined with base or head. Omit it to read Git.' },
        base: { type: 'string', minLength: 1, description: 'Git base revision for a range review. Required when head is provided; omit base/head for the current working tree.' },
        head: { type: 'string', minLength: 1, description: 'Git head revision for a range review. Optional and defaults to HEAD when base is provided; requires base.' },
        maxFiles: { type: 'number', minimum: REVIEW_MAX_FILES.min, maximum: REVIEW_MAX_FILES.max, default: REVIEW_MAX_FILES.default, description: 'Maximum changed files to deeply analyze. Integer 1-100; default 20. It bounds symbol lookup, patch projection, and graph analysis only; all changed-file totals and global risk signals still use the complete diff.' },
        maxSymbols: { type: 'number', minimum: REVIEW_MAX_SYMBOLS.min, maximum: REVIEW_MAX_SYMBOLS.max, default: REVIEW_MAX_SYMBOLS.default, description: 'Maximum mapped changed symbols to query for impact. Integer 1-50; default 12. This is a hard limit: values above 50 are rejected. It affects deep symbol/impact analysis only; global diff totals and risk signals still use the complete diff.' },
        detailLevel: {
          type: 'string',
          enum: ['minimal', 'standard'],
          default: 'minimal',
          description: 'Response projection, not analysis scope. minimal returns the top three priorities; standard returns the top ten. Both omit raw diff, impact text, and graph context; use explore for focused verification.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    annotations: MAY_INITIALIZE_INDEX,
  },
];

export interface CodeDeepServerOptions {
  projectPath: string;
  bridge: GraphReader & { ensureProjectIndex?: (projectPath?: string) => Promise<void> };
  ensureIndex?: (projectPath: string) => Promise<void>;
}

export function createCodeDeepServer(options: CodeDeepServerOptions): Server {
  const server = new Server(
    { name: 'code-deep', version: CODE_DEEP_VERSION },
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
        const { detailLevel, ...exploreInput } = input;
        const projectPath = input.projectPath ?? options.projectPath;
        await indexEnsurer(options)(projectPath);
        const text = await options.bridge.callText('codegraph_explore', {
          query: exploreInput.query,
          maxFiles: exploreInput.maxFiles,
          projectPath,
        });
        return exploreResult(text, detailLevel);
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
      return errorResult(formatToolError(error, request.params.name));
    }
  });

  return server;
}

function indexEnsurer(options: CodeDeepServerOptions): (projectPath: string) => Promise<void> {
  if (options.ensureIndex) return options.ensureIndex;
  if (options.bridge.ensureProjectIndex) {
    return (projectPath) => options.bridge.ensureProjectIndex!(projectPath);
  }
  return ensureProjectIndex;
}

function exploreResult(
  text: string,
  detailLevel: ExploreDetailLevel,
): CallToolResult {
  const projection = projectExploreText(text, detailLevel);
  return {
    content: [{ type: 'text', text: projection.text }],
    structuredContent: { ...projection.metadata },
  };
}

function reportResult(
  report: ReviewReport,
  detailLevel: 'minimal' | 'standard',
): CallToolResult {
  const reviewItemLimit = REVIEW_RESPONSE_ITEMS[detailLevel];
  const nestedItemLimit = REVIEW_RESPONSE_NESTED_ITEMS[detailLevel];
  const fileSymbolLimit = REVIEW_RESPONSE_FILE_SYMBOLS[detailLevel];
  const structuredContent = {
    schemaVersion: 2,
    detailLevel,
    summary: report.summary,
    files: report.files.map(({
    changedLines,
    patch: _patch,
    graphSummary: _graphSummary,
    symbols,
    ...file
  }) => ({
    ...file,
    symbols: symbols.slice(0, fileSymbolLimit),
    symbolsOmitted: Math.max(0, symbols.length - fileSymbolLimit),
    changedLineCount: changedLines.length,
    changedLineRanges: compactLineRanges(changedLines),
    })),
    reviewItems: report.reviewItems
      .slice(0, reviewItemLimit)
      .map((item) => projectReviewItem(item, nestedItemLimit)),
    reviewItemsOmitted: Math.max(0, report.reviewItems.length - reviewItemLimit),
    riskSignals: report.riskSignals,
    ignoredPaths: report.ignoredPaths,
  };
  return {
    content: [{
      type: 'text',
      text: renderReviewMarkdown(report, {
        detailLevel,
        maxItems: reviewItemLimit,
        includeExtendedSections: false,
      }),
    }],
    structuredContent,
  };
}

function projectReviewItem(
  item: ReviewReport['reviewItems'][number],
  limit: number,
): Record<string, unknown> {
  return {
    ...item,
    impact: {
      ...item.impact,
      affectedSymbols: item.impact.affectedSymbols.slice(0, limit),
      affectedSymbolsOmitted: Math.max(0, item.impact.affectedSymbols.length - limit),
      testFiles: item.impact.testFiles.slice(0, limit),
      testFilesOmitted: Math.max(0, item.impact.testFiles.length - limit),
    },
    tests: {
      ...item.tests,
      relatedFiles: item.tests.relatedFiles.slice(0, limit),
      relatedFilesOmitted: Math.max(0, item.tests.relatedFiles.length - limit),
      changedFiles: item.tests.changedFiles.slice(0, limit),
      changedFilesOmitted: Math.max(0, item.tests.changedFiles.length - limit),
    },
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

function formatToolError(error: unknown, toolName: string): string {
  if (!(error instanceof z.ZodError)) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'head requires base') {
      return 'Invalid review input: head requires base. Provide base with head, or omit head.';
    }
    if (message === 'diff cannot be combined with base or head') {
      return 'Invalid review input: diff cannot be combined with base or head. Choose one source mode: diff, base/head, or the current working tree.';
    }
    if (message === 'base must not be empty' || message === 'head must not be empty') {
      return `Invalid review input: ${message}. Provide a non-empty Git revision.`;
    }
    return message;
  }

  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.') || 'input';
    const guidance = path === 'query'
      ? 'query is required and must be non-empty; state the goal, relevant symbols/files, and relationship to trace.'
      : path === 'projectPath'
        ? 'projectPath must be a non-empty path to an absolute Git root.'
        : path === 'diff'
          ? 'diff must be a caller-supplied unified diff and cannot be combined with base or head.'
          : path === 'base' || path === 'head'
            ? `${path} must be a non-empty Git revision.`
            : path === 'maxFiles'
              ? toolName === 'explore'
                ? `maxFiles must be an integer from ${EXPLORE_MAX_FILES.min} to ${EXPLORE_MAX_FILES.max} (default ${EXPLORE_MAX_FILES.default}); it limits focused source files returned.`
                : `maxFiles must be an integer from ${REVIEW_MAX_FILES.min} to ${REVIEW_MAX_FILES.max} (default ${REVIEW_MAX_FILES.default}); it limits deep file analysis only.`
              : path === 'maxSymbols'
                ? `maxSymbols must be an integer from ${REVIEW_MAX_SYMBOLS.min} to ${REVIEW_MAX_SYMBOLS.max} (default ${REVIEW_MAX_SYMBOLS.default}); it limits mapped symbols queried for impact only.`
                : path === 'detailLevel'
                  ? 'detailLevel must be either "minimal" (default) or "standard".'
                  : issue.message;
    return `${path}: ${guidance}`;
  });
  return `Invalid ${toolName} input. ${issues.join(' ')} Do not retry with the same invalid value.`;
}
