#!/usr/bin/env node

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import {
  formatExploreOutput,
  formatReviewOutput,
  parseCliDetailLevel,
  type CliDetailLevel,
} from './cli-output.js';
import { CodeDeepClient } from './client.js';
import { CodeGraphBridge } from './codegraph-bridge.js';
import { installCodeDeep, parseInstallMode, parseInstallTargets, type InstallMode } from './installer.js';
import { createCodeDeepServer } from './mcp-server.js';
import { initializeProjectIndex } from './project-index.js';
import { collectProcessReport, renderProcessReport } from './process-report.js';
import { CODE_DEEP_VERSION } from './version.js';

const program = new Command()
  .name('code-deep')
  .description('Progressive code exploration and review, with optional MCP integration')
  .version(CODE_DEEP_VERSION);

program
  .command('install')
  .description('Install CLI-first agent instructions, with optional MCP integration')
  .requiredOption('--target <targets>', 'Comma-separated targets: codex,claude')
  .option('--mode <mode>', 'Integration mode: cli or mcp', parseInstallMode, 'cli')
  .action(async (options: { target: string; mode: InstallMode }) => {
    const result = await installCodeDeep({
      homeDir: homedir(),
      targets: parseInstallTargets(options.target),
      mode: options.mode,
    });
    for (const file of result.files) {
      process.stdout.write(`${file.action.padEnd(9)} ${file.path}\n`);
      if (file.backupPath) process.stdout.write(`backup    ${file.backupPath}\n`);
    }
  });

program
  .command('ps')
  .alias('processes')
  .description('Inspect code-deep and CodeGraph process health (read-only)')
  .option('--json', 'Print the versioned JSON report')
  .action(async (options: { json?: boolean }) => {
    const report = await collectProcessReport();
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderProcessReport(report)}\n`);
  });

program
  .command('mcp')
  .description('Run the code-deep MCP server over stdio')
  .option('-p, --path <path>', 'Project root', process.cwd())
  .action(async (options: { path: string }) => {
    const projectPath = resolve(options.path);
    const bridge = new CodeGraphBridge({ projectPath });
    const server = createCodeDeepServer({ projectPath, bridge });
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
  .description('Initialize or refresh the code-deep index for a project')
  .action(async (path = process.cwd()) => {
    await initializeProjectIndex(path);
  });

program
  .command('explore <query...>')
  .description('Explore focused source, call paths, and blast radius')
  .option('-p, --path <path>', 'Project root', process.cwd())
  .option('--max-files <count>', 'Maximum source files', parsePositiveInteger, 12)
  .option('--detail <level>', 'Output detail: minimal, standard, or full', parseCliDetailLevel, 'minimal')
  .action(async (query: string[], options: { path: string; maxFiles: number; detail: CliDetailLevel }) => {
    const projectPath = resolve(options.path);
    const client = new CodeDeepClient({ projectPath });
    try {
      const text = await client.explore(query.join(' '), { maxFiles: options.maxFiles });
      process.stdout.write(`${formatExploreOutput(text, options.detail)}\n`);
    } finally {
      await client.close();
    }
  });

program
  .command('review [path]')
  .description('Build a risk-ordered review of the working tree or Git range')
  .option('--base <revision>', 'Git base revision')
  .option('--head <revision>', 'Git head revision; requires --base')
  .option('--detail <level>', 'Output detail: minimal, standard, or full', parseCliDetailLevel, 'minimal')
  .option('--json', 'Print projected JSON; use --detail full for the complete report')
  .action(async (
    path = process.cwd(),
    options: { base?: string; head?: string; detail: CliDetailLevel; json?: boolean },
  ) => {
    const projectPath = resolve(path);
    const client = new CodeDeepClient({ projectPath });
    try {
      const report = await client.review({
        base: options.base,
        head: options.head,
      });
      process.stdout.write(`${formatReviewOutput(report, options.detail, options.json ?? false)}\n`);
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

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`code-deep: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
