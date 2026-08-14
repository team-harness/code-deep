# @team-harness/code-intel compatibility package

This package has moved to `@team-harness/code-deep`.

Installing this compatibility package installs the matching code-deep release
and exposes the `code-deep` command. Reinstall the agent configuration after
upgrading:

```bash
npm install -g @team-harness/code-intel
code-deep install --target codex,claude
```
