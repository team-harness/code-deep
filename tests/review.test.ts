import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ReviewAnalyzer } from '../src/review.js';

const exec = promisify(execFile);

const authDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -18,2 +18,4 @@ export function login() {
-  return issueToken(user)
+  validateSession(user)
+  return issueToken(user)
 }
`;

describe('ReviewAnalyzer', () => {
  it('maps changed hunks to symbols and collects graph impact', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const graph = {
      async callText(name: string, args: Record<string, unknown>): Promise<string> {
        calls.push({ name, args });
        if (name === 'codegraph_node') {
          return [
            '**src/auth.ts** — 2 symbols, used by 3 files: src/api.ts, src/app.ts, tests/auth.test.ts',
            '',
            '**Symbols**',
            '- `validateSession` (function) — :4',
            '- `login` (function) — :16',
          ].join('\n');
        }
        if (name === 'codegraph_impact') {
          return '**Impact: "login" affects 2 symbols**\n\n**src/api.ts:**\nloginRoute:4, App:12';
        }
        if (name === 'codegraph_explore') return 'verbatim graph context';
        throw new Error(`Unexpected tool: ${name}`);
      },
    };
    const analyzer = new ReviewAnalyzer(graph);

    const report = await analyzer.analyze({
      projectPath: '/repo',
      diff: authDiff,
    });

    expect(report.summary).toMatchObject({
      filesChanged: 1,
      additions: 2,
      deletions: 1,
    });
    expect(report.files[0]?.symbols).toEqual([
      { name: 'login', kind: 'function', line: 16 },
    ]);
    expect(report.impacts[0]).toMatchObject({
      symbol: 'login',
      file: 'src/auth.ts',
      affectedCount: 2,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.reviewItems[0]).toMatchObject({
      id: 'src/auth.ts:login:16',
      file: 'src/auth.ts',
      symbol: { name: 'login', kind: 'function', line: 16 },
      mappingConfidence: 'medium',
      impact: {
        affectedCount: 2,
        confidence: 'high',
      },
      tests: {
        status: 'missing',
        relatedFiles: [],
      },
    });
    expect(report.reviewItems[0]?.risk.reasons.map((reason) => reason.code)).toEqual([
      'sensitive-symbol',
      'tests-unlinked',
      'graph-impact',
    ]);
    expect(report.graphContext).toBe('verbatim graph context');
    expect(report.files[0]?.patch).toContain('+  validateSession(user)');
    expect(report.markdown).toContain('## Diff');
    expect(report.markdown).toContain('## Review priorities');
    expect(report.markdown).toContain('verbatim graph context');
    expect(calls.map((call) => call.name)).toEqual([
      'codegraph_node',
      'codegraph_impact',
      'codegraph_explore',
    ]);
  });

  it('produces an explainable risk score from changed paths and graph impact', async () => {
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return '- `rotateSession` (function) — :1';
        }
        if (name === 'codegraph_impact') {
          return Array.from({ length: 12 }, (_, index) => `- affected-${index}`).join('\n');
        }
        return 'security flow context';
      },
    };
    const analyzer = new ReviewAnalyzer(graph);
    const diff = `diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1 +1,2 @@
-export const rotateSession = oldRotation
+export function rotateSession() {}
+export const sessionVersion = 2
`;

    const report = await analyzer.analyze({ projectPath: '/repo', diff });

    expect(report.summary).toMatchObject({ riskScore: 60, riskLevel: 'high' });
    expect(report.riskSignals.map((signal) => signal.code)).toEqual([
      'sensitive-path',
      'tests-unchanged',
      'wide-impact',
    ]);
    expect(report.riskSignals.reduce((sum, signal) => sum + signal.score, 0)).toBe(60);
  });

  it('reviews tracked working-tree changes when no diff is supplied', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'code-intel-review-'));
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `answer` (variable) — :1';
        if (name === 'codegraph_impact') return '';
        return 'answer context';
      },
    };

    try {
      await exec('git', ['init', '-b', 'main'], { cwd: repo });
      await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src/value.ts'), 'export const answer = 41\n');
      await exec('git', ['add', '.'], { cwd: repo });
      await exec('git', ['commit', '-m', 'initial'], { cwd: repo });
      await writeFile(join(repo, 'src/value.ts'), 'export const answer = 42\n');
      await writeFile(join(repo, 'src/new.ts'), 'export const added = true\n');

      const report = await new ReviewAnalyzer(graph).analyze({ projectPath: repo });

      expect(report.files.map((file) => file.path).sort()).toEqual([
        'src/new.ts',
        'src/value.ts',
      ]);
      expect(report.summary).toMatchObject({ filesChanged: 2, additions: 2, deletions: 1 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reviews an explicit Git base and head range', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'code-intel-range-'));
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `answer` (variable) — :1';
        if (name === 'codegraph_impact') return '';
        return 'answer context';
      },
    };

    try {
      await exec('git', ['init', '-b', 'main'], { cwd: repo });
      await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await writeFile(join(repo, 'value.ts'), 'export const answer = 41\n');
      await exec('git', ['add', '.'], { cwd: repo });
      await exec('git', ['commit', '-m', 'initial'], { cwd: repo });
      const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
      await writeFile(join(repo, 'value.ts'), 'export const answer = 42\n');
      await exec('git', ['add', '.'], { cwd: repo });
      await exec('git', ['commit', '-m', 'change'], { cwd: repo });
      const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

      const report = await new ReviewAnalyzer(graph).analyze({
        projectPath: repo,
        base,
        head,
      });

      expect(report.files.map((file) => file.path)).toEqual(['value.ts']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('maps symbols declared after line one in a newly added file', async () => {
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `startServer` (function) — :4';
        if (name === 'codegraph_impact') return '';
        return 'server context';
      },
    };
    const diff = `diff --git a/src/server.ts b/src/server.ts
