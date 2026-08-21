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
import { CODE_DEEP_VERSION } from './version.js';

export type InstallTarget = 'codex' | 'claude';
export type InstallMode = 'cli' | 'mcp';
export type InstallAction = 'created' | 'updated' | 'unchanged';

export interface InstallFileResult {
  path: string;
  action: InstallAction;
  backupPath?: string;
}

export interface InstallResult {
  files: InstallFileResult[];
}

export interface InstallCodeDeepOptions {
  homeDir: string;
  targets: InstallTarget[];
  mode?: InstallMode;
}

const PACKAGE_SPEC = `@team-harness/code-deep@${CODE_DEEP_VERSION}`;
const MCP_ENTRY = {
  type: 'stdio',
  command: 'code-deep',
  args: ['mcp'],
};

const INSTRUCTIONS_START = '<!-- CODE_DEEP_START -->';
const INSTRUCTIONS_END = '<!-- CODE_DEEP_END -->';
const LEGACY_INSTRUCTIONS_START = '<!-- CODE_INTEL_START -->';
const LEGACY_INSTRUCTIONS_END = '<!-- CODE_INTEL_END -->';
const MCP_INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_START}
## code-deep

Use code-deep for code exploration and review assistance in Git repositories. The first \`explore\` or \`review\` call automatically initializes a missing index for the current repository or worktree:

Prefer the code-deep MCP tools \`code-deep.explore\` and \`code-deep.review\` whenever they are available. Do not probe or invoke the shell CLI before using an available MCP tool. Refer to the capability, server, and tools as \`code-deep\` in user-facing messages. CodeGraph is an internal backend. Do not describe a fallback as switching to CodeGraph.

1. Before broad reading or editing, call \`explore\` with the absolute Git root as \`projectPath\`. Make \`query\` state the task goal, relevant symbols or files, and the relationship to trace (callers, callees, data flow, or blast radius).
2. After changes, call \`review\` with the same \`projectPath\`. Omit \`base\`/\`head\` for the current working tree; provide both for a branch or pull-request range; use \`diff\` only for a caller-supplied patch.
3. Process \`reviewItems\` in descending risk order. Test status is \`linked\`, \`changed\`, \`missing\`, or \`unknown\`; risk prioritizes attention and does not prove a bug.
4. When \`filesOmitted\` or \`symbolsOmitted\` is nonzero, confidence is low, or warnings are present, run a targeted \`explore\` for the affected symbol or path.
5. Before emitting a review comment, verify a concrete failure path against the diff and focused source context.

Shell fallback, only when the code-deep MCP tools are unavailable: use \`code-deep explore "<task goal + symbols/files + relationship>" --path /absolute/git/root\` and \`code-deep review /absolute/git/root [--base <ref> --head <ref>]\`. If \`code-deep\` is not in \`PATH\`, run the same command through \`npx -y ${PACKAGE_SPEC}\`.

Do not ask the user to initialize new worktrees. Use \`code-deep init\` only for an explicit manual refresh or to diagnose an initialization failure.
${INSTRUCTIONS_END}`;

const CLI_INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_START}
## code-deep

