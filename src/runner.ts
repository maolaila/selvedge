import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localStatePath, writeJson, writeText } from './fs-utils';
import { SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS } from './types';
import type {
  SelvedgeGoalWorkflow,
  SelvedgeHeartbeatDisplayContext,
  SelvedgeHeartbeatOptionalField,
  SelvedgeHeartbeatTemplate,
  SelvedgeWorkflowPhase,
  SelvedgeWorkflowTask
} from './types';

export interface SelvedgeCodexRunnerOptions {
  readonly codexExecutable: string;
  readonly model: string;
  readonly serviceTier: 'auto' | 'fast' | 'flex' | 'priority';
  readonly reasoningEffort: 'default' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly timeoutMs?: number;
  readonly jsonOutput: boolean;
  readonly showOutput: boolean;
  readonly skipConfigGuard: boolean;
  readonly ignoreUserConfig: boolean;
  readonly heartbeatSeconds: number;
  readonly heartbeatTemplate?: SelvedgeHeartbeatTemplate;
  readonly heartbeatTemplatePath?: string;
  readonly heartbeatContext?: SelvedgeHeartbeatDisplayContext;
  readonly heartbeatContextPath?: string;
  readonly staleFinalMessageGraceMs?: number;
  readonly onHeartbeat?: (heartbeat: SelvedgeRunnerHeartbeat) => void;
}

export interface SelvedgeCodexRunResult {
  readonly exitCode: number;
  readonly status: 'Completed' | 'Failed';
  readonly classification: 'success' | 'failed' | 'capacity-interrupted' | 'config-error' | 'spawn-error';
  readonly promptPath: string;
  readonly logPath: string;
  readonly lastMessagePath: string;
  readonly statusPath: string;
}

export interface SelvedgeRunnerHeartbeat {
  readonly workflowId: string;
  readonly workflowTitle: string;
  readonly localTime: string;
  readonly totalGoal: string;
  readonly profileTitle: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskDisplayName: string;
  readonly taskProgress: string;
  readonly taskIndex: number;
  readonly taskTotal: number;
  readonly completedTasks: number;
  readonly phase: SelvedgeWorkflowPhase;
  readonly phaseLabel: string;
  readonly phaseProgress: string;
  readonly stage: string;
  readonly role: string;
  readonly roadmapNode: string;
  readonly currentAction: string;
  readonly migrationTarget: string | null;
  readonly runner: 'codex-cli';
  readonly elapsedMs: number;
  readonly elapsed: string;
  readonly idleMs: number;
  readonly idle: string;
  readonly logPath: string;
  readonly logDisplayPath: string;
  readonly lastMessagePath: string;
}

export interface SelvedgeStopPolicy {
  readonly stopFile: string;
  readonly stopTime: string;
  readonly cutoff: Date | null;
}

const VALID_SERVICE_TIERS = ['auto', 'fast', 'flex', 'priority'] as const;
const VALID_REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh'] as const;
const DEFAULT_STALE_FINAL_MESSAGE_GRACE_MS = 5 * 60 * 1000;
const FINAL_MESSAGE_STABLE_MS = 30 * 1000;
const DEFAULT_HEARTBEAT_TEMPLATE: SelvedgeHeartbeatTemplate = {
  format: 'block',
  optionalFields: ['machine']
};
const HEARTBEAT_OPTIONAL_FIELD_SET = new Set<string>(SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS);

const PHASE_LABELS: Record<SelvedgeWorkflowPhase, string> = {
  intake: '需求澄清 / 目标建档',
  planning: '事实源盘点 / 任务拆解',
  development: '开发执行',
  qa: 'QA 验收 / 独立复查',
  handoff: '交付总结 / 人工接手'
};

