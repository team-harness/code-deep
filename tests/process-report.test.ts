import { describe, expect, it } from 'vitest';
import {
  buildProcessReport,
  parsePosixProcessList,
  renderProcessReport,
  type DaemonRecord,
  type RawProcess,
} from '../src/process-report.js';

describe('process reporting', () => {
  it('parses POSIX process output and elapsed time', () => {
    const rows = parsePosixProcessList([
      '  101     1       02:03 node cli.js mcp',
      '  102   101  1-02:03:04 node npm-shim.js serve --mcp',
    ].join('\n'));

    expect(rows).toEqual([
      { pid: 101, ppid: 1, uptimeSeconds: 123, command: 'node cli.js mcp' },
      { pid: 102, ppid: 101, uptimeSeconds: 93784, command: 'node npm-shim.js serve --mcp' },
    ]);
  });

  it('classifies a shared daemon, session proxy, wrapper, launcher, and watchdog', () => {
    const raw: RawProcess[] = [
      { pid: 10, ppid: 1, uptimeSeconds: 1000, command: '/Applications/Codex.app/Codex' },
      { pid: 20, ppid: 10, uptimeSeconds: 500, command: 'npm exec @team-harness/code-intel mcp' },
      { pid: 30, ppid: 20, uptimeSeconds: 490, command: 'node /pkg/dist/cli.js mcp --path /repo' },
      { pid: 40, ppid: 30, uptimeSeconds: 480, command: 'node npm-shim.js serve --mcp --path /repo' },
      { pid: 41, ppid: 40, uptimeSeconds: 480, command: 'node -e Main thread unresponsive watchdog' },
      { pid: 50, ppid: 1, uptimeSeconds: 600, command: 'node npm-shim.js serve --mcp --path /repo' },
    ];
    const daemons: DaemonRecord[] = [{
      root: '/repo', pid: 50, version: '1.5.0', socketPath: '/repo/.codegraph/daemon.sock', startedAt: 1,
    }];

    const report = buildProcessReport(raw, daemons, {
      codeGraphVersion: '1.5.0',
      socketExists: () => true,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.processes.map(({ pid, role, status, projectPath }) => ({ pid, role, status, projectPath })))
      .toEqual([
        { pid: 20, role: 'launcher', status: 'active', projectPath: '/repo' },
        { pid: 30, role: 'code-intel-mcp', status: 'active', projectPath: '/repo' },
        { pid: 40, role: 'codegraph-proxy', status: 'active', projectPath: '/repo' },
        { pid: 41, role: 'codegraph-watchdog', status: 'healthy', projectPath: '/repo' },
        { pid: 50, role: 'codegraph-daemon', status: 'shared', projectPath: '/repo' },
      ]);
    expect(report.summary).toMatchObject({ total: 5, cleanupCandidates: 0, projects: 1 });
  });

  it('reports strong orphan and stale-metadata evidence without changing state', () => {
    const raw: RawProcess[] = [
      { pid: 70, ppid: 1, uptimeSeconds: 900, command: 'node npm-shim.js serve --mcp --path /orphan' },
      { pid: 80, ppid: 1, uptimeSeconds: 30, command: '/usr/bin/unrelated-process' },
    ];
    const daemons: DaemonRecord[] = [
      { root: '/stale', pid: 99, version: '1.5.0', socketPath: '/stale/socket', startedAt: 1 },
      { root: '/reused', pid: 80, version: '1.5.0', socketPath: '/reused/socket', startedAt: 1 },
    ];

    const report = buildProcessReport(raw, daemons, {
      codeGraphVersion: '1.5.0',
      socketExists: () => false,
    });

    expect(report.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 70, status: 'suspect', cleanupCandidate: false }),
      expect.objectContaining({ pid: 80, role: 'daemon-record', status: 'stale-metadata', cleanupCandidate: true }),
      expect.objectContaining({ pid: 99, role: 'daemon-record', status: 'stale-metadata', cleanupCandidate: true }),
    ]));
    expect(renderProcessReport(report)).toContain('Read-only report; no processes or files were changed.');
  });
});
