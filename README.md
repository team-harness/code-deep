# code-intel

`code-intel` gives coding agents two focused workflows: understand code before
changing it, then review the resulting diff. It keeps one CodeGraph MCP
connection alive for the lifetime of the outer MCP server and exposes a
deliberately small interface:

- `explore`: find relevant source, trace callers and callees, follow data flow,
  and understand blast radius without reading the repository broadly.
- `review`: diff parsing, changed-symbol mapping, impact collection, explainable risk scoring, and a structured report.

The npm package is `@team-harness/code-intel`. It installs CodeGraph as an exact dependency; end users do not need a separate global CodeGraph installation.

`code-intel` and its bundled CodeGraph dependency have independent versions.
`CODE_INTEL_VERSION` identifies this wrapper release; `CODEGRAPH_VERSION`
identifies the exact `@colbymchenry/codegraph` version it runs. This allows the
bridge and reviewer to ship fixes without waiting for a new upstream release.

## Install

```bash
npm install -g @team-harness/code-intel
code-intel install --target codex,claude
```

`install` registers the `code-intel` MCP server globally for the selected agents.
It also adds a marker-delimited guidance block to Codex `~/.codex/AGENTS.md`
and Claude `~/.claude/CLAUDE.md`, directing both agents to use `explore` for
code discovery and `review` before finalizing changes. Claude receives the
`mcp__code-intel__*` permission in `~/.claude/settings.json`.

The generated MCP configuration pins the currently installed code-intel version.
Run `code-intel install` again after upgrading the npm package so agents use the
same reviewed version as the global CLI.

The installer preserves unrelated configuration, backs up each changed existing
file as `<file>.code-intel.bak`, and is idempotent. It does not initialize a
repository during installation. The first `explore` or `review` call in a Git
repository automatically initializes a missing `.codegraph/` at that repository
or worktree root. Concurrent first calls in one process share the same
initialization. Existing indexes are left to CodeGraph's connect-time catch-up
and file watcher; use `code-intel init` only for an explicit refresh or to
diagnose initialization failure.

## MCP configuration

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "code-intel",
      "args": ["mcp", "--path", "/absolute/path/to/project"]
    }
  }
}
```

The agent sees only `explore` and `review`. Both leave source files unchanged,
but may create `.codegraph/` on first use, so their MCP annotations do not claim
strict read-only behavior. Internally, the review module also uses CodeGraph's
`node` and `impact` tools; they are not exposed on the outer MCP surface.

## Agent behavior

When the code-intel MCP tools are available, agents must call them directly and
must not probe the shell CLI first. Shell commands are fallback-only. User-facing
messages refer to the capability, server, and tools as `code-intel`; CodeGraph is
the internal backend name, not a separate tool to switch to.

## Explore code

Ask a task-oriented question before reading or editing broadly:

```bash
code-intel explore \
  "Trace how AuthService login creates and validates sessions, including callers and blast radius" \
  --path /path/to/project
```

`explore` returns a focused set of relevant source, symbol relationships, call
paths, and downstream impact. A useful query names the task, the symbols or
files already known, and the relationship to trace, such as callers, callees,
data flow, or blast radius.

Agents should prefer the MCP tool. When shell fallback is necessary and a global
`code-intel` command is not visible in the current process's `PATH`, run the same
command through `npx -y @team-harness/code-intel@1.5.5`.

Use `--max-files <count>` to control the amount of source returned. The MCP
`explore` tool accepts the same query, project path, and file limit, so agents
can refine an investigation with targeted follow-up questions while reusing the
same persistent CodeGraph connection.

## Review modes

Review the current working tree, including staged, unstaged, and untracked files:

```bash
code-intel review /path/to/project
```

Review a branch or pull-request range:

```bash
code-intel review /path/to/project --base origin/main --head HEAD
```

Get the structured report:

```bash
code-intel review /path/to/project --json
```

The MCP `review` tool accepts the same `base` and `head`, or a caller-supplied
unified `diff`. These modes are mutually exclusive, and `head` always requires
`base`. With no diff or range it reviews the target project's current working tree.

## Process diagnostics

Inspect the local code-intel wrappers, CodeGraph proxies, shared project daemons,
and watchdogs without changing any process or file:

```bash
code-intel ps
code-intel ps --json
```

The JSON report has `schemaVersion: 1` and records each process's role, status,
project, parent PID, uptime, supporting evidence, and whether strong evidence
makes it a future cleanup candidate. A long-running process is never classified
as an orphan based on age alone. This release does not terminate processes or
remove stale metadata.

## Architecture

```text
Agent / MCP host
      |
      | stdio MCP: explore, review
      v
code-intel (long-lived process)
      |
      +-- CodeGraphBridge ---- persistent MCP client ---- CodeGraph MCP
      |       +-- explore ---- focused source / call paths / blast radius
      |
      +-- ReviewAnalyzer
            +-- structured unified-diff parser
            +-- hunk -> current symbol mapping
            +-- node / impact / explore queries
            +-- deterministic risk scorer
            +-- Markdown + structured JSON report
```

The bridge ensures the requested Git repository or worktree index, lazily starts
CodeGraph on the first tool call, reuses that connection for later calls, and
reconnects once if the child exits during a tool request. CodeGraph may
additionally share its own per-project daemon across MCP clients.

## Review semantics

Risk scores are deterministic and explainable. Signals currently cover sensitive paths, missing test-file changes, graph impact width, diff size, file count, deleted files, and incomplete graph analysis. Global risk always uses metadata from the complete diff; `maxFiles` and `maxSymbols` limit only deep graph and patch analysis. Scores prioritize review effort; they are not claims that a bug exists.

Every report has `schemaVersion: 1` and a risk-ordered `reviewItems` array. Each
item represents one changed symbol and includes normalized impact symbols,
related test files, mapping and impact confidence, parser warnings, and the exact
reasons contributing to its per-symbol risk score. Existing report fields remain
available for compatibility.

```ts
const report = await codeIntel.review();
for (const item of report.reviewItems) {
  console.log(item.risk.level, item.symbol.name, item.tests.status);
}
```

The internal graph adapter keeps CodeGraph's original text in each impact result
for diagnostics, but downstream consumers no longer need to parse that display
format themselves. Unknown or changed backend formats produce explicit
low-confidence warnings instead of silently appearing as an empty graph result.
The default Markdown report includes these warnings and raises an
`graph-analysis-incomplete` signal so a failed lookup cannot appear as a clean,
low-risk review.

Changed hunks are mapped to the nearest preceding symbol in the current CodeGraph index. Deleted files and symbols can be absent from that index, so deletion findings are explicitly treated as uncertain. A future base-revision index can remove that limitation.

## Library use

```ts
import { CodeIntelClient } from '@team-harness/code-intel';

const codeIntel = new CodeIntelClient({ projectPath: process.cwd() });
try {
  const context = await codeIntel.explore('AuthService login');
  const report = await codeIntel.review();
} finally {
  await codeIntel.close();
}
```

`CodeIntelClient` is the public library boundary. Its `explore()` and `review()`
methods share one persistent CodeGraph connection; the bridge and analyzer are
internal implementation details. Automatic initialization is enabled by default;
library consumers that manage indexes separately can pass `autoInit: false`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Upstream

This project is powered by [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph), licensed under MIT. `code-intel` is an independent Team Harness integration and is not an official CodeGraph package.
