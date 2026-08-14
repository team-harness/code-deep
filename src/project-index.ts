import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { resolveCodeGraphBin } from './codegraph-bin.js';

export interface CodeGraphCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodeGraphCommandRunner = (
  args: string[],
) => Promise<CodeGraphCommandResult>;

export interface InitializeProjectIndexOptions {
  run?: CodeGraphCommandRunner;
  write?: (text: string) => void;
}

const pendingInitializations = new Map<string, Promise<void>>();

export async function ensureProjectIndex(
  requestedPath: string,
  options: Pick<InitializeProjectIndexOptions, 'run'> = {},
): Promise<void> {
  const projectPath = resolve(requestedPath);
  const repositoryRoot = await findRepositoryRoot(projectPath);
  const existingRoot = await findIndexRoot(projectPath, repositoryRoot);
  if (existingRoot) return;
  if (!repositoryRoot) {
    throw new Error(`Automatic code-deep initialization requires a Git repository: ${projectPath}`);
  }

  const pending = pendingInitializations.get(repositoryRoot);
  if (pending) return pending;

  const initialization = initializeProjectIndex(repositoryRoot, {
    ...options,
    write: () => {},
  }).then(async () => {
    if (!await isDirectory(join(repositoryRoot, '.codegraph'))) {
      throw new Error(`code-deep initialization completed without creating ${join(repositoryRoot, '.codegraph')}`);
    }
  }).catch(async (error: unknown) => {
    // Another process may have created the directory; a successful sync proves
    // that its index is usable instead of hiding a partial initialization.
    if (await isDirectory(join(repositoryRoot, '.codegraph'))) {
      await initializeProjectIndex(repositoryRoot, {
        ...options,
        write: () => {},
      });
      return;
    }
    throw error;
  }).finally(() => {
    if (pendingInitializations.get(repositoryRoot) === initialization) {
      pendingInitializations.delete(repositoryRoot);
    }
  });
  pendingInitializations.set(repositoryRoot, initialization);
  return initialization;
}

export async function initializeProjectIndex(
  requestedPath: string,
  options: InitializeProjectIndexOptions = {},
): Promise<void> {
  const projectPath = resolve(requestedPath);
  const repositoryRoot = await findRepositoryRoot(projectPath);
  const existingRoot = await findIndexRoot(projectPath, repositoryRoot);
  const targetPath = existingRoot ?? repositoryRoot ?? projectPath;
  const action = existingRoot ? 'Refreshing' : 'Initializing';
  const completed = existingRoot ? 'Refreshed' : 'Initialized';
  const args = existingRoot
    ? ['sync', targetPath, '--quiet']
    : ['init', targetPath];
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  write(`${action} code-deep index in ${targetPath}...\n`);
  const result = await (options.run ?? runCodeGraphCommand)(args);
  if (result.exitCode !== 0) {
    const detail = sanitizeBackendOutput(result.stderr.trim() || result.stdout.trim());
    throw new Error(detail || `code-deep index command exited with code ${result.exitCode}`);
  }
  write(`${completed} code-deep index in ${targetPath}.\n`);
}

async function findIndexRoot(
  startPath: string,
  repositoryRoot: string | null,
): Promise<string | null> {
  let current = startPath;
  const root = parse(startPath).root;
  while (true) {
    if (await isDirectory(join(current, '.codegraph'))) return current;
    if (current === repositoryRoot || current === root) return null;
    current = dirname(current);
  }
}

async function findRepositoryRoot(startPath: string): Promise<string | null> {
  let current = startPath;
  const root = parse(startPath).root;
  while (true) {
    if (await pathExists(join(current, '.git'))) return current;
    if (current === root) return null;
    current = dirname(current);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

async function runCodeGraphCommand(args: string[]): Promise<CodeGraphCommandResult> {
  const child = spawn(process.execPath, [resolveCodeGraphBin(), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`code-deep index process exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  return { exitCode, stdout, stderr };
}

function sanitizeBackendOutput(output: string): string {
  return output
    .replace(/"codegraph index" or "codegraph sync"/gi, '"code-deep init"')
    .replace(/codegraph (?:index|sync)/gi, 'code-deep init')
    .replace(/CodeGraph/g, 'code-deep')
    .replace(/codegraph/g, 'code-deep');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
