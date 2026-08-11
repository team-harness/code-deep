import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export type InstallTarget = 'codex' | 'claude';
export type InstallAction = 'created' | 'updated' | 'unchanged';

export interface InstallFileResult {
  path: string;
  action: InstallAction;
  backupPath?: string;
}

export interface InstallResult {
  files: InstallFileResult[];
}

export interface InstallCodeIntelOptions {
  homeDir: string;
  targets: InstallTarget[];
}

const MCP_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@team-harness/code-intel', 'mcp'],
};

const INSTRUCTIONS_START = '<!-- CODE_INTEL_START -->';
const INSTRUCTIONS_END = '<!-- CODE_INTEL_END -->';
const INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_START}
## code-intel

In repositories with a \`.codegraph/\` directory, use code-intel for code exploration and review assistance:

1. Before broad reading or editing, call \`explore\` with the absolute Git root as \`projectPath\`. Make \`query\` state the task goal, relevant symbols or files, and the relationship to trace (callers, callees, data flow, or blast radius).
2. After changes, call \`review\` with the same \`projectPath\`. Omit \`base\`/\`head\` for the current working tree; provide both for a branch or pull-request range; use \`diff\` only for a caller-supplied patch.
3. Process \`reviewItems\` in descending risk order. Test status is \`linked\`, \`changed\`, \`missing\`, or \`unknown\`; risk prioritizes attention and does not prove a bug.
4. When \`filesOmitted\` or \`symbolsOmitted\` is nonzero, confidence is low, or warnings are present, run a targeted \`explore\` for the affected symbol or path.
5. Before emitting a review comment, verify a concrete failure path against the diff and focused source context.

Shell fallback: \`code-intel explore "<task goal + symbols/files + relationship>" --path /absolute/git/root\` and \`code-intel review /absolute/git/root [--base <ref> --head <ref>]\`.

If \`.codegraph/\` is missing, ask the user to run \`code-intel init\`; do not create an index implicitly.
${INSTRUCTIONS_END}`;

export function parseInstallTargets(value: string): InstallTarget[] {
  const targets: InstallTarget[] = [];
  for (const raw of value.split(',')) {
    const target = raw.trim().toLowerCase();
    if (!target) continue;
    if (target !== 'codex' && target !== 'claude') {
      throw new Error(`Unsupported install target: ${target}`);
    }
    if (!targets.includes(target)) targets.push(target);
  }
  if (!targets.length) throw new Error('At least one install target is required');
  return targets;
}

export async function installCodeIntel(
  options: InstallCodeIntelOptions,
): Promise<InstallResult> {
  if (!options.targets.length) throw new Error('At least one install target is required');
  const files: InstallFileResult[] = [];
  for (const target of options.targets) {
    if (target === 'codex') {
      files.push(...await installCodex(options.homeDir));
    } else {
      files.push(...await installClaude(options.homeDir));
    }
  }
  return { files };
}

async function installCodex(homeDir: string): Promise<InstallFileResult[]> {
  const directory = join(homeDir, '.codex');
  const configPath = join(directory, 'config.toml');
  const instructionsPath = join(directory, 'AGENTS.md');
  const currentConfig = await readOptionalFile(configPath);
  const block = [
    '[mcp_servers.code-intel]',
    'command = "npx"',
    'args = ["-y", "@team-harness/code-intel", "mcp"]',
  ].join('\n');

  return [
    await writeIfChanged(configPath, upsertTomlTable(currentConfig ?? '', block)),
    await writeIfChanged(
      instructionsPath,
      upsertInstructions(await readOptionalFile(instructionsPath)),
    ),
  ];
}

async function installClaude(homeDir: string): Promise<InstallFileResult[]> {
  const directory = join(homeDir, '.claude');
  const mcpPath = join(homeDir, '.claude.json');
  const settingsPath = join(directory, 'settings.json');
  const instructionsPath = join(directory, 'CLAUDE.md');

  const mcp = await readJsonObject(mcpPath);
  const mcpServers = objectProperty(mcp, 'mcpServers', mcpPath);
  const mcpAlreadyInstalled = jsonEqual(mcpServers['code-intel'], MCP_ENTRY);
  if (!mcpAlreadyInstalled) mcpServers['code-intel'] = MCP_ENTRY;

  const settings = await readJsonObject(settingsPath);
  const permissions = objectProperty(settings, 'permissions', settingsPath);
  const allow = arrayProperty(permissions, 'allow', settingsPath);
  const permissionAlreadyInstalled = allow.includes('mcp__code-intel__*');
  if (!permissionAlreadyInstalled) allow.push('mcp__code-intel__*');

  return [
    mcpAlreadyInstalled
      ? unchanged(mcpPath)
      : await writeIfChanged(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`),
    permissionAlreadyInstalled
      ? unchanged(settingsPath)
      : await writeIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`),
    await writeIfChanged(
      instructionsPath,
      upsertInstructions(await readOptionalFile(instructionsPath)),
    ),
  ];
}

