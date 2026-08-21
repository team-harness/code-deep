import { projectExploreText } from './explore-projection.js';
import type { ReviewReport } from './review.js';
import { projectReviewReport, renderCompactReviewText } from './review-projection.js';

export type CliDetailLevel = 'minimal' | 'standard' | 'full';

export function parseCliDetailLevel(value: string): CliDetailLevel {
  if (value === 'minimal' || value === 'standard' || value === 'full') return value;
  throw new Error(`Detail level must be minimal, standard, or full; received: ${value}`);
}

export function formatExploreOutput(text: string, detailLevel: CliDetailLevel): string {
  if (detailLevel === 'full') return text;
  return projectExploreText(text, detailLevel).text;
}

export function formatReviewOutput(
  report: ReviewReport,
  detailLevel: CliDetailLevel,
  json: boolean,
): string {
  if (detailLevel === 'full') {
    return json ? JSON.stringify(report, null, 2) : report.markdown;
  }
  return json
    ? JSON.stringify(projectReviewReport(report, detailLevel), null, 2)
    : renderCompactReviewText(report, detailLevel);
}
