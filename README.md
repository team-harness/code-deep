# code-intel

`code-intel` is a persistent MCP bridge for code exploration and diff-aware review. It keeps one CodeGraph MCP connection alive for the lifetime of the outer MCP server and exposes a deliberately small interface:

- `explore`: relevant source, call paths, and blast radius.
- `review`: diff parsing, changed-symbol mapping, impact collection, explainable risk scoring, and a structured report.

The npm package is `@team-harness/code-intel`. It installs CodeGraph as an exact dependency; end users do not need a separate global CodeGraph installation.

## Install

```bash
npm install -g @team-harness/code-intel
code-intel install --target codex,claude
cd /path/to/project
code-intel init
```

`install` registers the `code-intel` MCP server globally for the selected agents.
It also adds a marker-delimited guidance block to Codex `~/.codex/AGENTS.md`
and Claude `~/.claude/CLAUDE.md`, directing both agents to use `explore` for
code discovery and `review` before finalizing changes. Claude receives the
`mcp__code-intel__*` permission in `~/.claude/settings.json`.

The installer preserves unrelated configuration, backs up each changed existing
file as `<file>.code-intel.bak`, and is idempotent. It does not initialize any
repository. Run `code-intel init` inside each project to create its local
`.codegraph/` index. The MCP process keeps the connection warm and CodeGraph
watches indexed source changes after startup.

## MCP configuration

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "npx",
      "args": [
        "-y",
        "@team-harness/code-intel",
        "mcp",
        "--path",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

The agent sees only `explore` and `review`. Internally, the review module also uses CodeGraph's `node` and `impact` tools; they are not exposed on the outer MCP surface.

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

The MCP `review` tool accepts the same `base` and `head`, or a caller-supplied unified `diff`. With no diff or range it reviews the target project's current working tree.

## Architecture

```text
Agent / MCP host
      |
      | stdio MCP: explore, review
      v
code-intel (long-lived process)
      |
      +-- CodeGraphBridge ---- persistent MCP client ---- CodeGraph MCP
      |
      +-- ReviewAnalyzer
            +-- structured unified-diff parser
            +-- hunk -> current symbol mapping
            +-- node / impact / explore queries
            +-- deterministic risk scorer
            +-- Markdown + structured JSON report
```

The bridge lazily starts CodeGraph on the first tool call, reuses that connection for later calls, and reconnects once if the child exits during a read-only request. CodeGraph may additionally share its own per-project daemon across MCP clients.

## Review semantics

Risk scores are deterministic and explainable. Signals currently cover sensitive paths, missing test-file changes, graph impact width, diff size, file count, and deleted files. They prioritize review effort; they are not claims that a bug exists.

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
internal implementation details.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Upstream

This project is powered by [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph), licensed under MIT. `code-intel` is an independent Team Harness integration and is not an official CodeGraph package.
