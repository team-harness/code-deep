import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCodeIntel,
  parseInstallTargets,
} from '../src/installer.js';
import { CODE_INTEL_VERSION } from '../src/version.js';

const PACKAGE_SPEC = `@team-harness/code-intel@${CODE_INTEL_VERSION}`;

describe('code-intel installer', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'code-intel-home-'));
    homes.push(home);
    return home;
  }

  it('parses a comma-separated target list and rejects unsupported targets', () => {
    expect(parseInstallTargets('codex,claude,codex')).toEqual(['codex', 'claude']);
    expect(() => parseInstallTargets('cursor')).toThrow('Unsupported install target: cursor');
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

    const first = await installCodeIntel({ homeDir, targets: ['codex'] });
    const installedConfig = await readFile(configPath, 'utf8');
    const installedInstructions = await readFile(instructionsPath, 'utf8');

    expect(installedConfig).toContain(originalConfig.trimEnd());
    expect(installedConfig).toContain('[mcp_servers.code-intel]\ncommand = "npx"');
    expect(installedConfig).toContain(`args = ["-y", "${PACKAGE_SPEC}", "mcp"]`);
    expect(installedInstructions).toContain('<!-- CODEGRAPH_START -->\nold rules\n<!-- CODEGRAPH_END -->');
    expect(installedInstructions).toContain('<!-- CODE_INTEL_START -->');
    expect(installedInstructions).toContain('absolute Git root as `projectPath`');
    expect(installedInstructions).toContain('task goal, relevant symbols or files, and the relationship');
    expect(installedInstructions).toContain('Process `reviewItems` in descending risk order');
    expect(installedInstructions).toContain('`linked`, `changed`, `missing`, or `unknown`');
    expect(installedInstructions).toContain('run a targeted `explore`');
    expect(installedInstructions).toContain('verify a concrete failure path');
    expect(installedInstructions).toContain(`npx -y ${PACKAGE_SPEC}`);
    expect(await readFile(`${configPath}.code-intel.bak`, 'utf8')).toBe(originalConfig);
    expect(first.files.map(({ action }) => action)).toEqual(['updated', 'updated']);

    const second = await installCodeIntel({ homeDir, targets: ['codex'] });
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
      '[mcp_servers."code-intel"]',
      'command = "old-command"',
      'args = ["old"]',
      '',
      '[mcp_servers.existing]',
      'command = "existing"',
      '',
    ].join('\n'));

    await installCodeIntel({ homeDir, targets: ['codex'] });

    const installed = await readFile(configPath, 'utf8');
    expect(installed.match(/\[mcp_servers\.(?:code-intel|"code-intel")\]/g)).toHaveLength(1);
    expect(installed).toContain('[mcp_servers.code-intel]\ncommand = "npx"');
    expect(installed).toContain(`args = ["-y", "${PACKAGE_SPEC}", "mcp"]`);
    expect(installed).toContain('[mcp_servers.existing]\ncommand = "existing"');
  });

  it('refuses an already duplicated equivalent Codex MCP table', async () => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    const duplicated = [
      '[mcp_servers.code-intel]',
      'command = "one"',
      '',
      '[mcp_servers."code-intel"]',
      'command = "two"',
      '',
    ].join('\n');
    await writeFile(configPath, duplicated);

    await expect(installCodeIntel({ homeDir, targets: ['codex'] }))
      .rejects.toThrow('declared more than once');
    expect(await readFile(configPath, 'utf8')).toBe(duplicated);
  });

  it.each([
    ['parent inline', '[mcp_servers]\n"code-intel" = { command = "old" }\n'],
    ['parent dotted', '[mcp_servers]\n"code-intel".command = "old"\n'],
    ['root inline', 'mcp_servers = { "code-intel" = { command = "old" } }\n'],
    ['root dotted', 'mcp_servers."code-intel".command = "old"\n'],
  ])('refuses the %s code-intel TOML representation', async (_name, existing) => {
    const homeDir = await makeHome();
    const codexDir = join(homeDir, '.codex');
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, 'config.toml');
    await writeFile(configPath, existing);

    await expect(installCodeIntel({ homeDir, targets: ['codex'] }))
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

    const first = await installCodeIntel({ homeDir, targets: ['claude'] });
    const mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, any>;
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    const instructions = await readFile(instructionsPath, 'utf8');

    expect(mcp.theme).toBe('dark');
    expect(mcp.mcpServers.existing).toEqual({ command: 'keep' });
    expect(mcp.mcpServers['code-intel']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', PACKAGE_SPEC, 'mcp'],
    });
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', 'mcp__code-intel__*']);
    expect(instructions).toContain('<!-- CODE_INTEL_START -->');
    expect(first.files.map(({ action }) => action)).toEqual(['updated', 'updated', 'updated']);

    const second = await installCodeIntel({ homeDir, targets: ['claude'] });
    expect(second.files.map(({ action }) => action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('refuses to overwrite malformed JSON', async () => {
    const homeDir = await makeHome();
    const malformed = '{ not-json';
    await writeFile(join(homeDir, '.claude.json'), malformed);

    await expect(installCodeIntel({ homeDir, targets: ['claude'] }))
      .rejects.toThrow('Cannot parse');
    expect(await readFile(join(homeDir, '.claude.json'), 'utf8')).toBe(malformed);
  });
});
