import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

export interface RawProcess {
  pid: number;
  ppid: number;
  uptimeSeconds: number | null;
  command: string;
}

export interface DaemonRecord {
  root: string;
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
}

export type ProcessRole =
  | 'launcher'
  | 'code-deep-mcp'
  | 'codegraph-proxy'
  | 'codegraph-session'
  | 'codegraph-daemon'
  | 'codegraph-watchdog'
  | 'daemon-record';

export type ProcessStatus =
  | 'active'
  | 'healthy'
  | 'shared'
  | 'suspect'
  | 'degraded'
  | 'version-mismatch'
  | 'stale-metadata';

export interface ProcessObservation {
  pid: number;
  ppid: number | null;
  role: ProcessRole;
  status: ProcessStatus;
  projectPath: string | null;
  uptimeSeconds: number | null;
  version: string | null;
  command: string;
  evidence: string[];
  cleanupCandidate: boolean;
}

export interface ProcessReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: NodeJS.Platform;
  summary: {
    total: number;
    projects: number;
    cleanupCandidates: number;
    suspects: number;
  };
  processes: ProcessObservation[];
}

export interface BuildProcessReportOptions {
  codeGraphVersion: string;
  socketExists: (path: string) => boolean;
  now?: Date;
  platform?: NodeJS.Platform;
}

export async function collectProcessReport(): Promise<ProcessReport> {
  const [raw, daemons] = await Promise.all([
    listProcesses(),
    readDaemonRecords(homedir()),
  ]);
  const existingSockets = new Set<string>();
  await Promise.all(daemons.map(async ({ socketPath }) => {
    try {
      await access(socketPath);
      existingSockets.add(socketPath);
    } catch {
      // A missing socket is evidence in the report, not a collection failure.
    }
  }));
  return buildProcessReport(raw, daemons, {
    codeGraphVersion: installedCodeGraphVersion(),
    socketExists: (path) => process.platform === 'win32' || existingSockets.has(path),
  });
}

export function buildProcessReport(
  raw: RawProcess[],
  daemons: DaemonRecord[],
  options: BuildProcessReportOptions,
): ProcessReport {
  const platform = options.platform ?? process.platform;
  const allByPid = new Map(raw.map((process) => [process.pid, process]));
  const daemonByPid = new Map(daemons.map((daemon) => [daemon.pid, daemon]));
  const livePids = new Set(raw.map((process) => process.pid));
  const relevant = raw
    .map((process) => ({ process, role: classifyRole(process.command, daemonByPid.has(process.pid)) }))
    .filter((item): item is { process: RawProcess; role: Exclude<ProcessRole, 'daemon-record'> } => item.role !== null);
  const liveDaemonPids = new Set(
    relevant.filter(({ role }) => role === 'codegraph-daemon').map(({ process }) => process.pid),
  );
  const liveDaemonRoots = new Set(
    daemons.filter((daemon) => liveDaemonPids.has(daemon.pid)).map((daemon) => daemon.root),
  );
  const projectByPid = new Map<number, string>();
  for (const { process } of relevant) {
    const daemon = daemonByPid.get(process.pid);
    const project = daemon?.root ?? pathArgument(process.command);
    if (project) projectByPid.set(process.pid, project);
  }
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const { process } of relevant) {
      if (projectByPid.has(process.pid)) continue;
      const inherited = projectByPid.get(process.ppid)
        ?? relevant.find((item) => item.process.ppid === process.pid && projectByPid.has(item.process.pid))
          ?.process.pid;
      const project = typeof inherited === 'number' ? projectByPid.get(inherited) : inherited;
      if (project) {
        projectByPid.set(process.pid, project);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const processes: ProcessObservation[] = relevant.map(({ process, role }) => {
    const daemon = daemonByPid.get(process.pid);
    const projectPath = projectByPid.get(process.pid) ?? null;
    const effectiveRole = role === 'codegraph-session'
      && projectPath !== null
      && liveDaemonRoots.has(projectPath)
      ? 'codegraph-proxy'
      : role;
    const evidence: string[] = [];
    let status: ProcessStatus;
    if (effectiveRole === 'codegraph-daemon' && daemon) {
      evidence.push(`Live daemon registry record for ${daemon.root}`);
      if (daemon.version !== options.codeGraphVersion) {
        status = 'version-mismatch';
        evidence.push(`Daemon v${daemon.version} differs from package v${options.codeGraphVersion}`);
      } else if (platform !== 'win32' && !options.socketExists(daemon.socketPath)) {
        status = 'degraded';
        evidence.push(`Daemon socket is missing: ${daemon.socketPath}`);
      } else {
        status = 'shared';
        evidence.push(platform === 'win32'
          ? 'Named-pipe liveness is inferred from the active daemon registry process'
          : `Daemon socket exists: ${daemon.socketPath}`);
      }
    } else if (effectiveRole === 'codegraph-watchdog') {
      status = allByPid.has(process.ppid) ? 'healthy' : 'suspect';
      evidence.push(status === 'healthy'
        ? `Watched parent PID ${process.ppid} is alive`
        : `Watched parent PID ${process.ppid} is absent`);
    } else if (process.ppid === 1 || !allByPid.has(process.ppid)) {
      status = 'suspect';
      evidence.push(`Supervisor PID ${process.ppid} is not an observable live process`);
      evidence.push('Insufficient evidence for automatic cleanup');
    } else {
      status = 'active';
      evidence.push(`Supervisor PID ${process.ppid} is alive`);
    }
    return {
      pid: process.pid,
      ppid: process.ppid,
      role: effectiveRole,
      status,
      projectPath,
      uptimeSeconds: process.uptimeSeconds,
      version: daemon?.version ?? null,
      command: commandLabel(effectiveRole),
      evidence,
      cleanupCandidate: false,
    };
  });

  for (const daemon of daemons) {
    if (liveDaemonPids.has(daemon.pid)) continue;
    const pidWasReused = livePids.has(daemon.pid);
    processes.push({
      pid: daemon.pid,
      ppid: null,
      role: 'daemon-record',
      status: 'stale-metadata',
      projectPath: daemon.root,
      uptimeSeconds: null,
      version: daemon.version,
      command: 'CodeGraph daemon registry record',
      evidence: [
        pidWasReused
          ? 'Registry PID now belongs to a non-CodeGraph process; only metadata is a cleanup candidate'
          : 'Registry PID is absent from the process table',
        `Socket: ${daemon.socketPath}`,
      ],
      cleanupCandidate: true,
    });
  }
  processes.sort((left, right) => left.pid - right.pid);
  const projects = new Set(processes.flatMap((process) => process.projectPath ? [process.projectPath] : []));
  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    platform,
    summary: {
      total: processes.length,
      projects: projects.size,
      cleanupCandidates: processes.filter((process) => process.cleanupCandidate).length,
      suspects: processes.filter((process) => process.status === 'suspect').length,
    },
    processes,
  };
}

