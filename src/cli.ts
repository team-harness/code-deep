#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { CodeIntelClient } from './client.js';
import { CodeGraphBridge, resolveCodeGraphBin } from './codegraph-bridge.js';
import { installCodeIntel, parseInstallTargets } from './installer.js';
import { createCodeIntelServer } from './mcp-server.js';

const program = new Command()
  .name('code-intel')
  .description('Persistent CodeGraph MCP bridge for code exploration and review')
  .version('0.2.0');

program
  .command('install')
  .description('Install code-intel MCP and agent instructions')
  .requiredOption('--target <targets>', 'Comma-separated targets: codex,claude')
  .action(async (options: { target: string }) => {
    const result = await installCodeIntel({
      homeDir: homedir(),
      targets: parseInstallTargets(options.target),
    });
    for (const file of result.files) {
      process.stdout.write(`${file.action.padEnd(9)} ${file.path}\n`);
      if (file.backupPath) process.stdout.write(`backup    ${file.backupPath}\n`);
    }
  });

program
  .command('mcp')
  .description('Run the code-intel MCP server over stdio')
  .option('-p, --path <path>', 'Project root', process.cwd())
  .action(async (options: { path: string }) => {
    const projectPath = resolve(options.path);
    const bridge = new CodeGraphBridge({ projectPath });
    const server = createCodeIntelServer({ projectPath, bridge });
    let closing = false;
    const close = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      await bridge.close();
    };
    server.onclose = () => { void close(); };
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
    await server.connect(new StdioServerTransport());
  });

program
  .command('init [path]')
  .description('Initialize or refresh the CodeGraph index for a project')
  .action(async (path = process.cwd()) => {
    await runCodeGraph(['init', resolve(path)]);
  });

program
  .command('explore <query...>')
  .description('Run one explore call for local diagnostics')
  .option('-p, --path <path>', 'Project root', process.cwd())
  .option('--max-files <count>', 'Maximum source files', parsePositiveInteger, 12)
  .action(async (query: string[], options: { path: string; maxFiles: number }) => {
    const projectPath = resolve(options.path);
    const client = new CodeIntelClient({ projectPath });
    try {
      const text = await client.explore(query.join(' '), { maxFiles: options.maxFiles });
      process.stdout.write(`${text}\n`);
    } finally {
      await client.close();
    }
  });

program
  .command('review [path]')
  .description('Review the current working tree or a Git base/head range')
  .option('--base <revision>', 'Git base revision')
  .option('--head <revision>', 'Git head revision; requires --base')
  .option('--json', 'Print the structured JSON report')
  .action(async (
    path = process.cwd(),
    options: { base?: string; head?: string; json?: boolean },
  ) => {
    const projectPath = resolve(path);
    const client = new CodeIntelClient({ projectPath });
    try {
      const report = await client.review({
        base: options.base,
        head: options.head,
      });
      process.stdout.write(options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${report.markdown}\n`);
    } finally {
      await client.close();
    }
  });

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

async function runCodeGraph(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [resolveCodeGraphBin(), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`CodeGraph exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`CodeGraph exited with code ${exitCode}`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`code-intel: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
