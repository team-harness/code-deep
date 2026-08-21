import type { ReviewReport } from './review.js';

export type ReviewDetailLevel = 'minimal' | 'standard';

const REVIEW_ITEM_LIMIT = { minimal: 3, standard: 10 } as const;
const FILE_SYMBOL_LIMIT = { minimal: 3, standard: 5 } as const;
const NESTED_ITEM_LIMIT = 3;
const TEXT_ITEM_LIMIT = 3;

const STATUS_CODE = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
} as const;

export function projectReviewReport(
  report: ReviewReport,
  detailLevel: ReviewDetailLevel,
): Record<string, unknown> {
  const itemLimit = REVIEW_ITEM_LIMIT[detailLevel];
  const projectedItems = report.reviewItems
    .slice(0, itemLimit)
    .map(projectReviewItem);
  const omittedReviewItems = Math.max(0, report.reviewItems.length - itemLimit);

  return {
    schemaVersion: 3,
    detailLevel,
    summary: {
      risk: `${report.summary.riskLevel}:${report.summary.riskScore}`,
      scope: {
        files: `${report.summary.filesAnalyzed}/${report.summary.filesChanged}`,
        symbols: `${report.summary.symbolsAnalyzed}/${report.summary.symbolsMapped}`,
        delta: delta(report.summary.additions, report.summary.deletions),
      },
    },
    files: report.files.map((file) => projectFile(file, detailLevel)),
    reviewItems: projectedItems,
    ...(omittedReviewItems > 0 ? { omitted: { reviewItems: omittedReviewItems } } : {}),
    ...(report.riskSignals.length > 0
      ? { signals: report.riskSignals.map((signal) => `${signal.code}:+${signal.score}`) }
      : {}),
    ...(report.ignoredPaths.length > 0 ? { ignoredPaths: report.ignoredPaths } : {}),
  };
}

export function renderCompactReviewText(
  report: ReviewReport,
  detailLevel: ReviewDetailLevel,
): string {
  const lines = [
    `Review ${report.summary.riskLevel}:${report.summary.riskScore}`
      + ` | ${report.summary.filesChanged} files ${delta(report.summary.additions, report.summary.deletions)}`
      + ` | symbols ${report.summary.symbolsAnalyzed}/${report.summary.symbolsMapped}`,
  ];

  for (const [index, item] of report.reviewItems.slice(0, TEXT_ITEM_LIMIT).entries()) {
    const reasons = item.risk.reasons.map((reason) => reason.code).join(',');
    const mapping = item.mappingConfidence === 'high' ? '' : ` map:${item.mappingConfidence}`;
    lines.push(
      `${index + 1}. ${item.risk.level}:${item.risk.score} ${item.symbol.name}`
      + ` @ ${item.file}:${item.symbol.line}`
      + ` | tests:${item.tests.status}${mapping} impact:${item.impact.affectedCount}`
      + (reasons ? ` | ${reasons}` : ''),
    );
  }

  const structuredItems = Math.min(report.reviewItems.length, REVIEW_ITEM_LIMIT[detailLevel]);
  const additionalStructuredItems = Math.max(0, structuredItems - TEXT_ITEM_LIMIT);
  const omittedItems = Math.max(0, report.reviewItems.length - structuredItems);
  if (additionalStructuredItems > 0 || omittedItems > 0) {
    const parts = [
      ...(additionalStructuredItems > 0 ? [`+${additionalStructuredItems} priorities in structuredContent`] : []),
      ...(omittedItems > 0 ? [`${omittedItems} omitted`] : []),
    ];
    lines.push(parts.join('; '));
  }
  return lines.join('\n');
}

function projectFile(
  file: ReviewReport['files'][number],
  detailLevel: ReviewDetailLevel,
): Record<string, unknown> {
  const symbolLimit = FILE_SYMBOL_LIMIT[detailLevel];
  const symbols = file.symbols.slice(0, symbolLimit).map(compactSymbol);
  const omittedSymbols = Math.max(0, file.symbols.length - symbolLimit);
  const lines = compactLineRanges(file.changedLines);

  return {
    path: file.path,
    status: STATUS_CODE[file.status],
    delta: delta(file.additions, file.deletions),
    ...(lines ? { lines } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
    ...(omittedSymbols > 0 ? { omittedSymbols } : {}),
    ...(file.graphConfidence && file.graphConfidence !== 'high'
      ? { graphConfidence: file.graphConfidence }
      : {}),
    ...(file.graphWarnings && file.graphWarnings.length > 0
      ? { graphWarnings: file.graphWarnings }
      : {}),
  };
}

function projectReviewItem(
  item: ReviewReport['reviewItems'][number],
): Record<string, unknown> {
  const targets = unique(item.impact.affectedSymbols
    .filter((target) => !isExactSymbol(item, target))
    .filter((target) => !isFileNode(target.file, target.name, target.line))
    .filter((target) => !isTestPath(target.file))
    .map((target) => `${target.file}:${target.name}:${target.line}`));
  const testFiles = unique([...item.impact.testFiles, ...item.tests.relatedFiles]);
  const projectedTargets = targets.slice(0, NESTED_ITEM_LIMIT);
  const projectedTestFiles = testFiles.slice(0, NESTED_ITEM_LIMIT);
  const omittedTargets = Math.max(0, targets.length - projectedTargets.length);
  const omittedTestFiles = Math.max(0, testFiles.length - projectedTestFiles.length);

  return {
    symbol: `${item.symbol.kind} ${item.symbol.name} @ ${item.file}:${item.symbol.line}`,
    risk: `${item.risk.level}:${item.risk.score}`,
    ...(item.mappingConfidence !== 'high' ? { mapping: item.mappingConfidence } : {}),
    impact: item.impact.affectedCount,
    ...(item.impact.confidence !== 'high' ? { impactConfidence: item.impact.confidence } : {}),
    tests: item.tests.status,
    ...(item.risk.reasons.length > 0
      ? { reasons: item.risk.reasons.map((reason) => `${reason.code}:+${reason.score}`) }
      : {}),
    ...(projectedTargets.length > 0 ? { targets: projectedTargets } : {}),
    ...(omittedTargets > 0 ? { omittedTargets } : {}),
    ...(projectedTestFiles.length > 0 ? { testFiles: projectedTestFiles } : {}),
    ...(omittedTestFiles > 0 ? { omittedTestFiles } : {}),
    ...(item.impact.warnings.length > 0 ? { warnings: item.impact.warnings } : {}),
  };
}

function compactSymbol(symbol: ReviewReport['files'][number]['symbols'][number]): string {
  return `${symbol.kind} ${symbol.name}:${symbol.line}`;
}

function compactLineRanges(lines: number[]): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of lines) {
    const current = ranges.at(-1);
    if (current && line <= current.end + 1) {
      current.end = Math.max(current.end, line);
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges.map(({ start, end }) => start === end ? `${start}` : `${start}-${end}`).join(',');
}

function delta(additions: number, deletions: number): string {
  return `+${additions}/-${deletions}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isExactSymbol(
  item: ReviewReport['reviewItems'][number],
  target: ReviewReport['reviewItems'][number]['impact']['affectedSymbols'][number],
): boolean {
  return target.file === item.file
    && target.name === item.symbol.name
    && target.line === item.symbol.line;
}

function isFileNode(file: string, name: string, line: number): boolean {
  return line === 1 && file.split('/').at(-1) === name;
}

function isTestPath(file: string): boolean {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u.test(file);
}
