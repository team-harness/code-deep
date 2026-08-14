import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.js';
import { CodeDeepClient } from '../src/index.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-codegraph-server.mjs', import.meta.url),
);

describe('CodeDeepClient', () => {
  it('exposes explore and review over one persistent CodeGraph connection', async () => {
    const client = new CodeDeepClient({
      projectPath: process.cwd(),
      command: process.execPath,
      args: [fixture],
    });

    try {
      const explored = JSON.parse(await client.explore('AuthService login')) as {
        pid: number;
        name: string;
        arguments: Record<string, unknown>;
      };
      const reviewed = await client.review({
        diff: [
          'diff --git a/src/auth.ts b/src/auth.ts',
          'index 1111111..2222222 100644',
          '--- a/src/auth.ts',
          '+++ b/src/auth.ts',
          '@@ -1 +1 @@',
          '-export const enabled = false;',
          '+export const enabled = true;',
        ].join('\n'),
      });
      const reviewContext = JSON.parse(reviewed.graphContext) as {
        pid: number;
        name: string;
      };

      expect(explored).toMatchObject({
        name: 'codegraph_explore',
        arguments: {
          query: 'AuthService login',
          maxFiles: 12,
          projectPath: process.cwd(),
        },
      });
      expect(reviewContext.name).toBe('codegraph_explore');
      expect(reviewContext.pid).toBe(explored.pid);
    } finally {
      await client.close();
    }
  });

  it('keeps bridge and analyzer implementation details out of the root API', () => {
    const exports = publicApi as Record<string, unknown>;

    expect(exports.CodeDeepClient).toBe(CodeDeepClient);
    expect(exports.CodeGraphBridge).toBeUndefined();
    expect(exports.ReviewAnalyzer).toBeUndefined();
  });

  it('validates review mode before attempting automatic initialization', async () => {
    const client = new CodeDeepClient({
      projectPath: '/not-a-git-repository',
      command: process.execPath,
      args: [fixture],
    });

    try {
      await expect(client.review({
        diff: 'diff --git a/a.ts b/a.ts',
        base: 'main',
      })).rejects.toThrow('diff cannot be combined with base or head');
    } finally {
      await client.close();
    }
  });
});
