import { describe, expect, it } from 'vitest';
import { CodeGraphAdapter } from '../src/graph-adapter.js';

describe('CodeGraphAdapter', () => {
  it('normalizes symbol and impact text into a versioned structure', async () => {
    const reader = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return [
            '**src/auth.ts** — 2 symbols, used by 2 files: src/api.ts, tests/auth.test.ts',
            '',
            '**Symbols**',
            '- `validateSession` (function) — :4',
            '- `login` (function) (user: User): Token — :16',
          ].join('\r\n');
        }
        if (name === 'codegraph_impact') {
          return [
            '**Impact: "login" affects 3 symbols**',
            '',
            '**src/auth.ts:**',
            'login:16',
            '',
            '**src/api.ts:**',
            'loginRoute:4',
            '',
            '**tests/auth.test.ts:**',
            'login test:12',
          ].join('\n');
        }
        return 'login graph context';
      },
    };
    const adapter = new CodeGraphAdapter(reader);

    const catalog = await adapter.getSymbols('src/auth.ts', '/repo');
    const impact = await adapter.getImpact('login', 'src/auth.ts', '/repo');

    expect(catalog).toMatchObject({
      schemaVersion: 1,
      file: 'src/auth.ts',
      confidence: 'high',
      warnings: [],
      symbols: [
        { name: 'validateSession', kind: 'function', line: 4 },
        { name: 'login', kind: 'function', line: 16 },
      ],
    });
    expect(impact).toMatchObject({
      schemaVersion: 1,
      symbol: 'login',
      affectedCount: 3,
      confidence: 'high',
      warnings: [],
      affectedSymbols: [
        { file: 'src/auth.ts', name: 'login', line: 16 },
        { file: 'src/api.ts', name: 'loginRoute', line: 4 },
        { file: 'tests/auth.test.ts', name: 'login test', line: 12 },
      ],
      testFiles: ['tests/auth.test.ts'],
    });
  });

  it('surfaces an explicit warning instead of silently accepting unknown impact text', async () => {
    const adapter = new CodeGraphAdapter({
      async callText(): Promise<string> {
        return 'backend format changed';
      },
    });

    const impact = await adapter.getImpact('login', 'src/auth.ts', '/repo');

    expect(impact).toMatchObject({
      affectedCount: 0,
      confidence: 'low',
      warnings: ['unrecognized-impact-format'],
    });
  });
});