Use the \`code-deep\` CLI for focused code exploration and review assistance in Git repositories. Each command exits after completing its work, so it does not leave a per-agent MCP process running. The first \`explore\` or \`review\` call automatically initializes a missing index for the current repository or worktree.

1. Before broad reading or editing, run \`code-deep explore "<task goal + symbols/files + callers, callees, data flow, or blast radius>" --path /absolute/git/root --detail minimal\`.
2. After changes, run \`code-deep review /absolute/git/root --detail minimal --json\`. Add both \`--base <ref>\` and \`--head <ref>\` for a branch range.
3. Process \`reviewItems\` in descending risk order. Test status is \`linked\`, \`changed\`, \`missing\`, or \`unknown\`; risk prioritizes attention and does not prove a bug.
4. When output reports omissions, low confidence, or warnings, rerun a targeted \`explore\` for the affected symbol or path. Use \`--detail standard\` for broader bounded context and \`--detail full\` only when the complete raw result is required.
5. Before emitting a review comment, verify a concrete failure path against the diff and focused source context.

If \`code-deep\` is not in \`PATH\`, run the same commands through \`npx -y ${PACKAGE_SPEC}\`. Do not ask the user to initialize new worktrees. Use \`code-deep init\` only for an explicit manual refresh or to diagnose an initialization failure. CodeGraph is an internal backend; refer to the capability as code-deep.
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

export function parseInstallMode(value: string): InstallMode {
  const mode = value.trim().toLowerCase();
  if (mode === 'cli' || mode === 'mcp') return mode;
  throw new Error(`Unsupported install mode: ${value}`);
}

export async function installCodeDeep(
  options: InstallCodeDeepOptions,
): Promise<InstallResult> {
  if (!options.targets.length) throw new Error('At least one install target is required');
  const mode = parseInstallMode(options.mode ?? 'cli');
  const files: InstallFileResult[] = [];
  for (const target of options.targets) {
    if (target === 'codex') {
      files.push(...await installCodex(options.homeDir, mode));
    } else {
      files.push(...await installClaude(options.homeDir, mode));
    }
  }
  return { files };
}

async function installCodex(homeDir: string, mode: InstallMode): Promise<InstallFileResult[]> {
  const directory = join(homeDir, '.codex');
  const configPath = join(directory, 'config.toml');
  const instructionsPath = join(directory, 'AGENTS.md');
  const currentConfig = await readOptionalFile(configPath);
  const block = [
    '[mcp_servers.code-deep]',
    'command = "code-deep"',
    'args = ["mcp"]',
  ].join('\n');

  const files: InstallFileResult[] = [];
  const nextConfig = upsertTomlTable(currentConfig ?? '', mode === 'mcp' ? block : null);
  if (mode === 'mcp' || (currentConfig !== null && nextConfig !== currentConfig)) {
    files.push(await writeIfChanged(configPath, nextConfig));
  }
  files.push(await writeIfChanged(
    instructionsPath,
    upsertInstructions(
      await readOptionalFile(instructionsPath),
      mode === 'mcp' ? MCP_INSTRUCTIONS_BLOCK : CLI_INSTRUCTIONS_BLOCK,
    ),
  ));
  return files;
}

async function installClaude(homeDir: string, mode: InstallMode): Promise<InstallFileResult[]> {
  const directory = join(homeDir, '.claude');
  const mcpPath = join(homeDir, '.claude.json');
  const settingsPath = join(directory, 'settings.json');
  const instructionsPath = join(directory, 'CLAUDE.md');

  const mcpContent = await readOptionalFile(mcpPath);
  const mcp = parseJsonObject(mcpContent, mcpPath);
  const settingsContent = await readOptionalFile(settingsPath);
  const settings = parseJsonObject(settingsContent, settingsPath);
  let mcpChanged = false;
  let settingsChanged = false;

  if (mode === 'mcp') {
    const mcpServers = objectProperty(mcp, 'mcpServers', mcpPath);
    mcpChanged = delete mcpServers['code-intel'] || mcpChanged;
    mcpChanged = !sameJsonValue(mcpServers['code-deep'], MCP_ENTRY) || mcpChanged;
    mcpServers['code-deep'] = MCP_ENTRY;

    const permissions = objectProperty(settings, 'permissions', settingsPath);
    const allow = arrayProperty(permissions, 'allow', settingsPath);
    const nextAllow = [
      ...allow.filter((entry) => entry !== 'mcp__code-intel__*' && entry !== 'mcp__code-deep__*'),
      'mcp__code-deep__*',
    ];
    settingsChanged = !sameJsonValue(allow, nextAllow);
    permissions.allow = nextAllow;
  } else {
    const mcpServers = optionalObjectProperty(mcp, 'mcpServers', mcpPath);
    if (mcpServers) {
      mcpChanged = delete mcpServers['code-intel'] || mcpChanged;
      mcpChanged = delete mcpServers['code-deep'] || mcpChanged;
    }
    const permissions = optionalObjectProperty(settings, 'permissions', settingsPath);
    if (permissions) {
      const allow = optionalArrayProperty(permissions, 'allow', settingsPath);
      if (allow) {
        const nextAllow = allow.filter((entry) => entry !== 'mcp__code-intel__*' && entry !== 'mcp__code-deep__*');
        settingsChanged = !sameJsonValue(allow, nextAllow);
        permissions.allow = nextAllow;
      }
    }
  }

  const files: InstallFileResult[] = [];
  if (mode === 'mcp' || (mcpContent !== null && mcpChanged)) {
    files.push(await writeIfChanged(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`));
  }
  if (mode === 'mcp' || (settingsContent !== null && settingsChanged)) {
    files.push(await writeIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`));
  }
  files.push(await writeIfChanged(
    instructionsPath,
    upsertInstructions(
      await readOptionalFile(instructionsPath),
      mode === 'mcp' ? MCP_INSTRUCTIONS_BLOCK : CLI_INSTRUCTIONS_BLOCK,
    ),
  ));
  return files;
}

function upsertTomlTable(content: string, block: string | null): string {
  const lines = content.split(/(?<=\n)/);
  const managedHeaders = lines
    .map((line, index) => ({ index, key: managedTomlKey(line) }))
    .filter((header): header is { index: number; key: ManagedTomlKey } => header.key !== null);
  for (const key of MANAGED_TOML_KEYS) {
    if (managedHeaders.filter((header) => header.key === key).length > 1) {
      throw new Error(`Cannot safely update Codex config: ${key} MCP table is declared more than once`);
    }
  }
  const parsed = parseTomlConfig(content);
  const mcpServers = parsed.mcp_servers;
  if (mcpServers !== undefined && !isRecord(mcpServers)) {
    throw new Error('Cannot safely update Codex config: mcp_servers is not a TOML table');
  }
  for (const key of MANAGED_TOML_KEYS) {
    const hasSemanticEntry = isRecord(mcpServers)
      && Object.prototype.hasOwnProperty.call(mcpServers, key);
    const hasHeader = managedHeaders.some((header) => header.key === key);
    if (hasSemanticEntry && !hasHeader) {
      throw new Error(`Cannot safely update Codex config: ${key} MCP uses an inline or dotted representation`);
    }
  }
  if (!managedHeaders.length) {
    if (block === null) return content;
    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
  }

  const managedIndexes = new Set(managedHeaders.map(({ index }) => index));
  const firstManagedIndex = managedHeaders[0]!.index;
  const output: string[] = [];
  let skippingManagedTable = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (managedIndexes.has(index)) {
      if (index === firstManagedIndex && block !== null) output.push(`${block}\n`);
      skippingManagedTable = true;
      continue;
    }
    if (/^\s*\[\[?[^\n]+\]\]?\s*(?:#.*)?(?:\r?\n)?$/.test(line)) {
      skippingManagedTable = false;
    }
    if (!skippingManagedTable) output.push(line);
  }
  return `${output.join('').trimEnd()}\n`;
}

const TOML_MCP_KEY = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const MANAGED_TOML_KEYS = ['code-deep', 'code-intel'] as const;
type ManagedTomlKey = typeof MANAGED_TOML_KEYS[number];
const MANAGED_TABLE_PATTERNS = Object.fromEntries(MANAGED_TOML_KEYS.map((key) => [
  key,
  new RegExp(String.raw`^\s*\[\s*${TOML_MCP_KEY}\s*\.\s*(?:${key}|"${key}"|'${key}')\s*\]\s*(?:#.*)?(?:\r?\n)?$`),
])) as Record<ManagedTomlKey, RegExp>;