const KG_SLOTS_TASK_LABELS: Array<[RegExp, string]> = [
  [/intake$/, '确认迁移目标、事实源和执行边界'],
  [/source-feature-inventory$/, '盘点原版功能地图（只读源码，不写实现）'],
  [/functional-detail-ledger$/, '整理功能细节对齐清单（拆出最小开发项）'],
  [/backend-handler$/, 'Backend handler runtime slice'],
  [/shell-start-roominfo-primitives$/, 'Shell room/start primitives slice'],
  [/result-mapper-runtime$/, 'Result mapper/runtime slice'],
  [/history-detail-bridge$/, 'History/detail bridge slice'],
  [/route-context-integration$/, 'Route/context integration slice'],
  [/qa-self-test$/, '开发后自测与源码逻辑回归'],
  [/independent-audit$/, '独立复查：原版源码 vs 已迁移实现'],
  [/handoff$/, '整理交付、证据和人工验收资料']
];

function compactText(input: string, maxLength: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function displayStatePath(input: string): string {
  const match = input.match(/(?:^|[\\/])\.selvedge[\\/].*$/);
  return match ? match[0].replace(/^[\\/]/, '') : compactText(input, 96);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((item) => String(item).padStart(2, '0')).join(':');
}

export function formatLocalTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `UTC${offsetSign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`
  ].join(' ');
}

function taskDisplayName(workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): string {
  if (workflow.profile.id === 'kg-slots-migration') {
    const match = KG_SLOTS_TASK_LABELS.find(([pattern]) => pattern.test(task.id));
    if (match) {
      return match[1];
    }
  }
  return compactText(task.title, 96);
}

function currentActionForTask(task: SelvedgeWorkflowTask, idleMs: number): string {
  const idle = formatDuration(idleMs);
  if (idleMs >= 10 * 60 * 1000) {
    return `Codex CLI 正在执行当前细分任务，已 ${idle} 没有新输出；继续等待，必要时查看日志`;
  }
  if (task.phase === 'planning') {
    return `Codex CLI 正在整理事实源、边界和后续最小任务；最近输出 ${idle} 前`;
  }
  if (task.phase === 'development') {
    return `Codex CLI 正在执行开发任务；最近输出 ${idle} 前`;
  }
  if (task.phase === 'qa') {
    return `Codex CLI 正在执行 QA / 复查任务；最近输出 ${idle} 前`;
  }
  return `Codex CLI 正在执行当前细分任务；最近输出 ${idle} 前`;
}

function recentMeaningfulLogLines(logTail: string): readonly string[] {
  const heartbeatLine =
    /^(?:\[Selvedge heartbeat\]|\s*(状态|总目标|阶段|任务|现在|用时|静默|日志|机器|迁移目标|Profile|进度|角色|路线节点|Runner|任务标题|完整路径):)/;
  return logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !heartbeatLine.test(line))
    .filter((line) => !/^[-\s]*codex output (begin|end)[-\s]*$/i.test(line))
    .reverse();
}

function lineForAction(lines: readonly string[], pattern: RegExp): string | null {
  const line = lines.find((item) => pattern.test(item));
  return line ? compactText(line, 128) : null;
}

export function classifyRunnerCurrentAction(task: SelvedgeWorkflowTask, idleMs: number, logTail: string): string {
  const idle = formatDuration(idleMs);
  const lines = recentMeaningfulLogLines(logTail);
  const stopLine = lineForAction(lines, /\bSTOP_AGENT\b|stop requested|safe stop|SIGINT|Stopped before|stop gate/i);
  if (stopLine) {
    return `停止门: ${stopLine}；最近输出 ${idle} 前`;
  }
  const gitLine = lineForAction(lines, /\bgit\s+(status|add|commit|push|diff|show|rev-parse|branch)\b|Git Gate|auto-push|worktree|dirty/i);
  if (gitLine) {
    return `Git Gate: ${gitLine}；最近输出 ${idle} 前`;
  }
  const qaSelfTestLine = lineForAction(
    lines,
    /\b(pnpm|bun|npm|yarn|node\s+--check|typecheck|vitest|jest|test|smoke|playwright|validate|kg-micro-shell:validate)\b/i
  );
  if (qaSelfTestLine) {
    return `QA 自测: ${qaSelfTestLine}；最近输出 ${idle} 前`;
  }
  const qaReviewLine = lineForAction(lines, /qa[-_\s]?reviewer|independent audit|review|复查|validation|PASS|FAILED|blocked|mismatch/i);
  if (qaReviewLine) {
    return `QA 复核: ${qaReviewLine}；最近输出 ${idle} 前`;
  }
  const implementationLine = lineForAction(lines, /apply_patch|Update File|Add File|Delete File|implementation|implement|modified|edit|patch/i);
  if (implementationLine) {
    return `开发实现: ${implementationLine}；最近输出 ${idle} 前`;
  }
  const contextLine = lineForAction(lines, /Get-Content|Select-String|\brg\b|Required first reads|authority source|source intake|AGENTS\.md|README\.md/i);
  if (contextLine) {
    return `上下文读取: ${contextLine}；最近输出 ${idle} 前`;
  }
  const latestLine = lines[0];
  if (latestLine) {
    return `Codex CLI 最近输出: ${compactText(latestLine, 128)}；最近输出 ${idle} 前`;
  }
  return currentActionForTask(task, idleMs);
}

