import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { resolveCodeGraphBin } from './codegraph-bridge.js';

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

export async function initializeProjectIndex(
  requestedPath: string,
  options: InitializeProjectIndexOptions = {},
): Promise<void> {
  const projectPath = resolve(requestedPath);
  const existingRoot = await findIndexRoot(projectPath);
  const targetPath = existingRoot ?? projectPath;
  const action = existingRoot ? 'Refreshing' : 'Initializing';
  const completed = existingRoot ? 'Refreshed' : 'Initialized';
  const args = existingRoot
    ? ['sync', targetPath, '--quiet']
    : ['init', targetPath];
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  write(`${action} code-intel index in ${targetPath}...\n`);
  const result = await (options.run ?? runCodeGraphCommand)(args);
  if (result.exitCode !== 0) {
    const detail = sanitizeBackendOutput(result.stderr.trim() || result.stdout.trim());
    throw new Error(detail || `code-intel index command exited with code ${result.exitCode}`);
  }
  write(`${completed} code-intel index in ${targetPath}.\n`);
}

async function findIndexRoot(startPath: string): Promise<string | null> {
  let current = startPath;
  const root = parse(startPath).root;
  while (true) {
    if (await isDirectory(join(current, '.codegraph'))) return current;
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
      if (signal) reject(new Error(`code-intel index process exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  return { exitCode, stdout, stderr };
}

function sanitizeBackendOutput(output: string): string {
  return output
    .replace(/"codegraph index" or "codegraph sync"/gi, '"code-intel init"')
    .replace(/codegraph (?:index|sync)/gi, 'code-intel init')
    .replace(/CodeGraph/g, 'code-intel')
    .replace(/codegraph/g, 'code-intel');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
