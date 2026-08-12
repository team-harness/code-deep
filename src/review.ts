import parseDiff from 'parse-diff';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CodeGraphAdapter,
  type GraphImpact,
  type GraphReader,
  isTestPath,
  parseSymbolCatalog,
} from './graph-adapter.js';

const exec = promisify(execFile);
const PRODUCTION_SOURCE_PATH = /\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kts?|swift|cs|php|rb|c|h|cc|cpp|cxx|hpp|scala|dart|lua|r|sol|sql|tf|nix|exs?|erl|hrl|fsx?|vb|vue|svelte|astro|sh)$/i;
// Mirrors the built-in extension map in the exact CodeGraph dependency version.
const CODEGRAPH_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.ets', '.js', '.mjs', '.cjs', '.xsjs', '.xsjslib',
  '.jsx', '.py', '.pyw', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc', '.cxx',
  '.hpp', '.hxx', '.cs', '.cshtml', '.razor', '.php', '.module', '.install', '.theme',
  '.inc', '.yml', '.yaml', '.twig', '.rb', '.rake', '.swift', '.kt', '.kts', '.dart',
  '.liquid', '.svelte', '.vue', '.astro', '.r', '.pas', '.dpr', '.dpk', '.lpr', '.dfm',
  '.fmx', '.scala', '.sc', '.lua', '.luau', '.m', '.mm', '.sol', '.cfc', '.cfm', '.cfs',
  '.metal', '.cu', '.cuh', '.nix', '.xml', '.cbl', '.cob', '.cobol', '.cpy', '.vb',
  '.erl', '.hrl', '.escript', '.properties', '.tf', '.tfvars', '.tofu',
]);
const NON_SENSITIVE_SYMBOLS = new Set(['GRAPH_ADAPTER_SCHEMA_VERSION']);

export type { GraphReader } from './graph-adapter.js';

export interface ReviewRequest {
  projectPath: string;
  diff?: string;
  base?: string;
  head?: string;
  maxFiles?: number;
  maxSymbols?: number;
}

export interface ReviewSymbol {
  name: string;
  kind: string;
  line: number;
}

export type ReviewConfidence = 'high' | 'medium' | 'low';

export interface ReviewedFile {
  path: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  additions: number;
  deletions: number;
  changedLines: number[];
  symbols: ReviewSymbol[];
  graphSummary: string;
  graphConfidence?: ReviewConfidence;
  graphWarnings?: string[];
  patch: string;
}

export interface SymbolImpact {
  symbol: string;
  file: string;
  affectedCount: number;
  details: string;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskSignal {
  code: string;
  score: number;
  message: string;
}

export type ReviewTestStatus = 'linked' | 'changed' | 'missing' | 'unknown';

export interface ReviewItemRisk {
  score: number;
  level: RiskLevel;
  reasons: RiskSignal[];
}

export interface ReviewAffectedSymbol {
  file: string;
  name: string;
  line: number;
}

export interface ReviewItemImpact {
  affectedCount: number;
  affectedSymbols: ReviewAffectedSymbol[];
  testFiles: string[];
  confidence: ReviewConfidence;
  warnings: string[];
}

export interface ReviewItem {
  id: string;
  file: string;
  symbol: ReviewSymbol;
  mappingConfidence: ReviewConfidence;
  impact: ReviewItemImpact;
  tests: {
    status: ReviewTestStatus;
    relatedFiles: string[];
    changedFiles: string[];
  };
  risk: ReviewItemRisk;
}

export interface ReviewReport {
  schemaVersion: 1;
  summary: {
    filesChanged: number;
    filesAnalyzed: number;
    filesOmitted: number;
    symbolsMapped: number;
    symbolsAnalyzed: number;
    symbolsOmitted: number;
    additions: number;
    deletions: number;
    riskScore: number;
    riskLevel: RiskLevel;
  };
  files: ReviewedFile[];
  impacts: SymbolImpact[];
  reviewItems: ReviewItem[];
  riskSignals: RiskSignal[];
  graphContext: string;
  markdown: string;
}

export class ReviewAnalyzer {
  private readonly graph: CodeGraphAdapter;