function migrationTargetFromWorkflow(workflow: SelvedgeGoalWorkflow): string | null {
  if (workflow.profile.id !== 'kg-slots-migration' && workflow.profile.id !== 'kg-game-migration') {
    return null;
  }
  const targetGame = workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.answer ?? null;
  if (workflow.profile.id === 'kg-game-migration') {
    return targetGame ? `KG game / ${compactText(targetGame, 96)}` : 'KG game / target pending';
  }
  if (targetGame && !/AuthorizedAutoSelect|auto/i.test(targetGame)) {
    return `KG slots / ${compactText(targetGame, 96)}`;
  }
  return 'KG slots / 待确认下一款游戏';
}

export function buildRunnerHeartbeat(
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  timing: {
    readonly elapsedMs: number;
    readonly idleMs: number;
    readonly logPath: string;
    readonly lastMessagePath: string;
    readonly currentAction?: string;
  },
  context?: SelvedgeHeartbeatDisplayContext
): SelvedgeRunnerHeartbeat {
  const taskIndex = Math.max(0, workflow.tasks.findIndex((item) => item.id === task.id)) + 1;
  const phaseIndex = Math.max(0, workflow.profile.lifecycle.findIndex((item) => item === task.phase)) + 1;
  const completedTasks = workflow.tasks.filter((item) => item.status === 'Completed').length;
  return {
    workflowId: workflow.id,
    workflowTitle: compactText(workflow.title, 120),
    localTime: formatLocalTimestamp(),
    totalGoal: compactText(context?.projectTotalGoal || workflow.target || workflow.title, 140),
    profileTitle: workflow.profile.title,
    taskId: task.id,
    taskTitle: compactText(task.title, 120),
    taskDisplayName: taskDisplayName(workflow, task),
    taskProgress: `${taskIndex}/${workflow.tasks.length}`,
    taskIndex,
    taskTotal: workflow.tasks.length,
    completedTasks,
    phase: task.phase,
    phaseLabel: PHASE_LABELS[task.phase],
    phaseProgress: `${phaseIndex}/${workflow.profile.lifecycle.length}`,
    stage: task.stage,
    role: task.role,
    roadmapNode: task.roadmapNode,
    currentAction: timing.currentAction ?? currentActionForTask(task, timing.idleMs),
    migrationTarget: context?.migrationTarget ?? migrationTargetFromWorkflow(workflow),
    runner: 'codex-cli',
    elapsedMs: timing.elapsedMs,
    elapsed: formatDuration(timing.elapsedMs),
    idleMs: timing.idleMs,
    idle: formatDuration(timing.idleMs),
    logPath: timing.logPath,
    logDisplayPath: displayStatePath(timing.logPath),
    lastMessagePath: timing.lastMessagePath
  };
}

export function buildHeartbeatLine(payload: SelvedgeRunnerHeartbeat): string {
  return buildHeartbeatBlock(payload);
}

function normalizeHeartbeatTemplate(template?: SelvedgeHeartbeatTemplate): SelvedgeHeartbeatTemplate {
  if (!template) {
    return DEFAULT_HEARTBEAT_TEMPLATE;
  }
  const optionalFields = template.optionalFields.filter(
    (field): field is SelvedgeHeartbeatOptionalField => HEARTBEAT_OPTIONAL_FIELD_SET.has(field)
  );
  return {
    format: 'block',
    optionalFields
  };
}

