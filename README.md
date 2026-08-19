# code-deep

> **Upgrading from code-intel:** install `@team-harness/code-deep`, then run
> `code-deep install --target codex,claude`. The installer replaces the old MCP
> server configuration and permissions. Restart the host after installation so
> its active MCP process uses code-deep.
>
> The legacy command `npm install -g @team-harness/code-intel` remains supported:
> it installs the matching `@team-harness/code-deep` release and exposes only
> the `code-deep` executable.

`code-deep` gives coding agents two focused workflows: understand code before
changing it, then review the resulting diff. It keeps one CodeGraph MCP
connection alive for the lifetime of the outer MCP server and exposes a
deliberately small interface:

- `explore`: find relevant source, trace callers and callees, follow data flow,
  and understand blast radius without reading the repository broadly.
- `review`: diff parsing, changed-symbol mapping, impact collection, explainable risk scoring, and a structured report.

The npm package is `@team-harness/code-deep`. It installs CodeGraph as an exact dependency; end users do not need a separate global CodeGraph installation.

`code-deep` and its bundled CodeGraph dependency have independent versions.
`CODE_DEEP_VERSION` identifies this wrapper release; `CODEGRAPH_VERSION`
identifies the exact `@colbymchenry/codegraph` version it runs. This allows the
bridge and reviewer to ship fixes without waiting for a new upstream release.

## Install

```bash
npm install -g @team-harness/code-deep
code-deep install --target codex,claude
```

`install` registers the `code-deep` MCP server globally for the selected agents.
It also adds a marker-delimited guidance block to Codex `~/.codex/AGENTS.md`
and Claude `~/.claude/CLAUDE.md`, directing both agents to use `explore` for
code discovery and `review` before finalizing changes. Claude receives the
`mcp__code-deep__*` permission in `~/.claude/settings.json`.

The generated MCP configuration invokes the global `code-deep` command. Run
`code-deep install` again after upgrading from code-intel so existing agent
configuration, permissions, and instructions migrate to the new identity.

The installer preserves unrelated configuration, backs up each changed existing
file as `<file>.code-deep.bak`, and is idempotent. It does not initialize a
repository during installation. The first `explore` or `review` call in a Git
repository automatically initializes a missing `.codegraph/` at that repository
or worktree root. Concurrent first calls in one process share the same
initialization. Existing indexes are left to CodeGraph's connect-time catch-up
and file watcher; use `code-deep init` only for an explicit refresh or to
diagnose initialization failure.

## MCP configuration

```json
{
  "mcpServers": {
    "code-deep": {
      "command": "code-deep",
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

When the code-deep MCP tools are available, agents must call them directly and
must not probe the shell CLI first. Shell commands are fallback-only. User-facing
messages refer to the capability, server, and tools as `code-deep`; CodeGraph is
the internal backend name, not a separate tool to switch to.

## Explore code

Ask a task-oriented question before reading or editing broadly:

```bash
code-deep explore \
  "Trace how AuthService login creates and validates sessions, including callers and blast radius" \
  --path /path/to/project
