#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { CodeGraphBridge, resolveCodeGraphBin } from './codegraph-bridge.js';
import { createCodeIntelServer } from './mcp-server.js';
import { ReviewAnalyzer } from './review.js';

const program = new Command()
  .name('code-intel')
  .description('Persistent CodeGraph MCP bridge for code exploration and review')
  .version('0.1.0');

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
    const bridge = new CodeGraphBridge({ projectPath });
    try {
      const text = await bridge.callText('codegraph_explore', {
        query: query.join(' '),
        maxFiles: options.maxFiles,
        projectPath,
      });
      process.stdout.write(`${text}\n`);
    } finally {
      await bridge.close();
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
    const bridge = new CodeGraphBridge({ projectPath });
    try {
      const report = await new ReviewAnalyzer(bridge).analyze({
        projectPath,
        base: options.base,
        head: options.head,
      });
      process.stdout.write(options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${report.markdown}\n`);
    } finally {
      await bridge.close();
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