function optionalHeartbeatLine(payload: SelvedgeRunnerHeartbeat, field: SelvedgeHeartbeatOptionalField): string | null {
  switch (field) {
    case 'machine':
      return `  机器: workflow=${payload.workflowId} | task=${payload.taskId}`;
    case 'migrationTarget':
      return `  迁移目标: ${payload.migrationTarget ?? '未配置'}`;
    case 'profile':
      return `  Profile: ${payload.profileTitle}`;
    case 'progress':
      return `  进度: 已完成 ${payload.completedTasks}/${payload.taskTotal} | 当前任务 ${payload.taskProgress} | 当前阶段 ${payload.phaseProgress}`;
    case 'role':
      return `  角色: ${payload.role}`;
    case 'roadmapNode':
      return `  路线节点: ${payload.roadmapNode}`;
    case 'runner':
      return `  Runner: ${payload.runner}`;
    case 'taskTitle':
      return `  任务标题: ${payload.taskTitle}`;
    case 'paths':
      return `  完整路径: log=${payload.logPath} | lastMessage=${payload.lastMessagePath}`;
    default:
      return null;
  }
}

export function buildHeartbeatBlock(payload: SelvedgeRunnerHeartbeat, template?: SelvedgeHeartbeatTemplate): string {
  const resolvedTemplate = normalizeHeartbeatTemplate(template);
  const fixedLines = [
    '[Selvedge heartbeat]',
    `  本机时间: ${payload.localTime}`,
    `  状态: 运行中`,
    `  总目标: ${payload.totalGoal}`,
    `  阶段: ${payload.phaseLabel} (${payload.phaseProgress})`,
    `  任务: ${payload.taskProgress} ${payload.taskDisplayName}`,
    `  现在: ${payload.currentAction}`,
    `  用时: ${payload.elapsed}`,
    `  静默: ${payload.idle}`,
    `  日志: ${payload.logDisplayPath}`
  ];
  const optionalLines = resolvedTemplate.optionalFields
    .map((field) => optionalHeartbeatLine(payload, field))
    .filter((line): line is string => Boolean(line));
  return [...fixedLines, ...optionalLines].join('\n');
}