```

The CLI `explore` command returns the complete focused source, symbol
relationships, call paths, and downstream impact produced by the backend. A
useful query names the task, the symbols or files already known, and the
relationship to trace, such as callers, callees, data flow, or blast radius.

Agents should prefer the MCP tool. When shell fallback is necessary and a global
`code-deep` command is not visible in the current process's `PATH`, run the same
command through `npx -y @team-harness/code-deep@2.0.0`.

Use `--max-files <count>` to control the CLI analysis and source breadth. The MCP
`explore` tool accepts the same query, project path, and file limit, but projects
the response independently. It defaults to `detailLevel: "minimal"`, capped at
8,000 characters with structural context and the most relevant bounded source
file. `detailLevel: "standard"` is capped at 20,000 characters and includes at
most three bounded source files. Structured metadata reports original/returned
characters, returned source files, and up to three omitted files as the next
targeted queries. This keeps every response directly useful for reading code
while avoiding repeated broad discovery over the same persistent connection.

## Review modes

Review the current working tree, including staged, unstaged, and untracked files:

```bash
code-deep review /path/to/project
```

Review a branch or pull-request range:

```bash
code-deep review /path/to/project --base origin/main --head HEAD
```

Get the structured report:

```bash
code-deep review /path/to/project --json
```

The MCP `review` tool accepts the same `base` and `head`, or a caller-supplied
unified `diff`. These modes are mutually exclusive, and `head` always requires
`base`. With no diff or range it reviews the target project's current working tree.
It defaults to `detailLevel: "minimal"`, returning the risk summary, signals,
compact changed-line ranges, and the top three review items without embedding
the diff or graph context. `detailLevel: "standard"` returns the top ten review
items. Both levels cap nested symbol, impact, and test lists and expose explicit
omission counters. Use targeted `explore` calls to retrieve source and call-path
context for the highest-risk symbols instead of loading the complete review into
the agent context.

Review input limits are explicit: `maxFiles` is an integer from `1` to `100`
(default `20`) and bounds deep file, symbol, patch, and graph analysis;
`maxSymbols` is an integer from `1` to `50` (default `12`) and bounds mapped
symbols queried for impact. Values above these hard limits are rejected. Neither
parameter truncates the complete-diff totals or global risk signals, so use them
to control analysis breadth rather than response size. Response projection limits
are independent: for example, `maxSymbols: 50` can analyze 50 symbols while
`detailLevel: "standard"` returns only the top ten and reports the other 40 in
`reviewItemsOmitted`.

Other review inputs are explicit as well: `projectPath` is the absolute Git root
and defaults to the server project; choose one source mode (current working tree,
caller-supplied `diff`, or `base` with optional `head`). `diff` cannot be combined
with `base`/`head`, and `head` requires `base` (defaulting to `HEAD`).
`detailLevel` controls only the response projection: `minimal` is the default and
returns priorities, risk, compact ranges, and the top three items; `standard`
returns the top ten. Neither level embeds raw diff, impact text, or graph context.

## Process diagnostics

Inspect the local code-deep wrappers, CodeGraph proxies, shared project daemons,
and watchdogs without changing any process or file:

```bash
code-deep ps
code-deep ps --json
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
code-deep (long-lived process)
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

Risk scores are deterministic and explainable. Signals currently cover sensitive paths, missing test-file changes, graph impact width, high-confidence cross-boundary impact, diff size, file count, deleted files, and incomplete graph analysis. Overall risk is the higher of the global signal total and the highest per-symbol risk, so a locally high-risk symbol cannot be hidden by a low aggregate score. Global signals always use metadata from the complete diff; `maxFiles` and `maxSymbols` limit only deep graph and patch analysis. Scores prioritize review effort; they are not claims that a bug exists.

Cross-boundary scoring requires a confidently parsed impact and a non-low-confidence symbol mapping. Boundaries are conservatively recognized at workspace roots such as `apps/`, `packages/`, `services/`, `modules/`, and `libs/`, or by the first domain below `src/`. The current backend does not expose structured critical-flow evidence, so code-deep does not infer `critical-flow` from display text.

Every core report has `schemaVersion: 1` and a risk-ordered `reviewItems` array. Each
report also exposes `ignoredPaths` for tool-generated files excluded from an implicit
working-tree review; caller-supplied diffs and Git ranges leave it empty. Each
item represents one changed symbol and includes normalized impact symbols,
related test files, mapping and impact confidence, parser warnings, and the exact
reasons contributing to its per-symbol risk score. CLI JSON and library reports
retain the complete structure; MCP responses use `schemaVersion: 2`, expose the
selected `detailLevel` and `reviewItemsOmitted`, and use compact changed-line ranges.

```ts
const report = await codeDeep.review();
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
import { CodeDeepClient } from '@team-harness/code-deep';

const codeDeep = new CodeDeepClient({ projectPath: process.cwd() });
try {
  const context = await codeDeep.explore('AuthService login');
  const report = await codeDeep.review();
} finally {
  await codeDeep.close();
}
```

`CodeDeepClient` is the public library boundary. Its `explore()` and `review()`
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

This project is powered by [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph), licensed under MIT. `code-deep` is an independent Team Harness integration and is not an official CodeGraph package.
