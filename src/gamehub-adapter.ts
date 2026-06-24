import { existsSync } from 'node:fs';
import { repoPath, readTextIfExists } from './fs-utils';
import { readSelvedgeConfig, validateSelvedgeConfig } from './config';
import type {
  AiQaSwitchState,
  GameHubReadOnlyModel,
  SelvedgeValidationIssue,
  StopFileState,
  TaskBoardState
} from './types';

function section(text: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = new RegExp(`^${escapedHeading}\\s*$`, 'm').exec(text);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }
  const rest = text.slice(startMatch.index + startMatch[0].length);
  const next = rest.search(/\n##\s+/);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function countTaskIds(text: string | null): number {
  if (!text || /^None\./m.test(text)) {
    return 0;
  }
  const matches = text.match(/^\s*-\s+\[[ xX]\]\s+ID:/gm);
  return matches?.length ?? 0;
}

function firstTaskId(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const match = /^\s*-\s+\[[ xX]\]\s+ID:\s*([^\r\n]+)/m.exec(text);
  return match?.[1]?.trim() ?? null;
}

function matchYamlScalar(text: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escapedKey}:\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!match) {
    return null;
  }
  return match[1]?.replace(/^"|"$/g, '') ?? null;
}

function extractCurrentSwitch(text: string): string | null {
  const current = section(text, '## Current Switch');
  if (!current) {
    return null;
  }
  const fenced = /```yaml\s*([\s\S]*?)```/m.exec(current);
  return fenced?.[1] ?? null;
}

export function readTaskBoard(cwd: string): TaskBoardState {
  const path = repoPath(cwd, 'docs/autopilot/state/TASK_BOARD.md');
  const text = readTextIfExists(path);
  if (!text) {
    return {
      exists: false,
      pendingRaw: null,
      pendingCount: 0,
      firstPendingId: null,
      inProgressRaw: null,
      inProgressCount: 0,
      approvedAfterAiQaMentionsSelvedge: false,
      manualAcceptancePassed: false
    };
  }
  const pendingRaw = section(text, '## Pending');
  const inProgressRaw = section(text, '## In Progress');
  const approvedRaw = section(text, '## Approved After AI-QA');
  return {
    exists: true,
    pendingRaw,
    pendingCount: countTaskIds(pendingRaw),
    firstPendingId: firstTaskId(pendingRaw),
    inProgressRaw,
    inProgressCount: countTaskIds(inProgressRaw),
    approvedAfterAiQaMentionsSelvedge: /Selvedge commercial productization/i.test(approvedRaw ?? ''),
    manualAcceptancePassed: /manual acceptance passed/i.test(pendingRaw ?? '')
  };
}

export function readAiQaSwitch(cwd: string): AiQaSwitchState {
  const path = repoPath(cwd, 'docs/autopilot/state/AI_QA_CAMPAIGN.md');
  const text = readTextIfExists(path);
  if (!text) {
    return {
      exists: false,
      enabled: 'unknown',
      workstream: null,
      campaignId: null,
      disabledReason: null
    };
  }
  const currentSwitch = extractCurrentSwitch(text);
  if (!currentSwitch) {
    return {
      exists: true,
      enabled: 'unknown',
      workstream: null,
      campaignId: null,
      disabledReason: null
    };
  }
  const enabledScalar = matchYamlScalar(currentSwitch, 'enabled');
  return {
    exists: true,
    enabled: enabledScalar === 'true' ? true : enabledScalar === 'false' ? false : 'unknown',
    workstream: matchYamlScalar(currentSwitch, 'workstream'),
    campaignId: matchYamlScalar(currentSwitch, 'campaignId'),
    disabledReason: /disabledReason:\s*>/m.test(currentSwitch) ? 'present' : null
  };
}

export function readStopFile(cwd: string): StopFileState {
  const path = repoPath(cwd, 'STOP_AGENT');
  const text = readTextIfExists(path);
  return {
    exists: existsSync(path),
    path,
    summary: text ? text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? null : null
  };
}

export function buildReadOnlyModel(cwd: string): GameHubReadOnlyModel {
  const config = readSelvedgeConfig(cwd);
  const taskBoard = readTaskBoard(cwd);
  const aiQaSwitch = readAiQaSwitch(cwd);
  const stopFile = readStopFile(cwd);
  const issues: SelvedgeValidationIssue[] = [...validateSelvedgeConfig(config)];
  const gameHubAdapterActive =
    taskBoard.exists ||
    aiQaSwitch.exists ||
    /^(game-hub|gamehub)$/i.test(config.projectName ?? '');

  if (gameHubAdapterActive && !taskBoard.exists) {
    issues.push({
      code: 'gamehub.taskBoard.missing',
      severity: 'error',
      message: 'docs/autopilot/state/TASK_BOARD.md is required for GameHub adapter parity.'
    });
  }
  if (gameHubAdapterActive && !aiQaSwitch.exists) {
    issues.push({
      code: 'gamehub.aiQaSwitch.missing',
      severity: 'warning',
      message: 'AI_QA_CAMPAIGN.md is missing; AI-QA switch parity cannot be evaluated.'
    });
  }
  if (aiQaSwitch.enabled === true) {
    issues.push({
      code: 'gamehub.aiQaSwitch.enabled',
      severity: 'error',
      message: `AI-QA switch is still enabled for ${aiQaSwitch.campaignId ?? 'unknown campaign'}. Do not start Selvedge mainline.`
    });
  }
  if (taskBoard.pendingCount > 0) {
    issues.push({
      code: 'gamehub.pending.exists',
      severity: 'error',
      message: `Current first Pending task is ${taskBoard.firstPendingId ?? 'unknown'}. Selvedge must not bypass it.`
    });
  }
  if (gameHubAdapterActive && !taskBoard.approvedAfterAiQaMentionsSelvedge) {
    issues.push({
      code: 'gamehub.selvedgeMainline.notRecorded',
      severity: 'warning',
      message: 'Task board does not record Selvedge as the approved post-QA mainline.'
    });
  }

  const hasBlockingError = issues.some((issue) => issue.severity === 'error');
  const canStart = gameHubAdapterActive
    ? !hasBlockingError && aiQaSwitch.enabled === false && taskBoard.pendingCount === 0
    : !hasBlockingError;
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    config,
    taskBoard,
    aiQaSwitch,
    stopFile,
    firstExecutableTask:
      taskBoard.pendingCount > 0
        ? {
            verdict: 'pending',
            reason: 'GameHub single-lane controller would execute the first Pending task.',
            taskId: taskBoard.firstPendingId
          }
        : !gameHubAdapterActive
          ? {
              verdict: 'none',
              reason: 'Generic Selvedge project is initialized; create a goal workflow or open the dashboard.',
              taskId: null
            }
        : {
            verdict: 'none',
            reason: 'Legacy TASK_BOARD Pending is empty; future approved work should start from Selvedge goal workflows.',
            taskId: null
          },
    selvedgeMainline: {
      canStartInCodexApp: canStart,
      reason:
        canStart && gameHubAdapterActive
          ? 'Legacy quick-games QA is historical, old Pending is empty, and Selvedge is the default GameHub control path.'
          : canStart
            ? 'Generic Selvedge project is ready. Use goal workflows or the dashboard to create bounded work.'
          : 'Selvedge mainline is not ready; see validation issues.'
    },
    issues
  };
}