function managedTomlKey(line: string): ManagedTomlKey | null {
  return MANAGED_TOML_KEYS.find((key) => MANAGED_TABLE_PATTERNS[key].test(line)) ?? null;
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

function upsertInstructions(content: string | null, instructionsBlock: string): string {
  if (content === null) return `${instructionsBlock}\n`;
  const markerPairs = [
    [INSTRUCTIONS_START, INSTRUCTIONS_END],
    [LEGACY_INSTRUCTIONS_START, LEGACY_INSTRUCTIONS_END],
  ] as const;
  const blocks = markerPairs.flatMap(([startMarker, endMarker]) => {
    const start = content.indexOf(startMarker);
    const end = content.indexOf(endMarker);
    if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
      throw new Error('Cannot update code-deep instructions: marker block is incomplete');
    }
    return start === -1 ? [] : [{ start, end: end + endMarker.length }];
  }).sort((left, right) => left.start - right.start);
  if (!blocks.length) {
    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${instructionsBlock}\n`;
  }
  let output = '';
  let cursor = 0;
  for (const [index, current] of blocks.entries()) {
    output += content.slice(cursor, current.start);
    if (index === 0) output += instructionsBlock;
    cursor = current.end;
  }
  output += content.slice(cursor);
  return output;
}

function parseJsonObject(content: string | null, path: string): Record<string, unknown> {
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

function optionalObjectProperty(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | null {
  const value = parent[key];
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error(`Cannot update ${path}: ${key} is not an object`);
  return value;
}

function optionalArrayProperty(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] | null {
  const value = parent[key];
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`Cannot update ${path}: ${key} is not an array`);
  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    backupPath = `${path}.code-deep.bak`;
    mode = (await stat(path)).mode;
    await copyFile(path, backupPath);
  }

  const temporary = `${path}.code-deep.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
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