function upsertTomlTable(content: string, block: string): string {
  const lines = content.split(/(?<=\n)/);
  const headerIndexes = lines
    .map((line, index) => isCodeIntelTomlHeader(line) ? index : -1)
    .filter((index) => index !== -1);
  if (headerIndexes.length > 1) {
    throw new Error('Cannot safely update Codex config: code-intel MCP table is declared more than once');
  }
  const parsed = parseTomlConfig(content);
  const mcpServers = parsed.mcp_servers;
  if (mcpServers !== undefined && !isRecord(mcpServers)) {
    throw new Error('Cannot safely update Codex config: mcp_servers is not a TOML table');
  }
  const hasSemanticEntry = isRecord(mcpServers)
    && Object.prototype.hasOwnProperty.call(mcpServers, 'code-intel');
  const headerIndex = headerIndexes[0] ?? -1;
  if (hasSemanticEntry && headerIndex === -1) {
    throw new Error('Cannot safely update Codex config: code-intel MCP uses an inline or dotted representation');
  }
  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
  }

  let endIndex = headerIndex + 1;
  while (endIndex < lines.length && !/^\s*\[\[?[^\n]+\]\]?\s*(?:#.*)?(?:\r?\n)?$/.test(lines[endIndex]!)) {
    endIndex++;
  }
  const before = lines.slice(0, headerIndex).join('').trimEnd();
  const after = lines.slice(endIndex).join('').trimStart();
  return `${before}${before ? '\n\n' : ''}${block}${after ? `\n\n${after}` : '\n'}`;
}

const TOML_MCP_KEY = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const TOML_CODE_INTEL_KEY = String.raw`(?:code-intel|"code-intel"|'code-intel')`;
const CODE_INTEL_TABLE_PATTERN = new RegExp(
  String.raw`^\s*\[\s*${TOML_MCP_KEY}\s*\.\s*${TOML_CODE_INTEL_KEY}\s*\]\s*(?:#.*)?(?:\r?\n)?$`,
);

function isCodeIntelTomlHeader(line: string): boolean {
  return CODE_INTEL_TABLE_PATTERN.test(line);
}

function parseTomlConfig(content: string): Record<string, unknown> {
  try {
    const parsed = parseToml(content) as unknown;
    if (!isRecord(parsed)) throw new Error('top-level value is not a table');
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse Codex config TOML: ${message}`);
  }
}

function upsertInstructions(content: string | null): string {
  if (content === null) return `${INSTRUCTIONS_BLOCK}\n`;
  const start = content.indexOf(INSTRUCTIONS_START);
  const end = content.indexOf(INSTRUCTIONS_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('Cannot update code-intel instructions: marker block is incomplete');
  }
  if (start !== -1) {
    return content.slice(0, start)
      + INSTRUCTIONS_BLOCK
      + content.slice(end + INSTRUCTIONS_END.length);
  }
  const trimmed = content.trimEnd();
  return `${trimmed}${trimmed ? '\n\n' : ''}${INSTRUCTIONS_BLOCK}\n`;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const content = await readOptionalFile(path);
  if (content === null) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error('top-level value is not an object');
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse ${path}: ${message}`);
  }
}

function objectProperty(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(value)) throw new Error(`Cannot update ${path}: ${key} is not an object`);
  return value;
}

function arrayProperty(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] {
  const value = parent[key];
  if (value === undefined) {
    const created: unknown[] = [];
    parent[key] = created;
    return created;
  }
  if (!Array.isArray(value)) throw new Error(`Cannot update ${path}: ${key} is not an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeIfChanged(path: string, content: string): Promise<InstallFileResult> {
  const current = await readOptionalFile(path);
  if (current === content) return unchanged(path);
  await mkdir(dirname(path), { recursive: true });

  let backupPath: string | undefined;
  let mode = 0o600;
  if (current !== null) {
    backupPath = `${path}.code-intel.bak`;
    mode = (await stat(path)).mode;
    await copyFile(path, backupPath);
  }

  const temporary = `${path}.code-intel.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
  return {
    path,
    action: current === null ? 'created' : 'updated',
    ...(backupPath ? { backupPath } : {}),
  };
}

function unchanged(path: string): InstallFileResult {
  return { path, action: 'unchanged' };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
