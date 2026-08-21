import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCodeDeep,
  parseInstallMode,
  parseInstallTargets,
} from '../src/installer.js';
import { CODE_DEEP_VERSION } from '../src/version.js';

const PACKAGE_SPEC = `@team-harness/code-deep@${CODE_DEEP_VERSION}`;

describe('code-deep installer', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'code-deep-home-'));
    homes.push(home);
    return home;
  }

  it('parses a comma-separated target list and rejects unsupported targets', () => {
    expect(parseInstallTargets('codex,claude,codex')).toEqual(['codex', 'claude']);
    expect(() => parseInstallTargets('cursor')).toThrow('Unsupported install target: cursor');
  });

  it('parses CLI and MCP install modes', () => {
    expect(parseInstallMode('cli')).toBe('cli');
    expect(parseInstallMode('mcp')).toBe('mcp');
    expect(() => parseInstallMode('daemon')).toThrow('Unsupported install mode: daemon');
  });

  it('defaults Codex installation to CLI guidance and removes managed MCP tables', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    const instructionsPath = join(codexDir, 'AGENTS.md');
    await writeFile(configPath, [
      'model = "gpt-5"',
      '',
      '[mcp_servers.code-deep]',
      'command = "code-deep"',
      'args = ["mcp"]',
      '',
      '[mcp_servers.existing]',
      'command = "existing"',
      '',
    ].join('\n'));

    const result = await installCodeDeep({ homeDir, targets: ['codex'] });
    const config = await readFile(configPath, 'utf8');
    const instructions = await readFile(instructionsPath, 'utf8');

    expect(config).not.toContain('mcp_servers.code-deep');
    expect(config).toContain('[mcp_servers.existing]\ncommand = "existing"');
    expect(instructions).toContain('code-deep explore');
    expect(instructions).toContain('--detail minimal');
    expect(instructions).not.toContain('Prefer the code-deep MCP tools');
    expect(result.files.map(({ action }) => action)).toEqual(['updated', 'created']);
  });

  it('defaults Claude installation to CLI guidance and removes managed MCP permissions', async () => {
    const homeDir = await makeHome();
    const claudeDir = join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const mcpPath = join(homeDir, '.claude.json');
    const settingsPath = join(claudeDir, 'settings.json');
    await writeFile(mcpPath, JSON.stringify({
      mcpServers: {
        existing: { command: 'keep' },
        'code-deep': { type: 'stdio', command: 'code-deep', args: ['mcp'] },
      },
    }, null, 2));
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ['mcp__code-deep__*', 'Bash(git status:*)'] },
    }, null, 2));

    const result = await installCodeDeep({ homeDir, targets: ['claude'] });
    const mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, any>;
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    const instructions = await readFile(join(claudeDir, 'CLAUDE.md'), 'utf8');

    expect(mcp.mcpServers).toEqual({ existing: { command: 'keep' } });
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)']);
    expect(instructions).toContain('code-deep review');
    expect(result.files.map(({ action }) => action)).toEqual(['updated', 'updated', 'created']);
  });

  it('keeps a fresh CLI-first install limited to instruction files and remains idempotent', async () => {
    const homeDir = await makeHome();

    const first = await installCodeDeep({ homeDir, targets: ['codex', 'claude'] });

    expect(first.files.map(({ path, action }) => [path.slice(homeDir.length), action])).toEqual([
      ['/.codex/AGENTS.md', 'created'],
      ['/.claude/CLAUDE.md', 'created'],
    ]);
    await expect(readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(homeDir, '.claude.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await installCodeDeep({ homeDir, targets: ['codex', 'claude'] });
    expect(second.files.map(({ action }) => action)).toEqual(['unchanged', 'unchanged']);
  });

  it('installs Codex MCP and exploration/review instructions without disturbing existing config', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    const instructionsPath = join(codexDir, 'AGENTS.md');
    const originalConfig = 'model = "gpt-5"\n\n[mcp_servers.existing]\ncommand = "existing"\n';
    await writeFile(configPath, originalConfig);
    await writeFile(instructionsPath, '# Personal rules\n\n<!-- CODEGRAPH_START -->\nold rules\n<!-- CODEGRAPH_END -->\n');

    const first = await installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' });
    const installedConfig = await readFile(configPath, 'utf8');
    const installedInstructions = await readFile(instructionsPath, 'utf8');

    expect(installedConfig).toContain(originalConfig.trimEnd());
    expect(installedConfig).toContain('[mcp_servers.code-deep]\ncommand = "code-deep"');
    expect(installedConfig).toContain('args = ["mcp"]');
    expect(installedInstructions).toContain('<!-- CODEGRAPH_START -->\nold rules\n<!-- CODEGRAPH_END -->');
    expect(installedInstructions).toContain('<!-- CODE_DEEP_START -->');
    expect(installedInstructions).toContain('absolute Git root as `projectPath`');
    expect(installedInstructions).toContain('task goal, relevant symbols or files, and the relationship');
    expect(installedInstructions).toContain('Process `reviewItems` in descending risk order');
    expect(installedInstructions).toContain('`linked`, `changed`, `missing`, or `unknown`');
    expect(installedInstructions).toContain('run a targeted `explore`');
    expect(installedInstructions).toContain('verify a concrete failure path');
    expect(installedInstructions).toContain('automatically initializes');
    expect(installedInstructions).not.toContain('ask the user to run `code-deep init`');
    expect(installedInstructions).toContain('Prefer the code-deep MCP tools');
    expect(installedInstructions).toContain('Do not probe or invoke the shell CLI');
    expect(installedInstructions).toContain('Refer to the capability, server, and tools as `code-deep`');
    expect(installedInstructions).toContain('Do not describe a fallback as switching to CodeGraph');
    expect(installedInstructions).toContain(`npx -y ${PACKAGE_SPEC}`);
    expect(await readFile(`${configPath}.code-deep.bak`, 'utf8')).toBe(originalConfig);
    expect(first.files.map(({ action }) => action)).toEqual(['updated', 'updated']);

    const second = await installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' });
    expect(second.files.map(({ action }) => action)).toEqual(['unchanged', 'unchanged']);
    expect(await readFile(configPath, 'utf8')).toBe(installedConfig);
    expect(await readFile(instructionsPath, 'utf8')).toBe(installedInstructions);
  });

  it('updates an equivalent quoted Codex MCP table without declaring it twice', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    await writeFile(configPath, [
      'model = "gpt-5"',
      '',
      '[mcp_servers."code-deep"]',
      'command = "old-command"',
      'args = ["old"]',
      '',
      '[mcp_servers.existing]',
      'command = "existing"',
      '',
    ].join('\n'));

    await installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' });

    const installed = await readFile(configPath, 'utf8');
    expect(installed.match(/\[mcp_servers\.(?:code-deep|"code-deep")\]/g)).toHaveLength(1);
    expect(installed).toContain('[mcp_servers.code-deep]\ncommand = "code-deep"');
    expect(installed).toContain('args = ["mcp"]');
    expect(installed).toContain('[mcp_servers.existing]\ncommand = "existing"');
  });

  it('migrates a legacy Codex MCP table and instruction block to code-deep', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    const instructionsPath = join(codexDir, 'AGENTS.md');
    await writeFile(configPath, [
      'model = "gpt-5"',
      '',
      '[mcp_servers.code-intel]',
      'command = "code-intel"',
      'args = ["mcp"]',
      '',
      '[mcp_servers.existing]',
      'command = "existing"',
      '',
    ].join('\n'));
    await writeFile(instructionsPath, [
      '# Personal rules',
      '',
      '<!-- CODE_INTEL_START -->',
      'legacy instructions',
      '<!-- CODE_INTEL_END -->',
      '',
    ].join('\n'));

    await installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' });

    const config = await readFile(configPath, 'utf8');
    const instructions = await readFile(instructionsPath, 'utf8');
    expect(config).toContain('[mcp_servers.code-deep]\ncommand = "code-deep"');
    expect(config).not.toContain('[mcp_servers.code-intel]');
    expect(config).toContain('[mcp_servers.existing]\ncommand = "existing"');
    expect(instructions).toContain('<!-- CODE_DEEP_START -->');
    expect(instructions).not.toContain('<!-- CODE_INTEL_START -->');
  });

  it('refuses an already duplicated equivalent Codex MCP table', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    const duplicated = [
      '[mcp_servers.code-deep]',
      'command = "one"',
      '',
      '[mcp_servers."code-deep"]',
      'command = "two"',
      '',
    ].join('\n');
    await writeFile(configPath, duplicated);

    await expect(installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' }))
      .rejects.toThrow('declared more than once');
    expect(await readFile(configPath, 'utf8')).toBe(duplicated);
  });

  it.each([
    ['parent inline', '[mcp_servers]\n"code-deep" = { command = "old" }\n'],
    ['parent dotted', '[mcp_servers]\n"code-deep".command = "old"\n'],
    ['root inline', 'mcp_servers = { "code-deep" = { command = "old" } }\n'],
    ['root dotted', 'mcp_servers."code-deep".command = "old"\n'],
  ])('refuses the %s code-deep TOML representation', async (_name, existing) => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    await writeFile(configPath, existing);

    await expect(installCodeDeep({ homeDir, targets: ['codex'], mode: 'mcp' }))
      .rejects.toThrow('inline or dotted representation');
    expect(await readFile(configPath, 'utf8')).toBe(existing);
  });

  it('installs Claude MCP, permissions, and instructions while preserving siblings', async () => {
    const homeDir = await makeHome();
    const claudeDir = join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const mcpPath = join(homeDir, '.claude.json');
    const settingsPath = join(claudeDir, 'settings.json');
    const instructionsPath = join(claudeDir, 'CLAUDE.md');
    await writeFile(mcpPath, JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'keep' } } }, null, 2));
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] } }, null, 2));
    await writeFile(instructionsPath, '# Existing Claude rules\n');

    const first = await installCodeDeep({ homeDir, targets: ['claude'], mode: 'mcp' });
    const mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, any>;
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    const instructions = await readFile(instructionsPath, 'utf8');

    expect(mcp.theme).toBe('dark');
    expect(mcp.mcpServers.existing).toEqual({ command: 'keep' });
    expect(mcp.mcpServers['code-deep']).toEqual({
      type: 'stdio',
      command: 'code-deep',
      args: ['mcp'],
    });
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', 'mcp__code-deep__*']);
    expect(instructions).toContain('<!-- CODE_DEEP_START -->');
    expect(first.files.map(({ action }) => action)).toEqual(['updated', 'updated', 'updated']);

    const second = await installCodeDeep({ homeDir, targets: ['claude'], mode: 'mcp' });
    expect(second.files.map(({ action }) => action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('migrates legacy Claude MCP configuration and permission to code-deep', async () => {
    const homeDir = await makeHome();
    const claudeDir = join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const mcpPath = join(homeDir, '.claude.json');
    const settingsPath = join(claudeDir, 'settings.json');
    await writeFile(mcpPath, JSON.stringify({
      mcpServers: {
        existing: { command: 'keep' },
        'code-intel': { type: 'stdio', command: 'code-intel', args: ['mcp'] },
      },
    }, null, 2));
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ['mcp__code-intel__*', 'Bash(git status:*)'] },
    }, null, 2));

    await installCodeDeep({ homeDir, targets: ['claude'], mode: 'mcp' });

    const mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, any>;
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    expect(mcp.mcpServers['code-deep']).toEqual({
      type: 'stdio',
      command: 'code-deep',
      args: ['mcp'],
    });
    expect(mcp.mcpServers['code-intel']).toBeUndefined();
    expect(mcp.mcpServers.existing).toEqual({ command: 'keep' });
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', 'mcp__code-deep__*']);
  });

  it('refuses to overwrite malformed JSON', async () => {
    const homeDir = await makeHome();
    const malformed = '{ not-json';
    await writeFile(join(homeDir, '.claude.json'), malformed);

    await expect(installCodeDeep({ homeDir, targets: ['claude'], mode: 'mcp' }))
      .rejects.toThrow('Cannot parse');
    expect(await readFile(join(homeDir, '.claude.json'), 'utf8')).toBe(malformed);
  });
});