new file mode 100644
--- /dev/null
+++ b/src/server.ts
@@ -0,0 +1,5 @@
+import { listen } from './net.js'
+
+const port = 3000
+export function startServer() {
+  return listen(port)
`;

    const report = await new ReviewAnalyzer(graph).analyze({ projectPath: '/repo', diff });

    expect(report.files[0]?.symbols).toEqual([
      { name: 'startServer', kind: 'function', line: 4 },
    ]);
  });

  it.runIf(process.platform !== 'win32')('does not follow untracked symlinks outside the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'code-intel-symlink-repo-'));
    const outside = await mkdtemp(join(tmpdir(), 'code-intel-symlink-outside-'));
    const secret = join(outside, 'secret.txt');
    const graph = { async callText(): Promise<string> { return ''; } };

    try {
      await exec('git', ['init', '-b', 'main'], { cwd: repo });
      await exec('git', [
        '-c', 'user.name=Test',
        '-c', 'user.email=test@example.com',
        'commit', '--allow-empty', '-m', 'initial',
      ], { cwd: repo });
      await writeFile(secret, 'TOP_SECRET_CONTENT\n');
      await symlink(secret, join(repo, 'external-link'));

      const report = await new ReviewAnalyzer(graph).analyze({ projectPath: repo });

      expect(report.files[0]?.patch).toContain(secret);
      expect(report.files[0]?.patch).not.toContain('TOP_SECRET_CONTENT');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports files omitted by the review analysis limit', async () => {
    const graph = { async callText(): Promise<string> { return ''; } };
    const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-export const one = 1
+export const one = 2
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-export const two = 1
+export const two = 2
`;

    const report = await new ReviewAnalyzer(graph).analyze({
      projectPath: '/repo',
      diff,
      maxFiles: 1,
    });

    expect(report.summary).toMatchObject({
      filesChanged: 2,
      filesAnalyzed: 1,
      filesOmitted: 1,
      additions: 2,
      deletions: 2,
    });
    expect(report.riskSignals).toContainEqual(expect.objectContaining({
      code: 'analysis-truncated',
    }));
  });

  it('reports omitted symbols and distinguishes changed tests from linked tests', async () => {
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return '- `one` (function) — :1\n- `two` (function) — :2';
        }
        if (name === 'codegraph_impact') {
          return '**Impact: "one" affects 1 symbol**\n\n**src/value.ts:**\none:1';
        }
        return 'value context';
      },
    };
    const diff = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,2 +1,2 @@
-export function one() { return 1 }
-export function two() { return 2 }
+export function one() { return 10 }
+export function two() { return 20 }
diff --git a/tests/value.test.ts b/tests/value.test.ts
--- a/tests/value.test.ts
+++ b/tests/value.test.ts
@@ -1 +1 @@
-expect(one()).toBe(1)
+expect(one()).toBe(10)
`;

    const report = await new ReviewAnalyzer(graph).analyze({
      projectPath: '/repo',
      diff,
      maxSymbols: 1,
    });

    expect(report.summary).toMatchObject({
      symbolsMapped: 3,
      symbolsAnalyzed: 1,
      symbolsOmitted: 2,
    });
    expect(report.riskSignals).toContainEqual(expect.objectContaining({
      code: 'symbol-analysis-truncated',
    }));
    expect(report.reviewItems[0]?.tests.status).toBe('changed');
    expect(report.reviewItems[0]?.risk.reasons).toContainEqual(expect.objectContaining({
      code: 'tests-unlinked',
      score: 10,
    }));
  });

  it('reviews an initialized repository before its first commit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'code-intel-no-head-'));
    const graph = { async callText(): Promise<string> { return ''; } };

    try {
      await exec('git', ['init', '-b', 'main'], { cwd: repo });
      await writeFile(join(repo, 'first.ts'), 'export const first = true\n');

      const report = await new ReviewAnalyzer(graph).analyze({ projectPath: repo });

      expect(report.files.map((file) => file.path)).toEqual(['first.ts']);
      expect(report.summary).toMatchObject({ filesChanged: 1, additions: 1 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not require test changes for documentation-only diffs', async () => {
    const graph = { async callText(): Promise<string> { return ''; } };
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old docs
+new docs
`;

    const report = await new ReviewAnalyzer(graph).analyze({ projectPath: '/repo', diff });

    expect(report.riskSignals.map((signal) => signal.code)).not.toContain('tests-unchanged');
  });

  it('does not classify protocol schema constants as sensitive symbols', async () => {
    const graph = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return '- `GRAPH_ADAPTER_SCHEMA_VERSION` (constant) — :1';
        }
        if (name === 'codegraph_impact') {
          return '**Impact: "GRAPH_ADAPTER_SCHEMA_VERSION" affects 1 symbol**\n\n**src/graph-adapter.ts:**\nGRAPH_ADAPTER_SCHEMA_VERSION:1';
        }
        return 'adapter context';
      },
    };
    const diff = `diff --git a/src/graph-adapter.ts b/src/graph-adapter.ts
--- a/src/graph-adapter.ts
+++ b/src/graph-adapter.ts
@@ -1 +1 @@
-export const GRAPH_ADAPTER_SCHEMA_VERSION = 0
+export const GRAPH_ADAPTER_SCHEMA_VERSION = 1
`;

    const report = await new ReviewAnalyzer(graph).analyze({ projectPath: '/repo', diff });

    expect(report.reviewItems[0]?.risk.reasons.map((reason) => reason.code))
      .not.toContain('sensitive-symbol');
  });
});
