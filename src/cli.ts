#!/usr/bin/env node
import { runGoal, runInit, runPlan, runRun, runServe, runStatus, runValidate } from './commands';
import type { CliOptions, SelvedgeCommand } from './types';

function parseCommand(raw: string | undefined): SelvedgeCommand {
  switch (raw) {
    case 'init':
    case 'status':
    case 'validate':
    case 'goal':
    case 'plan':
    case 'run':
    case 'dashboard':
    case 'serve':
      return raw;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return 'help';
    default:
      return 'help';
  }
}

function printHelp(): void {
  console.log(`Selvedge CLI

Usage:
  selvedge init
  selvedge status
  selvedge validate
  selvedge plan work --id <id> --goal <path-or-description> --workstream <name> --write <path> --validation <command>
  selvedge plan work --id <id> --goal <path-or-description> --runner shell --command <command>
  selvedge plan goal --id <id> --goal <description> --profile <universal-autopilot|kg-game-migration|kg-slots-migration> --non-interactive --answer <question=value>
  selvedge plan autopilot-next --id <id>
  selvedge run next --goal <id> --execute [--max-steps <n>] [--codex-executable codex] [--model gpt-5.5] [--capacity-retry-count 0] [--capacity-retry-base-seconds 300]
  selvedge run loop --goal <id> --execute [--stop-time 07:30|none] [--clear-stop-on-start] [--auto-push] [--heartbeat-seconds 30] [--max-rounds <n>] [--capacity-retry-count 0] [--capacity-retry-base-seconds 300]
  selvedge goal status --id <id>
  selvedge dashboard [--port 17371] [--no-open]
  selvedge plan kg-slots --target <game-or-review-id>
  selvedge run --plan <plan-id-or-path> [--task <task-id>] [--dry-run|--execute]
  selvedge serve [--port 17371] [--no-open]

Core behavior:
  - initializes npm-installed projects with selvedge.yaml and local .selvedge/ state
  - validates generic Selvedge projects without requiring GameHub-specific files
  - generates assigned-work and goal workflow task models under .selvedge/
  - generates AI-intake goal workflows with development and QA phases
  - applies reusable workflow profiles, defaulting to universal-autopilot
  - executes resumable goal queues through selvedge run next
  - executes shell, builtin, codex-cli, and codex-app-agent tasks through local runner adapters
  - runs long-lived goal loops with STOP_AGENT and stop-time safety gates
  - retries clean transient runner interruptions with Autopilot-style linear backoff
  - can auto-commit and push successful loop rounds when --auto-push is explicitly set
  - prints Selvedge heartbeat blocks every --heartbeat-seconds during Codex tasks
  - opens a dashboard-first operator flow through selvedge dashboard
  - opens the dashboard page automatically after a successful dashboard start
  - supports dashboard language switching between Chinese and English
  - accepts dashboard natural-language stop conditions that normalize into configurable stop-condition files
  - keeps GameHub/KG profiles as optional dogfood adapters, not the default npm path
  - supports --service-tier default|fast; omit it for Codex default service tier
`);
}

export async function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const command = parseCommand(normalizedArgv[0]);
  const options: CliOptions = {
    command,
    args: normalizedArgv.slice(1),
    cwd
  };
  try {
    switch (command) {
      case 'init':
        return runInit(options);
      case 'status':
        return runStatus(options);
      case 'validate':
        return runValidate(options);
      case 'goal':
        return runGoal(options);
      case 'plan':
        return runPlan(options);
      case 'run':
        return await runRun(options);
      case 'dashboard':
        return runServe(options);
      case 'serve':
        return runServe(options);
      case 'help':
        printHelp();
        return normalizedArgv[0] && !['help', '--help', '-h'].includes(normalizedArgv[0]) ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