  constructor(reader: GraphReader) {
    this.graph = new CodeGraphAdapter(reader);
  }

  async analyze(request: ReviewRequest): Promise<ReviewReport> {
    validateReviewRequest(request);
    const diff = request.diff ?? await readGitDiff(request);
    const parsed = parseDiff(diff);
    const graphExtensionOverrides = await loadCodeGraphExtensionOverrides(request.projectPath);
    const riskFiles = parsed.flatMap((file) => {
      const path = reviewPath(file);
      return path ? [{
        path,
        status: fileStatus(file),
        additions: file.additions,
        deletions: file.deletions,
      }] : [];
    });
    const selected = parsed.slice(0, request.maxFiles ?? 20);
    const patchBudget = Math.max(
      2_000,
      Math.min(10_000, Math.floor(50_000 / Math.max(selected.length, 1))),
    );
    const files: ReviewedFile[] = [];

    for (const file of selected) {
      const path = reviewPath(file);
      if (!path) continue;
      const changedLines = changedLineNumbers(file);
      let graphSummary = '';
      let symbols: ReviewSymbol[] = [];
      let graphConfidence: ReviewConfidence = 'low';
      let graphWarnings: string[] = [];
      if (isCodeGraphSourcePath(path, graphExtensionOverrides)) {
        try {
          const catalog = await this.graph.getSymbols(path, request.projectPath);
          graphSummary = catalog.rawText;
          graphConfidence = catalog.confidence;
          graphWarnings = catalog.warnings;
          symbols = symbolsAtLines(catalog.symbols, changedLines);
        } catch (error) {
          graphSummary = `CodeGraph lookup failed: ${errorMessage(error)}`;
          graphWarnings = ['symbol-lookup-failed'];
        }
      }

      files.push({
        path,
        status: fileStatus(file),
        additions: file.additions,
        deletions: file.deletions,
        changedLines,
        symbols,
        graphSummary,
        graphConfidence,
        graphWarnings,
        patch: filePatch(file, isDocumentationPath(path, graphExtensionOverrides) ? 2_000 : patchBudget),
      });
    }

    const mappedSymbols = uniqueSymbols(files);
    const changedSymbols = mappedSymbols.slice(0, request.maxSymbols ?? 12);
    const symbolsOmitted = Math.max(0, mappedSymbols.length - changedSymbols.length);
    const impacts: SymbolImpact[] = [];
    const structuredImpacts = new Map<string, GraphImpact>();
    for (const item of changedSymbols) {
      try {
        const impact = await this.graph.getImpact(
          item.symbol.name,
          item.file,
          request.projectPath,
        );
        structuredImpacts.set(reviewItemId(item.file, item.symbol), impact);
        impacts.push({
          symbol: item.symbol.name,
          file: item.file,
          affectedCount: impact.affectedCount,
          details: impact.rawText,
        });
      } catch (error) {
        const details = `CodeGraph impact lookup failed: ${errorMessage(error)}`;
        structuredImpacts.set(
          reviewItemId(item.file, item.symbol),
          failedGraphImpact(item.symbol.name, item.file, details),
        );
        impacts.push({
          symbol: item.symbol.name,
          file: item.file,
          affectedCount: 0,
          details,
        });
      }
    }

    const changedTestFiles = riskFiles
      .map((file) => file.path)
      .filter((path) => isTestPath(path));
    const reviewItems = changedSymbols
      .map((item) => buildReviewItem(
        item.file,
        item.symbol,
        files,
        structuredImpacts.get(reviewItemId(item.file, item.symbol))!,
        changedTestFiles,
      ))
      .sort((left, right) => right.risk.score - left.risk.score || left.id.localeCompare(right.id));

    const queryTerms = changedSymbols.length
      ? changedSymbols.map((item) => item.symbol.name)
      : files
        .filter((file) => isCodeGraphSourcePath(file.path, graphExtensionOverrides))
        .map((file) => file.path);
    let graphContext = '';
    if (queryTerms.length) {
      try {
        graphContext = (await this.graph.explore(
          queryTerms.join(' '),
          request.projectPath,
          Math.min(files.length + 4, 12),
        )).text;
      } catch (error) {
        graphContext = `CodeGraph explore failed: ${errorMessage(error)}`;
      }
    }

    const filesOmitted = Math.max(0, parsed.length - files.length);
    const riskSignals = scoreRisk(riskFiles, impacts);
    const analysisWarnings = collectAnalysisWarnings(files, reviewItems, graphContext);
    if (analysisWarnings.length) {
      riskSignals.push({
        code: 'graph-analysis-incomplete',
        score: 25,
        message: `${analysisWarnings.length} CodeGraph warning${analysisWarnings.length === 1 ? '' : 's'} make this review incomplete; inspect Analysis warnings and run targeted explore calls.`,
      });
    }
    if (filesOmitted) {
      riskSignals.push({
        code: 'analysis-truncated',
        score: 10,
        message: `${filesOmitted} changed file${filesOmitted === 1 ? ' was' : 's were'} omitted by maxFiles.`,
      });
    }
    if (symbolsOmitted) {
      riskSignals.push({
        code: 'symbol-analysis-truncated',
        score: 10,
        message: `${symbolsOmitted} mapped symbol${symbolsOmitted === 1 ? ' was' : 's were'} omitted by maxSymbols.`,
      });
    }
    const globalRiskScore = Math.min(
      100,
      riskSignals.reduce((total, signal) => total + signal.score, 0),
    );
    const highestItemRisk = Math.max(0, ...reviewItems.map((item) => item.risk.score));
    const riskScore = Math.max(globalRiskScore, highestItemRisk);
    const summary = {
      filesChanged: parsed.length,
      filesAnalyzed: files.length,
      filesOmitted,
      symbolsMapped: mappedSymbols.length,
      symbolsAnalyzed: changedSymbols.length,
      symbolsOmitted,
      additions: parsed.reduce((total, file) => total + file.additions, 0),
      deletions: parsed.reduce((total, file) => total + file.deletions, 0),
      riskScore,
      riskLevel: riskLevel(riskScore),
    };
    const report: ReviewReport = {
      schemaVersion: 1,
      summary,
      files,
      impacts,
      reviewItems,
      riskSignals,
      graphContext,
      markdown: '',
    };
    report.markdown = renderReviewMarkdown(report);
    return report;
  }
}

async function readGitDiff(request: ReviewRequest): Promise<string> {
  const execOptions = {
    cwd: request.projectPath,
    encoding: 'utf8' as const,
    maxBuffer: 20 * 1024 * 1024,
  };
  try {
    const { stdout: insideWorkTree } = await exec(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      execOptions,
    );
    if (insideWorkTree.trim() !== 'true') {
      throw new Error('not a Git working tree');
    }

    let stdout = '';
    if (request.base) {
      const target = `${request.base}...${request.head ?? 'HEAD'}`;
      ({ stdout } = await exec(
        'git',
        ['diff', '--no-ext-diff', '--unified=0', target, '--'],
        execOptions,
      ));
    } else {
      let hasHead = true;
      try {
        await exec('git', ['rev-parse', '--verify', 'HEAD'], execOptions);
      } catch {
        hasHead = false;
      }
      if (hasHead) {
        ({ stdout } = await exec(
          'git',
          ['diff', '--no-ext-diff', '--unified=0', 'HEAD', '--'],
          execOptions,
        ));
      }
    }
    if (request.base) return stdout;

    const { stdout: untrackedOutput } = await exec(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      execOptions,
    );
    const untrackedPaths = untrackedOutput.split('\0').filter(Boolean);
    const untrackedDiffs = await Promise.all(
      untrackedPaths.map((path) => untrackedFileDiff(request.projectPath, path)),
    );
    return [stdout, ...untrackedDiffs].filter(Boolean).join('\n');
  } catch (error) {
    throw new Error(
      `Unable to read Git diff in ${request.projectPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function untrackedFileDiff(projectPath: string, path: string): Promise<string> {
  if (path.includes('\n') || path.includes('\r')) return '';
  const absolutePath = join(projectPath, path);
  const metadata = await lstat(absolutePath);
  const symlink = metadata.isSymbolicLink();
  const mode = symlink ? '120000' : '100644';
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    '--- /dev/null',
    `+++ b/${path}`,
  ];
  if (!symlink && metadata.size > 2 * 1024 * 1024) {
    return [...header, `Binary files /dev/null and b/${path} differ`, ''].join('\n');
  }

  const data = symlink
    ? Buffer.from(await readlink(absolutePath), 'utf8')
    : await readFile(absolutePath);
  if (!symlink && data.includes(0)) {
    return [...header, `Binary files /dev/null and b/${path} differ`, ''].join('\n');
  }
  const content = data.toString('utf8');
  if (!content) return [...header, ''].join('\n');
  const endsWithNewline = !symlink && content.endsWith('\n');
  const lines = endsWithNewline
    ? content.slice(0, -1).split('\n')
    : content.split('\n');
  return [
    ...header,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(endsWithNewline ? [] : ['\\ No newline at end of file']),
    '',
  ].join('\n');
}

function reviewPath(file: parseDiff.File): string | null {
  if (file.to && file.to !== '/dev/null') return file.to;
  if (file.from && file.from !== '/dev/null') return file.from;
  return null;
}

function fileStatus(file: parseDiff.File): ReviewedFile['status'] {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';
  if (file.from && file.to && file.from !== file.to) return 'renamed';
  return 'modified';
}

function filePatch(file: parseDiff.File, maxChars: number): string {
  const patch = file.chunks
    .map((chunk) => [chunk.content, ...chunk.changes.map((change) => change.content)].join('\n'))
    .join('\n');
  if (patch.length <= maxChars) return patch;
  return `${patch.slice(0, maxChars)}\n... (diff truncated for this file)`;
}

function changedLineNumbers(file: parseDiff.File): number[] {
  const lines = new Set<number>();
  for (const chunk of file.chunks) {
    let hasAddedLine = false;
    for (const change of chunk.changes) {
      if (change.type !== 'add') continue;
      lines.add(change.ln);
      hasAddedLine = true;
    }
    if (!hasAddedLine) lines.add(chunk.newStart);
  }
  return [...lines].sort((left, right) => left - right);
}

export function parseSymbolMap(text: string): ReviewSymbol[] {
  return parseSymbolCatalog('', text).symbols;
}

function symbolsAtLines(symbols: ReviewSymbol[], lines: number[]): ReviewSymbol[] {
  const selected = new Map<string, ReviewSymbol>();
  for (const line of lines) {
    let nearest: ReviewSymbol | undefined;
    for (const symbol of symbols) {
      if (symbol.line > line) break;
      nearest = symbol;
    }
    if (nearest) selected.set(`${nearest.name}:${nearest.line}`, nearest);
  }
  return [...selected.values()];
}

function uniqueSymbols(files: ReviewedFile[]): Array<{ file: string; symbol: ReviewSymbol }> {
  const unique = new Map<string, { file: string; symbol: ReviewSymbol }>();
  for (const file of files) {
    for (const symbol of file.symbols) {
      const key = `${file.path}:${symbol.name}:${symbol.line}`;
      unique.set(key, { file: file.path, symbol });
    }
  }
  return [...unique.values()];
}

function reviewItemId(file: string, symbol: ReviewSymbol): string {
  return `${file}:${symbol.name}:${symbol.line}`;
}

function failedGraphImpact(symbol: string, file: string, details: string): GraphImpact {
  return {
    schemaVersion: 1,
    symbol,
    file,
    affectedCount: 0,
    affectedSymbols: [],
    testFiles: [],
    confidence: 'low',
    warnings: ['impact-lookup-failed'],
    rawText: details,
  };
}

function buildReviewItem(
  filePath: string,
  symbol: ReviewSymbol,
  files: ReviewedFile[],
  impact: GraphImpact,
  changedTestFiles: string[],
): ReviewItem {
  const file = files.find((candidate) => candidate.path === filePath);
  const mappingConfidence = symbolMappingConfidence(file, symbol);
  const tests = testEvidence(impact, changedTestFiles);
  const reasons: RiskSignal[] = [];

  if (isSensitiveReviewTarget(filePath, symbol.name)) {
    reasons.push({
      code: 'sensitive-symbol',
      score: 25,
      message: `${symbol.name} is in a security or data-sensitive path.`,
    });
  }
  if (tests.status === 'missing') {
    reasons.push({
      code: 'tests-unlinked',
      score: 20,
      message: `No related test symbol was found in the impact graph for ${symbol.name}.`,
    });
  } else if (tests.status === 'changed') {
    reasons.push({
      code: 'tests-unlinked',
      score: 10,
      message: `Test files changed, but none were linked to ${symbol.name} in the impact graph.`,
    });
  }
  if (impact.affectedCount >= 10) {
    reasons.push({
      code: 'wide-impact',
      score: 20,
      message: `${symbol.name} can affect ${impact.affectedCount} indexed symbols.`,
    });
  } else if (impact.affectedCount >= 5) {
    reasons.push({
      code: 'wide-impact',
      score: 12,
      message: `${symbol.name} can affect ${impact.affectedCount} indexed symbols.`,
    });
  } else if (impact.affectedCount > 0) {
    reasons.push({
      code: 'graph-impact',
      score: 5,
      message: `${symbol.name} reaches ${impact.affectedCount} indexed symbols.`,
    });
  }
  const crossedBoundaries = crossBoundaryTargets(filePath, impact);
  if (mappingConfidence !== 'low' && impact.confidence === 'high' && crossedBoundaries.length) {
    reasons.push({
      code: 'cross-boundary-impact',
      score: 10,
      message: `${symbol.name} reaches ${crossedBoundaries.join(', ')} outside its source boundary.`,
    });
  }
  if (mappingConfidence === 'low') {
    reasons.push({
      code: 'mapping-uncertain',
      score: 5,
      message: `The changed lines could not be mapped to ${symbol.name} with confidence.`,
    });
  }
  const changedLines = file ? file.additions + file.deletions : 0;
  if (changedLines >= 100) {
    reasons.push({
      code: 'large-file-change',
      score: changedLines >= 500 ? 20 : 12,
      message: `${changedLines} lines changed in ${filePath}.`,
    });
  }

  const score = Math.min(100, reasons.reduce((total, reason) => total + reason.score, 0));
  return {
    id: reviewItemId(filePath, symbol),
    file: filePath,
    symbol,
    mappingConfidence,
    impact: {
      affectedCount: impact.affectedCount,
      affectedSymbols: impact.affectedSymbols,
      testFiles: impact.testFiles,
      confidence: impact.confidence,
      warnings: impact.warnings,
    },
    tests,
    risk: {
      score,
      level: riskLevel(score),
      reasons,
    },
  };
}

function crossBoundaryTargets(filePath: string, impact: GraphImpact): string[] {
  const sourceBoundary = structuralBoundary(filePath);
  if (!sourceBoundary) return [];
  return [...new Set(
    impact.affectedSymbols
      .filter((symbol) => !isTestPath(symbol.file))
      .map((symbol) => structuralBoundary(symbol.file))
      .filter((boundary): boundary is string => boundary !== null && boundary !== sourceBoundary),
  )].sort();
}

function structuralBoundary(path: string): string | null {
  const segments = path.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean);
  const sourceIndex = segments.findIndex((segment) => segment === 'src');
  const workspaceIndex = segments.findIndex((segment) =>
    /^(?:apps|packages|services|modules|libs)$/i.test(segment),
  );
  if (
    workspaceIndex >= 0
    && (sourceIndex === -1 || workspaceIndex < sourceIndex)
    && segments[workspaceIndex + 2]
  ) {
    return `${segments[workspaceIndex]}/${segments[workspaceIndex + 1]}`;
  }
  if (sourceIndex >= 0 && segments[sourceIndex + 2]) {
    return segments.slice(0, sourceIndex + 2).join('/');
  }
  return null;
}

function symbolMappingConfidence(
  file: ReviewedFile | undefined,
  symbol: ReviewSymbol,
): ReviewConfidence {
  if (!file || file.graphConfidence === 'low') return 'low';
  return file.changedLines.includes(symbol.line) ? 'high' : 'medium';
}

function testEvidence(
  impact: GraphImpact,
  changedTestFiles: string[],
): ReviewItem['tests'] {
  if (impact.testFiles.length) {
    return {
      status: 'linked',
      relatedFiles: impact.testFiles,
      changedFiles: changedTestFiles.filter((path) => impact.testFiles.includes(path)),
    };
  }
  if (changedTestFiles.length) {
    return { status: 'changed', relatedFiles: [], changedFiles: changedTestFiles };
  }
  if (impact.confidence === 'low') {
    return { status: 'unknown', relatedFiles: [], changedFiles: [] };
  }
  return { status: 'missing', relatedFiles: [], changedFiles: [] };
}

function isSensitiveReviewTarget(file: string, symbol = ''): boolean {
  const sensitivePath = /(?:^|[/_.-])(auth|security|permission|payment|billing|migration|schema|crypto|secret)(?:[/_.-]|$)/i;
  if (NON_SENSITIVE_SYMBOLS.has(symbol)) return sensitivePath.test(file);
  const sensitiveWords = new Set([
    'auth', 'authentication', 'authorization', 'oauth', 'login', 'password',
    'token', 'session', 'crypt', 'crypto', 'secret', 'credential', 'permission',
    'payment', 'billing', 'encrypt', 'decrypt', 'sign', 'signature', 'verify',
    'migration', 'migrate', 'schema',
  ]);
  const symbolWords = symbol
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return sensitivePath.test(file) || symbolWords.some((word) =>
    sensitiveWords.has(word)
    || (word.endsWith('s') && sensitiveWords.has(word.slice(0, -1))),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scoreRisk(
  files: Array<Pick<ReviewedFile, 'path' | 'status' | 'additions' | 'deletions'>>,
  impacts: SymbolImpact[],
): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const sensitive = files.filter((file) =>
    /(?:^|[/_.-])(auth|security|permission|payment|billing|migration|schema|crypto|secret)(?:[/_.-]|$)/i.test(file.path),
  );
  if (sensitive.length) {
    signals.push({
      code: 'sensitive-path',
      score: 25,
      message: `Security or data-sensitive paths changed: ${sensitive.map((file) => file.path).join(', ')}`,
    });
  }

  const testPath = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
  const sourceChanged = files.some((file) =>
    isProductionSourcePath(file.path) && !testPath.test(file.path),
  );
  const testsChanged = files.some((file) => testPath.test(file.path));
  if (sourceChanged && !testsChanged) {
    signals.push({
      code: 'tests-unchanged',
      score: 15,
      message: 'Production code changed without a corresponding test-file change.',
    });
  }

  const widestImpact = Math.max(0, ...impacts.map((impact) => impact.affectedCount));
  if (widestImpact >= 10) {
    signals.push({
      code: 'wide-impact',
      score: 20,
      message: `At least one changed symbol can affect ${widestImpact} indexed symbols.`,
    });
  } else if (widestImpact >= 5) {
    signals.push({
      code: 'wide-impact',
      score: 12,
      message: `At least one changed symbol can affect ${widestImpact} indexed symbols.`,
    });
  } else if (widestImpact > 0) {
    signals.push({
      code: 'graph-impact',
      score: 5,
      message: `The change reaches ${widestImpact} indexed symbol${widestImpact === 1 ? '' : 's'}.`,
    });
  }

  const churn = files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  if (churn >= 500) {
    signals.push({ code: 'large-change', score: 25, message: `${churn} changed lines require a broad review.` });
  } else if (churn >= 100) {
    signals.push({ code: 'large-change', score: 12, message: `${churn} changed lines increase review breadth.` });
  } else if (churn >= 30) {
    signals.push({ code: 'change-size', score: 5, message: `${churn} lines changed.` });
  }

  if (files.length >= 10) {
    signals.push({ code: 'many-files', score: 15, message: `${files.length} files changed.` });
  } else if (files.length >= 5) {
    signals.push({ code: 'many-files', score: 8, message: `${files.length} files changed.` });
  }

  const deletedFiles = files.filter((file) => file.status === 'deleted').length;
  if (deletedFiles) {
    signals.push({
      code: 'deleted-files',
      score: 10,
      message: `${deletedFiles} file${deletedFiles === 1 ? '' : 's'} deleted; base-revision symbols may not be present in the current graph.`,
    });
  }
  return signals;
}

function isProductionSourcePath(path: string): boolean {
  return PRODUCTION_SOURCE_PATH.test(path);
}

function isDocumentationPath(path: string, overrides = new Set<string>()): boolean {
  if (isCodeGraphSourcePath(path, overrides)) return false;
  return /(?:^|\/)(?:docs?|\.codestable)(?:\/|$)|\.(?:md|mdx|rst|adoc|txt)$/i.test(path);
}

function isCodeGraphSourcePath(path: string, overrides: Set<string>): boolean {
  const normalized = path.toLowerCase();
  if (
    normalized === 'conf/routes'
    || normalized.endsWith('/conf/routes')
    || normalized.endsWith('.routes')
    || /\.app(?:\.src)?$/.test(normalized)
    || /(?:^|\/)(?:templates|sections)\/.+\.json$/.test(normalized)
  ) {
    return true;
  }
  const dot = normalized.lastIndexOf('.');
  if (dot === -1) return false;
  const extension = normalized.slice(dot);
  return CODEGRAPH_SOURCE_EXTENSIONS.has(extension) || overrides.has(extension);
}

async function loadCodeGraphExtensionOverrides(projectPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(projectPath, 'codegraph.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.extensions)) return new Set();
    const extensions = new Set<string>();
    for (const [rawExtension, language] of Object.entries(parsed.extensions)) {
      if (typeof language !== 'string') continue;
      let extension = rawExtension.trim().toLowerCase();
      if (!extension.startsWith('.')) extension = `.${extension}`;
      if (extension.length > 1 && !extension.slice(1).includes('.') && !/[\\/]/.test(extension)) {
        extensions.add(extension);
      }
    }
    return extensions;
  } catch {
    return new Set();
  }
}

export function validateReviewRequest(request: ReviewRequest): void {
  if (request.base !== undefined && !request.base.trim()) {
    throw new Error('base must not be empty');
  }
  if (request.head !== undefined && !request.head.trim()) {
    throw new Error('head must not be empty');
  }
  if (request.head !== undefined && request.base === undefined) {
    throw new Error('head requires base');
  }
  if (request.diff !== undefined && (request.base !== undefined || request.head !== undefined)) {
    throw new Error('diff cannot be combined with base or head');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

export function renderReviewMarkdown(
  report: ReviewReport,
  options: { detailLevel?: 'minimal' | 'standard' } = {},
): string {
  const detailLevel = options.detailLevel ?? 'standard';
  const analysisWarnings = collectAnalysisWarnings(
    report.files,
    report.reviewItems,
    report.graphContext,
  );
  const lines = [
    '# Code review intelligence',
    '',
    `Risk: **${report.summary.riskLevel} (${report.summary.riskScore}/100)**`,
    `Changes: ${report.summary.filesChanged} files, +${report.summary.additions}/-${report.summary.deletions}`,
    ...(report.summary.filesOmitted
      ? [`Analyzed: ${report.summary.filesAnalyzed}; omitted by maxFiles: ${report.summary.filesOmitted}`]
      : []),
    ...(report.summary.symbolsOmitted
      ? [`Mapped symbols: ${report.summary.symbolsMapped}; analyzed: ${report.summary.symbolsAnalyzed}; omitted by maxSymbols: ${report.summary.symbolsOmitted}`]
      : []),
    '',
    '## Review priorities',
    '',
  ];
  if (report.reviewItems.length) {
    const reviewItems = detailLevel === 'minimal'
      ? report.reviewItems.slice(0, 3)
      : report.reviewItems;
    for (const item of reviewItems) {
      const reasons = item.risk.reasons.length
        ? item.risk.reasons.map((reason) => reason.code).join(', ')
        : 'no elevated signals';
      lines.push(
        `- **${item.risk.level} ${item.risk.score}/100** ${item.symbol.name} (${item.file}:${item.symbol.line})`,
        `  Tests: ${item.tests.status}; mapping: ${item.mappingConfidence}; impact: ${item.impact.affectedCount}; reasons: ${reasons}`,
      );
    }
    const reviewItemsOmitted = detailLevel === 'minimal'
      ? Math.max(0, report.reviewItems.length - reviewItems.length)
      : 0;
    if (reviewItemsOmitted) {
      lines.push(`- ${reviewItemsOmitted} additional review items omitted; request detailLevel standard for the complete list.`);
    }
  } else {
    const documentationFiles = report.files
      .filter((file) => isDocumentationPath(file.path))
      .map((file) => file.path);
    if (analysisWarnings.length) {
      lines.push('- No changed symbols were mapped because graph analysis was incomplete; inspect the warnings below.');
    } else if (documentationFiles.length) {
      lines.push(`- Review documentation directly (${documentationFiles.join(', ')}): validate claims, links, examples, and acceptance criteria; symbol mapping does not apply.`);
    } else {
      lines.push('- Review changed files directly; no symbols were mapped for graph-based prioritization.');
    }
  }
  if (analysisWarnings.length) {
    lines.push('', '## Analysis warnings', '');
    for (const warning of analysisWarnings) lines.push(`- ${warning}`);
  }
  if (report.riskSignals.length) {
    lines.push('', '## Risk signals', '');
    for (const signal of report.riskSignals) {
      lines.push(`- +${signal.score} ${signal.message}`);
    }
  }
  if (detailLevel === 'minimal') return lines.join('\n');

  lines.push(
    '',
    '## Changed symbols',
    '',
  );
  for (const file of report.files) {
    const symbols = file.symbols.length
      ? file.symbols.map((symbol) => `${symbol.name}:${symbol.line}`).join(', ')
      : isDocumentationPath(file.path) ? 'documentation; symbol mapping not applicable' : 'no mapped symbol';
    lines.push(`- ${file.path}: ${symbols}`);
  }
  lines.push('', '## Impact', '');
  for (const impact of report.impacts) {
    lines.push(`- ${impact.symbol} (${impact.file}): ${impact.affectedCount} affected symbols`);
  }
  lines.push('', '## Diff', '');
  for (const file of report.files) {
    if (!file.patch) continue;
    lines.push(`### ${file.path}`, '', '~~~diff', file.patch, '~~~', '');
  }
  if (report.graphContext) {
    lines.push('## CodeGraph context', '', report.graphContext);
  }
  return lines.join('\n');
}

function collectAnalysisWarnings(
  files: ReviewedFile[],
  reviewItems: ReviewItem[],
  graphContext: string,
): string[] {
  const warnings = new Set<string>();
  for (const file of files) {
    for (const warning of file.graphWarnings ?? []) {
      warnings.add(`${file.path}: ${warning}`);
    }
  }
  for (const item of reviewItems) {
    for (const warning of item.impact.warnings) {
      warnings.add(`${item.file}:${item.symbol.line} ${item.symbol.name}: ${warning}`);
    }
  }
  if (graphContext.startsWith('CodeGraph explore failed:')) {
    warnings.add(`explore: ${graphContext}`);
  }
  return [...warnings];
}
