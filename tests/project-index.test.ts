import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureProjectIndex,
  initializeProjectIndex,
  type CodeGraphCommandRunner,
} from '../src/project-index.js';

describe('initializeProjectIndex', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      (path) => rm(path, { recursive: true, force: true }),
    ));
  });

  async function makeProject(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'code-intel-init-'));
    temporaryDirectories.push(path);
    return path;
  }

  it('initializes a new project with code-intel-owned output', async () => {
    const projectPath = await makeProject();
    const calls: string[][] = [];
    const output: string[] = [];
    const run: CodeGraphCommandRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: 'Initializing CodeGraph', stderr: '' };
    };

    await initializeProjectIndex(projectPath, {
      run,
      write: (text) => output.push(text),
    });

    expect(calls).toEqual([['init', projectPath]]);
    expect(output.join('')).toContain(`Initializing code-intel index in ${projectPath}`);
    expect(output.join('')).toContain(`Initialized code-intel index in ${projectPath}`);
    expect(output.join('')).not.toContain('CodeGraph');
  });

  it('refreshes an existing parent index instead of re-running init', async () => {
    const projectPath = await makeProject();
    const nestedPath = join(projectPath, 'src', 'feature');
    await mkdir(join(projectPath, '.codegraph'));
    await mkdir(nestedPath, { recursive: true });
    const calls: string[][] = [];
    const output: string[] = [];
    const run: CodeGraphCommandRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await initializeProjectIndex(nestedPath, {
      run,
      write: (text) => output.push(text),
    });

    expect(calls).toEqual([['sync', projectPath, '--quiet']]);
    expect(output.join('')).toContain(`Refreshing code-intel index in ${projectPath}`);
    expect(output.join('')).toContain(`Refreshed code-intel index in ${projectPath}`);
    expect(output.join('')).not.toContain('codegraph sync');
  });

  it('does not inherit an index from outside the current Git repository', async () => {
    const workspacePath = await makeProject();
    const projectPath = join(workspacePath, 'portable-agent-team');
    const nestedPath = join(projectPath, 'src');
    await mkdir(join(workspacePath, '.codegraph'));
    await mkdir(projectPath);
    await writeFile(join(projectPath, '.git'), 'gitdir: /tmp/example-worktree\n');
    await mkdir(nestedPath);
    const calls: string[][] = [];
    const output: string[] = [];
    const run: CodeGraphCommandRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await initializeProjectIndex(nestedPath, {
      run,
      write: (text) => output.push(text),
    });

    expect(calls).toEqual([['init', projectPath]]);
    expect(output.join('')).toContain(`Initializing code-intel index in ${projectPath}`);
    expect(output.join('')).not.toContain('Refreshing code-intel index');
  });

  it('rewrites backend branding and commands in failure diagnostics', async () => {
    const projectPath = await makeProject();
    const run: CodeGraphCommandRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'CodeGraph failed. Run "codegraph index" or "codegraph sync".',
    });

    await expect(initializeProjectIndex(projectPath, { run, write: () => {} }))
      .rejects.toThrow('code-intel failed. Run "code-intel init".');
  });
});

describe('ensureProjectIndex', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      (path) => rm(path, { recursive: true, force: true }),
    ));
  });

  async function makeWorkspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'code-intel-ensure-'));
    temporaryDirectories.push(path);
    return path;
  }

  it('automatically initializes a Git worktree once before first use', async () => {
    const workspacePath = await makeWorkspace();
    const worktreePath = join(workspacePath, 'feature-worktree');
    const nestedPath = join(worktreePath, 'src');
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(worktreePath, '.git'), 'gitdir: /tmp/example-worktree\n');
    const calls: string[][] = [];
    const run: CodeGraphCommandRunner = async (args) => {
      calls.push(args);
      await mkdir(join(worktreePath, '.codegraph'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await ensureProjectIndex(nestedPath, { run });
    await ensureProjectIndex(nestedPath, { run });

    expect(calls).toEqual([['init', worktreePath]]);
  });

  it('coalesces concurrent initialization attempts for the same worktree', async () => {
    const worktreePath = await makeWorkspace();
    await mkdir(join(worktreePath, '.git'));
    let calls = 0;
    const run: CodeGraphCommandRunner = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mkdir(join(worktreePath, '.codegraph'));
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await Promise.all([
      ensureProjectIndex(worktreePath, { run }),
      ensureProjectIndex(worktreePath, { run }),
    ]);

    expect(calls).toBe(1);
  });

  it('accepts a cross-process initialization race only after a successful sync', async () => {
    const worktreePath = await makeWorkspace();
    await mkdir(join(worktreePath, '.git'));
    const calls: string[][] = [];
    const run: CodeGraphCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'init') {
        await mkdir(join(worktreePath, '.codegraph'));
        return { exitCode: 1, stdout: '', stderr: 'index already exists' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await ensureProjectIndex(worktreePath, { run });

    expect(calls).toEqual([
      ['init', worktreePath],
      ['sync', worktreePath, '--quiet'],
    ]);
  });

  it('refuses to auto-initialize outside a Git repository', async () => {
    const projectPath = await makeWorkspace();
    const calls: string[][] = [];

    await expect(ensureProjectIndex(projectPath, {
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    })).rejects.toThrow('requires a Git repository');
    expect(calls).toEqual([]);
  });
});
