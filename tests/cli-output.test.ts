import { describe, expect, it } from 'vitest';
import {
  formatExploreOutput,
  formatReviewOutput,
  parseCliDetailLevel,
} from '../src/cli-output.js';
import type { ReviewReport } from '../src/review.js';

const report: ReviewReport = {
  schemaVersion: 1,
  summary: {
    filesChanged: 1,
    filesAnalyzed: 1,
    filesOmitted: 0,
    symbolsMapped: 1,
    symbolsAnalyzed: 1,
    symbolsOmitted: 0,
    additions: 9,
    deletions: 5,
    riskScore: 22,
    riskLevel: 'low',
  },
  files: [{
    path: 'src/example.ts',
    status: 'modified',
    additions: 9,
    deletions: 5,
    changedLines: [42, 45, 51, 52, 53],
    symbols: [{ name: 'example', kind: 'function', line: 42 }],
    graphSummary: 'raw graph output',
    graphConfidence: 'high',
    graphWarnings: [],
    patch: 'raw diff',
  }],
  impacts: [],
  reviewItems: [{
    id: 'src/example.ts:example:42',
    file: 'src/example.ts',
    symbol: { name: 'example', kind: 'function', line: 42 },
    mappingConfidence: 'high',
    impact: {
      affectedCount: 2,
      affectedSymbols: [],
      testFiles: ['tests/example.test.ts'],
      confidence: 'high',
      warnings: [],
    },
    tests: {
      status: 'linked',
      relatedFiles: ['tests/example.test.ts'],
      changedFiles: [],
    },
    risk: {
      score: 22,
      level: 'low',
      reasons: [{ code: 'wide-impact', score: 12, message: 'wide impact' }],
    },
  }],
  riskSignals: [],
  ignoredPaths: [],
  graphContext: 'raw context',
  markdown: '# Full review\n\nraw diff',
};

describe('CLI progressive output', () => {
  it('validates minimal, standard, and full detail levels', () => {
    expect(parseCliDetailLevel('minimal')).toBe('minimal');
    expect(parseCliDetailLevel('standard')).toBe('standard');
    expect(parseCliDetailLevel('full')).toBe('full');
    expect(() => parseCliDetailLevel('verbose')).toThrow('minimal, standard, or full');
  });

  it('projects explore output by default and preserves an explicit full response', () => {
    const source = [
      '**Exploration: example**',
      '',
      '**Source Code**',
      '',
      '**`src/example.ts`** - example',
      '',
      '```typescript',
      'export function example(): void {}',
      '```',
    ].join('\n');

    const minimal = formatExploreOutput(source, 'minimal');
    expect(minimal).toContain('Source Code (projected)');
    expect(minimal).toContain('export function example');
    expect(formatExploreOutput(source, 'full')).toBe(source);
  });

  it('uses compact review text and JSON unless full detail is requested', () => {
    expect(formatReviewOutput(report, 'minimal', false)).toContain('Review low:22');
    expect(formatReviewOutput(report, 'minimal', false)).not.toContain('raw diff');

    const compact = JSON.parse(formatReviewOutput(report, 'minimal', true)) as Record<string, unknown>;
    expect(compact.schemaVersion).toBe(3);
    expect(compact.detailLevel).toBe('minimal');

    expect(formatReviewOutput(report, 'full', false)).toBe(report.markdown);
    const full = JSON.parse(formatReviewOutput(report, 'full', true)) as Record<string, unknown>;
    expect(full.schemaVersion).toBe(1);
    expect(full.graphContext).toBe('raw context');
  });
});
