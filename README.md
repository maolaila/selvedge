# Selvedge CLI

**中文定位**：Selvedge 把 AI 编程从一次性聊天和零散命令，整理成可提问、可拆解、可验证、可停机恢复的长期自动化开发工作流。

Selvedge is a local CLI and dashboard control plane for long-running coding-agent work.
It turns a broad objective into small resumable tasks with explicit write boundaries,
validation gates, heartbeat status, stop conditions, recovery records, and human-review
handoff.

Selvedge runs inside your repository. It does not host your code, and it keeps its state
under `.selvedge/`.

## 中文介绍：让 AI 开发从“聊天式帮忙”变成“可控的长期工作流”

现在程序员用 AI 写代码，常见问题不是 AI 不会写，而是 AI 很难长期稳定地帮你把一个大目标做完：

- 目标一大，AI 容易一次性铺开，改动范围失控，最后很难 review。
- 需求没问清楚就开始写，做出来以后才发现方向、架构、边界或验收标准不对。
- 长任务跑到一半时，用户不知道它现在在做什么、卡在哪里、还能不能继续。
- 多轮执行后，AI 容易忘记前面的决策、验证结果、失败原因和人工停点。
- 自动化开发缺少明确的 WriteSet、验证命令、停止条件和恢复记录，不能放心无人值守。
- 代码能跑不代表能交付；缺少独立 QA、证据留档和 handoff，团队很难接手。

Selvedge 的思路是：不要让 AI 直接吞下一个巨大的目标，而是把目标变成一个本地、可恢复、可审计的执行控制面。

Selvedge 提供的核心能力：

- **总目标管理**：在 dashboard 中先保存项目总目标，再在这个总目标下拆分 scoped workflow，避免一个仓库里出现多个互相冲突的根目标。
- **AI 需求提问**：创建新目标时，Selvedge 会先让 AI 用中文为主提出关键问题，补齐业务结果、使用入口、权威事实源、写入边界、验证方式和停机条件。
- **架构确认门**：如果目标像是新项目初始化，Selvedge 会先生成技术栈、目录结构、初始化步骤和风险说明，等用户确认后才允许执行。
- **小步任务拆解**：把大目标拆成 intake、planning、development、QA、handoff 等阶段，每个任务都有 runner、WriteSet、validation、artifacts 和 stop policy。
- **本地 dashboard 控制台**：通过浏览器查看当前目标、任务队列、AI 提问、架构建议、心跳状态、停止条件，并可以安全启动、暂停或恢复。
- **Codex CLI 前置检查**：Selvedge 不会偷偷安装 AI runner；它会检测 `codex` 是否可用，缺失时给出清晰安装和登录提示。普通 dashboard 可继续使用，AI 拆解和自动执行会被明确阻塞。
- **无人值守安全边界**：支持 `STOP_AGENT`、安全停机、强制停机恢复记录、任务前后 Git dirty-state gate、失败分类和可恢复状态。
- **持续心跳和证据**：长任务运行时持续写入 heartbeat、日志、last message、workflow status 和 handoff 文档，用户可以随时知道“现在在做什么”。
- **验证优先交付**：每个任务都要求声明验证命令或证据；开发和 QA 分离，避免把“AI 说完成了”当成交付标准。
- **本地优先和可迁移**：Selvedge 运行在你的仓库里，状态保存在 `.selvedge/`，不托管你的代码，也不绑定特定业务项目。

适合的使用场景：

- 想把 AI 开发包装成长期自动化工作流，而不是一次性 prompt。
- 需要在本地仓库里持续执行迁移、重构、QA、文档治理或产品化任务。
- 希望 AI 先提问、先拆解、先设边界，再开始改代码。
- 希望无人执行时仍有可追踪的状态、日志、验证证据和人工接手机制。

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
- Codex CLI is needed for dashboard AI intake, architecture decomposition, and
  `codex-cli` / `codex-app-agent` execution. Selvedge detects it and shows setup
  guidance instead of installing it automatically.

Install Codex CLI when you want AI-guided planning or unattended execution:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex
```

Or with npm:

```sh
npm install -g @openai/codex
codex
```

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