export function renderProcessReport(report: ProcessReport): string {
  const lines = [
    `code-deep processes: ${report.summary.total} across ${report.summary.projects} project(s); ${report.summary.suspects} suspect, ${report.summary.cleanupCandidates} cleanup candidate(s)`,
    '',
    'PID      ROLE                 STATUS             UPTIME    PROJECT',
  ];
  for (const process of report.processes) {
    lines.push(
      `${String(process.pid).padEnd(8)} ${process.role.padEnd(20)} ${process.status.padEnd(18)} ${formatDuration(process.uptimeSeconds).padEnd(9)} ${process.projectPath ?? '-'}`,
    );
    for (const evidence of process.evidence) lines.push(`         - ${evidence}`);
  }
  if (!report.processes.length) lines.push('(no code-deep or CodeGraph processes found)');
  lines.push('', 'Read-only report; no processes or files were changed.');
  return lines.join('\n');
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function parsePosixProcessList(output: string): RawProcess[] {
  const result: RawProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    result.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uptimeSeconds: parseElapsed(match[3]!),
      command: match[4]!,
    });
  }
  return result;
}

async function listProcesses(): Promise<RawProcess[]> {
  if (process.platform === 'win32') return listWindowsProcesses();
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return parsePosixProcessList(stdout);
}

async function listWindowsProcesses(): Promise<RawProcess[]> {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const now = Date.now();
  return rows.flatMap((row) => {
    const pid = Number(row.ProcessId);
    const ppid = Number(row.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return [];
    const created = typeof row.CreationDate === 'string' ? Date.parse(row.CreationDate) : Number.NaN;
    return [{
      pid,
      ppid,
      uptimeSeconds: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : null,
      command: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }];
  });
}

async function readDaemonRecords(home: string): Promise<DaemonRecord[]> {
  const directory = join(home, '.codegraph', 'daemons');
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(files.map(async (file) => {
    try {
      const value = JSON.parse(await readFile(join(directory, file), 'utf8')) as Partial<DaemonRecord>;
      return typeof value.root === 'string'
        && typeof value.pid === 'number'
        && typeof value.version === 'string'
        && typeof value.socketPath === 'string'
        && typeof value.startedAt === 'number'
        ? value as DaemonRecord
        : null;
    } catch {
      return null;
    }
  }));
  return records.filter((record): record is DaemonRecord => record !== null);
}

function classifyRole(command: string, registeredDaemon: boolean): Exclude<ProcessRole, 'daemon-record'> | null {
  if (/Main thread unresponsive|liveness-watchdog/i.test(command)) return 'codegraph-watchdog';
  if (/serve\s+--mcp/.test(command) && /codegraph|npm-shim/i.test(command)) {
    return registeredDaemon ? 'codegraph-daemon' : 'codegraph-session';
  }
  if (/(?:npm|npx).*@team-harness\/(?:code-deep|code-intel).*\bmcp\b/.test(command)) return 'launcher';
  if (/(?:code-deep|code-intel|dist\/cli\.js).*\bmcp\b/.test(command)) return 'code-deep-mcp';
  return null;
}

function pathArgument(command: string): string | null {
  const match = command.match(/(?:^|\s)--path(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function commandLabel(role: Exclude<ProcessRole, 'daemon-record'>): string {
  if (role === 'launcher') return 'npx @team-harness/code-deep mcp';
  if (role === 'code-deep-mcp') return 'code-deep mcp';
  if (role === 'codegraph-watchdog') return 'CodeGraph watchdog';
  return 'CodeGraph serve --mcp';
}

function parseElapsed(value: string): number | null {
  const dayParts = value.split('-');
  const time = dayParts.pop()!.split(':').map(Number);
  if (time.some((part) => !Number.isFinite(part))) return null;
  const days = dayParts.length ? Number(dayParts[0]) : 0;
  const [hours, minutes, seconds] = time.length === 3
    ? time
    : [0, time[0]!, time[1]!];
  return days * 86400 + hours! * 3600 + minutes! * 60 + seconds!;
}

function installedCodeGraphVersion(): string {
  const packageJson = require('@colbymchenry/codegraph/package.json') as { version?: string };
  return packageJson.version ?? 'unknown';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
