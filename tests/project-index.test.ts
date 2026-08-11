import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
