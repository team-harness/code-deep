import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodeGraphBridge } from '../src/codegraph-bridge.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-codegraph-server.mjs', import.meta.url),
);

describe('CodeGraphBridge', () => {
  it('ensures the requested worktree index before connecting to CodeGraph', async () => {
    const ensured: string[] = [];
    const bridge = new CodeGraphBridge({
      projectPath: process.cwd(),
      command: process.execPath,
      args: [fixture],
      ensureIndex: async (projectPath) => { ensured.push(projectPath); },
    });

    try {
      await bridge.callText('codegraph_explore', {
        query: 'feature worktree',
        projectPath: '/worktrees/feature-a',
      });
      expect(ensured).toEqual(['/worktrees/feature-a']);
    } finally {
      await bridge.close();
    }
  });

  it('reuses one MCP child process across calls', async () => {
    const bridge = new CodeGraphBridge({
      projectPath: process.cwd(),
      command: process.execPath,
      args: [fixture],
      autoInit: false,
    });

    try {
      const first = await bridge.callText('codegraph_explore', { query: 'one' });
      const second = await bridge.callText('codegraph_explore', { query: 'two' });

      expect(JSON.parse(first).pid).toBe(JSON.parse(second).pid);
      expect(JSON.parse(second)).toMatchObject({
        name: 'codegraph_explore',
        arguments: { query: 'two' },
      });
    } finally {
      await bridge.close();
    }
  });

  it('reconnects and retries once when the child exits during a call', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'code-intel-bridge-'));
    const bridge = new CodeGraphBridge({
      projectPath: process.cwd(),
      command: process.execPath,
      args: [fixture],
      autoInit: false,
    });

    try {
      const result = await bridge.callText('codegraph_explore', {
        query: `crash-once:${join(temp, 'marker')}`,
      });
      expect(JSON.parse(result).name).toBe('codegraph_explore');
    } finally {
      await bridge.close();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('closes a child that is still connecting', async () => {
    const bridge = new CodeGraphBridge({
      projectPath: process.cwd(),
      command: process.execPath,
      args: [fixture, '--startup-delay=150'],
      autoInit: false,
    });

    const pending = bridge.callText('codegraph_explore', { query: 'pending' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.close();

    await expect(pending).rejects.toThrow(/closed/i);
  });
});
