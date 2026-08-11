import parseDiff from 'parse-diff';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GraphReader {
  callText(name: string, args: Record<string, unknown>): Promise<string>;
}

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

export interface ReviewedFile {
  path: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  additions: number;
  deletions: number;
  changedLines: number[];
  symbols: ReviewSymbol[];
  graphSummary: string;
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

export interface ReviewReport {
  summary: {
    filesChanged: number;
    filesAnalyzed: number;
    filesOmitted: number;
    additions: number;
    deletions: number;
    riskScore: number;
    riskLevel: RiskLevel;
  };
  files: ReviewedFile[];
  impacts: SymbolImpact[];
  riskSignals: RiskSignal[];
  graphContext: string;
  markdown: string;
}

export class ReviewAnalyzer {
  constructor(private readonly graph: GraphReader) {}

  async analyze(request: ReviewRequest): Promise<ReviewReport> {
    const diff = request.diff ?? await readGitDiff(request);
    const parsed = parseDiff(diff);
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
      try {
        graphSummary = await this.graph.callText('codegraph_node', {
          file: path,
          symbolsOnly: true,
          projectPath: request.projectPath,
        });
        symbols = symbolsAtLines(parseSymbolMap(graphSummary), changedLines);
      } catch (error) {
        graphSummary = `CodeGraph lookup failed: ${errorMessage(error)}`;
      }

      files.push({
        path,
        status: fileStatus(file),
        additions: file.additions,
        deletions: file.deletions,
        changedLines,
        symbols,
        graphSummary,
        patch: filePatch(file, patchBudget),
      });
    }

    const changedSymbols = uniqueSymbols(files).slice(0, request.maxSymbols ?? 12);
    const impacts: SymbolImpact[] = [];
    for (const item of changedSymbols) {
      try {
        const details = await this.graph.callText('codegraph_impact', {
          symbol: item.symbol.name,
          file: item.file,
          depth: 2,
          projectPath: request.projectPath,
        });
        impacts.push({
          symbol: item.symbol.name,
          file: item.file,
          affectedCount: countListItems(details),
          details,
        });
      } catch (error) {
        impacts.push({
          symbol: item.symbol.name,
          file: item.file,
          affectedCount: 0,
          details: `CodeGraph impact lookup failed: ${errorMessage(error)}`,
        });
      }
    }

    const queryTerms = changedSymbols.length
      ? changedSymbols.map((item) => item.symbol.name)
      : files.map((file) => file.path);
    let graphContext = '';
    if (queryTerms.length) {
      try {
        graphContext = await this.graph.callText('codegraph_explore', {
          query: queryTerms.join(' '),
          maxFiles: Math.min(files.length + 4, 12),
          projectPath: request.projectPath,
        });
      } catch (error) {
        graphContext = `CodeGraph explore failed: ${errorMessage(error)}`;
      }
    }

    const filesOmitted = Math.max(0, parsed.length - files.length);
    const riskSignals = scoreRisk(files, impacts);
    if (filesOmitted) {
      riskSignals.push({
        code: 'analysis-truncated',
        score: 10,
        message: `${filesOmitted} changed file${filesOmitted === 1 ? ' was' : 's were'} omitted by maxFiles.`,
      });
    }
    const riskScore = Math.min(
      100,
      riskSignals.reduce((total, signal) => total + signal.score, 0),
    );
    const summary = {
      filesChanged: parsed.length,
      filesAnalyzed: files.length,
      filesOmitted,
      additions: parsed.reduce((total, file) => total + file.additions, 0),
      deletions: parsed.reduce((total, file) => total + file.deletions, 0),
      riskScore,
      riskLevel: riskLevel(riskScore),
    };
    const report: ReviewReport = {
      summary,
      files,
      impacts,
      riskSignals,
      graphContext,
      markdown: '',
    };
    report.markdown = renderReviewMarkdown(report);
    return report;
  }
}

async function readGitDiff(request: ReviewRequest): Promise<string> {
  if (request.head && !request.base) {
    throw new Error('ReviewRequest.head requires ReviewRequest.base');
  }
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
  const symbols: ReviewSymbol[] = [];
  const pattern = /^- `([^`]+)` \(([^)]+)\).* — :(\d+)$/gm;
  for (const match of text.matchAll(pattern)) {
    symbols.push({
      name: match[1]!,
      kind: match[2]!,
      line: Number(match[3]),
    });
  }
  return symbols.sort((left, right) => left.line - right.line);
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

function countListItems(text: string): number {
  const impactHeader = text.match(/\baffects\s+([\d,]+)\s+symbols?\b/i);
  if (impactHeader?.[1]) return Number(impactHeader[1].replaceAll(',', ''));
  return text.match(/^- /gm)?.length ?? 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scoreRisk(
  files: ReviewedFile[],
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
  const sourcePath = /\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kts?|swift|cs|php|rb|c|h|cc|cpp|cxx|hpp|scala|dart|lua|r|sol|sql|tf|nix|exs?|erl|hrl|fsx?|vb|vue|svelte|astro|sh)$/i;
  const sourceChanged = files.some((file) =>
    sourcePath.test(file.path) && !testPath.test(file.path),
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
    signals.push({ code: 'large-change', score: 20, message: `${churn} changed lines increase review breadth.` });
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

function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

export function renderReviewMarkdown(report: ReviewReport): string {
  const lines = [
    '# Code review intelligence',
    '',
    `Risk: **${report.summary.riskLevel} (${report.summary.riskScore}/100)**`,
    `Changes: ${report.summary.filesChanged} files, +${report.summary.additions}/-${report.summary.deletions}`,
    ...(report.summary.filesOmitted
      ? [`Analyzed: ${report.summary.filesAnalyzed}; omitted by maxFiles: ${report.summary.filesOmitted}`]
      : []),
    '',
    '## Changed symbols',
    '',
  ];
  for (const file of report.files) {
    const symbols = file.symbols.length
      ? file.symbols.map((symbol) => `${symbol.name}:${symbol.line}`).join(', ')
      : 'no mapped symbol';
    lines.push(`- ${file.path}: ${symbols}`);
  }
  if (report.riskSignals.length) {
    lines.push('', '## Risk signals', '');
    for (const signal of report.riskSignals) {
      lines.push(`- +${signal.score} ${signal.message}`);
    }
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
