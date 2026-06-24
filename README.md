# Selvedge CLI

Selvedge is a local CLI and dashboard control plane for long-running coding-agent work.
It turns a broad objective into small resumable tasks with explicit write boundaries,
validation gates, heartbeat status, stop conditions, recovery records, and human-review
handoff.

Selvedge runs inside your repository. It does not host your code, and it keeps its state
under `.selvedge/`.

## Install

```sh
pnpm dlx @maolaila1/selvedge init
pnpm dlx @maolaila1/selvedge status
pnpm dlx @maolaila1/selvedge dashboard
```

After a global install:

```sh
npm install -g @maolaila1/selvedge
selvedge init
selvedge dashboard
```

Requirements:

- Node.js 20 or newer.
- Git for repository safety checks.
- Bun is needed only when running this source checkout's tests.
- Codex CLI is needed only for `codex-cli` or `codex-app-agent` execution.

## Quick Start

Initialize a project:

```sh
selvedge init
selvedge status
```

Create a bounded goal workflow:

```sh
selvedge plan goal \
  --id docs-refresh \
  --goal "Improve the README and verify links" \
  --workstream docs \
  --write "README.md" \
  --validation "git diff --check" \
  --non-interactive
```

Preview the next task:

```sh
selvedge run next --goal docs-refresh --dry-run
```

Run one task:

```sh
selvedge run next --goal docs-refresh --execute --max-steps 1
```

Run a loop until the workflow stops:

```sh
selvedge run loop --goal docs-refresh --execute --stop-time none --heartbeat-seconds 30
```

Open the local dashboard:

```sh
selvedge dashboard
```

The dashboard defaults to `http://127.0.0.1:17371/`. Use `--no-open` for
headless environments, or `--port <port>` to choose another port.

## Safety Model

Selvedge is designed around bounded execution:

- The total goal is planning context, not one giant runner prompt.
- Each executable task has a declared WriteSet, validation command list, artifacts,
  dependencies, and stop policy.
- `STOP_AGENT` in the repository root stops the next loop boundary.
- Dashboard safe stop writes `STOP_AGENT`; force stop records a recovery marker.
- Git dirty-state gates run before task start and after task completion.
- Automatic commit and push are disabled by default. Use `--auto-push` only when
  the repository policy allows Selvedge to commit declared task outputs and push
  the current branch.

## Dashboard

The dashboard is the preferred operator surface. It can:

- create or continue a project objective,
- ask guided intake questions,
- normalize stop conditions,
- start or stop the loop,
- show current task progress and heartbeat state,
- preserve user-entered form text while live status updates stream over WebSocket,
- fall back to snapshot polling if WebSocket is unavailable.

## Command Reference

```sh
selvedge init
selvedge status
selvedge validate
selvedge plan work --id <id> --goal <path-or-description> --workstream <name> --write <path> --validation <command>
selvedge plan goal --id <id> --goal <description> --profile <universal-autopilot|kg-game-migration|kg-slots-migration>
selvedge run next --goal <id> --execute [--max-steps <n>]
selvedge run loop --goal <id> --execute [--stop-time 07:30|none] [--auto-push] [--heartbeat-seconds 30] [--max-rounds <n>]
selvedge goal status --id <id>
selvedge dashboard [--port 17371] [--no-open]
selvedge serve [--port 17371] [--no-open]
```

`serve` is an alias for `dashboard`.

## Profiles

The default profile is `universal-autopilot`, which is intended for ordinary
repository work.

The `kg-game-migration` and `kg-slots-migration` profiles are dogfood profiles
from the original GameHub incubation project. They remain useful examples of how
Selvedge can encode domain-specific gates, but they are not required for a normal
project.

## Local Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

## Publish Checklist

Before publishing:

```sh
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
npm publish --dry-run --access public
```

Then publish:

```sh
npm login
npm publish --access public
```