function optionValue(args: readonly string[], name: string): string | null {
  const index = args.findIndex((arg) => arg === name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

function optionNumber(args: readonly string[], name: string): number | undefined {
  const rawValue = optionValue(args, name);
  if (!rawValue) {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function oneOf<T extends readonly string[]>(name: string, value: string | null, values: T, fallback: T[number]): T[number] {
  if (!value) {
    return fallback;
  }
  if (values.includes(value)) {
    return value as T[number];
  }
  throw new Error(`Unsupported ${name} "${value}". Expected one of: ${values.join(', ')}.`);
}

export function resolveCodexRunnerOptions(args: readonly string[]): SelvedgeCodexRunnerOptions {
  const requestedServiceTier = optionValue(args, '--service-tier') ?? process.env.SELVEDGE_SERVICE_TIER ?? null;
  const staleFinalMessageGraceSeconds = optionNumber(args, '--stale-final-message-grace-seconds');
  return {
    codexExecutable: optionValue(args, '--codex-executable') ?? process.env.SELVEDGE_CODEX_EXECUTABLE ?? 'codex',
    model: optionValue(args, '--model') ?? process.env.SELVEDGE_CODEX_MODEL ?? 'gpt-5.5',
    serviceTier: oneOf('--service-tier', requestedServiceTier === 'default' ? 'auto' : requestedServiceTier, VALID_SERVICE_TIERS, 'auto'),
    reasoningEffort: oneOf(
      '--reasoning-effort',
      optionValue(args, '--reasoning-effort') ?? process.env.SELVEDGE_REASONING_EFFORT ?? null,
      VALID_REASONING_EFFORTS,
      'xhigh'
    ),
    timeoutMs: optionNumber(args, '--timeout-ms'),
    jsonOutput: args.includes('--codex-json'),
    showOutput: args.includes('--show-codex-output'),
    skipConfigGuard: args.includes('--skip-codex-config-guard'),
    ignoreUserConfig: !args.includes('--use-user-config'),
    heartbeatSeconds: optionNumber(args, '--heartbeat-seconds') ?? 30,
    staleFinalMessageGraceMs:
      staleFinalMessageGraceSeconds === undefined
        ? DEFAULT_STALE_FINAL_MESSAGE_GRACE_MS
        : staleFinalMessageGraceSeconds * 1000
  };
}

export function buildCodexExecArgs(cwd: string, lastMessagePath: string, options: SelvedgeCodexRunnerOptions): readonly string[] {
  const args: string[] = ['--ask-for-approval', 'never', 'exec'];
  if (options.ignoreUserConfig) {
    args.push('--ignore-user-config');
  }
  if (options.reasoningEffort !== 'default') {
    args.push('--config', `model_reasoning_effort=${options.reasoningEffort}`);
  }
  if (options.serviceTier !== 'auto') {
    args.push('--config', `service_tier="${options.serviceTier}"`);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.jsonOutput) {
    args.push('--json');
  }
  args.push('--sandbox', 'danger-full-access', '--cd', cwd, '--output-last-message', lastMessagePath, '-');
  return args;
}

function userCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
  return join(codexHome, 'config.toml');
}

export function assertCodexServiceTierConfig(): void {
  const configPath = userCodexConfigPath();
  if (!existsSync(configPath)) {
    return;
  }
  const invalid: string[] = [];
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(service_tier|default-service-tier)\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[2] !== 'fast' && match[2] !== 'flex' && match[2] !== 'priority') {
      invalid.push(`${configPath}:${index + 1} ${match[1]}="${match[2]}"`);
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Codex user config contains unsupported service tier value(s): ${invalid.join('; ')}. Use fast/flex/priority, or remove the setting.`);
  }
}

function heartbeatContextPromptLines(contextPath: string | undefined): readonly string[] {
  if (!contextPath) {
    return [];
  }
  return [
    '- Before task work, read the heartbeat display context file and verify the human-facing task/target wording still matches this task.',
    `- Heartbeat display context: ${contextPath}`,
    '- If the context is stale or wrong, update only that heartbeat context file first; keep the fixed heartbeat block fields intact.'
  ];
}

export function buildCodexTaskPrompt(workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask, heartbeatContextPath?: string): string {
  const commandLines = task.commands?.length ? task.commands.map((item) => `- ${item}`) : ['- None declared; use Codex reasoning/tools for this task.'];
  return [
    `You are executing one Selvedge workflow task through Codex CLI.`,
    '',
    `Repository role: single-writer task controller for this round.`,
    `WorkflowId: ${workflow.id}`,
    `WorkflowTitle: ${workflow.title}`,
    `WorkflowMode: ${workflow.mode}`,
    `Profile: ${workflow.profile.id} / ${workflow.profile.title}`,
    `Workstream: ${workflow.workstream}`,
    `TaskId: ${task.id}`,
    `TaskTitle: ${task.title}`,
    `TaskPhase: ${task.phase}`,
    `TaskRole: ${task.role}`,
    `RoadmapNode: ${task.roadmapNode}`,
    `StopPolicy: ${task.stopPolicy}`,
    '',
    'Required first reads:',
    '- README.md',
    '- AGENTS.md',
    '- .selvedge/project/objective.md if present; this is the single project objective for the workspace, and monorepo work must be treated as scoped workflows under it.',
    `- ${workflow.documents.goal}`,
    `- ${workflow.documents.requirements}`,
    `- ${workflow.documents.taskQueue}`,
    '',
    'Workflow profile gates:',
    ...workflow.profile.planningGates.map((item) => `- Planning: ${item}`),
    ...workflow.profile.developmentGates.map((item) => `- Development: ${item}`),
    ...workflow.profile.qaGates.map((item) => `- QA: ${item}`),
    ...workflow.profile.stopGates.map((item) => `- Stop: ${item}`),
    '',
    'Task WriteSet:',
    ...task.writeSet.map((item) => `- ${item}`),
    '',
    'Task validation:',
    ...task.validation.map((item) => `- ${item}`),
    '',
    'Declared commands:',
    ...commandLines,
    '',
    'Task artifacts to create or update:',
    ...task.artifacts.map((item) => `- ${item}`),
    '',
    'Execution rules:',
    ...heartbeatContextPromptLines(heartbeatContextPath),
    '- The workflow total goal is context only. Do not execute it as one broad long-running objective.',
    '- Execute exactly this task. Do not advance the next Selvedge task.',
    '- Respect the declared WriteSet. If needed work falls outside it, record a blocker instead of writing outside the boundary.',
    '- Re-read authority sources before behavior-changing work.',
    '- Keep development and QA evidence separate.',
    '- Run declared validation when it is executable; if a validation item is descriptive, write concrete evidence for it.',
    '- If the task is blocked, write the blocker and next action into the requested artifact and stop.',
    '- Do not modify sibling read-only sources such as ../kg-cocos-client, ../kg-php, or ../kg unless the task explicitly allows it.',
    '- Do not force push, rebase, reset --hard, or overwrite user changes.',
    '- If implementation changes are completed and validation passes, make one coherent commit and push the current branch when repository policy allows it.',
    '- Leave a concise final response with status, evidence paths, validation, commit/push result, and any remaining blocker.',
    ''
  ].join('\n');
}

function tailText(path: string, maxBytes: number): string {
  if (!existsSync(path)) {
    return '';
  }
  const value = readFileSync(path, 'utf8');
  return value.length > maxBytes ? value.slice(value.length - maxBytes) : value;
}

function readHeartbeatContext(path: string | undefined): SelvedgeHeartbeatDisplayContext | undefined {
  if (!path || !existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SelvedgeHeartbeatDisplayContext;
  } catch {
    return undefined;
  }
}

function readHeartbeatTemplate(path: string | undefined): SelvedgeHeartbeatTemplate | undefined {
  if (!path || !existsSync(path)) {
    return undefined;
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { optionalFields?: readonly SelvedgeHeartbeatOptionalField[] };
    if (!Array.isArray(value.optionalFields)) {
      return undefined;
    }
    return {
      format: 'block',
      optionalFields: value.optionalFields
    };
  } catch {
    return undefined;
  }
}

export function classifyCodexResult(exitCode: number, text: string, configError: boolean, spawnError: boolean): SelvedgeCodexRunResult['classification'] {
  if (configError) {
    return 'config-error';
  }
  if (spawnError) {
    return 'spawn-error';
  }
  if (/unsupported service_tier|invalid service tier|service tier/i.test(text)) {
    return 'config-error';
  }
  if (exitCode === 0) {
    return 'success';
  }
  if (/^\s*(?:error:\s*)?(?:selected model is at capacity|model is at capacity|rate limit(?:ed)?|overloaded|temporarily unavailable|connection (?:was )?reset|ECONNRESET|ETIMEDOUT|network error|socket hang up)\b/mi.test(text)) {
    return 'capacity-interrupted';
  }
  return exitCode === 0 ? 'success' : 'failed';
}

function killCodexProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return;
  }
  child.kill('SIGTERM');
}

export function staleFinalMessageCompleted(lastMessagePath: string, startedAtMs: number, now: number, idleMs: number, graceMs: number): boolean {
  if (idleMs < graceMs || !existsSync(lastMessagePath)) {
    return false;
  }
  try {
    const stats = statSync(lastMessagePath);
    if (stats.size <= 0 || stats.mtimeMs < startedAtMs || now - stats.mtimeMs < FINAL_MESSAGE_STABLE_MS) {
      return false;
    }
    return readFileSync(lastMessagePath, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export async function runCodexWorkflowTask(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  options: SelvedgeCodexRunnerOptions
): Promise<SelvedgeCodexRunResult> {
  const promptPath = localStatePath(cwd, 'goals', workflow.id, 'prompts', `${task.id}.codex-prompt.md`);
  const logPath = localStatePath(cwd, 'logs', `${workflow.id}.${task.id}.codex.log`);
  const lastMessagePath = localStatePath(cwd, 'logs', `${workflow.id}.${task.id}.last-message.md`);
  const statusPath = localStatePath(cwd, 'status', `${workflow.id}.${task.id}.codex-run.json`);
  const prompt = buildCodexTaskPrompt(workflow, task, options.heartbeatContextPath);
  const startedAt = new Date();
  writeText(promptPath, prompt);
  rmSync(lastMessagePath, { force: true });
  writeText(
    logPath,
    [
      'Selvedge Codex runner',
      `Workflow: ${workflow.id}`,
      `Task: ${task.id}`,
      `Started: ${startedAt.toISOString()}`,
      `Executable: ${options.codexExecutable}`,
      `Model: ${options.model}`,
      `ServiceTier: ${options.serviceTier}`,
      `ReasoningEffort: ${options.reasoningEffort}`,
      ''
    ].join('\n')
  );

  let exitCode = 1;
  let signal: NodeJS.Signals | null = null;
  let errorMessage: string | null = null;
  let configError = false;
  let spawnError = false;

  try {
    if (!options.skipConfigGuard && !options.ignoreUserConfig) {
      assertCodexServiceTierConfig();
    }
    const args = buildCodexExecArgs(cwd, lastMessagePath, options);
    appendFileSync(logPath, `Command: ${options.codexExecutable} ${args.join(' ')}\n\n----- codex output begin -----\n`, 'utf8');
      const startedAtMs = Date.now();
      let lastOutputAtMs = startedAtMs;
      const heartbeatMs = options.heartbeatSeconds > 0 ? options.heartbeatSeconds * 1000 : 0;
      const staleFinalMessageGraceMs = options.staleFinalMessageGraceMs ?? DEFAULT_STALE_FINAL_MESSAGE_GRACE_MS;
      const runResult = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null; errorMessage: string | null; spawnError: boolean }>((resolve) => {
      const child = spawn(options.codexExecutable, args, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const finish = (result: { exitCode: number; signal: NodeJS.Signals | null; errorMessage: string | null; spawnError: boolean }) => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        resolve(result);
      };

      const writeChunk = (source: 'stdout' | 'stderr', chunk: Buffer) => {
        lastOutputAtMs = Date.now();
        const text = chunk.toString('utf8');
        appendFileSync(logPath, text, 'utf8');
        if (options.showOutput) {
          if (source === 'stdout') {
            process.stdout.write(text);
          } else {
            process.stderr.write(text);
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => writeChunk('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => writeChunk('stderr', chunk));
      child.on('error', (error) => finish({ exitCode: 1, signal: null, errorMessage: error.message, spawnError: true }));
      child.on('close', (code, closeSignal) =>
        finish({ exitCode: typeof code === 'number' ? code : 1, signal: closeSignal, errorMessage: null, spawnError: false })
      );

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          const now = Date.now();
          const heartbeatContext = readHeartbeatContext(options.heartbeatContextPath) ?? options.heartbeatContext;
          const heartbeatTemplate = readHeartbeatTemplate(options.heartbeatTemplatePath) ?? options.heartbeatTemplate;
          const currentAction = classifyRunnerCurrentAction(task, now - lastOutputAtMs, tailText(logPath, 16_000));
          const payload = buildRunnerHeartbeat(workflow, task, {
            elapsedMs: now - startedAtMs,
            idleMs: now - lastOutputAtMs,
            logPath,
            lastMessagePath,
            currentAction
          }, heartbeatContext);
          const line = buildHeartbeatBlock(payload, heartbeatTemplate);
          appendFileSync(logPath, `${line}\n`, 'utf8');
          console.log(line);
          options.onHeartbeat?.(payload);
          if (staleFinalMessageCompleted(lastMessagePath, startedAtMs, now, now - lastOutputAtMs, staleFinalMessageGraceMs)) {
            appendFileSync(
              logPath,
              `\nSelvedge runner stale-final-message guard: last message is stable after ${formatDuration(now - lastOutputAtMs)} without Codex output; stopping stale Codex process tree and treating the task as completed.\n`,
              'utf8'
            );
            killCodexProcessTree(child);
            finish({ exitCode: 0, signal: null, errorMessage: null, spawnError: false });
          }
        }, heartbeatMs);
      }

      if (options.timeoutMs) {
        timeout = setTimeout(() => {
          child.kill();
          finish({ exitCode: 1, signal: 'SIGTERM', errorMessage: `Codex runner timed out after ${options.timeoutMs}ms.`, spawnError: false });
        }, options.timeoutMs);
      }

      child.stdin?.end(prompt);
    });
    exitCode = runResult.exitCode;
    signal = runResult.signal;
    errorMessage = runResult.errorMessage;
    spawnError = runResult.spawnError;
  } catch (error) {
    configError = true;
    errorMessage = error instanceof Error ? error.message : String(error);
    appendFileSync(logPath, `Codex runner preflight failed: ${errorMessage}\n`, 'utf8');
  }

  appendFileSync(logPath, '\n----- codex output end -----\n', 'utf8');
  if (signal) {
    appendFileSync(logPath, `Signal: ${signal}\n`, 'utf8');
  }
  if (errorMessage) {
    appendFileSync(logPath, `Error: ${errorMessage}\n`, 'utf8');
  }

  const completedAt = new Date();
  const logTail = tailText(logPath, 12_000);
  const classification = classifyCodexResult(exitCode, `${logTail}\n${tailText(lastMessagePath, 12_000)}`, configError, spawnError);
  const status = exitCode === 0 && classification === 'success' ? 'Completed' : 'Failed';
  const runRecord = {
    workflowId: workflow.id,
    taskId: task.id,
    delegatedRunner: task.runner,
    runner: 'codex-cli',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    status,
    classification,
    exitCode,
    signal,
    error: errorMessage,
    prompt: promptPath,
    log: logPath,
    lastMessage: lastMessagePath,
    nextAction:
      status === 'Completed'
        ? 'Continue with the next Selvedge workflow task.'
        : 'Inspect the prompt, log, and last message; classify the blocker before retrying or changing the task boundary.'
  };
  writeJson(statusPath, runRecord);
  if (options.showOutput) {
    console.log(tailText(logPath, 20_000));
  }
  return {
    exitCode: status === 'Completed' ? 0 : exitCode || 1,
    status,
    classification,
    promptPath,
    logPath,
    lastMessagePath,
    statusPath
  };
}

function parseTimeOfDay(value: string): { hours: number; minutes: number } | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return { hours, minutes };
}

export function resolveStopPolicy(cwd: string, stopTime: string): SelvedgeStopPolicy {
  const stopFile = join(cwd, 'STOP_AGENT');
  if (/^(none|off|disable|disabled|never)$/i.test(stopTime.trim())) {
    return { stopFile, stopTime, cutoff: null };
  }
  const entries = stopTime
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  let cutoff: Date | null = null;
  const now = new Date();
  for (const entry of entries) {
    const parsed = parseTimeOfDay(entry);
    if (!parsed) {
      throw new Error(`Invalid --stop-time "${stopTime}". Use HH:mm, comma-separated HH:mm, or none.`);
    }
    const candidate = new Date(now);
    candidate.setHours(parsed.hours, parsed.minutes, 0, 0);
    if (candidate <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
    if (!cutoff || candidate < cutoff) {
      cutoff = candidate;
    }
  }
  return { stopFile, stopTime, cutoff };
}

export function isStopRequested(policy: SelvedgeStopPolicy): { stop: boolean; reason: string } {
  if (existsSync(policy.stopFile)) {
    return { stop: true, reason: 'STOP_AGENT exists.' };
  }
  if (policy.cutoff && new Date() >= policy.cutoff) {
    return { stop: true, reason: `Stop time reached: ${policy.cutoff.toISOString()}.` };
  }
  return { stop: false, reason: 'No stop requested.' };
}

export function clearStopFile(policy: SelvedgeStopPolicy): boolean {
  if (!existsSync(policy.stopFile)) {
    return false;
  }
  rmSync(policy.stopFile, { force: true });
  return true;
}

export function sleepSeconds(seconds: number): void {
  if (seconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}
