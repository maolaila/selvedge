import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { ensureDir, localStatePath, repoPath, writeJson, writeText } from './fs-utils';
import { runSelvedgeAiJson, type SelvedgeAiJsonEvidence } from './ai-assist';
import { getWorkflowProfile, parseWorkflowProfileId } from './profiles';
import { readSelvedgeConfig } from './config';
import {
  clearStopFile,
  buildRunnerHeartbeat,
  isStopRequested,
  resolveCodexRunnerOptions,
  resolveStopPolicy,
  runCodexWorkflowTask,
  sleepSeconds,
  type SelvedgeCodexRunResult
} from './runner';
import { SELVEDGE_CONFIG_SCHEMA, SELVEDGE_GOAL_WORKFLOW_SCHEMA, SELVEDGE_TASK_SCHEMA } from './schemas';
import { SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS } from './types';
import { buildReadOnlyModel } from './gamehub-adapter';
import { createAssignedWorkPlan, createKgSlotsDogfoodPlan } from './planner';
import {
  buildProjectObjectiveDraft,
  projectObjectiveMarkdownPath,
  readProjectObjective,
  saveProjectObjectiveWithReview
} from './project-objective';
import {
  createAutopilotNextWorkflow,
  createGoalWorkflow,
  readGoalWorkflow,
  saveGoalWorkflow,
  selectNextWorkflowTask,
  setWorkflowTaskStatus,
  workflowPath,
  writeBuiltinTaskEvidence,
  writeGoalWorkflow
} from './workflow';
import type {
  AssignedWorkPlanInput,
  CliOptions,
  GameHubReadOnlyModel,
  GoalWorkflowInput,
  SelvedgeArchitectureProposal,
  SelvedgeHeartbeatDisplayContext,
  SelvedgeHeartbeatOptionalField,
  SelvedgeHeartbeatTemplate,
  SelvedgeGoalWorkflow,
  SelvedgeProjectObjective,
  SelvedgeRequirementQuestion,
  SelvedgeRequirementQuestionOption,
  SelvedgePlan,
  SelvedgeTask,
  SelvedgeTaskStatus,
  SelvedgeWorkflowTask
} from './types';

function printIssueSummary(model: GameHubReadOnlyModel): void {
  if (model.issues.length === 0) {
    console.log('No validation issues.');
    return;
  }
  for (const issue of model.issues) {
    console.log(`[${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}

function writeLatestModel(cwd: string, model: GameHubReadOnlyModel): void {
  writeJson(localStatePath(cwd, 'status', 'latest-readonly-model.json'), model);
}

function planTarget(args: readonly string[]): string {
  const targetFlagIndex = args.findIndex((arg) => arg === '--target');
  if (targetFlagIndex >= 0) {
    const value = args[targetFlagIndex + 1];
    if (value && !value.startsWith('--')) {
      return value;
    }
  }
  const positional = args.find((arg) => !arg.startsWith('--') && arg !== 'kg-slots');
  return positional ?? 'kg-slots-next-dogfood-needs-human-target';
}

function optionValue(args: readonly string[], name: string): string | null {
  const index = args.findIndex((arg) => arg === name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

function optionValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) {
        values.push(value);
      }
    }
  }
  return values;
}

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function defaultSelvedgeConfig(cwd: string): string {
  const projectName = slug(basename(cwd)) || 'selvedge-project';
  return [
    'version: 1',
    'project:',
    `  name: ${projectName}`,
    '  currentPhase: product-extraction-ready',
    'product:',
    '  primaryBuilder: codex-cli',
    'compatibility:',
    '  currentAutopilotIsAuthoritative: false',
    'commercializationPlan:',
    '  distribution:',
    '    packageName: "@maolaila/selvedge"',
    'heartbeat:',
    '  format: block',
    '  optionalFields:',
    '    - machine',
    '    - progress',
    '    - role',
    '    - taskTitle',
    ''
  ].join('\n');
}

function createAssignedInput(args: readonly string[]): AssignedWorkPlanInput {
  const goal = optionValue(args, '--goal') ?? 'NeedsDecision: provide --goal <path-or-description>';
  const title = optionValue(args, '--title') ?? `Assigned work for ${goal}`;
  const id = optionValue(args, '--id') ?? `assigned-${slug(title) || 'work'}`;
  return {
    id,
    title,
    goal,
    workstream: optionValue(args, '--workstream') ?? 'assigned-work',
    stage: optionValue(args, '--stage') ?? 'development',
    runner: optionValue(args, '--runner') ?? 'codex-app-agent',
    commands: optionValues(args, '--command'),
    writeSet: optionValues(args, '--write'),
    validation: optionValues(args, '--validation')
  };
}

function createGoalInput(args: readonly string[], mode: 'goal-workflow' | 'autopilot-next'): GoalWorkflowInput {
  const goal =
    optionValue(args, '--goal') ??
    (mode === 'autopilot-next'
      ? 'Derive and execute the current GameHub Autopilot next objective through Selvedge.'
      : 'NeedsDecision: provide --goal <description>');
  const title =
    optionValue(args, '--title') ??
    (mode === 'autopilot-next' ? 'GameHub Autopilot Next Objective' : `Goal workflow for ${goal}`);
  const id = optionValue(args, '--id') ?? (mode === 'autopilot-next' ? 'autopilot-next' : `goal-${slug(title) || 'workflow'}`);
  return {
    id,
    title,
    goal,
    workstream: optionValue(args, '--workstream') ?? (mode === 'autopilot-next' ? 'gamehub-autopilot' : 'assigned-work'),
    source: mode === 'autopilot-next' ? 'selvedge plan autopilot-next' : 'selvedge plan goal',
    mode,
    profile: parseWorkflowProfileId(optionValue(args, '--profile')),
    commands: optionValues(args, '--command'),
    writeSet: optionValues(args, '--write'),
    validation: optionValues(args, '--validation'),
    answers: optionValues(args, '--answer'),
    nonInteractive: args.includes('--non-interactive') || mode === 'autopilot-next'
  };
}

function splitDashboardList(value: string | null): readonly string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueGoalId(cwd: string, preferredId: string): string {
  const base = slug(preferredId) || 'dashboard-goal';
  const baseId = base.startsWith('goal-') || base.startsWith('kg-') || base.startsWith('selvedge-') ? base : `goal-${base}`;
  let id = baseId;
  let suffix = 2;
  while (readGoalWorkflow(cwd, id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function inferDashboardProfile(body: URLSearchParams) {
  const explicitProfile = body.get('profile')?.trim();
  if (explicitProfile) {
    return parseWorkflowProfileId(explicitProfile);
  }
  const text = [
    body.get('goal') ?? '',
    body.get('workstream') ?? '',
    body.get('notes') ?? ''
  ].join('\n');
  const mentionsNewKgShellShape =
    /web[-\s]*entry|web[-\s]*style|webview|fish|poker|card|bingo|table|new\s+shell\s+profile|new\s+game\s+type/i.test(text);
  const mentionsKg = /\bkg\b|kg-micro-shell|KG|新版紫色KG|金冠/i.test(text);
  const mentionsSlots = /\bslots?\b|slots-class|slots\s*类型|slots\s*類型|老虎机|老虎機|slot\s*machine/i.test(text);
  const mentionsMigration = /迁移|遷移|migrat|接入|还原|還原|新类型|新類型|game\s*type/i.test(text);
  if (mentionsKg && mentionsNewKgShellShape) {
    return 'kg-game-migration' as const;
  }
  if (mentionsKg && mentionsSlots) {
    return 'kg-slots-migration' as const;
  }
  if (mentionsKg && mentionsMigration) {
    return 'kg-game-migration' as const;
  }
  return 'universal-autopilot' as const;
}

function createDashboardGoalInput(cwd: string, body: URLSearchParams): GoalWorkflowInput | null {
  const goal = body.get('goal')?.trim();
  if (!goal) {
    return null;
  }
  const profile = inferDashboardProfile(body);
  const title = body.get('title')?.trim() || `Goal workflow for ${goal}`;
  const id = uniqueGoalId(cwd, body.get('goalId')?.trim() || title);
  const workstream =
    body.get('workstream')?.trim() ||
    (profile === 'kg-slots-migration' || profile === 'kg-game-migration' ? 'kg-micro-shell' : 'assigned-work');
  const writeSet = splitDashboardList(body.get('writeSet'));
  const validation = splitDashboardList(body.get('validation'));
  const notes = body.get('notes')?.trim();
  const answers = [`business-outcome=${goal}`];
  if (notes) {
    answers.push(`operator-notes=${notes}`);
  }
  if (profile === 'kg-slots-migration') {
    answers.push('target-game=auto');
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  } else if (profile === 'kg-game-migration') {
    answers.push(`target-game=${goal}`);
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  }
  return {
    id,
    title,
    goal,
    workstream,
    source: 'selvedge dashboard',
    mode: 'goal-workflow',
    profile,
    commands: [],
    writeSet,
    validation,
    answers,
    nonInteractive: false
  };
}

function looksLikeNewProjectRequest(text: string): boolean {
  return /new\s+(project|app|application|repo|repository|product)|from\s+scratch|initialize|initialise|scaffold|bootstrap|create\s+(a\s+)?(project|app|application)|新建|初始化|脚手架|从零|搭建/.test(text);
}

function architectureProposalPrompt(workflow: SelvedgeGoalWorkflow, model: GameHubReadOnlyModel): string {
  return [
    'You are the Selvedge technical architecture advisor for a dashboard-created workflow.',
    '',
    'Use the total goal, existing intake questions, operator answers, and repository context to decide whether this workflow is a new-project initialization or an ordinary bounded task.',
    '',
    'Return only JSON with this exact shape:',
    '{"requiresArchitectureConfirmation":true,"summary":"short","recommendedStack":["..."],"reasons":["..."],"projectStructure":["..."],"initializationPlan":["..."],"risks":["..."],"questions":[{"id":"kebab-id","question":"plain user-facing question","reason":"why this matters","options":[{"id":"kebab-id","label":"short","description":"short","answer":"durable requirement answer"}]}]}',
    '',
    'Rules:',
    '- If the workflow will initialize or scaffold a new project/app/repo/product structure, set requiresArchitectureConfirmation=true and provide a concrete stack and project structure with reasons.',
    '- If the workflow is maintenance, migration, QA, docs, or another task inside an existing project, set requiresArchitectureConfirmation=false and keep architecture lists short.',
    '- Never ask the user to understand internal terms such as WriteSet, runner, or stop policy without explaining the practical choice.',
    '- Add only the most important follow-up questions that a non-technical user should answer before execution.',
    '- Do not create a long all-in-one execution plan. Selvedge executes one bounded subtask at a time.',
    '',
    'Repository adapter model:',
    JSON.stringify({
      cwd: model.cwd,
      projectName: model.config.projectName,
      firstExecutableTask: model.firstExecutableTask,
      selvedgeMainline: model.selvedgeMainline
    }, null, 2),
    '',
    'Workflow draft:',
    JSON.stringify(workflow, null, 2),
    ''
  ].join('\n');
}

function localArchitectureProposal(
  workflow: SelvedgeGoalWorkflow,
  evidence?: SelvedgeAiJsonEvidence
): SelvedgeArchitectureProposal {
  const requiresConfirmation = looksLikeNewProjectRequest([workflow.target, workflow.title, workflow.workstream].join('\n'));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    reviewer: 'local-architecture-gate',
    status: requiresConfirmation ? 'pending-confirmation' : 'not-required',
    confirmationRequired: requiresConfirmation,
    summary: requiresConfirmation
      ? 'This looks like a new-project initialization. AI architecture generation was unavailable, so Selvedge blocks execution until the operator retries AI generation or confirms an explicit architecture plan.'
      : 'No new project initialization was detected; no architecture confirmation gate is required for this workflow.',
    recommendedStack: [],
    reasons: requiresConfirmation
      ? ['New project initialization must not start until a technical stack and structure are confirmed.']
      : ['The workflow appears to operate inside an existing project structure.'],
    projectStructure: [],
    initializationPlan: [],
    risks: requiresConfirmation
      ? ['Starting without a confirmed architecture can create the wrong framework, folder layout, or integration boundary.']
      : [],
    promptPath: evidence?.promptPath,
    logPath: evidence?.logPath,
    lastMessagePath: evidence?.lastMessagePath
  };
}

function aiArchitectureProposalFromJson(
  workflow: SelvedgeGoalWorkflow,
  parsed: Record<string, unknown>,
  evidence: SelvedgeAiJsonEvidence
): SelvedgeArchitectureProposal {
  const requiresConfirmation =
    parsed.requiresArchitectureConfirmation === true ||
    looksLikeNewProjectRequest([workflow.target, workflow.title, workflow.workstream].join('\n'));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    reviewer: 'codex-cli-ai-architect',
    status: requiresConfirmation ? 'pending-confirmation' : 'not-required',
    confirmationRequired: requiresConfirmation,
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : requiresConfirmation
        ? 'AI generated a technical architecture proposal that requires user confirmation before project initialization.'
        : 'AI determined that no new-project architecture confirmation is required.',
    recommendedStack: asStringArray(parsed.recommendedStack),
    reasons: asStringArray(parsed.reasons),
    projectStructure: asStringArray(parsed.projectStructure),
    initializationPlan: asStringArray(parsed.initializationPlan),
    risks: asStringArray(parsed.risks),
    promptPath: evidence.promptPath,
    logPath: evidence.logPath,
    lastMessagePath: evidence.lastMessagePath
  };
}

function optionFromJson(raw: unknown): SelvedgeRequirementQuestionOption | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? slug(value.id) : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
  if (!id || !label || !answer) {
    return null;
  }
  return {
    id,
    label,
    description: description || label,
    answer
  };
}

function aiQuestionFromJson(raw: unknown): SelvedgeRequirementQuestion | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? slug(value.id) : '';
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!id || !question) {
    return null;
  }
  const options = Array.isArray(value.options)
    ? value.options.map(optionFromJson).filter((item): item is SelvedgeRequirementQuestionOption => Boolean(item)).slice(0, 3)
    : [];
  return {
    id: id.startsWith('ai-') ? id : `ai-${id}`,
    question,
    reason: reason || 'AI identified this as useful context before task execution.',
    answer: null,
    status: 'needs-user',
    options
  };
}

function mergeAiQuestions(
  workflow: SelvedgeGoalWorkflow,
  parsed: Record<string, unknown> | null
): readonly SelvedgeRequirementQuestion[] {
  const base = [...workflow.aiIntake.questions];
  if (!parsed || !Array.isArray(parsed.questions)) {
    return base;
  }
  for (const question of parsed.questions.map(aiQuestionFromJson).filter((item): item is SelvedgeRequirementQuestion => Boolean(item))) {
    if (!base.some((item) => item.id === question.id)) {
      base.push(question);
    }
    if (base.length >= 12) {
      break;
    }
  }
  return base;
}

function enhanceDashboardWorkflowWithAi(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  model: GameHubReadOnlyModel,
  runnerArgs: readonly string[]
): SelvedgeGoalWorkflow {
  const ai = runSelvedgeAiJson(
    cwd,
    'workflow-creation-intake-architecture',
    architectureProposalPrompt(workflow, model),
    runnerArgs
  );
  const questions = mergeAiQuestions(workflow, ai.parsed);
  const architecture = ai.parsed
    ? aiArchitectureProposalFromJson(workflow, ai.parsed, ai.evidence)
    : localArchitectureProposal(workflow, ai.evidence);
  return {
    ...workflow,
    architecture,
    aiIntake: {
      ...workflow.aiIntake,
      userDialogueRequired: questions.some((question) => question.status === 'needs-user'),
      questions,
      notes: [
        ...workflow.aiIntake.notes,
        ai.parsed
          ? `AI generated/checked intake and architecture for this dashboard workflow: ${ai.evidence.promptPath}`
          : `AI workflow creation review was unavailable; local safety gates were used: ${ai.evidence.logPath}`
      ]
    }
  };
}

function dashboardWorkflowIds(cwd: string): readonly string[] {
  const goalsRoot = localStatePath(cwd, 'goals');
  if (!existsSync(goalsRoot)) {
    return [];
  }
  return readdirSync(goalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && Boolean(readGoalWorkflow(cwd, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function createDashboardProjectObjectiveDraft(
  cwd: string,
  body: URLSearchParams,
  existing: SelvedgeProjectObjective | null,
  plannedWorkflowId: string | null
): SelvedgeProjectObjective | null {
  const totalGoal = (body.get('totalGoal') ?? body.get('goal') ?? '').trim();
  if (!totalGoal) {
    return null;
  }
  const workstream =
    body.get('workstream')?.trim() ||
    existing?.scopes[0]?.workstream ||
    (['kg-slots-migration', 'kg-game-migration'].includes(inferDashboardProfile(body)) ? 'kg-micro-shell' : 'assigned-work');
  const activeWorkflowIds = dashboardWorkflowIds(cwd);
  return buildProjectObjectiveDraft({
    totalGoal,
    scopes: splitDashboardList(body.get('scopes')),
    authoritySources: splitDashboardList(body.get('authoritySources')),
    writeBoundaries: splitDashboardList(body.get('writeSet')),
    validationExpectations: splitDashboardList(body.get('validation')),
    stopExpectations: splitDashboardList(body.get('stopExpectations')),
    notes: body.get('notes')?.trim() ?? '',
    workstream,
    activeWorkflowIds: activeWorkflowIds.length > 0 ? activeWorkflowIds : plannedWorkflowId ? [plannedWorkflowId] : [],
    existing
  });
}

function createWorkflowInputFromProjectObjective(
  objective: SelvedgeProjectObjective,
  body: URLSearchParams,
  workflowId: string
): GoalWorkflowInput {
  const workstream = body.get('workstream')?.trim() || objective.scopes[0]?.workstream || 'assigned-work';
  const pseudoBody = new URLSearchParams();
  pseudoBody.set('goal', objective.totalGoal);
  pseudoBody.set('workstream', workstream);
  pseudoBody.set('notes', objective.notes);
  const profile = inferDashboardProfile(pseudoBody);
  const answers = [
    `business-outcome=${objective.totalGoal}`,
    `authority-sources=${objective.authoritySources.join('; ') || 'Use the saved Selvedge project objective and workflow-specific source maps.'}`,
    `write-boundary=${objective.writeBoundaries.join('; ') || 'Workflow-specific WriteSet must be declared before edits.'}`,
    `qa-flow=${objective.validationExpectations.join('; ') || 'Use workflow-specific validation and independent QA where user-facing behavior changes.'}`,
    `stop-and-recovery=${objective.stopExpectations.join('; ') || 'Stop on conflict, unsafe scope, failed validation, or human-review gate.'}`,
    `handoff=Dashboard summary, evidence paths, validation result, blockers, and next action.`
  ];
  if (profile === 'kg-slots-migration') {
    answers.push('target-game=auto');
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  } else if (profile === 'kg-game-migration') {
    answers.push(`target-game=${objective.totalGoal}`);
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  }
  return {
    id: workflowId,
    title: `Workflow for ${objective.scopes[0]?.title ?? 'project objective'}`,
    goal: objective.totalGoal,
    workstream,
    source: 'selvedge dashboard',
    mode: 'goal-workflow',
    profile,
    commands: [],
    writeSet: objective.writeBoundaries,
    validation: objective.validationExpectations,
    answers,
    nonInteractive: true
  };
}

function createProjectObjectiveNextTaskInput(
  cwd: string,
  objective: SelvedgeProjectObjective,
  requestedTaskText: string
): GoalWorkflowInput {
  const explicitTask = requestedTaskText.trim();
  const taskGoal = explicitTask || 'Derive and execute the next bounded task from the saved Selvedge project objective.';
  const pseudoBody = new URLSearchParams();
  pseudoBody.set('goal', explicitTask || objective.totalGoal);
  pseudoBody.set('workstream', objective.scopes[0]?.workstream ?? '');
  pseudoBody.set('notes', objective.notes);
  const profile = inferDashboardProfile(pseudoBody);
  const workstream =
    profile === 'kg-slots-migration' || profile === 'kg-game-migration'
      ? 'kg-micro-shell'
      : objective.scopes[0]?.workstream || 'assigned-work';
  const answers = [
    `business-outcome=${oneLineAnswer(taskGoal)}`,
    `project-objective=${oneLineAnswer(objective.totalGoal)}`,
    `operator-next-task=${explicitTask ? oneLineAnswer(explicitTask) : 'AutoSelect: Selvedge master controller must choose the next bounded task from the saved project objective.'}`,
    'objective-conflict-check=Before execution, compare the next task against .selvedge/project/objective.md; stop as NeedsHumanInput if it conflicts with the total goal, scope, authority sources, write boundaries, or stop expectations.',
    `authority-sources=${objective.authoritySources.join('; ') || 'Use the saved Selvedge project objective and workflow-specific source maps.'}`,
    `write-boundary=${objective.writeBoundaries.join('; ') || 'Workflow-specific WriteSet must be declared before edits.'}`,
    `qa-flow=${objective.validationExpectations.join('; ') || 'Use workflow-specific validation and independent QA where user-facing behavior changes.'}`,
    `stop-and-recovery=${objective.stopExpectations.join('; ') || 'Stop on conflict, unsafe scope, failed validation, or human-review gate.'}`,
    'handoff=Dashboard summary, evidence paths, validation result, blockers, and next action.'
  ];
  if (profile === 'kg-slots-migration') {
    answers.push('target-game=auto');
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  } else if (profile === 'kg-game-migration') {
    answers.push(`target-game=${explicitTask ? oneLineAnswer(explicitTask) : 'source-intake-first under the saved project objective'}`);
    answers.push('kg-source-paths=../kg-cocos-client + ../kg-php');
  }
  return {
    id: uniqueGoalId(cwd, explicitTask ? `next-task-${explicitTask}` : 'project-next-task'),
    title: explicitTask ? `Next task: ${explicitTask}` : 'Next task from project objective',
    goal: taskGoal,
    workstream,
    source: 'selvedge dashboard project-objective start',
    mode: 'goal-workflow',
    profile,
    commands: [],
    writeSet: objective.writeBoundaries,
    validation: objective.validationExpectations,
    answers,
    nonInteractive: true
  };
}

export function createProjectObjectiveNextTaskWorkflowForDashboardStart(
  cwd: string,
  objective: SelvedgeProjectObjective,
  requestedTaskText: string,
  model: GameHubReadOnlyModel
): SelvedgeGoalWorkflow {
  const next = createGoalWorkflow(
    createProjectObjectiveNextTaskInput(cwd, objective, requestedTaskText),
    model
  );
  writeGoalWorkflow(cwd, next, model);
  writeHeartbeatContextsAfterDecomposition(cwd, next);
  writeWorkflowRunStatus(cwd, next, 'Created from dashboard start under the saved project objective.');
  return next;
}

export function createNextDashboardWorkflowForProjectObjectiveStart(
  cwd: string,
  objective: SelvedgeProjectObjective,
  requestedTaskText: string,
  model: GameHubReadOnlyModel
): SelvedgeGoalWorkflow {
  const explicitTask = requestedTaskText.trim();
  if (explicitTask) {
    return createProjectObjectiveNextTaskWorkflowForDashboardStart(cwd, objective, explicitTask, model);
  }
  const batchContinuation = createKgNewTypeBatchContinuation(cwd, model);
  if (batchContinuation) {
    return batchContinuation;
  }
  return createProjectObjectiveNextTaskWorkflowForDashboardStart(cwd, objective, '', model);
}

function oneLineAnswer(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function workflowIsFullyCompleted(workflow: SelvedgeGoalWorkflow): boolean {
  return workflow.tasks.length > 0 && workflow.tasks.every((task) => task.status === 'Completed');
}

function continuationTargetAnswer(goal: string, explicitGoalSupplied: boolean): string {
  if (!explicitGoalSupplied) {
    return 'auto';
  }
  const normalized = goal.toLowerCase();
  if (/\b(auto|next|continue|continuation)\b/.test(normalized)) {
    return 'auto';
  }
  return /\b[a-z][a-z0-9_-]{1,40}-\d{2,5}\b/i.test(goal) || /\b(gamecode|route|target)\b/i.test(goal)
    ? oneLineAnswer(goal)
    : 'auto';
}

function createCompletedWorkflowContinuationInput(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  requestedGoalText: string
): GoalWorkflowInput | null {
  if (workflow.profile.id !== 'kg-slots-migration') {
    return null;
  }
  if (!workflowIsFullyCompleted(workflow) || selectNextWorkflowTask(workflow)) {
    return null;
  }
  const explicitGoal = requestedGoalText.trim();
  const goal = explicitGoal || workflow.target || workflow.title;
  const id = uniqueGoalId(cwd, workflow.id);
  return {
    id,
    title: `Goal workflow for ${goal}`,
    goal,
    workstream: workflow.workstream || 'kg-micro-shell',
    source: `selvedge dashboard continuation from ${workflow.id}`,
    mode: 'goal-workflow',
    profile: 'kg-slots-migration',
    commands: [],
    writeSet: [
      'apps/kg-micro-shell/**',
      'docs/kg-micro-shell-agent-reference/**',
      '.selvedge/goals/**'
    ],
    validation: [
      'git diff --check',
      'pnpm --filter @gamehub/kg-micro-shell run typecheck',
      'browser smoke for the migrated KG route before handoff',
      'independent source-vs-implementation audit before ReadyForHumanReview'
    ],
    answers: [
      `business-outcome=${oneLineAnswer(goal)}`,
      `target-game=${continuationTargetAnswer(goal, Boolean(explicitGoal))}`,
      'kg-source-paths=../kg-cocos-client + ../kg-php',
      `authority-sources=Use AGENTS.md, .selvedge/project/objective.md, apps/kg-micro-shell docs, KG Cocos/PHP read-only sources, and completed workflow ${workflow.id} only as prior-target exclusion evidence.`,
      'write-boundary=Stay inside the KG slots migration profile. Runtime tasks must declare source-specific WriteSet before edits and must not modify ../kg-cocos-client, ../kg-php, or ../kg.',
      'development-flow=AI intake / docs-only source feature inventory / functional-detail parity ledger / bounded migration slices / self-test / independent audit / handoff.',
      'qa-flow=Source existence check, pure source-logic/data-flow regression, focused tests, browser smoke, and independent source-vs-implementation audit.',
      'stop-and-recovery=Stop on missing authority, no eligible slots candidate, unsafe WriteSet, failed validation, audit MismatchBlocker, unsupported runner, STOP policy conflict, or unclear user decision.',
      'handoff=Record selected target, evidence paths, validation result, blockers, human-review instructions, rollback guidance, and next action.'
    ],
    nonInteractive: true
  };
}

export function createCompletedWorkflowContinuationForDashboardStart(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  model: GameHubReadOnlyModel,
  requestedGoalText: string
): SelvedgeGoalWorkflow | null {
  const input = createCompletedWorkflowContinuationInput(cwd, workflow, requestedGoalText);
  if (!input) {
    return null;
  }
  const next = createGoalWorkflow(input, model);
  writeGoalWorkflow(cwd, next, model);
  writeHeartbeatContextsAfterDecomposition(cwd, next);
  writeWorkflowRunStatus(cwd, next, `Created from completed dashboard workflow ${workflow.id}.`);
  writeLoopStatus(cwd, workflow.id, 'Completed', `Dashboard created continuation workflow ${next.id} from completed workflow ${workflow.id}.`);
  writeWorkflowRunStatus(cwd, workflow, `Dashboard created continuation workflow ${next.id}; this workflow remains completed.`);
  return next;
}

interface RealMerchantStageDefinition {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly workstream: string;
  readonly goal: string;
  readonly writeSet: readonly string[];
  readonly validation: readonly string[];
  readonly stop: string;
}

const REAL_MERCHANT_CHAIN_SOURCE_WORKFLOW_ID = 'real-merchant-e2e-gap-map';

const REAL_MERCHANT_STAGE_DEFINITIONS: readonly RealMerchantStageDefinition[] = [
  {
    id: 'real-merchant-provider-api-contract-map',
    title: 'Real Merchant Provider API Contract Map',
    phase: 'planning',
    workstream: 'platform-backend-core',
    goal:
      'Turn the current GameHub OpenAPI surface into a provider contract map with exact request/response fields, error codes, examples, wallet modes, launch modes, order/reporting APIs, callback APIs, and target-set applicability for accepted KG slots and completed Play Kit quick-games only.',
    writeSet: ['.selvedge/goals/real-merchant-provider-api-contract-map/**', 'docs/**'],
    validation: [
      'Confirm target set is limited to accepted KG slots and completed Play Kit quick-games.',
      'Confirm provider contract matrix classifies each capability as Existing, PartiallyExisting, Missing, NeedsContractDecision, or NotApplicableWithEvidence.',
      'Confirm no production backend route, SDK, DB migration/schema, admin-console, game-template, KG runtime, or sibling KG source file is modified.',
      'pnpm selvedge validate',
      'git diff --check -- docs .selvedge/goals/real-merchant-provider-api-contract-map'
    ],
    stop: 'Stop on any attempt to add backend routes before provider contract map signoff.'
  },
  {
    id: 'openapi-security-hardening-foundation',
    title: 'OpenAPI Security Hardening Foundation',
    phase: 'development',
    workstream: 'platform-backend-core',
    goal:
      'Add provider-grade body limits, Redis-backed global/merchant/route rate limits, nonce observability, timestamp/skew tests, secret rotation contract, and negative API tests.',
    writeSet: [
      'apps/backend/src/middleware/**',
      'apps/backend/src/modules/auth/**',
      'apps/backend/src/bootstrap/env.ts',
      'packages/shared-utils/**',
      'packages/shared-types/**',
      'apps/backend/src/**/*.test.ts',
      'docs/**',
      '.selvedge/goals/openapi-security-hardening-foundation/**'
    ],
    validation: [
      'Cover invalid signature, stale timestamp, duplicate nonce, wrong app, body over limit, malformed JSON, unsupported content type, IP allowlist, cross-merchant route access, and rate-limit counter tests.',
      'Confirm no browser-visible app secret, raw signing material, or unbounded raw body buffering remains.',
      'pnpm --filter @gamehub/backend test',
      'pnpm --filter @gamehub/backend typecheck',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop on browser-visible app secret, raw signing material, unresolved replay path, or unbounded raw body buffering.'
  },
  {
    id: 'launch-code-session-exchange-hardening',
    title: 'Launch Code Session Exchange Hardening',
    phase: 'development',
    workstream: 'platform-backend-core',
    goal:
      'Replace browser-visible long-lived launch-token URLs with a one-time launchCode exchange path while preserving GameAPI internal session authority.',
    writeSet: [
      'apps/backend/src/modules/launch/**',
      'apps/backend/src/routes/openapi/launch.ts',
      'apps/backend/src/routes/launch.ts',
      'apps/backend/src/routes/gameapi/context.ts',
      'apps/backend/src/middleware/gameapi-auth.ts',
      'packages/shared-types/**',
      'packages/shared-utils/**',
      'apps/backend/src/**/*.test.ts',
      'docs/**',
      '.selvedge/goals/launch-code-session-exchange-hardening/**'
    ],
    validation: [
      'Cover one-time use, TTL expiry, replay rejection, merchant/game/session binding, origin/device binding, duplicate-session policy, no raw claims in URL after exchange, and old launch-token compatibility decision.',
      'Confirm launch URL cannot still be reused as a long-lived bearer without an accepted compatibility reason.',
      'pnpm --filter @gamehub/backend test',
      'pnpm --filter @gamehub/backend typecheck',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if the launch URL remains reusable as a long-lived bearer without an accepted compatibility reason.'
  },
  {
    id: 'merchant-sdk-real-host-fixture',
    title: 'Merchant SDK Real Host Fixture',
    phase: 'development',
    workstream: 'packages-game-sdk',
    goal:
      'Provide a real-merchant-style fixture path where merchant browser calls merchant backend enter, merchant backend calls GameHub OpenAPI, and browser uses GameHub SDK/script with safe launch facts only.',
    writeSet: [
      'packages/game-sdk/**',
      'apps/admin-console/**',
      'docs/**',
      '.selvedge/goals/merchant-sdk-real-host-fixture/**'
    ],
    validation: [
      'Confirm browser never signs OpenAPI and never receives appSecret.',
      'Confirm SDK opens Play Kit through POPUP_SCRIPT and KG slots through the accepted merchant route.',
      'Include SDK unit tests and browser smoke evidence.',
      'pnpm --filter @gamehub/game-sdk test',
      'pnpm --filter @gamehub/game-sdk typecheck',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if the fixture requires merchant browser to embed internal GameHub URL or raw Play Kit props as the integration contract.'
  },
  {
    id: 'kg-slots-real-merchant-e2e-matrix',
    title: 'KG Slots Real Merchant E2E Matrix',
    phase: 'development / QA',
    workstream: 'kg-micro-shell',
    goal: 'Run real merchant launch/init/play/history/detail smoke for all 12 accepted KG slots in scope.',
    writeSet: [
      'scripts/**',
      '.codex-run-logs/**',
      '.selvedge/goals/kg-slots-real-merchant-e2e-matrix/**',
      'docs/**'
    ],
    validation: [
      'Cover merchant backend launch, safe launch facts, GameAPI context/init, first paid rounds/play, history/detail, wallet/order/ledger DB reconciliation, no secret/policy leak, and Demo Center parity note.',
      'Product code changes require separate focused repair tasks.',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if any target fails first playable action or exposes debug/internal data.'
  },
  {
    id: 'play-kit-real-merchant-e2e-matrix',
    title: 'Play Kit Real Merchant E2E Matrix',
    phase: 'development / QA',
    workstream: 'quick-games',
    goal: 'Run real merchant SDK popup/init/play/animation/close smoke for all 17 completed Play Kit quick-games.',
    writeSet: [
      'apps/game-template/**',
      'packages/game-sdk/**',
      'scripts/**',
      '.codex-run-logs/**',
      '.selvedge/goals/play-kit-real-merchant-e2e-matrix/**',
      'docs/**'
    ],
    validation: [
      'Cover SDK popup launch, no visible scroll regression, context/init, component-owned action triggers rounds/play, backend-authoritative animation target, balance update, close/reopen behavior, and no raw props/secrets.',
      'Product code changes require separate focused repair tasks.',
      'pnpm --filter @gamehub/game-template typecheck',
      'pnpm --filter @gamehub/game-sdk typecheck',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if renderer falls back to an outer generic Play button or browser-controlled prize/forced props.'
  },
  {
    id: 'provider-order-callback-reporting-productization',
    title: 'Provider Order Callback Reporting Productization',
    phase: 'development',
    workstream: 'platform-backend-core',
    goal: 'Implement provider order pull, callback integration, callback status/replay, and merchant-facing net win/loss reporting.',
    writeSet: [
      'apps/backend/src/routes/openapi/**',
      'apps/backend/src/modules/order/**',
      'apps/backend/src/modules/callback/**',
      'apps/backend/src/modules/round/**',
      'packages/shared-types/**',
      'apps/backend/src/db/**',
      'docs/**',
      '.selvedge/goals/provider-order-callback-reporting-productization/**'
    ],
    validation: [
      'Cover latest cursor pull, time-range pull, single-order query, callback enqueue on settlement/balance/session events, retry/status/replay, SSRF guard, callback signature, and netWinLoss = totalBet - totalPayout.',
      'Confirm sign mismatch between round_records.netAmount and merchant-facing netWinLoss is resolved by contract or projection.',
      'pnpm --filter @gamehub/backend test',
      'pnpm --filter @gamehub/backend typecheck',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if the netWinLoss sign contract remains unresolved.'
  },
  {
    id: 'api-only-db-reconciliation-suite',
    title: 'API Only DB Reconciliation Suite',
    phase: 'QA',
    workstream: 'platform-backend-core',
    goal: 'Create repeatable API-only and DB reconciliation checks for every completed game target where the path applies.',
    writeSet: [
      'scripts/**',
      'apps/backend/src/**/*.test.ts',
      '.codex-run-logs/**',
      'docs/**',
      '.selvedge/goals/api-only-db-reconciliation-suite/**'
    ],
    validation: [
      'Cover launch, init, play, history/detail, orders, callbacks, transfer wallet APIs, single wallet paths, idempotency, nonce/signature failures, invalid game/bet/session, duplicate request, insufficient balance, and cross-merchant isolation.',
      'DB rows must reconcile sessions, rounds, orders, ledger, wallets, callbacks, and report views.',
      'pnpm --filter @gamehub/backend test',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if any money-changing API lacks DB evidence.'
  },
  {
    id: 'real-merchant-load-security-pre-aiqa-gate',
    title: 'Real Merchant Load Security Pre AIQA Gate',
    phase: 'pre-AI-QA',
    workstream: 'platform-backend-core',
    goal: 'Execute the mandatory load/security/concurrency readiness gate before any real-merchant AI-QA campaign.',
    writeSet: [
      'scripts/**',
      '.codex-run-logs/**',
      'docs/**',
      '.selvedge/goals/real-merchant-load-security-pre-aiqa-gate/**'
    ],
    validation: [
      'Run sandbox-only load profile for OpenAPI launch, GameAPI init/play, Play Kit SDK popup smoke-level load, order pull, callback enqueue/drain, wallet APIs, Redis nonce/rate-limit behavior, duplicate settlement, callback queue drain, DB/Redis metrics, p50/p95/p99, and error budget.',
      'Stop on unresolved P0/P1 risk for money consistency, replay, launch leakage, cross-merchant isolation, callback backlog, or DB/Redis saturation.',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop on unresolved P0/P1 money, replay, launch leakage, cross-merchant, callback backlog, DB, or Redis risk.'
  },
  {
    id: 'real-merchant-independent-review-and-handoff',
    title: 'Real Merchant Independent Review And Handoff',
    phase: 'independent review / handoff',
    workstream: 'docs-governance',
    goal: 'Independently verify the real merchant implementation against the authority sources and decide whether it reaches ReadyForHumanReview.',
    writeSet: ['docs/**', '.selvedge/goals/real-merchant-independent-review-and-handoff/**', '.codex-run-logs/**'],
    validation: [
      'Classify every target and provider capability as Match, MismatchBlocker, IntentionalDifferenceWithAuthorityReason, or NotApplicableWithEvidence.',
      'Any MismatchBlocker creates a focused repair task before handoff.',
      'Confirm API-only, DB reconciliation, security, load, and browser E2E evidence exists for critical paths.',
      'pnpm selvedge validate',
      'git diff --check'
    ],
    stop: 'Stop if any critical path lacks API-only, DB reconciliation, security, load, or browser E2E evidence.'
  }
];

function realMerchantStageIndex(workflowId: string): number {
  return REAL_MERCHANT_STAGE_DEFINITIONS.findIndex((stage) => stage.id === workflowId);
}

function realMerchantAuthoritySources(previousWorkflowId: string): string {
  return [
    'AGENTS.md',
    '.selvedge/project/objective.md',
    'docs/real-merchant-websocket-hardening-requirements.md',
    'docs/post-kg-aiqa-productization-roadmap.md',
    '.selvedge/goals/real-merchant-e2e-gap-map/current-implementation-gap-map.md',
    '.selvedge/goals/real-merchant-e2e-gap-map/downstream-task-decomposition.md',
    `.selvedge/goals/${previousWorkflowId}/handoff.md`,
    'packages/shared-types/src/openapi.ts',
    'apps/backend/src/routes/openapi/**',
    'docs/merchant-browser-sdk.md',
    'docs/game-round-flow.md'
  ].join('; ');
}

function createRealMerchantStageInput(stage: RealMerchantStageDefinition, previousWorkflowId: string): GoalWorkflowInput {
  return {
    id: stage.id,
    title: stage.title,
    goal: `${stage.goal} This is one stage in the approved real merchant execution chain; continue automatically to the next declared stage after handoff until the final independent review and handoff completes.`,
    workstream: stage.workstream,
    source: `selvedge real merchant chain continuation from ${previousWorkflowId}`,
    mode: 'goal-workflow',
    profile: 'universal-autopilot',
    commands: [],
    writeSet: stage.writeSet,
    validation: stage.validation,
    answers: [
      `business-outcome=${stage.goal}`,
      'users-and-entry=GameHub operators start the real merchant chain from the Selvedge dashboard. Selvedge runs one bounded workflow at a time and automatically continues to the next declared real merchant stage after handoff.',
      `authority-sources=${realMerchantAuthoritySources(previousWorkflowId)}`,
      `write-boundary=Use only this stage WriteSet: ${stage.writeSet.join('; ')}. Do not add KG non-slots, BYDH/LKPY fishing, poker/card/table/bingo, Web Entry, or crawled games to this first real merchant loop.`,
      `development-flow=Run this stage as a bounded Selvedge workflow in the approved chain. Current stage phase: ${stage.phase}. After handoff, continuous mode must create or select the next real merchant stage, not a generic project-objective workflow.`,
      `qa-flow=${stage.validation.join('; ')}`,
      `stop-and-recovery=${stage.stop} Also stop on missing authority source, unsafe WriteSet, failed validation, audit MismatchBlocker, unsupported runner, STOP policy conflict, unclear user decision, or any attempt to widen target scope beyond accepted KG slots and completed Play Kit quick-games.`,
      'handoff=Record final status, evidence paths, validation result, blockers, rollback notes, downstream stage readiness, and whether the next real merchant stage may start automatically.'
    ],
    nonInteractive: true
  };
}

interface RealMerchantContinuationResult {
  readonly handled: boolean;
  readonly workflow: SelvedgeGoalWorkflow | null;
}

function realMerchantTerminalComplete(cwd: string, workflow: SelvedgeGoalWorkflow): boolean {
  const finalStage = REAL_MERCHANT_STAGE_DEFINITIONS[REAL_MERCHANT_STAGE_DEFINITIONS.length - 1];
  if (workflow.id !== finalStage.id || !workflowIsFullyCompleted(workflow) || selectNextWorkflowTask(workflow)) {
    return false;
  }
  const workflows = readAllGoalWorkflows(cwd);
  return REAL_MERCHANT_STAGE_DEFINITIONS.every((stage) => {
    const stageWorkflow = workflows.find((item) => item.id === stage.id);
    return Boolean(stageWorkflow && workflowIsFullyCompleted(stageWorkflow) && !workflowBlockingReason(stageWorkflow));
  });
}

function createRealMerchantContinuation(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  model: GameHubReadOnlyModel
): RealMerchantContinuationResult {
  const isSourceWorkflow = workflow.id === REAL_MERCHANT_CHAIN_SOURCE_WORKFLOW_ID;
  const currentIndex = isSourceWorkflow ? -1 : realMerchantStageIndex(workflow.id);
  if (!isSourceWorkflow && currentIndex < 0) {
    return { handled: false, workflow: null };
  }
  if (!workflowIsFullyCompleted(workflow) || selectNextWorkflowTask(workflow)) {
    return { handled: true, workflow: null };
  }
  const workflows = readAllGoalWorkflows(cwd);
  for (let index = currentIndex + 1; index < REAL_MERCHANT_STAGE_DEFINITIONS.length; index += 1) {
    const stage = REAL_MERCHANT_STAGE_DEFINITIONS[index];
    const existing = workflows.find((item) => item.id === stage.id);
    if (existing) {
      if (!workflowIsFullyCompleted(existing) || workflowBlockingReason(existing) || selectNextWorkflowTask(existing)) {
        writeLoopStatus(
          cwd,
          workflow.id,
          'Completed',
          `Real merchant chain selected existing next workflow ${existing.id} from completed workflow ${workflow.id}.`
        );
        writeWorkflowRunStatus(
          cwd,
          workflow,
          `Real merchant chain selected existing next workflow ${existing.id}; this workflow remains completed.`
        );
        return { handled: true, workflow: existing };
      }
      continue;
    }
    const next = createGoalWorkflow(createRealMerchantStageInput(stage, workflow.id), model);
    writeGoalWorkflow(cwd, next, model);
    writeHeartbeatContextsAfterDecomposition(cwd, next);
    writeWorkflowRunStatus(cwd, next, `Created by real merchant continuous chain after ${workflow.id}.`);
    writeLoopStatus(
      cwd,
      workflow.id,
      'Completed',
      `Real merchant chain created next workflow ${next.id} from completed workflow ${workflow.id}.`
    );
    writeWorkflowRunStatus(
      cwd,
      workflow,
      `Real merchant chain created next workflow ${next.id}; this workflow remains completed.`
    );
    return { handled: true, workflow: next };
  }
  writeLoopStatus(cwd, workflow.id, 'Completed', 'Real merchant chain complete. No downstream workflow remains.');
  writeWorkflowRunStatus(cwd, workflow, 'Real merchant chain complete. No downstream workflow remains.');
  return { handled: true, workflow: null };
}

interface KgNewTypeMigrationBatchItem {
  readonly batch: string;
  readonly catalogClass: string;
  readonly approvedCount: number;
  readonly requiredTargetConstraint: string;
  readonly status: string;
}

function kgMigrationListPath(cwd: string): string {
  return repoPath(cwd, join('apps', 'kg-micro-shell', 'docs', 'game-migration-list.md'));
}

export function readKgNewTypeMigrationBatch(cwd: string): readonly KgNewTypeMigrationBatchItem[] {
  const path = kgMigrationListPath(cwd);
  if (!existsSync(path)) {
    return [];
  }
  const rows: KgNewTypeMigrationBatchItem[] = [];
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*(NT-\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*`?([^`|]+?)`?\s*\|$/.exec(line);
    if (!match) continue;
    rows.push({
      batch: match[1].trim(),
      catalogClass: match[2].trim(),
      approvedCount: Number(match[3]),
      requiredTargetConstraint: match[4].trim(),
      status: match[5].trim()
    });
  }
  return rows.filter((row) => row.status === 'Planned' && row.approvedCount > 0);
}

function readAllGoalWorkflows(cwd: string): readonly SelvedgeGoalWorkflow[] {
  const root = localStatePath(cwd, 'goals');
  if (!existsSync(root)) {
    return [];
  }
  const workflows: SelvedgeGoalWorkflow[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workflow = readGoalWorkflow(cwd, entry.name);
    if (workflow) {
      workflows.push(workflow);
    }
  }
  return workflows;
}

function workflowSearchText(workflow: SelvedgeGoalWorkflow): string {
  return [
    workflow.id,
    workflow.title,
    workflow.target,
    workflow.source,
    ...workflow.aiIntake.questions.map((item) => item.answer ?? '')
  ].join('\n');
}

function workflowReferencesBatch(workflow: SelvedgeGoalWorkflow, batch: string): boolean {
  return new RegExp(`\\b${batch}\\b`, 'i').test(workflowSearchText(workflow));
}

function targetAnswerForKgNewTypeBatch(item: KgNewTypeMigrationBatchItem, ordinal: number): string {
  const forestConstraint =
    item.catalogClass === 'Bingo / Table' &&
    /森林舞会/.test(item.requiredTargetConstraint) &&
    ordinal === 1
      ? 'This target must be 森林舞会.'
      : item.requiredTargetConstraint;
  return [
    `Batch ${item.batch}: ${item.catalogClass} target ${ordinal} of ${item.approvedCount}.`,
    forestConstraint,
    'Use source-intake-first: select the exact route/gameCode only from KG catalog/source evidence before runtime work.'
  ].join(' ');
}

function createKgNewTypeBatchContinuationInput(
  cwd: string,
  item: KgNewTypeMigrationBatchItem,
  ordinal: number,
  objective: SelvedgeProjectObjective | null
): GoalWorkflowInput {
  const goal = `KG new-type batch ${item.batch}: migrate ${item.catalogClass} target ${ordinal} of ${item.approvedCount}`;
  return {
    id: uniqueGoalId(cwd, `kg-new-type-${item.batch.toLowerCase()}-${ordinal}`),
    title: goal,
    goal: `${goal}. ${item.requiredTargetConstraint}`,
    workstream: 'kg-micro-shell',
    source: `selvedge continuous planner from ${item.batch}`,
    mode: 'goal-workflow',
    profile: 'kg-game-migration',
    commands: [],
    writeSet: objective?.writeBoundaries.length
      ? objective.writeBoundaries
      : [
          'apps/kg-micro-shell/**',
          'apps/backend/src/modules/games/**',
          'apps/backend/src/routes/gameapi/**',
          'apps/game-template/src/app/kg/micro-shell/**',
          'packages/shared-types/**',
          'docs/kg-micro-shell-agent-reference/**',
          'apps/kg-micro-shell/docs/**',
          '.selvedge/goals/**'
        ],
    validation: objective?.validationExpectations.length
      ? objective.validationExpectations
      : [
          'git diff --check',
          'focused backend and KG micro-shell tests for the selected target',
          'browser smoke for the migrated KG route before handoff',
          'independent source-vs-implementation audit before ReadyForHumanReview'
        ],
    answers: [
      `business-outcome=${oneLineAnswer(goal)}`,
      `target-game=${targetAnswerForKgNewTypeBatch(item, ordinal)}`,
      'kg-source-paths=../kg-cocos-client + ../kg-php',
      `authority-sources=${objective?.authoritySources.join('; ') || 'Use AGENTS.md, .selvedge/project/objective.md, apps/kg-micro-shell docs, KG Cocos/PHP read-only sources, and the new-type migration batch table.'}`,
      'write-boundary=Stay inside the KG game migration profile. Runtime tasks must declare source-specific WriteSet before edits and must not modify ../kg-cocos-client, ../kg-php, or ../kg.',
      'development-flow=AI intake / micro-shell profile fit / docs-only source feature inventory / functional-detail parity ledger / bounded migration slices / self-test / independent audit / handoff.',
      'qa-flow=Source existence check, pure source-logic/data-flow regression, focused tests, browser smoke, and independent source-vs-implementation audit.',
      'stop-and-recovery=In continuous mode, create the next approved KG new-type batch workflow after handoff. After the approved batch is complete, continue from the saved project objective. Stop only on explicit stop condition, missing authority, unsafe WriteSet, failed validation, audit MismatchBlocker, STOP policy conflict, unsupported runner, unclear user decision, or a proven total-goal completion state.',
      'handoff=Record selected target, batch id, evidence paths, validation result, blockers, human-review instructions, rollback guidance, and next action.'
    ],
    nonInteractive: true
  };
}

function createKgNewTypeBatchContinuation(
  cwd: string,
  model: GameHubReadOnlyModel
): SelvedgeGoalWorkflow | null {
  const batch = readKgNewTypeMigrationBatch(cwd);
  if (batch.length === 0) {
    return null;
  }
  const workflows = readAllGoalWorkflows(cwd);
  const objective = readProjectObjective(cwd);
  for (const item of batch) {
    const allocated = workflows.filter((workflow) =>
      workflow.profile.id === 'kg-game-migration' && workflowReferencesBatch(workflow, item.batch)
    );
    const blocked = allocated.find((workflow) => workflowBlockingReason(workflow));
    if (blocked) {
      return blocked;
    }
    const active = allocated.find((workflow) => !workflowIsFullyCompleted(workflow));
    if (active) {
      return active;
    }
    const completedCount = allocated.filter((workflow) => workflowIsFullyCompleted(workflow)).length;
    if (completedCount >= item.approvedCount) {
      continue;
    }
    const next = createGoalWorkflow(
      createKgNewTypeBatchContinuationInput(cwd, item, completedCount + 1, objective),
      model
    );
    writeGoalWorkflow(cwd, next, model);
    writeHeartbeatContextsAfterDecomposition(cwd, next);
    writeWorkflowRunStatus(
      cwd,
      next,
      `Created by continuous planner for KG new-type batch ${item.batch}.`
    );
    return next;
  }
  return null;
}

export function createContinuousWorkflowContinuationForDashboardStart(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  model: GameHubReadOnlyModel,
  requestedGoalText = ''
): SelvedgeGoalWorkflow | null {
  if (!workflowIsFullyCompleted(workflow) || selectNextWorkflowTask(workflow)) {
    return null;
  }
  const explicitGoal = requestedGoalText.trim();
  if (explicitGoal) {
    const objective = readProjectObjective(cwd);
    if (objective) {
      return createProjectObjectiveNextTaskWorkflowForDashboardStart(
        cwd,
        objective,
        explicitGoal,
        model
      );
    }
  }
  const realMerchantContinuation = createRealMerchantContinuation(cwd, workflow, model);
  if (realMerchantContinuation.handled) {
    return realMerchantContinuation.workflow;
  }
  const batchContinuation = createKgNewTypeBatchContinuation(cwd, model);
  if (batchContinuation) {
    writeLoopStatus(
      cwd,
      workflow.id,
      'Completed',
      `Continuous planner created next workflow ${batchContinuation.id} from completed workflow ${workflow.id}.`
    );
    writeWorkflowRunStatus(
      cwd,
      workflow,
      `Continuous planner created next workflow ${batchContinuation.id}; this workflow remains completed.`
    );
    return batchContinuation;
  }
  const objective = readProjectObjective(cwd);
  if (objective) {
    const next = createProjectObjectiveNextTaskWorkflowForDashboardStart(
      cwd,
      objective,
      '',
      model
    );
    writeLoopStatus(
      cwd,
      workflow.id,
      'Completed',
      `Continuous planner created project-objective workflow ${next.id} from completed workflow ${workflow.id}.`
    );
    writeWorkflowRunStatus(
      cwd,
      workflow,
      `Continuous planner created project-objective workflow ${next.id}; this workflow remains completed.`
    );
    return next;
  }
  return createCompletedWorkflowContinuationForDashboardStart(cwd, workflow, model, requestedGoalText);
}

function writePlan(cwd: string, plan: SelvedgePlan): void {
  writeJson(localStatePath(cwd, 'tasks', `${plan.id}.json`), plan);
  const lines = [
    `# ${plan.title}`,
    '',
    `Created: ${plan.createdAt}`,
    `Target: ${plan.target}`,
    `Mode: ${plan.mode}`,
    '',
    '## Tasks',
    ''
  ];
  for (const task of plan.tasks) {
    lines.push(`### ${task.id}`);
    lines.push('');
    lines.push(`- Title: ${task.title}`);
    lines.push(`- Stage: ${task.stage}`);
    lines.push(`- Role: ${task.role}`);
    lines.push(`- Workstream: ${task.workstream}`);
    lines.push(`- Runner: ${task.runner}`);
    lines.push(`- StopPolicy: ${task.stopPolicy}`);
    if (task.commands?.length) {
      lines.push(`- Commands: ${task.commands.length}`);
    }
    lines.push('');
  }
  writeText(localStatePath(cwd, 'evidence', `${plan.id}.md`), `${lines.join('\n')}\n`);
}

function writeWorkflowResult(cwd: string, workflow: SelvedgeGoalWorkflow, model: GameHubReadOnlyModel): void {
  writeGoalWorkflow(cwd, workflow, model);
  writeHeartbeatContextsAfterDecomposition(cwd, workflow);
  console.log(`Created Selvedge goal workflow: ${workflow.id}`);
  console.log(`Goal: ${workflow.documents.goal}`);
  console.log(`Requirements: ${workflow.documents.requirements}`);
  console.log(`Queue: ${workflow.documents.taskQueue}`);
  console.log(`Workflow model: ${join('.selvedge', 'goals', workflow.id, 'goal.workflow.json')}`);
}

function answerWorkflowIntakeQuestion(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  questionId: string,
  answer: string,
  model: GameHubReadOnlyModel,
  followUpQuestion: SelvedgeRequirementQuestion | null = null
): SelvedgeGoalWorkflow {
  const trimmed = answer.trim();
  let questions = workflow.aiIntake.questions.map((question) =>
    question.id === questionId
      ? {
          ...question,
          answer: trimmed,
          status: 'answered' as const
        }
      : question
  );
  if (followUpQuestion && !questions.some((question) => question.id === followUpQuestion.id)) {
    questions = [...questions, followUpQuestion];
  }
  const userDialogueRequired = questions.some((question) => question.status === 'needs-user');
  const next: SelvedgeGoalWorkflow = {
    ...workflow,
    aiIntake: {
      ...workflow.aiIntake,
      userDialogueRequired,
      questions
    },
    tasks: workflow.tasks.map((task) =>
      task.runner === 'builtin:intake-doc' && task.status === 'NeedsHumanInput'
        ? {
            ...task,
            status: 'Pending',
            statusUpdatedAt: new Date().toISOString(),
            statusReason: 'Dashboard intake answer supplied; intake can be rechecked.'
          }
        : task
    )
  };
  writeGoalWorkflow(cwd, next, model);
  writeHeartbeatContextsAfterDecomposition(cwd, next);
  writeWorkflowRunStatus(cwd, next, userDialogueRequired ? 'Dashboard intake answer saved.' : 'Dashboard intake completed.');
  return next;
}

function formatIntakeAnswer(
  selectedOption: SelvedgeRequirementQuestionOption | null,
  answerText: string
): string | null {
  const detail = answerText.trim();
  if (!selectedOption) {
    return detail.length > 0 ? detail : null;
  }
  const lines = [
    `Selected option: ${selectedOption.label}`,
    selectedOption.answer
  ];
  if (detail.length > 0) {
    lines.push(`Operator detail: ${detail}`);
  }
  return lines.join('\n');
}

function resolveDashboardIntakeAnswer(
  workflow: SelvedgeGoalWorkflow,
  questionId: string,
  selectedOptionId: string | undefined,
  answerText: string
): string | null {
  const question = workflow.aiIntake.questions.find((item) => item.id === questionId);
  if (!question) {
    return null;
  }
  const selectedOption =
    selectedOptionId && selectedOptionId.length > 0
      ? question.options?.find((item) => item.id === selectedOptionId)
      : null;
  if (selectedOptionId && selectedOptionId.length > 0 && !selectedOption) {
    return null;
  }
  return formatIntakeAnswer(selectedOption ?? null, answerText);
}

function intakeAnswerPrompt(
  workflow: SelvedgeGoalWorkflow,
  questionId: string,
  answer: string
): string {
  const question = workflow.aiIntake.questions.find((item) => item.id === questionId);
  return [
    'You are the Selvedge intake answer normalizer.',
    '',
    'The user may be non-technical or may have answered with incomplete language. Convert the answer into durable requirement text and, only when needed for safety, add one follow-up question.',
    '',
    'Return only JSON with this exact shape:',
    '{"answer":"durable requirement text","status":"accepted|needs-clarification","followUpQuestion":{"id":"kebab-id","question":"plain user-facing question","reason":"why it matters","options":[{"id":"kebab-id","label":"short","description":"short","answer":"durable answer"}]},"note":"short"}',
    '',
    'Rules:',
    '- Keep the user answer authoritative. Do not override a custom answer with an option unless the user selected that option.',
    '- Make the answer concrete enough for a task runner and QA reviewer.',
    '- If the missing detail affects authority sources, WriteSet, validation, stop policy, architecture initialization, or user acceptance, return status needs-clarification with one follow-up question.',
    '- If no follow-up is needed, omit followUpQuestion or set it null.',
    '',
    'Workflow:',
    JSON.stringify({
      id: workflow.id,
      title: workflow.title,
      target: workflow.target,
      profile: workflow.profile.id,
      workstream: workflow.workstream,
      architecture: workflow.architecture ?? null
    }, null, 2),
    '',
    'Question:',
    JSON.stringify(question ?? { id: questionId }, null, 2),
    '',
    'User answer:',
    answer,
    ''
  ].join('\n');
}

interface IntakeAnswerAiResult {
  readonly answer: string;
  readonly followUpQuestion: SelvedgeRequirementQuestion | null;
  readonly evidence?: SelvedgeAiJsonEvidence;
}

function normalizeIntakeAnswerWithAi(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  questionId: string,
  answer: string,
  runnerArgs: readonly string[]
): IntakeAnswerAiResult {
  const ai = runSelvedgeAiJson(
    cwd,
    'intake-answer-normalization',
    intakeAnswerPrompt(workflow, questionId, answer),
    runnerArgs
  );
  if (!ai.parsed) {
    return {
      answer,
      followUpQuestion: null,
      evidence: ai.evidence
    };
  }
  const normalizedAnswer = typeof ai.parsed.answer === 'string' && ai.parsed.answer.trim()
    ? ai.parsed.answer.trim()
    : answer;
  const followUpQuestion =
    ai.parsed.status === 'needs-clarification'
      ? aiQuestionFromJson(ai.parsed.followUpQuestion)
      : null;
  return {
    answer: normalizedAnswer,
    followUpQuestion,
    evidence: ai.evidence
  };
}

function confirmWorkflowArchitecture(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  model: GameHubReadOnlyModel
): SelvedgeGoalWorkflow {
  const architecture = workflow.architecture;
  if (!architecture) {
    return workflow;
  }
  const next: SelvedgeGoalWorkflow = {
    ...workflow,
    architecture: {
      ...architecture,
      status: 'confirmed',
      confirmationRequired: false,
      confirmedAt: new Date().toISOString()
    }
  };
  writeGoalWorkflow(cwd, next, model);
  writeHeartbeatContextsAfterDecomposition(cwd, next);
  writeWorkflowRunStatus(cwd, next, 'Architecture proposal confirmed by operator.');
  return next;
}

export function runInit(options: CliOptions): number {
  const configPath = repoPath(options.cwd, 'selvedge.yaml');
  const dirs = [
    'schema',
    'tasks',
    'status',
    'evidence',
    'logs',
    'workflows',
    'goals',
    'profiles'
  ];
  for (const dir of dirs) {
    ensureDir(localStatePath(options.cwd, dir));
  }
  writeJson(localStatePath(options.cwd, 'schema', 'selvedge.schema.json'), SELVEDGE_CONFIG_SCHEMA);
  writeJson(localStatePath(options.cwd, 'schema', 'task.schema.json'), SELVEDGE_TASK_SCHEMA);
  writeJson(localStatePath(options.cwd, 'schema', 'goal-workflow.schema.json'), SELVEDGE_GOAL_WORKFLOW_SCHEMA);
  if (!existsSync(configPath)) {
    writeText(configPath, defaultSelvedgeConfig(options.cwd));
  }
  writeText(
    localStatePath(options.cwd, 'README.generated.md'),
    [
      '# Selvedge generated state',
      '',
      'This directory is generated by @maolaila/selvedge.',
      'Generated state is local until the project explicitly promotes Selvedge as authoritative.',
      ''
    ].join('\n')
  );
  console.log('Selvedge local state initialized under .selvedge/.');
  console.log(existsSync(configPath) ? 'Selvedge config ready at selvedge.yaml.' : 'Selvedge config was not created.');
  return 0;
}

export function runStatus(options: CliOptions): number {
  const model = buildReadOnlyModel(options.cwd);
  writeLatestModel(options.cwd, model);
  console.log(`Project: ${model.config.projectName ?? 'unknown'}`);
  console.log(`Phase: ${model.config.currentPhase ?? 'unknown'}`);
  console.log(`TASK_BOARD Pending: ${model.taskBoard.pendingCount}`);
  console.log(`AI-QA switch: ${model.aiQaSwitch.enabled === false ? 'disabled' : String(model.aiQaSwitch.enabled)}`);
  console.log(`STOP_AGENT: ${model.stopFile.exists ? 'present' : 'absent'}`);
  console.log(`Selvedge can start in Codex App: ${model.selvedgeMainline.canStartInCodexApp ? 'yes' : 'no'}`);
  console.log(model.selvedgeMainline.reason);
  return model.issues.some((issue) => issue.severity === 'error') ? 1 : 0;
}

export function runValidate(options: CliOptions): number {
  const model = buildReadOnlyModel(options.cwd);
  writeLatestModel(options.cwd, model);
  console.log(`Selvedge validation generated .selvedge/status/latest-readonly-model.json`);
  printIssueSummary(model);
  if (!model.selvedgeMainline.canStartInCodexApp) {
    console.log(model.selvedgeMainline.reason);
  }
  return model.issues.some((issue) => issue.severity === 'error') ? 1 : 0;
}

export function runPlan(options: CliOptions): number {
  const mode = options.args[0];
  if (mode !== 'kg-slots' && mode !== 'work' && mode !== 'goal' && mode !== 'autopilot-next') {
    console.error('Usage: selvedge plan <work|goal|autopilot-next|kg-slots> [options]');
    return 1;
  }
  const model = buildReadOnlyModel(options.cwd);
  writeLatestModel(options.cwd, model);
  const isAutopilotWrapper = mode === 'autopilot-next' && model.taskBoard.pendingCount > 0;
  if (!model.selvedgeMainline.canStartInCodexApp && !isAutopilotWrapper) {
    printIssueSummary(model);
    console.error('Cannot create a Selvedge plan until validation errors are cleared.');
    return 1;
  }
  if (mode === 'goal' || mode === 'autopilot-next') {
    const workflow =
      mode === 'autopilot-next'
        ? createAutopilotNextWorkflow(optionValue(options.args.slice(1), '--id') ?? 'autopilot-next', model)
        : createGoalWorkflow(createGoalInput(options.args.slice(1), 'goal-workflow'), model);
    writeWorkflowResult(options.cwd, workflow, model);
    return 0;
  }
  const plan =
    mode === 'kg-slots'
      ? createKgSlotsDogfoodPlan(planTarget(options.args.slice(1)), model)
      : createAssignedWorkPlan(createAssignedInput(options.args.slice(1)), model);
  writePlan(options.cwd, plan);
  console.log(`Created Selvedge plan: ${plan.id}`);
  console.log(`Task model: ${join('.selvedge', 'tasks', `${plan.id}.json`)}`);
  console.log(`Evidence: ${join('.selvedge', 'evidence', `${plan.id}.md`)}`);
  return 0;
}

function resolvePlanPath(cwd: string, args: readonly string[]): string | null {
  const explicit = optionValue(args, '--plan');
  if (!explicit) {
    return null;
  }
  if (explicit.endsWith('.json') || explicit.includes('/') || explicit.includes('\\')) {
    return repoPath(cwd, explicit);
  }
  return localStatePath(cwd, 'tasks', `${explicit}.json`);
}

function resolveGoalId(args: readonly string[]): string {
  return optionValue(args, '--goal') ?? optionValue(args, '--id') ?? 'autopilot-next';
}

function optionNumber(args: readonly string[], name: string): number | undefined {
  const rawValue = optionValue(args, name);
  if (!rawValue) {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionNonNegativeNumber(args: readonly string[], name: string): number | undefined {
  const rawValue = optionValue(args, name);
  if (!rawValue) {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const DEFAULT_CAPACITY_RETRY_COUNT = 0;
const DEFAULT_CAPACITY_RETRY_BASE_SECONDS = 300;

interface CapacityRetryOptions {
  readonly retryCount: number;
  readonly baseSeconds: number;
}

export function capacityRetryDelaySeconds(attempt: number, baseSeconds: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeBaseSeconds = Number.isFinite(baseSeconds) ? Math.max(0, Math.floor(baseSeconds)) : 0;
  return safeAttempt * safeBaseSeconds;
}

function resolveCapacityRetryOptions(args: readonly string[]): CapacityRetryOptions {
  return {
    retryCount: optionNonNegativeNumber(args, '--capacity-retry-count') ?? DEFAULT_CAPACITY_RETRY_COUNT,
    baseSeconds: optionNonNegativeNumber(args, '--capacity-retry-base-seconds') ?? DEFAULT_CAPACITY_RETRY_BASE_SECONDS
  };
}

function selectTask(plan: SelvedgePlan, args: readonly string[], preferExecutable: boolean): SelvedgeTask | null {
  const explicitTaskId = optionValue(args, '--task');
  if (explicitTaskId) {
    return plan.tasks.find((task) => task.id === explicitTaskId) ?? null;
  }
  if (preferExecutable) {
    return plan.tasks.find((task) => task.runner === 'shell') ?? plan.tasks[0] ?? null;
  }
  return plan.tasks[0] ?? null;
}

function runShellCommand(cwd: string, command: string, timeoutMs: number | undefined) {
  const baseOptions = {
    cwd,
    encoding: 'utf8' as const,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs
  };
  if (process.platform === 'win32') {
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      baseOptions
    );
  }
  return spawnSync(command, {
    ...baseOptions,
    shell: true
  });
}

function runShellTask(options: CliOptions, plan: SelvedgePlan, task: SelvedgeTask): number {
  const commands = task.commands ?? [];
  const timeoutMs = optionNumber(options.args, '--timeout-ms');
  const statusFileName = `${plan.id}.${task.id}.run.json`;
  const logFileName = `${plan.id}.${task.id}.log`;
  const logPath = localStatePath(options.cwd, 'logs', logFileName);
  if (commands.length === 0) {
    const runRecord = {
      planId: plan.id,
      taskId: task.id,
      runner: task.runner,
      startedAt: new Date().toISOString(),
      status: 'Failed',
      reason: 'Shell runner requires at least one command on the selected task.'
    };
    writeJson(localStatePath(options.cwd, 'status', statusFileName), runRecord);
    console.error('Shell runner requires at least one task command.');
    return 1;
  }

  const startedAt = new Date();
  const commandRecords: Array<{
    command: string;
    exitCode: number;
    signal: string | null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    error: string | null;
  }> = [];
  const logLines: string[] = [
    `Selvedge shell run`,
    `Plan: ${plan.id}`,
    `Task: ${task.id}`,
    `Started: ${startedAt.toISOString()}`,
    ''
  ];

  let finalExitCode = 0;
  for (const [index, command] of commands.entries()) {
    const commandStartedAt = Date.now();
    logLines.push(`## Command ${index + 1}`);
    logLines.push(command);
    logLines.push('');
    const result = runShellCommand(options.cwd, command, timeoutMs);
    const durationMs = Date.now() - commandStartedAt;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = typeof result.status === 'number' ? result.status : 1;
    const signal = result.signal ?? null;
    const error = result.error ? result.error.message : null;
    commandRecords.push({
      command,
      exitCode,
      signal,
      durationMs,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      error
    });
    logLines.push(`ExitCode: ${exitCode}`);
    if (signal) {
      logLines.push(`Signal: ${signal}`);
    }
    if (error) {
      logLines.push(`Error: ${error}`);
    }
    if (stdout) {
      logLines.push('');
      logLines.push('### stdout');
      logLines.push(stdout.trimEnd());
    }
    if (stderr) {
      logLines.push('');
      logLines.push('### stderr');
      logLines.push(stderr.trimEnd());
    }
    logLines.push('');
    if (exitCode !== 0 || signal || error) {
      finalExitCode = exitCode === 0 ? 1 : exitCode;
      break;
    }
  }

  const completedAt = new Date();
  const status = finalExitCode === 0 ? 'Completed' : 'Failed';
  const runRecord = {
    planId: plan.id,
    taskId: task.id,
    runner: task.runner,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    status,
    timeoutMs: timeoutMs ?? null,
    commandCount: commands.length,
    commands: commandRecords,
    log: join('.selvedge', 'logs', logFileName),
    nextAction:
      finalExitCode === 0
        ? 'Run validation and handoff review for the plan.'
        : 'Inspect log output, classify the failure, and update the plan or task boundary before retrying.'
  };
  writeText(logPath, `${logLines.join('\n')}\n`);
  writeJson(localStatePath(options.cwd, 'status', statusFileName), runRecord);
  console.log(`Shell runner ${status.toLowerCase()} for plan ${plan.id}.`);
  console.log(`Selected task: ${task.id}`);
  console.log(`Status: ${join('.selvedge', 'status', statusFileName)}`);
  console.log(`Log: ${join('.selvedge', 'logs', logFileName)}`);
  return finalExitCode;
}

function planFromWorkflow(workflow: SelvedgeGoalWorkflow): SelvedgePlan {
  return {
    version: 1,
    id: workflow.id,
    title: workflow.title,
    createdAt: workflow.createdAt,
    target: workflow.target,
    source: workflow.source,
    mode: 'assigned-work',
    tasks: workflow.tasks
  };
}

function writeWorkflowRunStatus(cwd: string, workflow: SelvedgeGoalWorkflow, message: string): void {
  writeJson(localStatePath(cwd, 'status', `${workflow.id}.workflow-status.json`), {
    workflowId: workflow.id,
    updatedAt: new Date().toISOString(),
    message,
    tasks: workflow.tasks.map((task) => ({
      id: task.id,
      phase: task.phase,
      runner: task.runner,
      status: task.status,
      statusReason: task.statusReason ?? null
    }))
  });
}

function writeLoopStatus(
  cwd: string,
  workflowId: string,
  status: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  writeJson(localStatePath(cwd, 'status', `${workflowId}.loop-status.json`), {
    workflowId,
    updatedAt: new Date().toISOString(),
    status,
    message,
    ...details
  });
}

function heartbeatContextPath(cwd: string, workflowId: string, taskId: string): string {
  return localStatePath(cwd, 'goals', workflowId, 'heartbeat-context', `${taskId}.json`);
}

function readHeartbeatContext(path: string): SelvedgeHeartbeatDisplayContext | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SelvedgeHeartbeatDisplayContext;
  } catch {
    return null;
  }
}

function readGoalArtifact(cwd: string, workflowId: string, fileName: string): string {
  const path = localStatePath(cwd, 'goals', workflowId, fileName);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function cleanSelectedTargetName(value: string): string {
  return value.replace(/\s*planned GameHub route\s*/i, '').trim();
}

function deriveMigrationTarget(cwd: string, workflow: SelvedgeGoalWorkflow): string | null {
  if (workflow.profile.id !== 'kg-slots-migration' && workflow.profile.id !== 'kg-game-migration') {
    return null;
  }
  const artifacts = [
    readGoalArtifact(cwd, workflow.id, 'development-evidence.md'),
    readGoalArtifact(cwd, workflow.id, 'functional-detail-ledger.md'),
    readGoalArtifact(cwd, workflow.id, 'source-feature-inventory.md'),
    readGoalArtifact(cwd, workflow.id, 'requirements.md')
  ].join('\n');
  const namedTarget = /Selected target:\s*`([^`]+)`\s*\/\s*([^\/\n`]+?)\s*\/\s*(?:planned GameHub route\s*)?`([^`]+)`/i.exec(artifacts);
  if (namedTarget) {
    return `KG slots / ${namedTarget[1]} (${cleanSelectedTargetName(namedTarget[2])}) / ${namedTarget[3]}`;
  }
  const routeTarget = /Selected target(?: from prior planning artifacts)?:\s*`([^`]+)`\s*\/\s*`([^`]+)`/i.exec(artifacts);
  if (routeTarget) {
    return `KG slots / ${routeTarget[1]} / ${routeTarget[2]}`;
  }
  const targetAnswer = workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.answer ?? null;
  if (workflow.profile.id === 'kg-game-migration') {
    return targetAnswer ? `KG game / ${targetAnswer}` : 'KG game / target pending';
  }
  if (targetAnswer && !/AuthorizedAutoSelect|auto/i.test(targetAnswer)) {
    return `KG slots / ${targetAnswer}`;
  }
  return 'KG slots / 待确认下一款游戏';
}

function buildHeartbeatContext(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  generationTiming: SelvedgeHeartbeatDisplayContext['generationTiming']
): SelvedgeHeartbeatDisplayContext {
  const projectObjective = readProjectObjective(cwd);
  return {
    workflowId: workflow.id,
    taskId: task.id,
    updatedAt: new Date().toISOString(),
    projectTotalGoal: projectObjective?.totalGoal,
    migrationTarget: deriveMigrationTarget(cwd, workflow),
    generationTiming,
    reviewer: generationTiming === 'after-ai-decomposition' ? 'ai-decomposition-agent' : 'selvedge-controller',
    instruction:
      generationTiming === 'after-ai-decomposition'
        ? 'Generated after task decomposition; downstream task agents should keep this aligned with the selected target.'
        : 'Generated before task start because no post-decomposition context existed or current evidence changed.'
  };
}

function shouldReplaceHeartbeatContext(existing: SelvedgeHeartbeatDisplayContext | null, next: SelvedgeHeartbeatDisplayContext): boolean {
  if (!existing) {
    return true;
  }
  if (!existing.migrationTarget || /待确认/.test(existing.migrationTarget)) {
    return Boolean(next.migrationTarget && !/待确认/.test(next.migrationTarget));
  }
  if (next.projectTotalGoal && next.projectTotalGoal !== existing.projectTotalGoal) {
    return true;
  }
  return false;
}

function ensureHeartbeatContext(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  generationTiming: SelvedgeHeartbeatDisplayContext['generationTiming']
): { path: string; context: SelvedgeHeartbeatDisplayContext } {
  const path = heartbeatContextPath(cwd, workflow.id, task.id);
  const existing = readHeartbeatContext(path);
  const next = buildHeartbeatContext(cwd, workflow, task, generationTiming);
  const context = shouldReplaceHeartbeatContext(existing, next) ? next : existing!;
  if (context === next) {
    writeJson(path, context);
  }
  return { path, context };
}

function writeHeartbeatContextsAfterDecomposition(cwd: string, workflow: SelvedgeGoalWorkflow): void {
  for (const task of workflow.tasks) {
    ensureHeartbeatContext(cwd, workflow, task, 'after-ai-decomposition');
  }
}

function workflowTaskStatusDetails(
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  context?: SelvedgeHeartbeatDisplayContext
): Record<string, unknown> {
  const snapshot = buildRunnerHeartbeat(workflow, task, {
    elapsedMs: 0,
    idleMs: 0,
    logPath: '',
    lastMessagePath: ''
  }, context);
  return {
    totalGoal: snapshot.totalGoal,
    workflowTitle: snapshot.workflowTitle,
    profileTitle: snapshot.profileTitle,
    phase: snapshot.phase,
    phaseLabel: snapshot.phaseLabel,
    phaseProgress: snapshot.phaseProgress,
    stage: snapshot.stage,
    taskId: snapshot.taskId,
    taskTitle: snapshot.taskTitle,
    taskDisplayName: snapshot.taskDisplayName,
    taskProgress: snapshot.taskProgress,
    taskIndex: snapshot.taskIndex,
    taskTotal: snapshot.taskTotal,
    completedTasks: snapshot.completedTasks,
    role: snapshot.role,
    roadmapNode: snapshot.roadmapNode,
    migrationTarget: snapshot.migrationTarget
  };
}

function runGit(cwd: string, args: readonly string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

function normalizeGitStatusPath(line: string): string {
  const value = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renamedTarget = value.includes(' -> ') ? value.split(' -> ').pop() ?? value : value;
  return renamedTarget.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

export function isSelvedgeRuntimeStateStatusLine(line: string): boolean {
  const path = normalizeGitStatusPath(line);
  return [
    /^STOP_AGENT$/,
    /^\.selvedge\/status\//,
    /^\.selvedge\/logs\//,
    /^\.selvedge\/stop-conditions\//,
    /^\.selvedge\/goals\/[^/]+\/goal\.workflow\.json$/,
    /^\.selvedge\/goals\/[^/]+\/task-queue\.md$/,
    /^\.selvedge\/goals\/[^/]+\/heartbeat-context\//,
    /^\.selvedge\/goals\/[^/]+\/prompts\//
  ].some((pattern) => pattern.test(path));
}

export function actionableGitStatusLines(statusOutput: string): readonly string[] {
  return statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !isSelvedgeRuntimeStateStatusLine(line));
}

function normalizeRepoRelativeStatusPath(cwd: string, value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^"|"$/g, '');
  const absolute = resolveTaskArtifactPath(cwd, value).replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/g, '');
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : normalized;
}

function normalizeWriteSetRule(rule: string): string {
  return rule.replace(/\\/g, '/').replace(/^"|"$/g, '').trim();
}

function writeSetRuleAllowsPath(rule: string, path: string): boolean {
  const normalized = normalizeWriteSetRule(rule);
  if (!normalized || normalized.includes(' ')) {
    return false;
  }
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3).replace(/\/+$/g, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!normalized.includes('*')) {
    const prefix = normalized.replace(/\/+$/g, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  const tokenized = normalized
    .replace(/\*\*/g, '__SELVE_DOUBLE_STAR__')
    .replace(/\*/g, '__SELVE_SINGLE_STAR__');
  const regex = new RegExp(`^${tokenized
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/__SELVE_DOUBLE_STAR__/g, '.*')
    .replace(/__SELVE_SINGLE_STAR__/g, '[^/]*')}$`);
  return regex.test(path);
}

type SelvedgeDirtyGateBoundary = 'task-start' | 'post-task';

function workflowStatePathRules(workflow: SelvedgeGoalWorkflow): readonly string[] {
  return [
    `.selvedge/goals/${workflow.id}/goal.workflow.json`,
    `.selvedge/goals/${workflow.id}/task-queue.md`
  ];
}

function allowedDirtyPathRulesForTaskBoundary(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  task: SelvedgeWorkflowTask,
  boundary: SelvedgeDirtyGateBoundary
): readonly string[] {
  const allowed: string[] = [];
  if (boundary === 'post-task') {
    allowed.push(...workflowStatePathRules(workflow));
  }
  if (!isDashboardBlockerRecoveryTask(task)) {
    if (boundary === 'post-task') {
      for (const artifact of task.artifacts) {
        allowed.push(normalizeRepoRelativeStatusPath(cwd, artifact));
      }
      allowed.push(...task.writeSet.map((item) => normalizeWriteSetRule(item)));
    }
    return allowed;
  }
  if (boundary === 'task-start') {
    for (const artifact of task.artifacts) {
      allowed.push(normalizeRepoRelativeStatusPath(cwd, artifact));
    }
  }
  const blockedTaskId = task.notes.find((note) => note.startsWith('RecoverBlockedTask:'))?.slice('RecoverBlockedTask:'.length);
  const blockedTask = blockedTaskId ? workflow.tasks.find((item) => item.id === blockedTaskId) : null;
  for (const artifact of blockedTask?.artifacts ?? []) {
    allowed.push(normalizeRepoRelativeStatusPath(cwd, artifact));
  }
  if (boundary === 'task-start') {
    allowed.push(...(blockedTask?.writeSet ?? []).map((item) => normalizeWriteSetRule(item)));
  }
  return allowed;
}

function allowedGitStatusLinesForTaskBoundary(
  cwd: string,
  statusOutput: string,
  workflow?: SelvedgeGoalWorkflow,
  task?: SelvedgeWorkflowTask,
  boundary: SelvedgeDirtyGateBoundary = 'task-start'
): readonly string[] {
  const allowedDirtyPathRules = workflow && task ? allowedDirtyPathRulesForTaskBoundary(cwd, workflow, task, boundary) : [];
  return statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = normalizeGitStatusPath(line);
      return allowedDirtyPathRules.some((rule) => path === rule || writeSetRuleAllowsPath(rule, path));
    });
}

export function actionableGitStatusLinesForTaskBoundary(
  cwd: string,
  statusOutput: string,
  workflow?: SelvedgeGoalWorkflow,
  task?: SelvedgeWorkflowTask,
  boundary: SelvedgeDirtyGateBoundary = 'task-start'
): readonly string[] {
  const allowedDirtyPathRules = workflow && task ? allowedDirtyPathRulesForTaskBoundary(cwd, workflow, task, boundary) : [];
  return statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = normalizeGitStatusPath(line);
      if (allowedDirtyPathRules.some((rule) => path === rule || writeSetRuleAllowsPath(rule, path))) {
        return false;
      }
      return !isSelvedgeRuntimeStateStatusLine(line);
    });
}

function preflightCleanWorktree(
  cwd: string,
  workflow?: SelvedgeGoalWorkflow,
  task?: SelvedgeWorkflowTask
): { ok: boolean; message: string; details: readonly string[] } {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (status.status !== 0) {
    return {
      ok: false,
      message: 'Git Gate failed before starting the next Selvedge task: git status failed.',
      details: [status.stderr || status.stdout || 'git status failed']
    };
  }
  const statusLines = actionableGitStatusLinesForTaskBoundary(cwd, status.stdout ?? '', workflow, task, 'task-start');
  if (statusLines.length > 0) {
    return {
      ok: false,
      message: 'Git Gate blocked the next Selvedge task: worktree is dirty before task start.',
      details: statusLines
    };
  }
  return {
    ok: true,
    message: 'Git Gate passed: worktree is clean before task start.',
    details: []
  };
}

function uniqueGitStatusPaths(lines: readonly string[]): readonly string[] {
  return Array.from(new Set(lines.map((line) => normalizeGitStatusPath(line)).filter(Boolean)));
}

function autoCommitMessage(workflow?: SelvedgeGoalWorkflow, task?: SelvedgeWorkflowTask): string {
  if (workflow && task) {
    return `selvedge: complete ${task.id}`;
  }
  return 'selvedge: commit completed task outputs';
}

export function autoPushIfClean(
  cwd: string,
  workflow?: SelvedgeGoalWorkflow,
  task?: SelvedgeWorkflowTask
): { ok: boolean; message: string; branch: string | null; details: readonly string[] } {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (status.status !== 0) {
    return {
      ok: false,
      message: 'git status failed before auto-push.',
      branch: null,
      details: [status.stderr || status.stdout || 'git status failed']
    };
  }
  const statusLines = actionableGitStatusLinesForTaskBoundary(cwd, status.stdout ?? '', workflow, task, 'post-task');
  const allowedStatusLines = allowedGitStatusLinesForTaskBoundary(cwd, status.stdout ?? '', workflow, task, 'post-task');
  if (statusLines.length > 0) {
    return {
      ok: false,
      message: 'Worktree is dirty after the round; auto-push is blocked.',
      branch: null,
      details: statusLines
    };
  }
  const branchResult = runGit(cwd, ['branch', '--show-current']);
  const branch = (branchResult.stdout ?? '').trim();
  if (branchResult.status !== 0 || !branch) {
    return {
      ok: false,
      message: 'Cannot determine current branch for auto-push.',
      branch: null,
      details: [branchResult.stderr || branchResult.stdout || 'Detached HEAD or git branch failed']
    };
  }
  const details: string[] = [];
  const allowedPaths = uniqueGitStatusPaths(allowedStatusLines);
  if (allowedPaths.length > 0) {
    const add = runGit(cwd, ['add', '-f', '--', ...allowedPaths]);
    if (add.status !== 0) {
      return {
        ok: false,
        message: 'Auto-commit staging failed before auto-push.',
        branch,
        details: [add.stderr || add.stdout || 'git add failed']
      };
    }
    const diffCheck = runGit(cwd, ['diff', '--cached', '--check']);
    if (diffCheck.status !== 0) {
      return {
        ok: false,
        message: 'Auto-commit diff check failed before auto-push.',
        branch,
        details: [diffCheck.stdout ?? '', diffCheck.stderr ?? ''].filter((item) => item.trim().length > 0)
      };
    }
    const staged = runGit(cwd, ['diff', '--cached', '--name-only']);
    if (staged.status !== 0) {
      return {
        ok: false,
        message: 'Auto-commit staged diff inspection failed before auto-push.',
        branch,
        details: [staged.stderr || staged.stdout || 'git diff --cached failed']
      };
    }
    if ((staged.stdout ?? '').trim().length > 0) {
      const message = autoCommitMessage(workflow, task);
      const commit = runGit(cwd, ['commit', '-m', message]);
      if (commit.status !== 0) {
        return {
          ok: false,
          message: 'Auto-commit failed before auto-push.',
          branch,
          details: [commit.stdout ?? '', commit.stderr ?? ''].filter((item) => item.trim().length > 0)
        };
      }
      const commitHash = runGit(cwd, ['rev-parse', '--short', 'HEAD']);
      const hash = (commitHash.stdout ?? '').trim();
      details.push(`Auto-commit completed${hash ? `: ${hash}` : ''} ${message}`);
    }
  }
  const push = runGit(cwd, ['push', 'origin', `HEAD:${branch}`]);
  return {
    ok: push.status === 0,
    message: push.status === 0 ? (allowedPaths.length > 0 ? 'Auto-commit and push completed.' : 'Auto-push completed.') : 'Auto-push failed.',
    branch,
    details: [...details, push.stdout ?? '', push.stderr ?? ''].filter((item) => item.trim().length > 0)
  };
}

interface HeartbeatPreferenceRecord {
  readonly requestedText: string;
  readonly normalizedAt: string;
  readonly normalizer: 'selvedge-local-intent-normalizer' | 'codex-cli-ai-heartbeat-normalizer';
  readonly optionalFields: readonly SelvedgeHeartbeatOptionalField[];
  readonly note: string;
  readonly ai?: SelvedgeAiJsonEvidence;
}

type StopConditionRule =
  | {
      readonly kind: 'maxElapsedSeconds';
      readonly seconds: number;
      readonly source: string;
    }
  | {
      readonly kind: 'maxRounds';
      readonly rounds: number;
      readonly source: string;
    }
  | {
      readonly kind: 'wallClockAfter';
      readonly time: string;
      readonly source: string;
    }
  | {
      readonly kind: 'noPendingWork';
      readonly source: string;
    }
  | {
      readonly kind: 'heartbeatIdleSeconds';
      readonly seconds: number;
      readonly source: string;
    }
  | {
      readonly kind: 'readyForHumanReview';
      readonly source: string;
    }
  | {
      readonly kind: 'needsAiConditionProgram';
      readonly source: string;
    };

interface StopConditionRecord {
  readonly version: 1;
  readonly goalId: string;
  readonly requestedText: string;
  readonly normalizedAt: string;
  readonly generator: 'selvedge-local-condition-normalizer' | 'codex-cli-ai-condition-generator';
  readonly mode: 'continuous' | 'configured';
  readonly rules: readonly StopConditionRule[];
  readonly note: string;
  readonly ai?: SelvedgeAiJsonEvidence;
}

function heartbeatPreferencePath(cwd: string): string {
  return localStatePath(cwd, 'status', 'heartbeat-preferences.json');
}

function readHeartbeatPreference(cwd: string): HeartbeatPreferenceRecord | null {
  const path = heartbeatPreferencePath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HeartbeatPreferenceRecord;
  } catch {
    return null;
  }
}

function normalizeHeartbeatPreference(requestedText: string, fallback: SelvedgeHeartbeatTemplate): HeartbeatPreferenceRecord {
  const text = requestedText.trim();
  const normalized = text.toLowerCase();
  const fields: SelvedgeHeartbeatOptionalField[] = [];
  const add = (field: SelvedgeHeartbeatOptionalField) => {
    if (!fields.includes(field)) {
      fields.push(field);
    }
  };
  const wantsMachine = /\b(id|workflow|task)\b|机器|编号|调试|诊断/.test(normalized);
  const rejectsMachine = /不要.*(机器|id|编号)|不看.*(机器|id|编号)|隐藏.*(机器|id|编号)/.test(normalized);
  if (/迁移|游戏|目标|game|route|code|gamecode/.test(normalized)) add('migrationTarget');
  if (/进度|完成|第几|百分比|progress/.test(normalized)) add('progress');
  if (/角色|谁在|agent|负责人|role/.test(normalized)) add('role');
  if (/路线|节点|roadmap|阶段门|gate/.test(normalized)) add('roadmapNode');
  if (/runner|执行器|codex|shell/.test(normalized)) add('runner');
  if (/profile|工作流|模式|流程/.test(normalized)) add('profile');
  if (/标题|原始任务|task title/.test(normalized)) add('taskTitle');
  if (/完整路径|路径|last.?message|日志路径|path/.test(normalized)) add('paths');
  if (wantsMachine && !rejectsMachine) add('machine');
  if (fields.length === 0) {
    for (const field of fallback.optionalFields) {
      add(field);
    }
  }
  const allowed = new Set<string>(SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS);
  return {
    requestedText: text,
    normalizedAt: new Date().toISOString(),
    normalizer: 'selvedge-local-intent-normalizer',
    optionalFields: fields.filter((field) => allowed.has(field)),
    note: 'Dashboard users describe what they want to see in natural language; Selvedge normalizes it into the fixed heartbeat block contract.'
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function heartbeatPreferencePrompt(
  requestedText: string,
  fallback: SelvedgeHeartbeatTemplate
): string {
  return [
    'You are the Selvedge heartbeat wording normalizer.',
    '',
    'The operator describes what they want to see in heartbeat blocks. Convert that plain language into the fixed Selvedge heartbeat block contract.',
    '',
    'Return only JSON with this exact shape:',
    '{"optionalFields":["machine|migrationTarget|profile|progress|role|roadmapNode|runner|taskTitle|paths"],"note":"short human explanation"}',
    '',
    'Rules:',
    '- The heartbeat format is always a text block. Do not invent custom fields.',
    '- Fixed fields always exist: status, totalGoal, phase, task, currentAction, elapsed, idle, log.',
    '- optionalFields may include only: machine, migrationTarget, profile, progress, role, roadmapNode, runner, taskTitle, paths.',
    '- If the user asks to hide ids or machine diagnostics, omit machine.',
    '- If the request is vague, keep the fallback optional fields.',
    '',
    'Fallback optional fields:',
    JSON.stringify(fallback.optionalFields),
    '',
    'Operator request:',
    requestedText || '(blank)',
    ''
  ].join('\n');
}

function aiHeartbeatPreferenceFromJson(
  requestedText: string,
  parsed: Record<string, unknown>,
  evidence: SelvedgeAiJsonEvidence,
  fallback: SelvedgeHeartbeatTemplate
): HeartbeatPreferenceRecord {
  const allowed = new Set<string>(SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS);
  const fields: SelvedgeHeartbeatOptionalField[] = [];
  for (const item of asStringArray(parsed.optionalFields)) {
    if (allowed.has(item) && !fields.includes(item as SelvedgeHeartbeatOptionalField)) {
      fields.push(item as SelvedgeHeartbeatOptionalField);
    }
  }
  if (fields.length === 0) {
    for (const field of fallback.optionalFields) {
      fields.push(field);
    }
  }
  return {
    requestedText: requestedText.trim(),
    normalizedAt: new Date().toISOString(),
    normalizer: 'codex-cli-ai-heartbeat-normalizer',
    optionalFields: fields,
    note: typeof parsed.note === 'string' && parsed.note.trim()
      ? parsed.note.trim()
      : 'AI normalized the operator heartbeat wording into Selvedge optional display fields.',
    ai: evidence
  };
}

function normalizeHeartbeatPreferenceWithAi(
  cwd: string,
  requestedText: string,
  fallback: SelvedgeHeartbeatTemplate,
  runnerArgs: readonly string[]
): HeartbeatPreferenceRecord {
  const ai = runSelvedgeAiJson(
    cwd,
    'heartbeat-preference-normalization',
    heartbeatPreferencePrompt(requestedText, fallback),
    runnerArgs
  );
  if (ai.parsed) {
    return aiHeartbeatPreferenceFromJson(requestedText, ai.parsed, ai.evidence, fallback);
  }
  return {
    ...normalizeHeartbeatPreference(requestedText, fallback),
    ai: ai.evidence,
    note: 'AI heartbeat normalization was unavailable; Selvedge used the conservative local fallback.'
  };
}

function resolveHeartbeatTemplateForRun(cwd: string): SelvedgeHeartbeatTemplate {
  const fallback = readSelvedgeConfig(cwd).heartbeatTemplate;
  const preference = readHeartbeatPreference(cwd);
  if (!preference) {
    return fallback;
  }
  return {
    format: 'block',
    optionalFields: preference.optionalFields
  };
}

function stopConditionPath(cwd: string, goalId: string): string {
  return localStatePath(cwd, 'stop-conditions', `${goalId}.json`);
}

function stopConditionRequestPath(cwd: string, goalId: string): string {
  return localStatePath(cwd, 'stop-conditions', `${goalId}.request.md`);
}

function parseDurationSecondsFromText(text: string): number | null {
  const patterns: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小时|小時)/i, 3600],
    [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m|分钟|分鐘|分)/i, 60],
    [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)/i, 1]
  ];
  let seconds = 0;
  for (const [pattern, multiplier] of patterns) {
    const match = pattern.exec(text);
    if (match) {
      seconds += Math.round(Number(match[1]) * multiplier);
    }
  }
  if (seconds === 0) {
    const cjkPatterns: Array<[RegExp, number]> = [
      [/(\d+(?:\.\d+)?)\s*(?:小时|小時)/i, 3600],
      [/(\d+(?:\.\d+)?)\s*(?:分钟|分鐘)/i, 60],
      [/(\d+(?:\.\d+)?)\s*秒/i, 1]
    ];
    for (const [pattern, multiplier] of cjkPatterns) {
      const match = pattern.exec(text);
      if (match) {
        seconds += Math.round(Number(match[1]) * multiplier);
      }
    }
  }
  return seconds > 0 ? seconds : null;
}

export function normalizeStopCondition(goalId: string, requestedText: string): StopConditionRecord {
  const text = requestedText.trim();
  const normalized = text.toLowerCase();
  const rules: StopConditionRule[] = [];
  const addRule = (rule: StopConditionRule) => {
    if (rule.kind === 'heartbeatIdleSeconds') {
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        const existing = rules[index];
        if (existing.kind === 'maxElapsedSeconds' && existing.seconds === rule.seconds) {
          rules.splice(index, 1);
        }
      }
    }
    if (
      rule.kind === 'maxElapsedSeconds' &&
      rules.some((item) => item.kind === 'heartbeatIdleSeconds' && item.seconds === rule.seconds)
    ) {
      return;
    }
    if (!rules.some((item) => item.kind === rule.kind && JSON.stringify(item) === JSON.stringify(rule))) {
      rules.push(rule);
    }
  };
  if (!text) {
    return {
      version: 1,
      goalId,
      requestedText: '',
      normalizedAt: new Date().toISOString(),
      generator: 'selvedge-local-condition-normalizer',
      mode: 'continuous',
      rules: [],
      note: 'No operator stop condition was entered. The loop runs until STOP_AGENT, a human-input or unrecoverable blocker, or the workflow policy stops it. Recoverable failures are converted into recovery tasks.'
    };
  }
  const durationSeconds = parseDurationSecondsFromText(normalized);
  const cjkIdleRequested = /静默|无输出|没有输出|沒有輸出|没输出|沒輸出|無輸出/.test(text);
  const cjkHumanReviewRequested =
    /人工.*(验收|驗收|审核|審核|复核|複核|确认|確認)|人类.*(验收|驗收|审核|審核)|人工验收|人工驗收|人工接手|人工确认|人工確認/.test(text);
  const cjkNoPendingRequested =
    /队列.*(完成|空)|隊列.*(完成|空)|任务.*(完成|做完|结束)|任務.*(完成|做完|結束)|没有任务|沒有任務|无任务|無任務/.test(text);
  const idleRequested = /idle|silent|no output|quiet|静默|靜默|无输出|無輸出|没输出|沒有輸出/i.test(text);
  const humanReviewRequested =
    /ready\s*for\s*human\s*review|readyforhumanreview|human\s*(review|acceptance)|review\s*ready/i.test(text) ||
    /人工.*(验收|驗收|审核|審核|复核|復核)|验收.*阶段|驗收.*階段|人工确认|人工確認/.test(text);
  if (durationSeconds && !idleRequested && /run|keep|after|later|停|停止|跑|运行|運行|小時|小时|minute|分钟|分鐘|hour/i.test(text)) {
    addRule({
      kind: 'maxElapsedSeconds',
      seconds: durationSeconds,
      source: 'operator duration request'
    });
  }
  const idleSeconds = durationSeconds && idleRequested ? durationSeconds : null;
  if (idleSeconds) {
    addRule({
      kind: 'heartbeatIdleSeconds',
      seconds: idleSeconds,
      source: 'operator idle-output request'
    });
  }
  const roundsMatch = /(\d+)\s*(?:rounds?|tasks?|轮|輪|次|个任务|個任務)/i.exec(text);
  if (durationSeconds && !cjkIdleRequested && /运行|停机|停止|小时|小時|分钟|分鐘/.test(text)) {
    addRule({
      kind: 'maxElapsedSeconds',
      seconds: durationSeconds,
      source: 'operator duration request'
    });
  }
  if (durationSeconds && cjkIdleRequested) {
    addRule({
      kind: 'heartbeatIdleSeconds',
      seconds: durationSeconds,
      source: 'operator idle-output request'
    });
  }
  const cjkRoundsMatch = /(\d+)\s*(?:轮次|輪次|轮|輪|次|个任务|個任務)/i.exec(text);
  if (cjkRoundsMatch && !roundsMatch) {
    addRule({
      kind: 'maxRounds',
      rounds: Number(cjkRoundsMatch[1]),
      source: 'operator round-count request'
    });
  }
  if (roundsMatch) {
    addRule({
      kind: 'maxRounds',
      rounds: Number(roundsMatch[1]),
      source: 'operator round-count request'
    });
  }
  const timeMatch = /(?:after|at|到|超过|超過|晚于|晚於)?\s*(\d{1,2}):(\d{2})/.exec(text);
  if (timeMatch) {
    addRule({
      kind: 'wallClockAfter',
      time: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
      source: 'operator wall-clock request'
    });
  }
  if (humanReviewRequested || cjkHumanReviewRequested) {
    addRule({
      kind: 'readyForHumanReview',
      source: 'operator human-review readiness request'
    });
  } else if (/no work|empty queue|complete|done|finish|完成|做完|空队列|空隊列|没有任务|沒有任務|无任务|無任務/i.test(text)) {
    addRule({
      kind: 'noPendingWork',
      source: 'operator completion request'
    });
  }
  if (!humanReviewRequested && !cjkHumanReviewRequested && cjkNoPendingRequested) {
    addRule({
      kind: 'noPendingWork',
      source: 'operator completion request'
    });
  }
  if (rules.length === 0) {
    addRule({
      kind: 'needsAiConditionProgram',
      source: 'unparsed operator stop request'
    });
  }
  return {
    version: 1,
    goalId,
    requestedText: text,
    normalizedAt: new Date().toISOString(),
    generator: 'selvedge-local-condition-normalizer',
    mode: 'configured',
    rules,
    note: 'The stop condition is stored as a declarative local program. Future AI adapters can rewrite this file without changing runner code.'
  };
}

function stopConditionPrompt(goalId: string, requestedText: string, localRecord: StopConditionRecord): string {
  return [
    'You are the Selvedge stop-condition program generator.',
    '',
    'Convert the operator natural-language stop condition into a small declarative JSON program. Selvedge will evaluate it before each new task or loop round.',
    '',
    'Return only JSON with this exact shape:',
    '{"mode":"continuous|configured","rules":[{"kind":"maxElapsedSeconds|maxRounds|wallClockAfter|noPendingWork|heartbeatIdleSeconds|readyForHumanReview|needsAiConditionProgram","seconds":0,"rounds":0,"time":"HH:mm","source":"short"}],"note":"short human explanation"}',
    '',
    'Rules:',
    '- Blank input means continuous mode with no rules.',
    '- Use maxElapsedSeconds for elapsed runtime limits.',
    '- Use maxRounds for task/round count limits.',
    '- Use wallClockAfter for local time cutoffs formatted HH:mm.',
    '- Use heartbeatIdleSeconds for no-output or idle-output limits.',
    '- Use noPendingWork only when the user explicitly asks to stop after the queue is empty or all work is complete.',
    '- Use readyForHumanReview when the user asks to stop at a manual review, manual acceptance, human handoff, feature-module readiness, game readiness, or review-ready stage.',
    '- readyForHumanReview is project-agnostic: it means the current independently reviewable module has completed its required development and QA/audit gates and has no blocker statuses. For KG slots it maps to one migrated game reaching review readiness, not to an early planning or partial QA step.',
    '- If the request is too ambiguous to compile safely, return one needsAiConditionProgram rule and explain what is missing.',
    '',
    'Workflow id:',
    goalId,
    '',
    'Operator request:',
    requestedText || '(blank)',
    '',
    'Local fallback parse for comparison:',
    JSON.stringify(localRecord, null, 2),
    ''
  ].join('\n');
}

function stopRuleFromJson(raw: unknown): StopConditionRule | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const kind = String(value.kind ?? '');
  const source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : 'AI stop-condition program';
  if (kind === 'maxElapsedSeconds') {
    const seconds = Number(value.seconds);
    return Number.isFinite(seconds) && seconds > 0 ? { kind, seconds: Math.round(seconds), source } : null;
  }
  if (kind === 'maxRounds') {
    const rounds = Number(value.rounds);
    return Number.isInteger(rounds) && rounds > 0 ? { kind, rounds, source } : null;
  }
  if (kind === 'wallClockAfter') {
    const time = String(value.time ?? '');
    return /^\d{2}:\d{2}$/.test(time) ? { kind, time, source } : null;
  }
  if (kind === 'heartbeatIdleSeconds') {
    const seconds = Number(value.seconds);
    return Number.isFinite(seconds) && seconds > 0 ? { kind, seconds: Math.round(seconds), source } : null;
  }
  if (kind === 'noPendingWork' || kind === 'readyForHumanReview' || kind === 'needsAiConditionProgram') {
    return { kind, source } as StopConditionRule;
  }
  return null;
}

function aiStopConditionFromJson(
  goalId: string,
  requestedText: string,
  parsed: Record<string, unknown>,
  evidence: SelvedgeAiJsonEvidence
): StopConditionRecord {
  const text = requestedText.trim();
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.map(stopRuleFromJson).filter((item): item is StopConditionRule => Boolean(item))
    : [];
  const continuous = parsed.mode === 'continuous' && text.length === 0;
  const effectiveRules = continuous || rules.length > 0
    ? rules
    : [{ kind: 'needsAiConditionProgram', source: 'AI response did not contain a valid stop rule' } as StopConditionRule];
  return {
    version: 1,
    goalId,
    requestedText: text,
    normalizedAt: new Date().toISOString(),
    generator: 'codex-cli-ai-condition-generator',
    mode: continuous ? 'continuous' : 'configured',
    rules: effectiveRules,
    note: typeof parsed.note === 'string' && parsed.note.trim()
      ? parsed.note.trim()
      : 'AI generated the Selvedge stop-condition program.',
    ai: evidence
  };
}

function normalizeStopConditionWithAi(
  cwd: string,
  goalId: string,
  requestedText: string,
  runnerArgs: readonly string[]
): StopConditionRecord {
  const local = normalizeStopCondition(goalId, requestedText);
  if (requestedText.trim().length === 0) {
    return local;
  }
  if (!local.rules.some((rule) => rule.kind === 'needsAiConditionProgram')) {
    return local;
  }
  const ai = runSelvedgeAiJson(
    cwd,
    'stop-condition-normalization',
    stopConditionPrompt(goalId, requestedText, local),
    runnerArgs
  );
  if (ai.parsed) {
    return aiStopConditionFromJson(goalId, requestedText, ai.parsed, ai.evidence);
  }
  return {
    ...local,
    ai: ai.evidence,
    note: 'AI stop-condition generation was unavailable; Selvedge used the conservative local fallback. Ambiguous requests remain needsAiConditionProgram.'
  };
}

export function saveStopCondition(cwd: string, goalId: string, requestedText: string): StopConditionRecord {
  const existingPath = stopConditionPath(cwd, goalId);
  if (requestedText.trim().length === 0 && existsSync(existingPath)) {
    const existing = readStopConditionFile(existingPath);
    if (existing) {
      return existing;
    }
  }
  const record = normalizeStopCondition(goalId, requestedText);
  writeJson(existingPath, record);
  writeText(
    stopConditionRequestPath(cwd, goalId),
    [
      `# Stop Condition Request For ${goalId}`,
      '',
      requestedText.trim() || 'No operator condition. Continuous run.',
      '',
      'Selvedge stores the executable stop policy in the adjacent JSON condition program.',
      ''
    ].join('\n')
  );
  return record;
}

function saveStopConditionWithAi(
  cwd: string,
  goalId: string,
  requestedText: string,
  runnerArgs: readonly string[]
): StopConditionRecord {
  const existingPath = stopConditionPath(cwd, goalId);
  if (requestedText.trim().length === 0 && existsSync(existingPath)) {
    const existing = readStopConditionFile(existingPath);
    if (existing) {
      return existing;
    }
  }
  const record = normalizeStopConditionWithAi(cwd, goalId, requestedText, runnerArgs);
  writeJson(existingPath, record);
  writeText(
    stopConditionRequestPath(cwd, goalId),
    [
      `# Stop Condition Request For ${goalId}`,
      '',
      requestedText.trim() || 'No operator condition. Continuous run.',
      '',
      'Selvedge stores the executable stop policy in the adjacent JSON condition program.',
      'Dashboard-submitted stop conditions are first matched locally. AI is called only when the local matcher cannot safely compile the request.',
      ''
    ].join('\n')
  );
  return record;
}

function readStopConditionFile(path: string | null): StopConditionRecord | null {
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StopConditionRecord;
  } catch {
    return null;
  }
}

export function readSavedStopCondition(cwd: string, goalId: string): StopConditionRecord | null {
  return readStopConditionFile(stopConditionPath(cwd, goalId));
}

export function clearSavedStopCondition(cwd: string, goalId: string): boolean {
  const jsonPath = stopConditionPath(cwd, goalId);
  const requestPath = stopConditionRequestPath(cwd, goalId);
  const existed = existsSync(jsonPath) || existsSync(requestPath);
  rmSync(jsonPath, { force: true });
  rmSync(requestPath, { force: true });
  return existed;
}

function resolveStopConditionFile(cwd: string, workflowId: string, args: readonly string[]): string | null {
  const explicit = optionValue(args, '--stop-condition-file');
  if (explicit) {
    return explicit.endsWith('.json') || explicit.includes('/') || explicit.includes('\\')
      ? repoPath(cwd, explicit)
      : localStatePath(cwd, 'stop-conditions', `${explicit}.json`);
  }
  const defaultPath = stopConditionPath(cwd, workflowId);
  return existsSync(defaultPath) ? defaultPath : null;
}

function stopConditionRuleSummary(rule: StopConditionRule): string {
  switch (rule.kind) {
    case 'maxElapsedSeconds':
      return `elapsed >= ${rule.seconds}s`;
    case 'maxRounds':
      return `rounds >= ${rule.rounds}`;
    case 'wallClockAfter':
      return `local time >= ${rule.time}`;
    case 'noPendingWork':
      return 'no pending runnable task';
    case 'heartbeatIdleSeconds':
      return `heartbeat idle >= ${rule.seconds}s`;
    case 'readyForHumanReview':
      return 'workflow reached ReadyForHumanReview without blockers';
    case 'needsAiConditionProgram':
      return 'needs AI-generated condition program';
    default:
      return 'unknown rule';
  }
}

function stopConditionStatusDetails(record: StopConditionRecord | null): Record<string, unknown> | null {
  return record
    ? {
        mode: record.mode,
        requestedText: record.requestedText,
        normalizedAt: record.normalizedAt,
        generator: record.generator,
        rules: record.rules.map(stopConditionRuleSummary)
      }
    : null;
}

function stopConditionSummaryText(record: StopConditionRecord | null, copy: DashboardCopy): string {
  return record && record.mode === 'configured'
    ? `${record.requestedText} -> ${record.rules.map(stopConditionRuleSummary).join('; ')}`
    : copy.noActiveStopCondition;
}

function stopConditionElapsedBaseMs(record: StopConditionRecord | null, loopStartedAtMs: number): number {
  const normalizedAtMs = typeof record?.normalizedAt === 'string' ? Date.parse(record.normalizedAt) : Number.NaN;
  return Number.isFinite(normalizedAtMs) && normalizedAtMs > loopStartedAtMs
    ? normalizedAtMs
    : loopStartedAtMs;
}

function humanizeWorkflowBlockerReason(reason: string): string {
  return reason
    .replace(
      /Blocking audit signal found in (.+?\.md)\.\s*success;/,
      'Blocking audit signal found in $1. Runner completed, but the audit artifact verdict is blocked;'
    )
    .replace(
      /\.\s*success;\s*log=/,
      '. Runner completed, but the audit artifact verdict is blocked; log='
    );
}

function workflowBlockingReason(workflow: SelvedgeGoalWorkflow): string | null {
  const task = workflowBlockingTask(workflow);
  if (!task) {
    return null;
  }
  const statusReason = task.statusReason ? humanizeWorkflowBlockerReason(task.statusReason) : '';
  return `${task.id} is ${task.status}${statusReason ? `: ${statusReason}` : ''}`;
}

function workflowBlockingTask(workflow: SelvedgeGoalWorkflow): SelvedgeWorkflowTask | null {
  return workflow.tasks.find((item) =>
    ['Failed', 'Blocked', 'NeedsHumanInput', 'NeedsRunner'].includes(item.status)
  ) ?? null;
}

export function workflowReadyForHumanReview(workflow: SelvedgeGoalWorkflow): boolean {
  if (workflowBlockingReason(workflow)) {
    return false;
  }
  if (workflow.aiIntake.userDialogueRequired) {
    return false;
  }
  return workflow.tasks.length > 0 && workflow.tasks.every((task) => task.status === 'Completed');
}

export interface DashboardBlockerStartPreparation {
  readonly workflow: SelvedgeGoalWorkflow;
  readonly prepared: boolean;
  readonly recoveryTaskId: string | null;
  readonly blockedTaskId: string | null;
  readonly message: string;
  readonly blockingReason: string | null;
}

function compactDashboardPreflight(preflight: DashboardBlockerStartPreparation | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!preflight) {
    return null;
  }
  return {
    prepared: preflight.prepared === true,
    recoveryTaskId: typeof preflight.recoveryTaskId === 'string' ? preflight.recoveryTaskId : null,
    blockedTaskId: typeof preflight.blockedTaskId === 'string' ? preflight.blockedTaskId : null,
    message: typeof preflight.message === 'string' ? preflight.message : null,
    blockingReason: typeof preflight.blockingReason === 'string' ? preflight.blockingReason : null
  };
}

export function prepareLoopBlockerRecovery(
  cwd: string,
  workflowId: string
): DashboardBlockerStartPreparation {
  const workflow = readGoalWorkflow(cwd, workflowId);
  if (!workflow) {
    return {
      workflow: {
        version: 1,
        id: workflowId,
        title: workflowId,
        createdAt: new Date().toISOString(),
        target: workflowId,
        source: 'missing workflow',
        mode: 'goal-workflow',
        profile: getWorkflowProfile('universal-autopilot'),
        workstream: 'unknown',
        aiIntake: {
          provider: 'codex-app-agent',
          promptPath: '',
          userDialogueRequired: true,
          questions: [],
          notes: []
        },
        documents: {
          goal: '',
          requirements: '',
          taskQueue: '',
          handoff: ''
        },
        tasks: []
      },
      prepared: false,
      recoveryTaskId: null,
      blockedTaskId: null,
      message: `Goal workflow not found: ${workflowPath(cwd, workflowId)}`,
      blockingReason: `Goal workflow not found: ${workflowPath(cwd, workflowId)}`
    };
  }
  const preparation = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
  if (preparation.prepared) {
    writeWorkflowRunStatus(
      cwd,
      preparation.workflow,
      `Loop auto-recovery prepared: ${preparation.message}`
    );
  }
  return preparation;
}

function compactDashboardRunControl(control: Record<string, unknown> | null): Record<string, unknown> {
  if (!control) {
    return {};
  }
  const next: Record<string, unknown> = { ...control };
  next.startPreflight = compactDashboardPreflight(
    typeof control.startPreflight === 'object' && control.startPreflight
      ? control.startPreflight as Record<string, unknown>
      : null
  );
  return next;
}

function blockerRecoveryTaskId(workflow: SelvedgeGoalWorkflow, blockedTask: SelvedgeWorkflowTask): string {
  const workflowSlug = slug(workflow.id) || 'workflow';
  const taskSlug = slug(blockedTask.id).replace(new RegExp(`^${workflowSlug}-?`), '') || 'task';
  return `${workflowSlug}-${taskSlug}-blocker-recovery`.slice(0, 120).replace(/-+$/g, '');
}

function blockerRecoveryTaskAttemptId(baseId: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return `${baseId.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`.replace(/-+$/g, '');
}

function nextBlockerRecoveryTaskId(workflow: SelvedgeGoalWorkflow, blockedTask: SelvedgeWorkflowTask): string {
  const baseId = blockerRecoveryTaskId(workflow, blockedTask);
  const existingBase = workflow.tasks.find((task) => task.id === baseId);
  if (!existingBase || existingBase.status !== 'Completed') {
    return baseId;
  }
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = blockerRecoveryTaskAttemptId(baseId, attempt);
    const existing = workflow.tasks.find((task) => task.id === candidate);
    if (!existing || existing.status !== 'Completed') {
      return candidate;
    }
  }
  return blockerRecoveryTaskAttemptId(baseId, Date.now());
}

function canDashboardAutoPrepareBlocker(task: SelvedgeWorkflowTask): boolean {
  return ['Blocked', 'Failed', 'NeedsRunner'].includes(task.status);
}

function isDashboardBlockerRecoveryTask(task: SelvedgeWorkflowTask): boolean {
  return /-blocker-recovery(?:-\d+)?$/.test(task.id) || task.notes.some((note) => note.startsWith('RecoverBlockedTask:'));
}

function isRetryableRunnerInterruption(reason: string | null | undefined): boolean {
  return /capacity-interrupted|Selected model is at capacity|Connection was reset|network|ECONNRESET/i.test(reason ?? '');
}

function lastStopWasForceForWorkflow(cwd: string, workflowId: string): boolean {
  const lastStop = readLastStop(cwd);
  if (!lastStop || lastStop.mode !== 'force') {
    return false;
  }
  return typeof lastStop.goalId !== 'string' || lastStop.goalId === workflowId;
}

function codexLastMessagePath(cwd: string, workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): string {
  return localStatePath(cwd, 'logs', `${workflow.id}.${task.id}.last-message.md`);
}

function textFileContains(path: string, pattern: RegExp): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return pattern.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

function recoveryTaskHasRepairedForRerunEvidence(cwd: string, workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): boolean {
  if (!isDashboardBlockerRecoveryTask(task)) {
    return false;
  }
  const lastMessageRepaired = textFileContains(codexLastMessagePath(cwd, workflow, task), /Status:\s*`?RepairedForRerun`?/i);
  const artifactRepaired = task.artifacts.some((artifact) =>
    textFileContains(resolveTaskArtifactPath(cwd, artifact), /Recovery status:\s*`?RepairedForRerun`?/i)
  );
  return lastMessageRepaired && artifactRepaired;
}

function recoverInterruptedInProgressTask(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  interruptedTask: SelvedgeWorkflowTask
): DashboardBlockerStartPreparation {
  const now = new Date().toISOString();
  const completedRecovery = recoveryTaskHasRepairedForRerunEvidence(cwd, workflow, interruptedTask);
  const nextWorkflow: SelvedgeGoalWorkflow = {
    ...workflow,
    tasks: workflow.tasks.map((task) => {
      if (task.id !== interruptedTask.id) {
        return task;
      }
      return completedRecovery
        ? {
            ...task,
            status: 'Completed',
            statusUpdatedAt: now,
            completedAt: now,
            statusReason:
              'Recovered stale InProgress after a force stop; recovery artifact and last message recorded RepairedForRerun.'
          }
        : {
            ...task,
            status: 'Pending',
            statusUpdatedAt: now,
            startedAt: undefined,
            completedAt: undefined,
            statusReason:
              'Reset stale InProgress after a force stop before Selvedge received a runner completion event.'
          };
    })
  };
  saveGoalWorkflow(cwd, nextWorkflow);
  writeWorkflowRunStatus(
    cwd,
    nextWorkflow,
    completedRecovery
      ? `Recovered stale InProgress recovery task ${interruptedTask.id} as completed from RepairedForRerun evidence.`
      : `Reset stale InProgress task ${interruptedTask.id} for retry after a force stop.`
  );
  return {
    workflow: nextWorkflow,
    prepared: true,
    recoveryTaskId: completedRecovery ? null : interruptedTask.id,
    blockedTaskId: interruptedTask.id,
    message: completedRecovery
      ? `Recovered stale InProgress recovery task ${interruptedTask.id} from completed recovery evidence.`
      : `Reset stale InProgress task ${interruptedTask.id} for retry after the previous force stop.`,
    blockingReason: `${interruptedTask.id} was left InProgress after a force stop.`
  };
}

function prepareInterruptedWorkflowForDashboardStart(
  cwd: string,
  workflow: SelvedgeGoalWorkflow
): DashboardBlockerStartPreparation | null {
  if (!lastStopWasForceForWorkflow(cwd, workflow.id)) {
    return null;
  }
  const interruptedTask = workflow.tasks.find((task) => task.status === 'InProgress');
  return interruptedTask ? recoverInterruptedInProgressTask(cwd, workflow, interruptedTask) : null;
}

function retryInterruptedTask(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  interruptedTask: SelvedgeWorkflowTask,
  blockingReason: string
): DashboardBlockerStartPreparation {
  const now = new Date().toISOString();
  const nextWorkflow: SelvedgeGoalWorkflow = {
    ...workflow,
    tasks: workflow.tasks
      .filter((task) => !isDashboardBlockerRecoveryTask(task) || !task.notes.includes(`RecoverBlockedTask:${interruptedTask.id}`))
      .map((task) => {
        if (task.id !== interruptedTask.id) {
          return task;
        }
        return {
          ...task,
          status: 'Pending',
          dependsOn: task.dependsOn.filter((id) => id !== blockerRecoveryTaskId(workflow, interruptedTask)),
          statusUpdatedAt: now,
          startedAt: undefined,
          completedAt: undefined,
          statusReason: `Retrying after transient runner interruption. Previous failure: ${blockingReason}`
        };
      })
  };
  saveGoalWorkflow(cwd, nextWorkflow);
  writeWorkflowRunStatus(cwd, nextWorkflow, `Retrying ${interruptedTask.id} after transient runner interruption.`);
  return {
    workflow: nextWorkflow,
    prepared: true,
    recoveryTaskId: null,
    blockedTaskId: interruptedTask.id,
    message: `Transient runner interruption on ${interruptedTask.id}; Selvedge reset the same task for retry instead of creating a blocker recovery task.`,
    blockingReason
  };
}

function retryExistingBlockerRecoveryTask(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  recoveryTask: SelvedgeWorkflowTask,
  blockingReason: string
): DashboardBlockerStartPreparation {
  const now = new Date().toISOString();
  const nextWorkflow: SelvedgeGoalWorkflow = {
    ...workflow,
    tasks: workflow.tasks.map((task) =>
      task.id === recoveryTask.id
        ? {
            ...task,
            status: 'Pending',
            statusUpdatedAt: now,
            startedAt: undefined,
            completedAt: undefined,
            statusReason: `Retrying dashboard blocker recovery after a failed start. Previous failure: ${blockingReason}`
          }
        : task
    )
  };
  saveGoalWorkflow(cwd, nextWorkflow);
  return {
    workflow: nextWorkflow,
    prepared: true,
    recoveryTaskId: recoveryTask.id,
    blockedTaskId: recoveryTask.notes.find((note) => note.startsWith('RecoverBlockedTask:'))?.slice('RecoverBlockedTask:'.length) ?? null,
    message: `Workflow recovery task ${recoveryTask.id} failed earlier. Selvedge reset it for retry before continuing.`,
    blockingReason
  };
}

function taskHasExistingArtifact(cwd: string, task: SelvedgeWorkflowTask): boolean {
  return task.artifacts.some((artifact) => existsSync(resolveTaskArtifactPath(cwd, artifact)));
}

function completeFalsePositiveArtifactBlocker(
  cwd: string,
  workflow: SelvedgeGoalWorkflow,
  blockedTask: SelvedgeWorkflowTask
): DashboardBlockerStartPreparation | null {
  if (
    blockedTask.status !== 'Blocked' ||
    !/Blocking audit signal found/i.test(blockedTask.statusReason ?? '') ||
    !taskHasExistingArtifact(cwd, blockedTask) ||
    taskArtifactBlockingReason(cwd, blockedTask)
  ) {
    return null;
  }
  const nextWorkflow = setWorkflowTaskStatus(
    workflow,
    blockedTask.id,
    'Completed',
    'Recovered false-positive audit blocker after rescanning artifacts with the current Selvedge blocker rules.'
  );
  saveGoalWorkflow(cwd, nextWorkflow);
  writeWorkflowRunStatus(cwd, nextWorkflow, `Recovered false-positive artifact blocker on ${blockedTask.id}.`);
  return {
    workflow: nextWorkflow,
    prepared: true,
    recoveryTaskId: null,
    blockedTaskId: blockedTask.id,
    message: `Recovered false-positive artifact blocker on ${blockedTask.id}.`,
    blockingReason: null
  };
}

function cleanBlockerReasonForRecoveryPrompt(reason: string): string {
  return reason
    .replace(/MismatchBlocker/g, 'recorded blocker')
    .replace(/ReadyForHumanReview/g, 'human-review readiness');
}

function blockerRecoveryArtifactPath(workflowId: string, recoveryTaskId: string): string {
  return join('.selvedge', 'goals', workflowId, `${recoveryTaskId}.md`);
}

function dashboardBlockerRecoveryMarkdown(
  workflow: SelvedgeGoalWorkflow,
  blockedTask: SelvedgeWorkflowTask,
  recoveryTaskId: string,
  blockingReason: string
): string {
  return [
    `# Dashboard Blocker Recovery: ${recoveryTaskId}`,
    '',
    `Workflow: ${workflow.id}`,
    `Blocked task: ${blockedTask.id}`,
    `Blocked task title: ${blockedTask.title}`,
    `Blocked task status: ${blockedTask.status}`,
    '',
    '## Why This Exists',
    '',
    'The user clicked Start from the Selvedge dashboard while the selected workflow had a recorded blocker.',
    'Selvedge converted that blocked state into this recovery task so the runner can first repair the workflow to a runnable state, then rerun the original blocked task.',
    '',
    '## Recorded Blocker',
    '',
    blockingReason,
    '',
    '## Recovery Instructions',
    '',
    '- Read the blocked task artifact, status reason, logs, and last message before editing.',
    '- Repair only the minimum repo state needed to make the original task runnable again.',
    '- Keep the original authority sources and WriteSet boundaries unless the blocker proves a narrow additional WriteSet is required.',
    '- If repair is unsafe or needs a human decision, stop and update this recovery artifact with the exact question and evidence.',
    '- After repair, leave the original blocked task queued for rerun; do not mark the workflow ready by assertion.',
    ''
  ].join('\n');
}

function createBlockerRecoveryTask(
  workflow: SelvedgeGoalWorkflow,
  blockedTask: SelvedgeWorkflowTask,
  recoveryTaskId: string
): SelvedgeWorkflowTask {
  return {
    id: recoveryTaskId,
    title: `Repair blocker before continuing: ${blockedTask.title}`,
    phase: blockedTask.phase,
    stage: 'recovery',
    role: 'selvedge-blocker-recovery-lead',
    workstream: blockedTask.workstream,
    roadmapNode: `${blockedTask.roadmapNode} / dashboard blocker recovery`,
    runner: blockedTask.runner === 'shell' ? 'codex-app-agent' : blockedTask.runner,
    writeSet: [
      blockerRecoveryArtifactPath(workflow.id, recoveryTaskId),
      '.selvedge/status/**',
      'Minimum repo files required to clear the recorded blocker; do not broaden scope without evidence.'
    ],
    validation: [
      'Read the blocked task artifact, status reason, logs, and last message before editing.',
      'Repair the minimum state needed for the original task to run again.',
      'Run focused validation that proves the blocker path is now runnable.',
      'Record evidence, changed files, validation commands, and any remaining user decision in the recovery artifact.'
    ],
    dependsOn: blockedTask.dependsOn,
    artifacts: [blockerRecoveryArtifactPath(workflow.id, recoveryTaskId)],
    stopPolicy: 'stop-if-recovery-needs-human-decision-or-cannot-be-repaired-safely',
    notes: [
      `RecoverBlockedTask:${blockedTask.id}`,
      'Created by dashboard start preflight because Start was clicked while the workflow had a recorded blocker.',
      'After this task completes, Selvedge must rerun the original task instead of skipping it.'
    ],
    status: 'Pending'
  };
}

export function prepareBlockedWorkflowForDashboardStart(
  cwd: string,
  workflow: SelvedgeGoalWorkflow
): DashboardBlockerStartPreparation {
  const interruptedRecovery = prepareInterruptedWorkflowForDashboardStart(cwd, workflow);
  if (interruptedRecovery) {
    return interruptedRecovery;
  }
  const blockedTask = workflowBlockingTask(workflow);
  const blockingReason = workflowBlockingReason(workflow);
  if (!blockedTask || !blockingReason) {
    return {
      workflow,
      prepared: false,
      recoveryTaskId: null,
      blockedTaskId: null,
      message: 'Workflow is ready to start.',
      blockingReason: null
    };
  }
  const falsePositiveRepair = completeFalsePositiveArtifactBlocker(cwd, workflow, blockedTask);
  if (falsePositiveRepair) {
    return falsePositiveRepair;
  }
  if (!canDashboardAutoPrepareBlocker(blockedTask)) {
    return {
      workflow,
      prepared: false,
      recoveryTaskId: null,
      blockedTaskId: blockedTask.id,
      message: `Workflow needs human input before it can start: ${blockingReason}`,
      blockingReason
    };
  }
  if (isRetryableRunnerInterruption(blockingReason)) {
    if (isDashboardBlockerRecoveryTask(blockedTask)) {
      const originalTaskId = blockedTask.notes.find((note) => note.startsWith('RecoverBlockedTask:'))?.slice('RecoverBlockedTask:'.length) ?? null;
      const originalTask = originalTaskId ? workflow.tasks.find((task) => task.id === originalTaskId) : null;
      if (originalTask) {
        return retryInterruptedTask(cwd, workflow, originalTask, blockingReason);
      }
    }
    return retryInterruptedTask(cwd, workflow, blockedTask, blockingReason);
  }
  if (isDashboardBlockerRecoveryTask(blockedTask)) {
    return retryExistingBlockerRecoveryTask(cwd, workflow, blockedTask, blockingReason);
  }

  const recoveryTaskId = nextBlockerRecoveryTaskId(workflow, blockedTask);
  const existingRecovery = workflow.tasks.find((task) => task.id === recoveryTaskId);
  const recoveryTask = existingRecovery ?? createBlockerRecoveryTask(workflow, blockedTask, recoveryTaskId);
  const now = new Date().toISOString();
  const resetBlockedTask: SelvedgeWorkflowTask = {
    ...blockedTask,
    status: 'Pending',
    dependsOn: Array.from(new Set([...blockedTask.dependsOn, recoveryTaskId])),
    statusUpdatedAt: now,
    startedAt: undefined,
    completedAt: undefined,
    statusReason: `Queued for rerun after dashboard blocker recovery task ${recoveryTaskId}. Previous blocker evidence is preserved in ${blockerRecoveryArtifactPath(workflow.id, recoveryTaskId)}.`
  };
  const tasks: SelvedgeWorkflowTask[] = [];
  for (const task of workflow.tasks) {
    if (task.id === recoveryTask.id) {
      continue;
    }
    if (task.id === blockedTask.id) {
      tasks.push(recoveryTask);
      tasks.push(resetBlockedTask);
      continue;
    }
    tasks.push(task);
  }
  const nextWorkflow: SelvedgeGoalWorkflow = {
    ...workflow,
    tasks
  };
  writeText(
    repoPath(cwd, blockerRecoveryArtifactPath(workflow.id, recoveryTaskId)),
    dashboardBlockerRecoveryMarkdown(
      workflow,
      blockedTask,
      recoveryTaskId,
      cleanBlockerReasonForRecoveryPrompt(blockingReason)
    )
  );
  saveGoalWorkflow(cwd, nextWorkflow);
  return {
    workflow: nextWorkflow,
    prepared: true,
    recoveryTaskId,
    blockedTaskId: blockedTask.id,
    message: `Workflow had a blocker. Selvedge queued ${recoveryTaskId} first, then will rerun ${blockedTask.id}.`,
    blockingReason
  };
}

function localTimeReached(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    return false;
  }
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = Number(match[1]) * 60 + Number(match[2]);
  return currentMinutes >= targetMinutes;
}

function evaluateStopCondition(
  record: StopConditionRecord | null,
  context: {
    readonly startedAtMs: number;
    readonly elapsedBaseMs?: number;
    readonly rounds: number;
    readonly hasPendingTask: boolean;
    readonly hasBlockingTask: boolean;
    readonly readyForHumanReview: boolean;
    readonly latestLoopStatus: Record<string, unknown> | null;
  }
): { stop: boolean; reason: string } {
  if (!record || record.mode === 'continuous') {
    return { stop: false, reason: 'No configured stop condition.' };
  }
  const elapsedBaseMs = context.elapsedBaseMs ?? context.startedAtMs;
  for (const rule of record.rules) {
    if (rule.kind === 'maxElapsedSeconds' && Date.now() - elapsedBaseMs >= rule.seconds * 1000) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
    if (rule.kind === 'maxRounds' && context.rounds >= rule.rounds) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
    if (rule.kind === 'wallClockAfter' && localTimeReached(rule.time)) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
    if (rule.kind === 'noPendingWork' && !context.hasPendingTask && !context.hasBlockingTask) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
    if (rule.kind === 'readyForHumanReview' && context.readyForHumanReview) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
    if (
      rule.kind === 'heartbeatIdleSeconds' &&
      typeof context.latestLoopStatus?.idleMs === 'number' &&
      context.latestLoopStatus.idleMs >= rule.seconds * 1000
    ) {
      return { stop: true, reason: `Configured stop condition reached: ${stopConditionRuleSummary(rule)}.` };
    }
  }
  return { stop: false, reason: 'Configured stop condition has not been reached.' };
}

function resolveTaskArtifactPath(cwd: string, artifact: string): string {
  return /^[a-zA-Z]:[\\/]/.test(artifact) || artifact.startsWith('/')
    ? artifact
    : repoPath(cwd, artifact);
}

export function taskNeedsBlockingArtifactScan(task: SelvedgeWorkflowTask): boolean {
  if (isDashboardBlockerRecoveryTask(task)) {
    return false;
  }
  const text = [
    task.id,
    task.stopPolicy,
    ...task.validation,
    ...(task.notes ?? [])
  ].join('\n');
  return /independent-audit|mismatch-blocker|MismatchBlocker|ReadyForHumanReview/i.test(text);
}

export function artifactContainsBlockingSignal(text: string): boolean {
  const scanText = text
    .split(/\r?\n/)
    .filter((line) => {
      if (/ReadyForHumanReview[^.\r\n]*NotBlocked/i.test(line)) {
        return false;
      }
      return !/ReadyForHumanReview[^.\r\n]*\b(no|not|none|without|zero)\b[^.\r\n]*blocked/i.test(line);
    })
    .join('\n');
  return [
    /^(?!.*(?:(?:\b(?:no|none|without|zero)\b)|0)[^|\r\n]{0,80}`?MismatchBlocker`?\s+found).*`?MismatchBlocker`?\s+found/i,
    /\|\s*[^|\r\n]+\s*\|\s*`?MismatchBlocker`?\s*\|/i,
    /must\s+not\s+be\s+marked\s+`?ReadyForHumanReview`?/i,
    /\bnot\s+ReadyForHumanReview\b/i,
    /ReadyForHumanReview[^.\r\n]*(blocked|阻塞|不得|不能)/i
  ].some((pattern) => pattern.test(scanText));
}

function taskArtifactBlockingReason(cwd: string, task: SelvedgeWorkflowTask): string | null {
  if (!taskNeedsBlockingArtifactScan(task)) {
    return null;
  }
  for (const artifact of task.artifacts) {
    const path = resolveTaskArtifactPath(cwd, artifact);
    if (!existsSync(path)) {
      continue;
    }
    const text = readFileSync(path, 'utf8');
    if (artifactContainsBlockingSignal(text)) {
      return `Blocking audit signal found in ${artifact}.`;
    }
  }
  return null;
}

function completionStatusAfterArtifactGates(
  cwd: string,
  task: SelvedgeWorkflowTask,
  status: SelvedgeTaskStatus,
  reason: string
): { status: SelvedgeTaskStatus; reason: string; exitCode: number } {
  if (status !== 'Completed') {
    return { status, reason, exitCode: 1 };
  }
  const blockingReason = taskArtifactBlockingReason(cwd, task);
  if (blockingReason) {
    return {
      status: 'Blocked',
      reason: `${blockingReason} Runner completed, but the task artifact verdict is blocked. ${reason}`,
      exitCode: 1
    };
  }
  return { status, reason, exitCode: 0 };
}

function runBuiltinWorkflowTask(options: CliOptions, workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): SelvedgeGoalWorkflow {
  if (task.runner === 'builtin:intake-doc' && workflow.aiIntake.userDialogueRequired) {
    const next = setWorkflowTaskStatus(
      workflow,
      task.id,
      'NeedsHumanInput',
      'Required intake answers are missing. Answer them in the Selvedge dashboard or provide explicit --answer values before execution.'
    );
    saveGoalWorkflow(options.cwd, next);
    writeWorkflowRunStatus(options.cwd, next, 'Intake requires user input.');
    return next;
  }
  let next = setWorkflowTaskStatus(workflow, task.id, 'InProgress');
  saveGoalWorkflow(options.cwd, next);
  if (task.runner === 'builtin:handoff') {
    next = setWorkflowTaskStatus(next, task.id, 'Completed');
    saveGoalWorkflow(options.cwd, next);
    writeBuiltinTaskEvidence(options.cwd, next, task);
    writeWorkflowRunStatus(options.cwd, next, `Completed ${task.id}.`);
    return next;
  }
  writeBuiltinTaskEvidence(options.cwd, next, task);
  next = setWorkflowTaskStatus(next, task.id, 'Completed');
  saveGoalWorkflow(options.cwd, next);
  writeWorkflowRunStatus(options.cwd, next, `Completed ${task.id}.`);
  return next;
}

export async function runNextWorkflow(options: CliOptions): Promise<number> {
  const workflowId = resolveGoalId(options.args);
  let workflow = readGoalWorkflow(options.cwd, workflowId);
  if (!workflow) {
    console.error(`Goal workflow not found: ${workflowPath(options.cwd, workflowId)}`);
    return 1;
  }
  const execute = options.args.includes('--execute');
  const stopPolicy = resolveStopPolicy(options.cwd, optionValue(options.args, '--stop-time') ?? 'none');
  if (execute && options.args.includes('--clear-stop-on-start')) {
    clearStopFile(stopPolicy);
  }
  const maxSteps = optionNumber(options.args, '--max-steps') ?? 1;
  for (let index = 0; index < maxSteps; index += 1) {
    if (execute && !options.args.includes('--ignore-stop-file')) {
      const stop = isStopRequested(stopPolicy);
      if (stop.stop) {
        writeWorkflowRunStatus(options.cwd, workflow, `Stopped before next task: ${stop.reason}`);
        console.log(`Selvedge stopped before launching a task: ${stop.reason}`);
        return 0;
      }
    }
    const task = selectNextWorkflowTask(workflow);
    if (!task) {
      const blockingReason = workflowBlockingReason(workflow);
      if (blockingReason) {
        writeWorkflowRunStatus(options.cwd, workflow, `Workflow blocked: ${blockingReason}`);
        console.error(`Selvedge workflow blocked: ${blockingReason}`);
        return 1;
      }
      writeWorkflowRunStatus(options.cwd, workflow, 'No pending runnable task remains.');
      console.log(`No pending runnable task remains for workflow ${workflow.id}.`);
      return 0;
    }
    if (!execute) {
      writeWorkflowRunStatus(options.cwd, workflow, `Dry-run selected ${task.id}.`);
      console.log(`Dry-run selected task: ${task.id}`);
      console.log(`Runner: ${task.runner}`);
      console.log(`Status: ${join('.selvedge', 'status', `${workflow.id}.workflow-status.json`)}`);
      return 0;
    }
    const heartbeatContext = ensureHeartbeatContext(options.cwd, workflow, task, 'before-task-start-refresh');
    if (task.runner.startsWith('builtin:')) {
      workflow = runBuiltinWorkflowTask(options, workflow, task);
      const updatedTask = workflow.tasks.find((item) => item.id === task.id);
      if (updatedTask?.status !== 'Completed') {
        console.log(`Workflow stopped at ${task.id}: ${updatedTask?.status ?? 'unknown'}`);
        return 1;
      }
      continue;
    }
    if (task.runner === 'shell') {
      workflow = setWorkflowTaskStatus(workflow, task.id, 'InProgress');
      saveGoalWorkflow(options.cwd, workflow);
      const commandExitCode = runShellTask(options, planFromWorkflow(workflow), task);
      workflow = readGoalWorkflow(options.cwd, workflow.id) ?? workflow;
      const shellCompletion = completionStatusAfterArtifactGates(
        options.cwd,
        task,
        commandExitCode === 0 ? 'Completed' : 'Failed',
        commandExitCode === 0 ? 'Shell command set completed.' : `Shell command set failed with exit code ${commandExitCode}.`
      );
      workflow = setWorkflowTaskStatus(
        workflow,
        task.id,
        shellCompletion.status,
        shellCompletion.reason
      );
      saveGoalWorkflow(options.cwd, workflow);
      writeWorkflowRunStatus(options.cwd, workflow, `Shell task ${task.id} ${shellCompletion.status.toLowerCase()}.`);
      if (commandExitCode !== 0 || shellCompletion.exitCode !== 0) {
        return commandExitCode || shellCompletion.exitCode;
      }
      continue;
    }
    if (task.runner === 'codex-app-agent' || task.runner === 'codex-cli') {
      const codexRunnerOptions = resolveCodexRunnerOptions(options.args);
      const capacityRetryOptions = resolveCapacityRetryOptions(options.args);
      const heartbeatTemplate = resolveHeartbeatTemplateForRun(options.cwd);
      workflow = setWorkflowTaskStatus(workflow, task.id, 'InProgress');
      saveGoalWorkflow(options.cwd, workflow);
      const workflowIdForHeartbeat = workflow.id;
      let capacityAttempt = 0;
      let result: SelvedgeCodexRunResult | null = null;
      while (true) {
        capacityAttempt += 1;
        result = await runCodexWorkflowTask(options.cwd, workflow, task, {
        ...codexRunnerOptions,
        heartbeatTemplate,
        heartbeatTemplatePath: heartbeatPreferencePath(options.cwd),
        heartbeatContext: heartbeatContext.context,
        heartbeatContextPath: heartbeatContext.path,
        onHeartbeat: (heartbeat) => {
          writeLoopStatus(options.cwd, workflowIdForHeartbeat, 'Heartbeat', `正在执行 ${heartbeat.taskProgress} ${heartbeat.taskDisplayName}。`, {
            totalGoal: heartbeat.totalGoal,
            workflowTitle: heartbeat.workflowTitle,
            profileTitle: heartbeat.profileTitle,
            localTime: heartbeat.localTime,
            phase: heartbeat.phase,
            phaseLabel: heartbeat.phaseLabel,
            phaseProgress: heartbeat.phaseProgress,
            stage: heartbeat.stage,
            taskId: task.id,
            taskTitle: heartbeat.taskTitle,
            taskDisplayName: heartbeat.taskDisplayName,
            taskProgress: heartbeat.taskProgress,
            taskIndex: heartbeat.taskIndex,
            taskTotal: heartbeat.taskTotal,
            completedTasks: heartbeat.completedTasks,
            role: heartbeat.role,
            roadmapNode: heartbeat.roadmapNode,
            migrationTarget: heartbeat.migrationTarget,
            runner: heartbeat.runner,
            currentAction: heartbeat.currentAction,
            elapsedMs: heartbeat.elapsedMs,
            elapsed: heartbeat.elapsed,
            idleMs: heartbeat.idleMs,
            idle: heartbeat.idle,
            logPath: heartbeat.logPath,
            logDisplayPath: heartbeat.logDisplayPath,
            heartbeatContextPath: heartbeatContext.path,
            lastMessagePath: heartbeat.lastMessagePath
          });
        }
      });
        if (result.exitCode === 0 || result.classification !== 'capacity-interrupted') {
          break;
        }

        const gitGate = preflightCleanWorktree(options.cwd);
        if (!gitGate.ok) {
          const message = `Capacity interruption left an actionable dirty worktree; not retrying ${task.id} automatically.`;
          writeWorkflowRunStatus(options.cwd, workflow, `${message} ${gitGate.details.join(' | ')}`);
          writeLoopStatus(options.cwd, workflowIdForHeartbeat, 'Blocked', message, {
            ...workflowTaskStatusDetails(workflow, task, heartbeatContext.context),
            runner: task.runner,
            attempt: capacityAttempt,
            logPath: result.logPath,
            lastMessagePath: result.lastMessagePath,
            gitGate: gitGate.details
          });
          console.error(message);
          for (const detail of gitGate.details) {
            console.error(detail);
          }
          break;
        }

        if (capacityRetryOptions.retryCount > 0 && capacityAttempt > capacityRetryOptions.retryCount) {
          const message = `Capacity retry limit reached for ${task.id} (${capacityRetryOptions.retryCount}).`;
          writeWorkflowRunStatus(options.cwd, workflow, message);
          writeLoopStatus(options.cwd, workflowIdForHeartbeat, 'Failed', message, {
            ...workflowTaskStatusDetails(workflow, task, heartbeatContext.context),
            runner: task.runner,
            attempt: capacityAttempt,
            capacityRetryCount: capacityRetryOptions.retryCount,
            logPath: result.logPath,
            lastMessagePath: result.lastMessagePath
          });
          console.error(message);
          break;
        }

        if (!options.args.includes('--ignore-stop-file')) {
          const stop = isStopRequested(stopPolicy);
          if (stop.stop) {
            workflow = readGoalWorkflow(options.cwd, workflow.id) ?? workflow;
            workflow = setWorkflowTaskStatus(
              workflow,
              task.id,
              'Pending',
              `Stopped before retrying transient runner interruption: ${stop.reason}`
            );
            saveGoalWorkflow(options.cwd, workflow);
            writeWorkflowRunStatus(options.cwd, workflow, `Stopped before capacity retry for ${task.id}: ${stop.reason}`);
            writeLoopStatus(options.cwd, workflowIdForHeartbeat, 'Stopped', `Stopped before retrying ${task.id}: ${stop.reason}`, {
              ...workflowTaskStatusDetails(workflow, task, heartbeatContext.context),
              runner: task.runner,
              attempt: capacityAttempt,
              logPath: result.logPath,
              lastMessagePath: result.lastMessagePath
            });
            console.log(`Selvedge stopped before retrying task ${task.id}: ${stop.reason}`);
            return 0;
          }
        }

        const delaySeconds = capacityRetryDelaySeconds(capacityAttempt, capacityRetryOptions.baseSeconds);
        const message = `Selected model is at capacity or the runner hit a transient interruption. Worktree is clean; retrying ${task.id} after ${delaySeconds} second(s).`;
        writeWorkflowRunStatus(options.cwd, workflow, message);
        writeLoopStatus(options.cwd, workflowIdForHeartbeat, 'Waiting', message, {
          ...workflowTaskStatusDetails(workflow, task, heartbeatContext.context),
          runner: task.runner,
          attempt: capacityAttempt,
          capacityRetryCount: capacityRetryOptions.retryCount,
          delaySeconds,
          logPath: result.logPath,
          lastMessagePath: result.lastMessagePath
        });
        console.log(message);
        if (delaySeconds > 0) {
          await sleepSeconds(delaySeconds);
        }
        workflow = readGoalWorkflow(options.cwd, workflow.id) ?? workflow;
      }
      if (!result) {
        console.error(`Codex runner did not produce a result for task ${task.id}.`);
        return 1;
      }
      workflow = readGoalWorkflow(options.cwd, workflow.id) ?? workflow;
      const codexCompletion = completionStatusAfterArtifactGates(
        options.cwd,
        task,
        result.status,
        `${result.classification}; log=${result.logPath}; lastMessage=${result.lastMessagePath}`
      );
      workflow = setWorkflowTaskStatus(
        workflow,
        task.id,
        codexCompletion.status,
        codexCompletion.reason
      );
      saveGoalWorkflow(options.cwd, workflow);
      writeWorkflowRunStatus(options.cwd, workflow, `Codex task ${task.id} ${codexCompletion.status.toLowerCase()}: ${result.classification}.`);
      console.log(`Codex runner ${codexCompletion.status.toLowerCase()} for task ${task.id}.`);
      console.log(`Prompt: ${result.promptPath}`);
      console.log(`Log: ${result.logPath}`);
      console.log(`Last message: ${result.lastMessagePath}`);
      console.log(`Status: ${result.statusPath}`);
      if (result.exitCode !== 0 || codexCompletion.exitCode !== 0) {
        return result.exitCode || codexCompletion.exitCode;
      }
      continue;
    }
    workflow = setWorkflowTaskStatus(
      workflow,
      task.id,
      'NeedsRunner',
      `Runner ${task.runner} is not executable by this Selvedge CLI installation.`
    );
    saveGoalWorkflow(options.cwd, workflow);
    writeWorkflowRunStatus(options.cwd, workflow, `Unsupported runner for ${task.id}.`);
    console.error(`Runner not available for task ${task.id}: ${task.runner}`);
    return 1;
  }
  return 0;
}

function stripLoopOnlyArgs(args: readonly string[]): string[] {
  const stripWithValue = new Set(['--max-rounds', '--sleep-seconds', '--no-work-idle-seconds']);
  const stripFlags = new Set(['--exit-on-no-work', '--clear-stop-on-start', '--skip-auto-push']);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (stripWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (stripFlags.has(arg)) {
      continue;
    }
    result.push(arg);
  }
  if (!result.includes('--max-steps')) {
    result.push('--max-steps', '1');
  }
  return result;
}

export function loopArgsForWorkflow(args: readonly string[], workflowId: string): string[] {
  const result = stripLoopOnlyArgs(args);
  const goalIndex = result.findIndex((arg) => arg === '--goal');
  if (goalIndex >= 0) {
    result[goalIndex + 1] = workflowId;
    return result;
  }
  result.push('--goal', workflowId);
  return result;
}

function updateDashboardRunControlActiveGoal(cwd: string, previousWorkflowId: string, nextWorkflowId: string): void {
  const control = readDashboardRunControl(cwd);
  if (!control || control.goalId !== previousWorkflowId) {
    return;
  }
  writeJson(dashboardRunControlPath(cwd), {
    ...compactDashboardRunControl(control),
    goalId: nextWorkflowId,
    previousGoalId: previousWorkflowId,
    switchedAt: new Date().toISOString(),
    message: `Continuous planner switched from ${previousWorkflowId} to ${nextWorkflowId}. Dashboard is now tracking the active workflow.`
  });
}

export async function runLoop(options: CliOptions): Promise<number> {
  let workflowId = resolveGoalId(options.args);
  if (!options.args.includes('--execute')) {
    console.error('Usage: selvedge run loop --goal <goal-id> --execute [--max-rounds <n>] [--stop-time <HH:mm|none>]');
    return 1;
  }
  const stopPolicy = resolveStopPolicy(options.cwd, optionValue(options.args, '--stop-time') ?? '07:30');
  const clearedStop = options.args.includes('--clear-stop-on-start') ? clearStopFile(stopPolicy) : false;
  const maxRounds = optionNonNegativeNumber(options.args, '--max-rounds') ?? 0;
  const sleepBetweenRounds = optionNonNegativeNumber(options.args, '--sleep-seconds') ?? 10;
  const noWorkIdleSeconds = optionNonNegativeNumber(options.args, '--no-work-idle-seconds') ?? 1800;
  const exitOnNoWork = options.args.includes('--exit-on-no-work');
  const ignoreStopFile = options.args.includes('--ignore-stop-file');
  const autoPush = options.args.includes('--auto-push') && !options.args.includes('--skip-auto-push');
  const stopConditionFile = resolveStopConditionFile(options.cwd, workflowId, options.args);
  const initialStopCondition = readStopConditionFile(stopConditionFile);
  const loopStartedAtMs = Date.now();
  let rounds = 0;
  writeLoopStatus(options.cwd, workflowId, 'Started', 'Selvedge loop started.', {
    maxRounds,
    sleepBetweenRounds,
    noWorkIdleSeconds,
    stopTime: stopPolicy.stopTime,
    stopCutoff: stopPolicy.cutoff?.toISOString() ?? null,
    clearedStop,
    autoPush,
    stopConditionFile,
    stopCondition: stopConditionStatusDetails(initialStopCondition)
  });

  while (maxRounds === 0 || rounds < maxRounds) {
    const stopCondition = readStopConditionFile(stopConditionFile);
    if (!ignoreStopFile) {
      const stop = isStopRequested(stopPolicy);
      if (stop.stop) {
        writeLoopStatus(options.cwd, workflowId, 'Stopped', stop.reason, { rounds });
        console.log(`Selvedge loop stopped: ${stop.reason}`);
        return 0;
      }
    }
    const workflow = readGoalWorkflow(options.cwd, workflowId);
    if (!workflow) {
      console.error(`Goal workflow not found: ${workflowPath(options.cwd, workflowId)}`);
      writeLoopStatus(options.cwd, workflowId, 'Failed', 'Goal workflow not found.', { rounds });
      return 1;
    }
    const task = selectNextWorkflowTask(workflow);
    const blockingReason = workflowBlockingReason(workflow);
    if (blockingReason) {
      const recovery = prepareLoopBlockerRecovery(options.cwd, workflowId);
      if (recovery.prepared) {
        writeLoopStatus(options.cwd, workflowId, 'Preparing', `Loop auto-recovery queued: ${recovery.message}`, {
          rounds,
          recoveryTaskId: recovery.recoveryTaskId,
          blockedTaskId: recovery.blockedTaskId,
          blockingReason: recovery.blockingReason
        });
        console.log(`Loop auto-recovery queued: ${recovery.message}`);
        continue;
      }
      writeLoopStatus(options.cwd, workflowId, 'Blocked', `Workflow blocked: ${blockingReason}`, { rounds });
      console.error(`Selvedge workflow blocked: ${blockingReason}`);
      return 1;
    }
    const configuredStop = evaluateStopCondition(stopCondition, {
      startedAtMs: loopStartedAtMs,
      elapsedBaseMs: stopConditionElapsedBaseMs(stopCondition, loopStartedAtMs),
      rounds,
      hasPendingTask: Boolean(task),
      hasBlockingTask: Boolean(blockingReason),
      readyForHumanReview: workflowReadyForHumanReview(workflow),
      latestLoopStatus: readStatusJson(localStatePath(options.cwd, 'status', `${workflowId}.loop-status.json`))
    });
    if (configuredStop.stop) {
      writeLoopStatus(options.cwd, workflowId, 'Stopped', configuredStop.reason, {
        rounds,
        stopConditionFile,
        stopCondition: stopConditionStatusDetails(stopCondition)
      });
      console.log(`Selvedge loop stopped: ${configuredStop.reason}`);
      return 0;
    }
    if (!task) {
      if (exitOnNoWork) {
        writeLoopStatus(options.cwd, workflowId, 'Idle', 'No pending runnable task remains.', { rounds });
        console.log(`No pending runnable task remains for workflow ${workflowId}.`);
        return 0;
      }
      const continuation = createContinuousWorkflowContinuationForDashboardStart(
        options.cwd,
        workflow,
        buildReadOnlyModel(options.cwd)
      );
      if (continuation) {
        const previousWorkflowId = workflowId;
        workflowId = continuation.id;
        updateDashboardRunControlActiveGoal(options.cwd, previousWorkflowId, workflowId);
        writeLoopStatus(
          options.cwd,
          workflowId,
          'Started',
          `Continuous planner switched from ${previousWorkflowId} to ${workflowId}.`,
          {
            rounds,
            previousWorkflowId,
            stopConditionFile,
            stopCondition: stopConditionStatusDetails(stopCondition)
          }
        );
        console.log(`Continuous planner created or selected next workflow ${workflowId}.`);
        continue;
      }
      if (realMerchantTerminalComplete(options.cwd, workflow)) {
        writeLoopStatus(options.cwd, workflowId, 'Completed', 'Real merchant chain complete. No downstream workflow remains.', { rounds });
        console.log(`Real merchant chain complete for workflow ${workflowId}.`);
        return 0;
      }
      writeLoopStatus(options.cwd, workflowId, 'Idle', 'No pending runnable task remains.', { rounds });
      console.log(`No pending runnable task remains for workflow ${workflowId}.`);
      sleepSeconds(noWorkIdleSeconds);
      continue;
    }
    const gitGate = preflightCleanWorktree(options.cwd, workflow, task);
    if (!gitGate.ok) {
      const blockedWorkflow = setWorkflowTaskStatus(
        workflow,
        task.id,
        'Blocked',
        `${gitGate.message} ${gitGate.details.join(' | ')}`
      );
      saveGoalWorkflow(options.cwd, blockedWorkflow);
      writeWorkflowRunStatus(options.cwd, blockedWorkflow, `Git Gate blocked ${task.id}: ${gitGate.message}`);
      const recovery = prepareLoopBlockerRecovery(options.cwd, workflowId);
      if (recovery.prepared) {
        writeLoopStatus(options.cwd, workflowId, 'Preparing', `Loop auto-recovery queued: ${recovery.message}`, {
          rounds,
          taskId: task.id,
          gate: 'Git Gate',
          details: gitGate.details,
          recoveryTaskId: recovery.recoveryTaskId,
          blockedTaskId: recovery.blockedTaskId
        });
        console.log(`Loop auto-recovery queued: ${recovery.message}`);
        continue;
      }
      writeLoopStatus(options.cwd, workflowId, 'Blocked', gitGate.message, {
        rounds,
        taskId: task.id,
        gate: 'Git Gate',
        details: gitGate.details
      });
      console.error(gitGate.message);
      for (const detail of gitGate.details) {
        console.error(detail);
      }
      return 1;
    }
    rounds += 1;
    const heartbeatContext = ensureHeartbeatContext(options.cwd, workflow, task, 'before-task-start-refresh');
    writeLoopStatus(options.cwd, workflowId, 'Running', `准备启动 ${task.id}。`, {
      rounds,
      heartbeatContextPath: heartbeatContext.path,
      ...workflowTaskStatusDetails(workflow, task, heartbeatContext.context)
    });
    const exitCode = await runNextWorkflow({
      ...options,
      args: loopArgsForWorkflow(options.args, workflowId)
    });
    if (exitCode !== 0) {
      const recovery = prepareLoopBlockerRecovery(options.cwd, workflowId);
      if (recovery.prepared) {
        writeLoopStatus(options.cwd, workflowId, 'Preparing', `Loop auto-recovery queued after round failure: ${recovery.message}`, {
          rounds,
          taskId: task.id,
          exitCode,
          recoveryTaskId: recovery.recoveryTaskId,
          blockedTaskId: recovery.blockedTaskId,
          blockingReason: recovery.blockingReason
        });
        console.log(`Loop auto-recovery queued after round failure: ${recovery.message}`);
        continue;
      }
      writeLoopStatus(options.cwd, workflowId, 'Failed', `Round failed with exit code ${exitCode}.`, { rounds, taskId: task.id });
      return exitCode;
    }
    if (autoPush) {
      const latestWorkflowForPush = readGoalWorkflow(options.cwd, workflowId) ?? workflow;
      const latestTaskForPush = latestWorkflowForPush.tasks.find((item) => item.id === task.id) ?? task;
      const push = autoPushIfClean(options.cwd, latestWorkflowForPush, latestTaskForPush);
      writeLoopStatus(options.cwd, workflowId, push.ok ? 'Pushed' : 'Failed', push.message, {
        rounds,
        taskId: task.id,
        branch: push.branch,
        details: push.details
      });
      if (!push.ok) {
        const blockedWorkflow = setWorkflowTaskStatus(
          latestWorkflowForPush,
          task.id,
          'Blocked',
          `${push.message} ${push.details.join(' | ')}`
        );
        saveGoalWorkflow(options.cwd, blockedWorkflow);
        writeWorkflowRunStatus(options.cwd, blockedWorkflow, `Auto-push blocked ${task.id}: ${push.message}`);
        const recovery = prepareLoopBlockerRecovery(options.cwd, workflowId);
        if (recovery.prepared) {
          writeLoopStatus(options.cwd, workflowId, 'Preparing', `Loop auto-recovery queued after auto-push failure: ${recovery.message}`, {
            rounds,
            taskId: task.id,
            branch: push.branch,
            details: push.details,
            recoveryTaskId: recovery.recoveryTaskId,
            blockedTaskId: recovery.blockedTaskId,
            blockingReason: recovery.blockingReason
          });
          console.log(`Loop auto-recovery queued after auto-push failure: ${recovery.message}`);
          continue;
        }
        console.error(push.message);
        for (const detail of push.details) {
          console.error(detail);
        }
        return 1;
      }
    }
    sleepSeconds(sleepBetweenRounds);
  }
  writeLoopStatus(options.cwd, workflowId, 'Stopped', 'Max rounds reached.', { rounds });
  console.log(`Selvedge loop stopped after ${rounds} round(s).`);
  return 0;
}

export async function runRun(options: CliOptions): Promise<number> {
  if (options.args[0] === 'next') {
    return runNextWorkflow({
      ...options,
      args: options.args.slice(1)
    });
  }
  if (options.args[0] === 'loop') {
    return runLoop({
      ...options,
      args: options.args.slice(1)
    });
  }
  const planPath = resolvePlanPath(options.cwd, options.args);
  if (!planPath) {
    console.error('Usage: selvedge run --plan <plan-id-or-path> [--task <task-id>] [--dry-run|--execute]');
    return 1;
  }
  if (!existsSync(planPath)) {
    console.error(`Plan not found: ${planPath}`);
    return 1;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as SelvedgePlan;
  const execute = options.args.includes('--execute');
  const dryRun = options.args.includes('--dry-run') || !execute;
  const selectedTask = selectTask(plan, options.args, execute);
  const explicitTaskId = optionValue(options.args, '--task');
  if (!selectedTask) {
    console.error(explicitTaskId ? `Task not found in plan: ${explicitTaskId}` : `Plan has no tasks: ${plan.id}`);
    return 1;
  }
  if (execute && selectedTask.runner === 'shell') {
    return runShellTask(options, plan, selectedTask);
  }
  const runRecord = {
    planId: plan.id,
    startedAt: new Date().toISOString(),
    dryRun,
    selectedTask: selectedTask.id,
    runner: selectedTask.runner,
    status: dryRun ? 'ReadyDryRun' : 'NeedsRunnerAdapter',
    note: dryRun
      ? 'Dry-run selected a task and wrote local status without executing a runner.'
      : 'Execution adapters are not enabled in this MVP slice; runner execution must be implemented before --execute can run.'
  };
  writeJson(localStatePath(options.cwd, 'status', `${plan.id}.${selectedTask.id}.run.json`), runRecord);
  console.log(`${dryRun ? 'Dry-run ready' : 'Runner adapter missing'} for plan ${plan.id}.`);
  console.log(`Selected task: ${selectedTask.id}`);
  console.log(`Status: ${join('.selvedge', 'status', `${plan.id}.${selectedTask.id}.run.json`)}`);
  return dryRun ? 0 : 1;
}

export function runGoal(options: CliOptions): number {
  const subcommand = options.args[0] ?? 'status';
  if (subcommand !== 'status') {
    console.error('Usage: selvedge goal status --id <goal-id>');
    return 1;
  }
  const workflowId = resolveGoalId(options.args.slice(1));
  const workflow = readGoalWorkflow(options.cwd, workflowId);
  if (!workflow) {
    console.error(`Goal workflow not found: ${workflowPath(options.cwd, workflowId)}`);
    return 1;
  }
  console.log(`Goal: ${workflow.id}`);
  console.log(`Total goal: ${workflow.target}`);
  console.log(`Title: ${workflow.title}`);
  console.log(`Mode: ${workflow.mode}`);
  console.log(`Profile: ${workflow.profile.id} / ${workflow.profile.title}`);
  console.log(`Progress: ${workflow.tasks.filter((task) => task.status === 'Completed').length}/${workflow.tasks.length} completed`);
  console.log('Tasks:');
  for (const task of workflow.tasks) {
    const details = workflowTaskStatusDetails(workflow, task);
    console.log(
      `${task.status.padEnd(16)} ${String(details.phaseLabel).padEnd(24)} ${String(details.taskProgress).padEnd(5)} ${details.taskDisplayName} (${task.id})`
    );
  }
  return 0;
}

let dashboardRunChild: ChildProcess | null = null;
let dashboardShutdownHandled = false;

interface DashboardTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly displayName: string;
  readonly description: string;
  readonly detailText: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly phaseLabel: string;
  readonly taskProgress: string;
  readonly runner: string;
  readonly runnerLabel: string;
  readonly role: string;
  readonly roleLabel: string;
  readonly roadmapNode: string;
  readonly roadmapLabel: string;
  readonly isCurrent: boolean;
}

interface DashboardGoalSummary {
  readonly id: string;
  readonly title: string;
  readonly totalGoal: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly mode: string;
  readonly completed: number;
  readonly total: number;
  readonly blocked: number;
  readonly nextTask: string;
  readonly nextPhase: string;
  readonly migrationTarget: string | null;
  readonly needsUserQuestions: number;
  readonly nextQuestionId: string | null;
  readonly nextQuestion: string | null;
  readonly nextQuestionOptions: readonly SelvedgeRequirementQuestionOption[];
  readonly loopStatus: string | null;
  readonly loopMessage: string | null;
  readonly blockingReason: string | null;
  readonly currentTask: DashboardTaskSummary | null;
  readonly tasks: readonly DashboardTaskSummary[];
  readonly canQuickRun: boolean;
  readonly architectureStatus: string | null;
  readonly architectureSummary: string | null;
  readonly architectureConfirmationRequired: boolean;
  readonly architectureStack: readonly string[];
  readonly architectureStructure: readonly string[];
  readonly architectureInitPlan: readonly string[];
  readonly architectureRisks: readonly string[];
}

interface DashboardTaskPresentation {
  readonly name: string;
  readonly description: string;
}

const DASHBOARD_TASK_PRESENTATION_RULES: ReadonlyArray<[RegExp, DashboardTaskPresentation]> = [
  [/blocker-recovery/i, { name: '修复阻塞', description: '先处理上一次运行留下的阻塞或异常状态，恢复后再回到原任务。' }],
  [/(?:^|-)intake$/i, { name: '需求确认', description: '确认目标、范围、事实来源和本轮迁移对象。' }],
  [/micro-shell-profile-fit/i, { name: '迁移方式确认', description: '判断当前游戏应该复用现有壳层、扩展壳层，还是需要新壳层。' }],
  [/source-feature-inventory/i, { name: '源码功能盘点', description: '读取 KG 原始源码，盘点入口、事件、协议、玩法状态和可用功能。' }],
  [/functional-detail-ledger/i, { name: '功能细节对齐', description: '把源码功能拆成可验证的细节清单，明确哪些要实现、哪些不适用。' }],
  [/profile-config-foundation|slot-web-profile-config-foundation/i, { name: '配置基础', description: '建立本游戏需要的类型、壳层、奖控和配置解析基础。' }],
  [/backend-handler/i, { name: '后端玩法处理', description: '实现后端下注、开奖、风控、控奖和资金权威路径。' }],
  [/shell-(?:protocol|start|roominfo|room-info).*primitive/i, { name: '启动协议接入', description: '接入游戏启动、房间信息、上下文和前端协议字段。' }],
  [/result-(?:callback|mapper)|ingress-runtime/i, { name: '结果回调映射', description: '把后端结果转换成游戏源码期望的回调、动画和状态字段。' }],
  [/history-detail|room-state/i, { name: '历史和房间状态', description: '接入历史记录、详情、恢复、重连或房间状态相关能力。' }],
  [/route-context-integration/i, { name: '路由与页面接入', description: '把当前游戏正式接入 GameHub 路由、页面入口和运行上下文。' }],
  [/qa-self-test/i, { name: '自测验收', description: '按源码逻辑、接口和浏览器路径做开发后的自测验收。' }],
  [/independent-audit/i, { name: '独立复查', description: '重新对照源码和实现差异，确认没有阻塞级不一致。' }],
  [/handoff/i, { name: '交付说明', description: '记录完成状态、证据、已知问题、回滚方式和人工验收说明。' }],
  [/planning|task-decomposition/i, { name: '拆分任务', description: '把总目标拆成可恢复、可验证的小任务队列。' }],
  [/development/i, { name: '开发实现', description: '执行一个边界清晰的开发切片并留下验证证据。' }],
  [/(?:^|-)qa$/i, { name: '测试验收', description: '运行测试、回归和失败分类。' }]
];

function dashboardTaskPresentation(task: SelvedgeWorkflowTask): DashboardTaskPresentation {
  const searchableText = `${task.id} ${task.title} ${task.roadmapNode}`;
  const matched = DASHBOARD_TASK_PRESENTATION_RULES.find(([pattern]) => pattern.test(searchableText));
  if (matched) {
    return matched[1];
  }
  if (task.phase === 'intake') {
    return { name: '需求确认', description: '确认目标、范围和执行边界。' };
  }
  if (task.phase === 'planning') {
    return { name: '任务规划', description: '梳理事实来源、边界和后续最小任务。' };
  }
  if (task.phase === 'development') {
    return { name: '开发实现', description: '实现当前小任务并留下验证证据。' };
  }
  if (task.phase === 'qa') {
    return { name: '测试验收', description: '测试、复查并分类问题。' };
  }
  return { name: '交付说明', description: '整理交付状态和后续处理方式。' };
}

function dashboardStatusLabel(status: string): string {
  switch (status) {
    case 'Completed':
      return '已完成';
    case 'InProgress':
      return '执行中';
    case 'Pending':
      return '待执行';
    case 'Failed':
      return '失败';
    case 'Blocked':
      return '已阻塞';
    case 'NeedsHumanInput':
      return '需人工确认';
    case 'NeedsRunner':
      return '需执行器';
    default:
      return status;
  }
}

function dashboardPhaseLabel(phase: string, fallback: string): string {
  switch (phase) {
    case 'intake':
      return '需求确认';
    case 'planning':
      return '规划 / 盘点';
    case 'development':
      return '开发实现';
    case 'qa':
      return 'QA 验收 / 复查';
    case 'handoff':
      return '交付说明';
    default:
      return fallback;
  }
}

function dashboardRunnerLabel(runner: string): string {
  switch (runner) {
    case 'builtin:intake-doc':
      return '内置需求记录';
    case 'builtin:task-decomposition':
      return '内置任务拆分';
    case 'builtin:handoff':
      return '内置交付记录';
    case 'codex-app-agent':
      return 'Codex 自动执行';
    case 'codex-cli':
      return 'Codex CLI';
    case 'shell':
      return '本地命令';
    default:
      return runner;
  }
}

function dashboardRoleLabel(role: string): string {
  switch (role) {
    case 'selvedge-ai-intake-lead':
      return '需求澄清';
    case 'selvedge-planner':
      return '任务规划';
    case 'selvedge-dev-runner':
      return '开发执行';
    case 'selvedge-qa-lead':
      return '测试负责人';
    case 'selvedge-handoff-lead':
      return '交付整理';
    case 'selvedge-blocker-recovery-lead':
      return '阻塞恢复';
    case 'kg-micro-shell-architect':
      return 'KG 迁移架构';
    case 'kg-micro-shell-implementer':
      return 'KG 迁移开发';
    case 'kg-micro-shell-qa-reviewer':
      return 'KG 自测验收';
    case 'kg-micro-shell-independent-auditor':
      return 'KG 独立复查';
    case 'selvedge-control-plane':
      return 'Selvedge 控制面';
    case 'selvedge-task-lead':
      return '任务负责人';
    default:
      return role;
  }
}

function dashboardRoadmapLabel(roadmapNode: string): string {
  const lower = roadmapNode.toLowerCase();
  if (lower.includes('intake')) return '需求确认';
  if (lower.includes('profile fit')) return '迁移方式确认';
  if (lower.includes('source feature')) return '源码功能盘点';
  if (lower.includes('functional-detail')) return '功能细节对齐';
  if (lower.includes('profile config foundation') || lower.includes('config foundation')) return '配置基础';
  if (lower.includes('backend handler')) return '后端玩法处理';
  if (lower.includes('shell') && (lower.includes('protocol') || lower.includes('start') || lower.includes('room'))) return '启动协议接入';
  if (lower.includes('result') || lower.includes('callback') || lower.includes('ingress')) return '结果回调映射';
  if (lower.includes('history') || lower.includes('room-state')) return '历史和房间状态';
  if (lower.includes('route') || lower.includes('context')) return '路由与页面接入';
  if (lower.includes('browser self-test') || lower.includes('source logic')) return '自测验收';
  if (lower.includes('independent audit')) return '独立复查';
  if (lower.includes('handoff')) return '交付说明';
  if (lower.includes('development')) return '开发实现';
  if (lower.includes('qa')) return '测试验收';
  return roadmapNode;
}

function dashboardTaskDetailText(task: SelvedgeWorkflowTask, presentation: DashboardTaskPresentation, phaseLabel: string): string {
  return [
    `任务：${presentation.name}`,
    `说明：${presentation.description}`,
    `状态：${dashboardStatusLabel(task.status)}`,
    `阶段：${phaseLabel}`,
    `执行器：${dashboardRunnerLabel(task.runner)} (${task.runner})`,
    `角色：${dashboardRoleLabel(task.role)} (${task.role})`,
    `路线：${dashboardRoadmapLabel(task.roadmapNode)} (${task.roadmapNode})`,
    `任务ID：${task.id}`,
    `原始标题：${task.title}`
  ].join('\n');
}

function listGoalSummaries(cwd: string): DashboardGoalSummary[] {
  const goalsRoot = localStatePath(cwd, 'goals');
  if (!existsSync(goalsRoot)) {
    return [];
  }
  const result: DashboardGoalSummary[] = [];
  for (const entry of readdirSync(goalsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workflow = readGoalWorkflow(cwd, entry.name);
    if (!workflow) {
      continue;
    }
    if (!workflow.profile || !Array.isArray(workflow.tasks)) {
      const loopStatus = readStatusJson(localStatePath(cwd, 'status', `${entry.name}.loop-status.json`));
      result.push({
        id: entry.name,
        title: workflow.title ?? entry.name,
        totalGoal: workflow.target ?? workflow.title ?? entry.name,
        profileId: 'legacy-or-invalid',
        createdAt: workflow.createdAt ?? '',
        mode: workflow.mode ?? 'unknown',
        completed: 0,
        total: Array.isArray(workflow.tasks) ? workflow.tasks.length : 0,
        blocked: 1,
        nextTask: 'Legacy workflow schema needs migration before dashboard execution.',
        nextPhase: 'Needs recovery',
        migrationTarget: null,
        needsUserQuestions: 0,
        nextQuestionId: null,
        nextQuestion: null,
        nextQuestionOptions: [],
        loopStatus: typeof loopStatus?.status === 'string' ? loopStatus.status : null,
        loopMessage: typeof loopStatus?.message === 'string' ? loopStatus.message : null,
        blockingReason: 'Legacy workflow schema needs migration before dashboard execution.',
        currentTask: null,
        tasks: [],
        canQuickRun: false,
        architectureStatus: null,
        architectureSummary: null,
        architectureConfirmationRequired: false,
        architectureStack: [],
        architectureStructure: [],
        architectureInitPlan: [],
        architectureRisks: []
      });
      continue;
    }
    const nextTask = selectNextWorkflowTask(workflow);
    const nextQuestion = workflow.aiIntake.questions.find((question) => question.status === 'needs-user') ?? null;
    const context = nextTask ? buildHeartbeatContext(cwd, workflow, nextTask, 'before-task-start-refresh') : null;
    const loopStatus = readStatusJson(localStatePath(cwd, 'status', `${workflow.id}.loop-status.json`));
    const activeTaskId =
      typeof loopStatus?.taskId === 'string'
        ? loopStatus.taskId
        : workflow.tasks.find((task) => task.status === 'InProgress')?.id ??
          nextTask?.id ??
          workflow.tasks.find((task) => ['Failed', 'Blocked', 'NeedsHumanInput', 'NeedsRunner'].includes(task.status))?.id ??
          null;
    const taskSummaries = workflow.tasks.map((task): DashboardTaskSummary => {
      const details = workflowTaskStatusDetails(workflow, task);
      const presentation = dashboardTaskPresentation(task);
      const phaseLabel = dashboardPhaseLabel(task.phase, String(details.phaseLabel));
      return {
        id: task.id,
        title: task.title,
        displayName: presentation.name,
        description: presentation.description,
        detailText: dashboardTaskDetailText(task, presentation, phaseLabel),
        status: task.status,
        statusLabel: dashboardStatusLabel(task.status),
        phaseLabel,
        taskProgress: String(details.taskProgress),
        runner: task.runner,
        runnerLabel: dashboardRunnerLabel(task.runner),
        role: task.role,
        roleLabel: dashboardRoleLabel(task.role),
        roadmapNode: task.roadmapNode,
        roadmapLabel: dashboardRoadmapLabel(task.roadmapNode),
        isCurrent: task.id === activeTaskId
      };
    });
    const currentTask = taskSummaries.find((task) => task.isCurrent) ?? null;
    const nextTaskSummary = nextTask ? taskSummaries.find((task) => task.id === nextTask.id) ?? null : null;
    const blockingReason = workflowBlockingReason(workflow);
    const completed = workflow.tasks.filter((task) => task.status === 'Completed').length;
    const total = workflow.tasks.length;
    const blocked = workflow.tasks.filter((task) => ['Failed', 'Blocked', 'NeedsHumanInput', 'NeedsRunner'].includes(task.status)).length;
    const completedHistory = total > 0 && completed >= total && blocked === 0 && !nextTask;
    result.push({
      id: workflow.id,
      title: workflow.title,
      totalGoal: workflow.target,
      profileId: workflow.profile.id,
      createdAt: workflow.createdAt,
      mode: workflow.mode,
      completed,
      total,
      blocked,
      nextTask: nextTaskSummary ? `${nextTaskSummary.taskProgress} ${nextTaskSummary.displayName}` : 'No pending task',
      nextPhase: nextTaskSummary ? nextTaskSummary.phaseLabel : 'Complete',
      migrationTarget: context?.migrationTarget ?? null,
      needsUserQuestions: workflow.aiIntake.questions.filter((question) => question.status === 'needs-user').length,
      nextQuestionId: nextQuestion?.id ?? null,
      nextQuestion: nextQuestion?.question ?? null,
      nextQuestionOptions: nextQuestion?.options ?? [],
      loopStatus: typeof loopStatus?.status === 'string' ? loopStatus.status : null,
      loopMessage: typeof loopStatus?.message === 'string' ? loopStatus.message : null,
      blockingReason,
      currentTask,
      tasks: taskSummaries,
      canQuickRun: !completedHistory &&
        !workflow.aiIntake.userDialogueRequired &&
        workflow.architecture?.status !== 'pending-confirmation' &&
        Boolean(workflow.profile && Array.isArray(workflow.tasks)),
      architectureStatus: workflow.architecture?.status ?? null,
      architectureSummary: workflow.architecture?.summary ?? null,
      architectureConfirmationRequired: workflow.architecture?.status === 'pending-confirmation',
      architectureStack: workflow.architecture?.recommendedStack ?? [],
      architectureStructure: workflow.architecture?.projectStructure ?? [],
      architectureInitPlan: workflow.architecture?.initializationPlan ?? [],
      architectureRisks: workflow.architecture?.risks ?? []
    });
  }
  return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function readStatusJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

type DashboardLocale = 'zh' | 'en';
type DashboardRuntimeTextKey =
  | 'saveStopCondition'
  | 'clearStopCondition'
  | 'stopConditionHint'
  | 'stopConditionSaved'
  | 'stopConditionCleared';

interface DashboardCopy {
  readonly htmlLang: string;
  readonly pageTitle: string;
  readonly subtitle: string;
  readonly languageLabel: string;
  readonly chinese: string;
  readonly english: string;
  readonly runState: string;
  readonly stopCondition: string;
  readonly noActiveStopCondition: string;
  readonly goalsMetric: string;
  readonly stopAgentMetric: string;
  readonly canStartMetric: string;
  readonly aiQaMetric: string;
  readonly activeWorkflow: string;
  readonly serialQueueNotice: string;
  readonly projectObjective: string;
  readonly projectObjectiveHint: string;
  readonly projectObjectiveSaved: string;
  readonly projectObjectiveBlocked: string;
  readonly projectObjectiveViewHint: string;
  readonly projectObjectiveEmpty: string;
  readonly editProjectObjective: string;
  readonly cancelProjectObjectiveEdit: string;
  readonly architectureProposal: string;
  readonly architectureProposalHint: string;
  readonly architectureNotRequired: string;
  readonly architectureStack: string;
  readonly architectureStructure: string;
  readonly architectureInitPlan: string;
  readonly architectureRisks: string;
  readonly confirmArchitecture: string;
  readonly architectureStartBlocked: string;
  readonly monorepoScopesLabel: string;
  readonly monorepoScopesPlaceholder: string;
  readonly authoritySourcesLabel: string;
  readonly authoritySourcesPlaceholder: string;
  readonly stopExpectationsLabel: string;
  readonly stopExpectationsPlaceholder: string;
  readonly saveProjectObjective: string;
  readonly objectiveReview: string;
  readonly totalGoalSection: string;
  readonly currentTaskSection: string;
  readonly noCurrentTask: string;
  readonly taskQueue: string;
  readonly taskDetails: string;
  readonly taskDescriptionLabel: string;
  readonly runnerLabel: string;
  readonly roleLabel: string;
  readonly roadmapLabel: string;
  readonly workflowSummary: string;
  readonly createGoal: string;
  readonly totalGoalLabel: string;
  readonly totalGoalPlaceholder: string;
  readonly workstreamLabel: string;
  readonly workstreamPlaceholder: string;
  readonly writeSetLabel: string;
  readonly writeSetPlaceholder: string;
  readonly validationLabel: string;
  readonly validationPlaceholder: string;
  readonly notesLabel: string;
  readonly notesPlaceholder: string;
  readonly createGoalButton: string;
  readonly aiGuidanceNotice: string;
  readonly guidedIntake: string;
  readonly noPendingIntake: string;
  readonly answerPlaceholder: string;
  readonly chooseAnswerOption: string;
  readonly answerSelectionHint: string;
  readonly answerDetailsLabel: string;
  readonly answerDetailsPlaceholder: string;
  readonly saveAnswer: string;
  readonly questionsRemaining: string;
  readonly startStop: string;
  readonly goalLabel: string;
  readonly noGoalWorkflowYet: string;
  readonly noStartableGoalWorkflow: string;
  readonly continuationGoalLabel: string;
  readonly continuationGoalPlaceholder: string;
  readonly continuationGoalHint: string;
  readonly stopConditionBeforeStart: string;
  readonly stopConditionPlaceholder: string;
  readonly startContinue: string;
  readonly runContinuous: string;
  readonly runningButton: string;
  readonly blockedButton: string;
  readonly recoverAndRunButton: string;
  readonly startBlockedMessage: string;
  readonly safeStop: string;
  readonly forceStop: string;
  readonly latestHeartbeat: string;
  readonly heartbeatWording: string;
  readonly heartbeatPreferenceLabel: string;
  readonly heartbeatPreferenceDefault: string;
  readonly normalizedFields: string;
  readonly saveHeartbeatPreference: string;
  readonly goalWorkflows: string;
  readonly noGoalRows: string;
  readonly idHeader: string;
  readonly goalHeader: string;
  readonly progressHeader: string;
  readonly intakeHeader: string;
  readonly nextStepHeader: string;
  readonly targetHeader: string;
  readonly loopHeader: string;
  readonly quickRunHeader: string;
  readonly needsAnswers: string;
  readonly ready: string;
  readonly blocked: string;
  readonly technicalState: string;
  readonly statusLabel: string;
  readonly totalGoalHeartbeat: string;
  readonly phaseHeartbeat: string;
  readonly taskHeartbeat: string;
  readonly currentActionHeartbeat: string;
  readonly elapsedHeartbeat: string;
  readonly idleHeartbeat: string;
  readonly migrationTargetHeartbeat: string;
  readonly logHeartbeat: string;
  readonly updatedHeartbeat: string;
  readonly noHeartbeat: string;
  readonly defaultStoppedMessage: string;
  readonly defaultReadyMessage: string;
  readonly confirmSafeStop1: string;
  readonly confirmSafeStop2: string;
  readonly confirmForceStop1: string;
  readonly confirmForceStop2: string;
  readonly confirmForceStop3: string;
  readonly loadingButton: string;
  readonly liveConnecting: string;
  readonly liveConnected: string;
  readonly liveReconnecting: string;
  readonly lastUpdatedPrefix: string;
}

const DASHBOARD_COPY: Record<DashboardLocale, DashboardCopy> = {
  zh: {
    htmlLang: 'zh-CN',
    projectObjectiveViewHint: '已保存的项目总目标默认只读展示；点击编辑后才能修改，保存时会再次由 AI 审查。',
    projectObjectiveEmpty: '还没有项目总目标，请先填写并保存。',
    editProjectObjective: '编辑总目标',
    cancelProjectObjectiveEdit: '取消编辑',
    pageTitle: 'Selvedge 控制台',
    subtitle: '从终端启动控制台；目标录入、需求引导、启动、停机、心跳文案和状态都在这里完成。终端只作为给人工看的实时心跳窗口。',
    languageLabel: '语言',
    chinese: '中文',
    english: 'English',
    runState: '运行状态',
    stopCondition: '停机条件',
    noActiveStopCondition: '当前没有额外停机条件。除 STOP_AGENT、需要人工决策或不可恢复错误外，将持续运行；可恢复问题会自动排修复任务。',
    goalsMetric: '目标',
    stopAgentMetric: 'STOP_AGENT',
    canStartMetric: '可启动',
    aiQaMetric: 'AI-QA 开关',
    activeWorkflow: '当前工作流',
    serialQueueNotice: '串行队列：同一时间只执行一个细分任务。',
    projectObjective: '项目总目标',
    projectObjectiveHint: '一个 Selvedge 项目只保留一个总目标；monorepo 用作用域拆分到 apps、packages 或 workstream，不创建多个根目标。保存后会先由 AI 审查是否存在逻辑冲突；无冲突才覆盖正式目标。',
    projectObjectiveSaved: '项目总目标已通过 AI 审查并保存。',
    projectObjectiveBlocked: '项目总目标未覆盖正式版本。AI 审查发现冲突，或模型审查不可用；请按建议修改后再次保存。',
    architectureProposal: '技术架构方案',
    architectureProposalHint: '新项目初始化前，Selvedge 会先用 AI 给出技术栈、结构和理由；用户确认后才允许初始化项目结构。',
    architectureNotRequired: '当前 workflow 不需要新项目技术架构确认。',
    architectureStack: '建议技术栈',
    architectureStructure: '建议项目结构',
    architectureInitPlan: '初始化步骤',
    architectureRisks: '风险 / 注意事项',
    confirmArchitecture: '确认技术架构方案',
    architectureStartBlocked: '技术架构方案还未确认，不能启动执行。',
    monorepoScopesLabel: 'Monorepo 作用域',
    monorepoScopesPlaceholder: '每行一个作用域。示例：apps/kg-micro-shell|KG 微壳|kg-micro-shell',
    authoritySourcesLabel: '权威事实源',
    authoritySourcesPlaceholder: '每行一个事实源、文档、源码目录、API 或运行证据。',
    stopExpectationsLabel: '停机 / 人工接手期望',
    stopExpectationsPlaceholder: '例如：完成一个独立功能模块到人工验收阶段后停机；遇到事实源冲突先停机。',
    saveProjectObjective: '保存并让 AI 审查',
    objectiveReview: '最近一次目标审查',
    totalGoalSection: '总目标',
    currentTaskSection: '当前细分任务',
    noCurrentTask: '当前没有正在执行或等待执行的细分任务。',
    taskQueue: '细分任务队列',
    taskDetails: '当前任务详情',
    taskDescriptionLabel: '说明',
    runnerLabel: '执行器',
    roleLabel: '角色',
    roadmapLabel: '路线节点',
    workflowSummary: '工作流总览',
    createGoal: '创建目标',
    totalGoalLabel: '希望 Selvedge 完成什么？',
    totalGoalPlaceholder: '描述总目标。Selvedge 会生成目标、需求、任务队列、QA 和交付文档。',
    workstreamLabel: '工作流',
    workstreamPlaceholder: '可选。例如：kg-micro-shell、docs-governance、platform-backend-core',
    writeSetLabel: '允许写入范围',
    writeSetPlaceholder: '可选。每行一个路径或区域。留空则由 Selvedge 在需求引导中继续询问。',
    validationLabel: '如何证明工作完成？',
    validationPlaceholder: '可选。每行一个验证命令或证据要求。',
    notesLabel: '在继续追问前，Selvedge 还需要知道什么？',
    notesPlaceholder: '可选。上下文、权威事实源、已知限制或验收说明。',
    createGoalButton: '创建目标并开始需求引导',
    aiGuidanceNotice: '只需要写想法或目标，不需要一次说清楚。Selvedge 会通过 AI 继续提问、给出可选意见，并把你的回答沉淀成需求；这些意见只是参考，你随时可以直接输入自己的答案。',
    guidedIntake: '需求引导',
    noPendingIntake: '当前没有待回答的需求问题。可以创建目标，或启动已经准备好的目标。',
    answerPlaceholder: '用自然语言回答这个问题。Selvedge 会把答案写入需求文档。',
    chooseAnswerOption: '选择一个最接近的答案',
    answerSelectionHint: '这些只是 AI 给出的意见。可以只选一个答案，也可以写补充说明；如果选项都不合适，只写你自己的答案也可以。',
    answerDetailsLabel: '补充说明',
    answerDetailsPlaceholder: '如果上面的答案不够准确，在这里补充你的真实要求、限制或验收标准。',
    saveAnswer: '保存回答',
    questionsRemaining: '个问题待回答',
    startStop: '启动 / 停机',
    goalLabel: '目标',
    noGoalWorkflowYet: '还没有目标工作流',
    noStartableGoalWorkflow: '没有可启动目标；请先创建新目标',
    continuationGoalLabel: '下一轮目标（可选）',
    continuationGoalPlaceholder: '可留空。当前 workflow 完成时，留空表示由 Selvedge 总控自动选择下一款 KG slots；也可以输入明确的新目标或 gameCode。',
    continuationGoalHint: '只有所选 workflow 已全部完成且没有 Pending 任务时才会创建下一轮 workflow；未完成的 workflow 会继续原队列。',
    stopConditionBeforeStart: '启动前停机条件',
    stopConditionPlaceholder: '留空就是长期持续运行。示例：跑 6 小时后停；跑 3 轮后停；到 07:30 停；队列完成后停；30 分钟没有输出就停。',
    startContinue: '启动 / 继续',
    runContinuous: '持续运行',
    runningButton: '运行中',
    blockedButton: '已阻塞',
    recoverAndRunButton: '处理 blocker 并继续',
    startBlockedMessage: '当前目标存在 blocker。点击启动后，Selvedge 会先排入并执行恢复任务，修复到可继续状态后再回到原任务队列；如果需要人工决策，会停下并说明原因。',
    safeStop: '安全停机',
    forceStop: '强制停机',
    latestHeartbeat: '最新心跳',
    heartbeatWording: '心跳文案',
    heartbeatPreferenceLabel: '你想在心跳块里看到什么？',
    heartbeatPreferenceDefault: '显示当前迁移目标、进度、当前阶段、当前任务和必要诊断信息。',
    normalizedFields: '已规范化的可选字段',
    saveHeartbeatPreference: '保存心跳偏好',
    goalWorkflows: '目标工作流',
    noGoalRows: '还没有目标工作流。先在上方创建一个目标。',
    idHeader: 'ID',
    goalHeader: '目标',
    progressHeader: '进度',
    intakeHeader: '需求',
    nextStepHeader: '下一步',
    targetHeader: '对象',
    loopHeader: '循环',
    quickRunHeader: '快捷启动',
    needsAnswers: '还需回答',
    ready: '可启动',
    blocked: '阻塞',
    technicalState: '技术状态',
    statusLabel: '状态',
    totalGoalHeartbeat: '总目标',
    phaseHeartbeat: '阶段',
    taskHeartbeat: '任务',
    currentActionHeartbeat: '当前动作',
    elapsedHeartbeat: '用时',
    idleHeartbeat: '静默',
    migrationTargetHeartbeat: '迁移目标',
    logHeartbeat: '日志',
    updatedHeartbeat: '更新时间',
    noHeartbeat: '还没有写入心跳。',
    defaultStoppedMessage: '当前存在 STOP_AGENT。从控制台启动会为所选目标清理旧停机标记。',
    defaultReadyMessage: '创建或选择目标，按需完成需求回答，然后启动循环。',
    confirmSafeStop1: '确认安全停机？Selvedge 会写入 STOP_AGENT，并在下一个任务边界前停止。',
    confirmSafeStop2: '再次确认安全停机。当前任务可能会继续运行到安全边界。',
    confirmForceStop1: '强制停机只应在运行卡住时使用。继续吗？',
    confirmForceStop2: '第二次确认：强制停机可能留下需要恢复的部分状态。',
    confirmForceStop3: '第三次确认：现在强制停止 dashboard 启动的 runner？',
    loadingButton: '处理中...',
    liveConnecting: '实时更新：连接中',
    liveConnected: '实时更新：已连接',
    liveReconnecting: '实时更新：重连中',
    lastUpdatedPrefix: '更新'
  },
  en: {
    htmlLang: 'en',
    projectObjectiveViewHint: 'The saved project objective is read-only by default. Click edit to change it; saving will run AI review again.',
    projectObjectiveEmpty: 'No project objective exists yet. Fill it in and save it first.',
    editProjectObjective: 'Edit objective',
    cancelProjectObjectiveEdit: 'Cancel edit',
    pageTitle: 'Selvedge Dashboard',
    subtitle: 'Start the dashboard from a terminal. Use this page for goal intake, start, stop, heartbeat wording, and status. The terminal stays as the live heartbeat monitor.',
    languageLabel: 'Language',
    chinese: '中文',
    english: 'English',
    runState: 'Run state',
    stopCondition: 'Stop condition',
    noActiveStopCondition: 'No active operator stop condition. The run is continuous unless STOP_AGENT, human input, an unrecoverable blocker, or workflow policy stops it; recoverable failures become recovery tasks.',
    goalsMetric: 'Goals',
    stopAgentMetric: 'STOP_AGENT',
    canStartMetric: 'Can start',
    aiQaMetric: 'AI-QA switch',
    activeWorkflow: 'Active Workflow',
    serialQueueNotice: 'Serial queue: only one subtask runs at a time.',
    projectObjective: 'Project Objective',
    projectObjectiveHint: 'One Selvedge project keeps one root objective. Monorepos use scopes for apps, packages, or workstreams instead of multiple root goals. After save, AI reviews the draft for logical conflicts; only an accepted draft replaces the saved objective.',
    projectObjectiveSaved: 'Project objective passed AI review and was saved.',
    projectObjectiveBlocked: 'Project objective was not replaced. AI review found conflicts, or model review was unavailable. Edit and save again.',
    architectureProposal: 'Technical Architecture Proposal',
    architectureProposalHint: 'Before new project initialization, Selvedge asks AI to propose the stack, structure, and reasons. Execution can start only after user confirmation.',
    architectureNotRequired: 'This workflow does not require a new-project architecture confirmation.',
    architectureStack: 'Recommended stack',
    architectureStructure: 'Suggested project structure',
    architectureInitPlan: 'Initialization plan',
    architectureRisks: 'Risks / notes',
    confirmArchitecture: 'Confirm architecture proposal',
    architectureStartBlocked: 'The technical architecture proposal is not confirmed yet, so execution cannot start.',
    monorepoScopesLabel: 'Monorepo scopes',
    monorepoScopesPlaceholder: 'One scope per line. Example: apps/kg-micro-shell|KG micro shell|kg-micro-shell',
    authoritySourcesLabel: 'Authority sources',
    authoritySourcesPlaceholder: 'One source, document, source folder, API, or runtime evidence per line.',
    stopExpectationsLabel: 'Stop / handoff expectations',
    stopExpectationsPlaceholder: 'Example: stop when one independent feature module reaches human review readiness; stop on authority-source conflicts.',
    saveProjectObjective: 'Save and AI-review',
    objectiveReview: 'Latest objective review',
    totalGoalSection: 'Total Goal',
    currentTaskSection: 'Current Subtask',
    noCurrentTask: 'No subtask is currently running or ready to run.',
    taskQueue: 'Subtask Queue',
    taskDetails: 'Current task details',
    taskDescriptionLabel: 'Summary',
    runnerLabel: 'Runner',
    roleLabel: 'Role',
    roadmapLabel: 'Roadmap node',
    workflowSummary: 'Workflow Summary',
    createGoal: 'Create Goal',
    totalGoalLabel: 'What should Selvedge accomplish?',
    totalGoalPlaceholder: 'Describe the total goal. Selvedge will turn it into durable goal, requirements, task queue, QA, and handoff documents.',
    workstreamLabel: 'Workstream',
    workstreamPlaceholder: 'Optional. Example: kg-micro-shell, docs-governance, platform-backend-core',
    writeSetLabel: 'Allowed write areas',
    writeSetPlaceholder: 'Optional. One path or area per line. Leave blank if Selvedge should ask during intake.',
    validationLabel: 'How should Selvedge prove the work?',
    validationPlaceholder: 'Optional. One validation command or evidence requirement per line.',
    notesLabel: 'Anything Selvedge should know before asking follow-up questions?',
    notesPlaceholder: 'Optional context, authority sources, known limits, or acceptance notes.',
    createGoalButton: 'Create goal and start intake',
    aiGuidanceNotice: 'Write the idea or goal in your own words. Selvedge will use AI to ask follow-up questions, offer optional suggestions, and turn your answers into requirements. Suggestions are only suggestions; you can always type your own answer.',
    guidedIntake: 'Guided Intake',
    noPendingIntake: 'No pending intake question. Create a goal or start a ready goal.',
    answerPlaceholder: 'Answer this question in plain language. Selvedge will save it into the requirements document.',
    chooseAnswerOption: 'Choose the closest answer',
    answerSelectionHint: 'These are AI suggestions only. Choose one answer, add details, or write only your own answer if none of the options fits.',
    answerDetailsLabel: 'Extra details',
    answerDetailsPlaceholder: 'If the options are not precise enough, add your real requirement, constraint, or acceptance rule here.',
    saveAnswer: 'Save answer',
    questionsRemaining: 'question(s) remaining',
    startStop: 'Start / Stop',
    goalLabel: 'Goal',
    noGoalWorkflowYet: 'No goal workflow yet',
    noStartableGoalWorkflow: 'No startable goal; create a new goal first',
    continuationGoalLabel: 'Next goal (optional)',
    continuationGoalPlaceholder: 'Leave blank to let the Selvedge master controller choose the next KG slots target after a completed workflow. Or enter a new goal, target, route, or gameCode.',
    continuationGoalHint: 'A new workflow is created only when the selected workflow is fully complete and has no pending task. Incomplete workflows continue their existing queue.',
    stopConditionBeforeStart: 'Stop condition before start',
    stopConditionPlaceholder: 'Leave blank for a long continuous run. Examples: stop after 6 hours; stop after 3 rounds; stop at 07:30; stop when the queue is complete; stop if there is no output for 30 minutes.',
    startContinue: 'Start / Continue',
    runContinuous: 'Run continuous',
    runningButton: 'Running',
    blockedButton: 'Blocked',
    recoverAndRunButton: 'Repair blocker and continue',
    startBlockedMessage: 'The selected goal has a blocker. When you start, Selvedge will queue and run a recovery task first, then return to the original task queue. If human input is required, it will stop and explain what to do.',
    safeStop: 'Safe stop',
    forceStop: 'Force stop',
    latestHeartbeat: 'Latest Heartbeat',
    heartbeatWording: 'Heartbeat Wording',
    heartbeatPreferenceLabel: 'What do you want to see in heartbeat blocks?',
    heartbeatPreferenceDefault: 'Show the current migration target, progress, current phase, current task, and useful diagnostics.',
    normalizedFields: 'Normalized optional fields',
    saveHeartbeatPreference: 'Save heartbeat preference',
    goalWorkflows: 'Goal Workflows',
    noGoalRows: 'No goal workflows yet. Create one above.',
    idHeader: 'Id',
    goalHeader: 'Goal',
    progressHeader: 'Progress',
    intakeHeader: 'Intake',
    nextStepHeader: 'Next Step',
    targetHeader: 'Target',
    loopHeader: 'Loop',
    quickRunHeader: 'Quick Run',
    needsAnswers: 'Needs',
    ready: 'Ready',
    blocked: 'blocked',
    technicalState: 'Technical state',
    statusLabel: 'Status',
    totalGoalHeartbeat: 'Total goal',
    phaseHeartbeat: 'Phase',
    taskHeartbeat: 'Task',
    currentActionHeartbeat: 'Current action',
    elapsedHeartbeat: 'Elapsed',
    idleHeartbeat: 'Idle',
    migrationTargetHeartbeat: 'Migration target',
    logHeartbeat: 'Log',
    updatedHeartbeat: 'Updated',
    noHeartbeat: 'No heartbeat has been written yet.',
    defaultStoppedMessage: 'STOP_AGENT is present. Starting from the dashboard will clear the stale stop marker for the selected goal.',
    defaultReadyMessage: 'Create or select a goal, finish intake answers if needed, then start the loop.',
    confirmSafeStop1: 'Request a safe stop? Selvedge will write STOP_AGENT and stop before the next task.',
    confirmSafeStop2: 'Confirm safe stop. The current task may continue until it reaches a safe boundary.',
    confirmForceStop1: 'Force stop should be used only when the run is stuck. Continue?',
    confirmForceStop2: 'Second confirmation: force stop may leave partial state that requires recovery.',
    confirmForceStop3: 'Third confirmation: force stop the dashboard-started runner now?',
    loadingButton: 'Working...',
    liveConnecting: 'Live updates: connecting',
    liveConnected: 'Live updates: connected',
    liveReconnecting: 'Live updates: reconnecting',
    lastUpdatedPrefix: 'Updated'
  }
};

function dashboardCodexRunnerArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  const flagsWithValue = new Set([
    '--codex-executable',
    '--model',
    '--service-tier',
    '--reasoning-effort',
    '--timeout-ms',
    '--heartbeat-seconds'
  ]);
  const standaloneFlags = new Set([
    '--codex-json',
    '--show-codex-output',
    '--skip-codex-config-guard',
    '--use-user-config'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValue.has(arg)) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) {
        result.push(arg, value);
        index += 1;
      }
      continue;
    }
    if (standaloneFlags.has(arg)) {
      result.push(arg);
    }
  }
  return result;
}

function dashboardThinkingModelLabel(args: readonly string[]): string {
  try {
    const runnerOptions = resolveCodexRunnerOptions(args);
    return runnerOptions.reasoningEffort === 'default'
      ? runnerOptions.model
      : `${runnerOptions.model}-${runnerOptions.reasoningEffort}`;
  } catch {
    return process.env.SELVEDGE_CODEX_MODEL ?? 'AI';
  }
}

function dashboardRuntimeText(
  locale: DashboardLocale,
  key: DashboardRuntimeTextKey
): string {
  const zh: Record<DashboardRuntimeTextKey, string> = {
    saveStopCondition: '保存/更新停机条件',
    clearStopCondition: '清除停机条件',
    stopConditionHint: '运行中也可以保存新的停机条件；Selvedge 会在下一个安全边界重新读取并执行。',
    stopConditionSaved: '停机条件已保存。运行中的 loop 会在下一个安全边界读取最新条件。',
    stopConditionCleared: '停机条件已清除；下次启动默认长期持续运行。'
  };
  const en: Record<DashboardRuntimeTextKey, string> = {
    saveStopCondition: 'Save/update stop condition',
    clearStopCondition: 'Clear stop condition',
    stopConditionHint: 'You can save a new stop condition while the loop is running. Selvedge reloads it at the next safe boundary.',
    stopConditionSaved: 'Stop condition saved. A running loop will reload it at the next safe boundary.',
    stopConditionCleared: 'Stop condition cleared. The next start defaults to a long continuous run.'
  };
  return (locale === 'zh' ? zh : en)[key];
}

function dashboardThinkingMessage(locale: DashboardLocale, modelLabel: string): string {
  return locale === 'zh'
    ? `${modelLabel}正在思考，在此期间不要关闭程序和窗口，请稍等...`
    : `${modelLabel} is Thinking... Do not close the program or window. Please wait...`;
}

function resolveDashboardLocale(requestUrl: URL, request: IncomingMessage): DashboardLocale {
  const explicit = requestUrl.searchParams.get('lang')?.toLowerCase();
  if (explicit?.startsWith('zh')) {
    return 'zh';
  }
  if (explicit?.startsWith('en')) {
    return 'en';
  }
  const acceptLanguage = Array.isArray(request.headers['accept-language'])
    ? request.headers['accept-language'].join(',')
    : request.headers['accept-language'] ?? '';
  return acceptLanguage.toLowerCase().includes('zh') ? 'zh' : 'en';
}

function dashboardPath(locale: DashboardLocale): string {
  return `/?lang=${locale}`;
}

function dashboardAction(path: string, locale: DashboardLocale): string {
  return `${path}?lang=${locale}`;
}

function redirectDashboard(response: ServerResponse, locale: DashboardLocale): void {
  redirect(response, dashboardPath(locale));
}

function readRequestBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  });
}

function writeStopAgent(cwd: string, reason: string): void {
  writeText(repoPath(cwd, 'STOP_AGENT'), `${reason}\n${new Date().toISOString()}\n`);
}

function lastStopPath(cwd: string): string {
  return localStatePath(cwd, 'status', 'last-stop.json');
}

function writeLastStop(
  cwd: string,
  record: {
    readonly mode: 'safe' | 'force';
    readonly reason: string;
    readonly goalId?: string | null;
    readonly pid?: number | null;
    readonly killResult?: Record<string, unknown>;
  }
): void {
  writeJson(lastStopPath(cwd), {
    ...record,
    updatedAt: new Date().toISOString()
  });
}

function readLastStop(cwd: string): Record<string, unknown> | null {
  return readStatusJson(lastStopPath(cwd));
}

function requestSafeStop(cwd: string, reason: string): void {
  writeStopAgent(cwd, reason);
  const control = readDashboardRunControl(cwd);
  writeLastStop(cwd, {
    mode: 'safe',
    reason,
    goalId: typeof control?.goalId === 'string' ? control.goalId : null,
    pid: typeof control?.pid === 'number' ? control.pid : null
  });
  writeJson(dashboardRunControlPath(cwd), {
    ...compactDashboardRunControl(control),
    status: 'StopRequested',
    updatedAt: new Date().toISOString(),
    stopMode: 'safe',
    reason,
    message: 'Safe stop requested. The current task may finish; the loop must stop before the next task.'
  });
}

function dashboardRunControlPath(cwd: string): string {
  return localStatePath(cwd, 'status', 'dashboard-run-control.json');
}

function readDashboardRunControl(cwd: string): Record<string, unknown> | null {
  return readStatusJson(dashboardRunControlPath(cwd));
}

function numericPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function processLooksAlive(pid: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusUpdatedAtMs(status: Record<string, unknown> | null): number {
  const updatedAt = typeof status?.updatedAt === 'string' ? Date.parse(status.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) ? updatedAt : Number.NaN;
}

function statusUpdatedWithin(status: Record<string, unknown> | null, maxAgeMs: number): boolean {
  const updatedAt = statusUpdatedAtMs(status);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= maxAgeMs;
}

function loopStatusLooksActive(loopStatus: Record<string, unknown> | null): boolean {
  const status = String(loopStatus?.status ?? '');
  return ['Started', 'Running', 'Heartbeat'].includes(status) && statusUpdatedWithin(loopStatus, 5 * 60 * 1000);
}

function dashboardRunLooksActive(
  runControl: Record<string, unknown> | null,
  latestLoopStatus: Record<string, unknown> | null
): boolean {
  if (dashboardRunChild && !dashboardRunChild.killed) {
    return true;
  }
  const status = String(runControl?.status ?? '');
  const pid = numericPid(runControl?.pid);
  if (['ForceStopRequested', 'LoopExited', 'LoopFailed'].includes(status)) {
    const controlUpdatedAt = statusUpdatedAtMs(runControl);
    const loopUpdatedAt = statusUpdatedAtMs(latestLoopStatus);
    if (Number.isFinite(controlUpdatedAt) && (!Number.isFinite(loopUpdatedAt) || controlUpdatedAt >= loopUpdatedAt)) {
      return false;
    }
  }
  if (['StartedFromDashboard', 'AlreadyRunning', 'StopConditionUpdated', 'StopConditionCleared'].includes(status)) {
    return Boolean((pid && processLooksAlive(pid)) || loopStatusLooksActive(latestLoopStatus));
  }
  if (status === 'StopRequested') {
    return Boolean((pid && processLooksAlive(pid)) || loopStatusLooksActive(latestLoopStatus));
  }
  return loopStatusLooksActive(latestLoopStatus);
}

function forceKillProcessTree(pid: number | null): Record<string, unknown> {
  if (!pid || !Number.isFinite(pid)) {
    return {
      attempted: false,
      reason: 'No dashboard-started pid was recorded.'
    };
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return {
      attempted: true,
      command: `taskkill /PID ${pid} /T /F`,
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  try {
    process.kill(pid, 'SIGKILL');
    return {
      attempted: true,
      command: `kill -9 ${pid}`,
      exitCode: 0
    };
  } catch (error) {
    return {
      attempted: true,
      command: `kill -9 ${pid}`,
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function requestForceStop(cwd: string, reason: string): void {
  writeStopAgent(cwd, reason);
  const control = readDashboardRunControl(cwd);
  const latestLoopStatus = latestLoopStatusForGoals(cwd, listGoalSummaries(cwd));
  const goalId =
    typeof control?.goalId === 'string'
      ? control.goalId
      : typeof latestLoopStatus?.workflowId === 'string'
        ? latestLoopStatus.workflowId
        : null;
  const pid = typeof control?.pid === 'number' ? control.pid : null;
  const killResult = forceKillProcessTree(pid);
  dashboardRunChild = null;
  writeLastStop(cwd, {
    mode: 'force',
    reason,
    goalId,
    pid,
    killResult
  });
  if (goalId) {
    writeLoopStatus(cwd, goalId, 'Stopped', 'Force stop requested from Selvedge dashboard.', {
      stopMode: 'force',
      killResult
    });
  }
  writeJson(dashboardRunControlPath(cwd), {
    status: 'ForceStopRequested',
    updatedAt: new Date().toISOString(),
    stopMode: 'force',
    reason,
    goalId,
    pid,
    killResult,
    message: 'Force stop requested. A recovery check is required before the next start.'
  });
}

function requestDashboardShutdownSafeStop(cwd: string, reason: string): void {
  if (dashboardShutdownHandled) {
    return;
  }
  dashboardShutdownHandled = true;
  requestSafeStop(cwd, reason);
}

function recoverBeforeDashboardStart(cwd: string, goalId: string): Record<string, unknown> | null {
  const lastStop = readLastStop(cwd);
  if (!lastStop || lastStop.mode === 'safe') {
    return null;
  }
  const loopStatus = readStatusJson(localStatePath(cwd, 'status', `${goalId}.loop-status.json`));
  const control = readDashboardRunControl(cwd);
  const recovery = {
    status: 'Completed',
    recoveredAt: new Date().toISOString(),
    goalId,
    reason: 'Previous stop was not safe; dashboard performed a pre-start recovery inspection.',
    previousStop: lastStop,
    stopFilePresentBeforeStart: existsSync(repoPath(cwd, 'STOP_AGENT')),
    loopStatus,
    dashboardRunControl: control,
    action: 'Cleared STOP_AGENT on start and allowed the loop to relaunch from the persisted workflow queue.'
  };
  writeJson(localStatePath(cwd, 'status', 'dashboard-recovery-check.json'), recovery);
  return recovery;
}

function dashboardLoopLooksActive(cwd: string, goalId: string): boolean {
  const control = readDashboardRunControl(cwd);
  const latestLoopStatus = latestLoopStatusForGoals(cwd, listGoalSummaries(cwd));
  if (dashboardRunLooksActive(control, latestLoopStatus)) {
    return true;
  }
  if (existsSync(repoPath(cwd, 'STOP_AGENT'))) {
    return false;
  }
  const loopStatus = readStatusJson(localStatePath(cwd, 'status', `${goalId}.loop-status.json`));
  return loopStatusLooksActive(loopStatus);
}

function updateDashboardStopCondition(
  cwd: string,
  goalId: string,
  requestedText: string,
  runnerArgs: readonly string[],
  locale: DashboardLocale
): StopConditionRecord {
  const control = readDashboardRunControl(cwd);
  const record = saveStopConditionWithAi(cwd, goalId, requestedText, runnerArgs);
  writeJson(dashboardRunControlPath(cwd), {
    ...compactDashboardRunControl(control),
    status: 'StopConditionUpdated',
    updatedAt: new Date().toISOString(),
    goalId,
    stopCondition: record,
    stopConditionPath: stopConditionPath(cwd, goalId),
    message: dashboardRuntimeText(locale, 'stopConditionSaved')
  });
  return record;
}

function clearDashboardStopCondition(cwd: string, goalId: string, locale: DashboardLocale): void {
  const control = readDashboardRunControl(cwd);
  const removed = clearSavedStopCondition(cwd, goalId);
  writeJson(dashboardRunControlPath(cwd), {
    ...compactDashboardRunControl(control),
    status: 'StopConditionCleared',
    updatedAt: new Date().toISOString(),
    goalId,
    stopCondition: null,
    stopConditionPath: stopConditionPath(cwd, goalId),
    removed,
    message: dashboardRuntimeText(locale, 'stopConditionCleared')
  });
}

function quotePowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellArrayLiteral(values: readonly string[]): string {
  return `@(${values.map(quotePowerShellSingleQuoted).join(', ')})`;
}

function openDashboardHeartbeatWindow(cwd: string, goalId: string, logPath: string): number | null {
  if (process.platform !== 'win32') {
    return null;
  }
  const script = [
    'chcp 65001 | Out-Null',
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$Host.UI.RawUI.WindowTitle = ${quotePowerShellSingleQuoted(`Selvedge heartbeat - ${goalId}`)}`,
    `Set-Location -LiteralPath ${quotePowerShellSingleQuoted(cwd)}`,
    `Write-Host ${quotePowerShellSingleQuoted(`Selvedge 心跳: ${goalId}`)}`,
    `Write-Host ${quotePowerShellSingleQuoted(`日志: ${logPath}`)}`,
    'Write-Host ""',
    `Get-Content -LiteralPath ${quotePowerShellSingleQuoted(logPath)} -Encoding UTF8 -Tail 80 -Wait`
  ].join('; ');
  try {
    const terminal = spawn('powershell.exe', ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    terminal.unref();
    return terminal.pid ?? null;
  } catch (error) {
    appendFileSync(
      logPath,
      `\nFailed to open Selvedge heartbeat window: ${error instanceof Error ? error.message : String(error)}\n`,
      'utf8'
    );
    return null;
  }
}

function openDashboardHeartbeatWindowVisible(cwd: string, goalId: string, logPath: string): number | null {
  if (process.platform !== 'win32') {
    return null;
  }
  const scriptPath = localStatePath(cwd, 'status', `dashboard-heartbeat.${slug(goalId) || 'goal'}.${Date.now()}.ps1`);
  const script = [
    'try { chcp 65001 | Out-Null } catch {}',
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$Host.UI.RawUI.WindowTitle = ${quotePowerShellSingleQuoted(`Selvedge heartbeat - ${goalId}`)}`,
    `Set-Location -LiteralPath ${quotePowerShellSingleQuoted(cwd)}`,
    `Write-Host ${quotePowerShellSingleQuoted(`Selvedge 心跳: ${goalId}`)}`,
    `Write-Host ${quotePowerShellSingleQuoted(`日志: ${logPath}`)}`,
    'Write-Host ""',
    `while (!(Test-Path -LiteralPath ${quotePowerShellSingleQuoted(logPath)})) { Start-Sleep -Milliseconds 500 }`,
    `Get-Content -LiteralPath ${quotePowerShellSingleQuoted(logPath)} -Encoding UTF8 -Tail 80 -Wait`
  ].join('\r\n');
  writeText(scriptPath, `${script}\r\n`);
  try {
    const launcherScript = [
      `$p = Start-Process -FilePath ${quotePowerShellSingleQuoted('powershell.exe')} -ArgumentList ${powershellArrayLiteral([
        '-NoExit',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath
      ])} -WorkingDirectory ${quotePowerShellSingleQuoted(cwd)} -WindowStyle Normal -PassThru`,
      'if ($p) { [Console]::Out.Write($p.Id) }'
    ].join('; ');
    const launcher = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcherScript], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    const pid = Number.parseInt((launcher.stdout ?? '').trim(), 10);
    if (launcher.status === 0 && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
    appendFileSync(
      logPath,
      `\nFailed to open Selvedge heartbeat window: Start-Process returned ${launcher.status}; stdout=${launcher.stdout ?? ''}; stderr=${launcher.stderr ?? ''}\n`,
      'utf8'
    );
    return null;
  } catch (error) {
    appendFileSync(
      logPath,
      `\nFailed to open Selvedge heartbeat window: ${error instanceof Error ? error.message : String(error)}\n`,
      'utf8'
    );
    return null;
  }
}

interface SelvedgeSelfInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
  readonly shell: boolean;
}

function resolveSelvedgeSelfInvocation(): SelvedgeSelfInvocation {
  const compiledCli = join(__dirname, 'cli.js');
  if (existsSync(compiledCli)) {
    return {
      command: process.execPath,
      args: [compiledCli],
      display: `${process.execPath} ${compiledCli}`,
      shell: false
    };
  }
  const sourceCli = join(__dirname, 'cli.ts');
  if (existsSync(sourceCli)) {
    return {
      command: 'bun',
      args: [sourceCli],
      display: `bun ${sourceCli}`,
      shell: false
    };
  }
  const argvEntry = process.argv[1];
  if (argvEntry && existsSync(argvEntry)) {
    return {
      command: process.execPath,
      args: [argvEntry],
      display: `${process.execPath} ${argvEntry}`,
      shell: false
    };
  }
  return {
    command: 'selvedge',
    args: [],
    display: 'selvedge',
    shell: process.platform === 'win32'
  };
}

function startGoalLoopFromDashboard(
  cwd: string,
  goalId: string,
  stopConditionText: string,
  runnerArgs: readonly string[],
  preflight: DashboardBlockerStartPreparation | null = null
): void {
  if (dashboardLoopLooksActive(cwd, goalId)) {
    const current = readDashboardRunControl(cwd);
    writeJson(dashboardRunControlPath(cwd), {
      ...compactDashboardRunControl(current),
      status: typeof current?.status === 'string' ? current.status : 'AlreadyRunning',
      updatedAt: new Date().toISOString(),
      goalId: typeof current?.goalId === 'string' ? current.goalId : goalId,
      attemptedGoalId: goalId,
      message: 'A loop appears to be active. Stop safely before starting another one.'
    });
    return;
  }
  const recovery = recoverBeforeDashboardStart(cwd, goalId);
  const stopCondition = saveStopConditionWithAi(cwd, goalId, stopConditionText, runnerArgs);
  const clearedStop = clearStopFile(resolveStopPolicy(cwd, 'none'));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  ensureDir(localStatePath(cwd, 'logs'));
  const logPath = localStatePath(cwd, 'logs', `dashboard-loop.${goalId}.${timestamp}.log`);
  appendFileSync(
    logPath,
    [
      'Selvedge dashboard loop',
      `Goal: ${goalId}`,
      `Started: ${new Date().toISOString()}`,
      `StopCondition: ${stopCondition.mode}`,
      preflight?.prepared ? `Preflight: ${preflight.message}` : null,
      ''
    ].filter((line): line is string => line !== null).join('\n'),
    'utf8'
  );
  const self = resolveSelvedgeSelfInvocation();
  const args = [
    ...self.args,
    'run',
    'loop',
    '--goal',
    goalId,
    '--execute',
    '--stop-time',
    'none',
    '--clear-stop-on-start',
    '--heartbeat-seconds',
    '30',
    '--stop-condition-file',
    stopConditionPath(cwd, goalId),
    ...runnerArgs
  ];
  const child = spawn(self.command, args, {
    cwd,
    shell: self.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const heartbeatWindowPid = openDashboardHeartbeatWindowVisible(cwd, goalId, logPath);
  dashboardRunChild = child;
  const mirrorOutput = (target: NodeJS.WriteStream, chunk: Buffer) => {
    appendFileSync(logPath, chunk, 'utf8');
    target.write(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => mirrorOutput(process.stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => mirrorOutput(process.stderr, chunk));
  child.on('close', (code, signal) => {
    appendFileSync(logPath, `\nDashboard loop process exited: code=${code ?? 'null'} signal=${signal ?? 'null'}\n`, 'utf8');
    if (dashboardRunChild === child) {
      dashboardRunChild = null;
    }
    const current = readDashboardRunControl(cwd);
    if (
      current &&
      current.pid === child.pid &&
      ['StartedFromDashboard', 'StopRequested', 'AlreadyRunning'].includes(String(current.status ?? ''))
    ) {
      writeJson(dashboardRunControlPath(cwd), {
        ...compactDashboardRunControl(current),
        status: code === 0 ? 'LoopExited' : 'LoopFailed',
        updatedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        message: code === 0 ? 'Dashboard-started loop exited normally.' : 'Dashboard-started loop exited with a failure.'
      });
    }
  });
  writeJson(dashboardRunControlPath(cwd), {
    status: 'StartedFromDashboard',
    updatedAt: new Date().toISOString(),
    goalId,
    pid: child.pid,
    clearedStop,
    recovery,
    startPreflight: compactDashboardPreflight(preflight),
    stopCondition,
    stopConditionPath: stopConditionPath(cwd, goalId),
    command: `${self.display} ${args.slice(self.args.length).join(' ')}`,
    logPath,
    heartbeatWindowPid,
    message: preflight?.prepared
      ? `${preflight.message} Dashboard-started Selvedge loop is running.`
      : 'Dashboard-started Selvedge loop is running. Start is disabled until this loop exits or is stopped.'
  });
}

function saveHeartbeatPreference(
  cwd: string,
  requestedText: string,
  runnerArgs: readonly string[] = []
): HeartbeatPreferenceRecord {
  const record = normalizeHeartbeatPreferenceWithAi(
    cwd,
    requestedText,
    readSelvedgeConfig(cwd).heartbeatTemplate,
    runnerArgs
  );
  writeJson(heartbeatPreferencePath(cwd), record);
  return record;
}

function dashboardHtml(
  model: GameHubReadOnlyModel,
  goals: ReturnType<typeof listGoalSummaries>,
  heartbeatPreference: HeartbeatPreferenceRecord | null,
  runControl: Record<string, unknown> | null
): string {
  const escapedModel = JSON.stringify(model, null, 2)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const goalRows =
    goals.length === 0
      ? '<tr><td colspan="5">No goal workflows yet.</td></tr>'
      : goals
          .map(
            (goal) =>
              `<tr><td>${escapeHtml(goal.id)}</td><td>${escapeHtml(goal.title)}</td><td>${escapeHtml(goal.mode)}</td><td>${goal.completed}/${goal.total}${goal.blocked > 0 ? ` · blocked ${goal.blocked}` : ''}</td><td>${escapeHtml(goal.nextPhase)}<br /><span>${escapeHtml(goal.nextTask)}</span></td><td>${escapeHtml(goal.migrationTarget ?? '-')}</td><td>${escapeHtml(goal.loopStatus ?? '-')}<br /><span>${escapeHtml(goal.loopMessage ?? '')}</span></td><td><form method="post" action="/actions/start-loop"><input type="hidden" name="goalId" value="${escapeHtml(goal.id)}" /><button type="submit">Start / Continue</button></form></td></tr>`
          )
          .join('');
  const preferenceText = heartbeatPreference?.requestedText ?? '我想看到当前在迁移什么类型的什么游戏，也保留机器诊断信息';
  const normalizedFields = heartbeatPreference?.optionalFields.join(', ') ?? 'selvedge.yaml default';
  const primaryGoal = goals[0] ?? null;
  const runStatus = typeof runControl?.status === 'string' ? runControl.status : model.stopFile.exists ? 'Stopped' : primaryGoal?.loopStatus ?? 'Ready';
  const lastStopWasForce = runControl?.stopMode === 'force' || runControl?.status === 'ForceStopRequested';
  const runMessage =
    typeof runControl?.message === 'string'
      ? runControl.message
      : lastStopWasForce
        ? '上次是强行停机。点击 Start / Continue 后会先做恢复检查，再自动清除 STOP 标记并继续。'
      : model.stopFile.exists
        ? '当前已安全停止。要继续，请在目标任务行点击 Start / Continue。'
        : primaryGoal?.loopStatus === 'Heartbeat' || primaryGoal?.loopStatus === 'Running'
          ? '当前看起来正在运行。需要暂停时点击 Stop safely。'
          : '请选择一个目标任务并点击 Start / Continue。';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Selvedge Control Console</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2937; background: #f8fafc; }
    main { max-width: 1120px; margin: 0 auto; }
    h1 { font-size: 28px; margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
    .tile { background: white; border: 1px solid #d1d5db; border-radius: 8px; padding: 14px; }
    .label { font-size: 12px; text-transform: uppercase; color: #6b7280; }
    .value { font-size: 20px; font-weight: 650; margin-top: 4px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 0; }
    button { border: 1px solid #1f2937; background: #1f2937; color: white; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button.secondary { background: white; color: #1f2937; }
    button.danger { border-color: #b91c1c; background: #b91c1c; }
    textarea { width: 100%; min-height: 92px; border: 1px solid #d1d5db; border-radius: 6px; padding: 10px; font: inherit; box-sizing: border-box; }
    .panel { background: white; border: 1px solid #d1d5db; border-radius: 8px; padding: 14px; margin: 20px 0; }
    .callout { background: #ecfdf5; border: 1px solid #86efac; border-radius: 8px; padding: 14px; margin: 20px 0; }
    .muted, span { color: #6b7280; font-size: 13px; }
    details { margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; margin: 20px 0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    th { background: #f3f4f6; color: #374151; font-weight: 650; }
    pre { background: #111827; color: #e5e7eb; border-radius: 8px; padding: 16px; overflow: auto; }
  </style>
  <script>
    function confirmSafeStop() {
      return window.confirm('安全停机会让当前任务尽量自然结束，并阻止下一轮任务启动。确定要安全停机吗？') &&
        window.confirm('再次确认：安全停机不会强杀当前进程，可能还会等当前任务收尾。继续？');
    }
    function confirmForceStop() {
      return window.confirm('强行停机会尽量终止 Dashboard 启动的运行进程。只在任务明显卡死时使用。继续？') &&
        window.confirm('第二次确认：强行停机可能留下未完成状态，下次启动前会先做恢复检查。继续？') &&
        window.confirm('第三次确认：你真的要强行停机吗？');
    }
  </script>
</head>
<body>
<main>
  <h1>Selvedge Control Console</h1>
  <p>Goal control, stop safety, and heartbeat wording for operators who prefer clicking and typing over commands.</p>
  <section class="callout">
    <strong>当前状态：${escapeHtml(runStatus)}</strong>
    <p>${escapeHtml(runMessage)}</p>
  </section>
  <section class="grid">
    <div class="tile"><div class="label">Pending</div><div class="value">${model.taskBoard.pendingCount}</div></div>
    <div class="tile"><div class="label">AI-QA</div><div class="value">${String(model.aiQaSwitch.enabled)}</div></div>
    <div class="tile"><div class="label">STOP_AGENT</div><div class="value">${model.stopFile.exists ? 'present' : 'absent'}</div></div>
    <div class="tile"><div class="label">Can Start</div><div class="value">${model.selvedgeMainline.canStartInCodexApp ? 'yes' : 'no'}</div></div>
  </section>
  <section class="actions">
    <form method="post" action="/actions/stop-safe" onsubmit="return confirmSafeStop()"><button class="secondary" type="submit">Safe stop</button></form>
    <form method="post" action="/actions/stop-force" onsubmit="return confirmForceStop()"><button class="danger" type="submit">Force stop</button></form>
  </section>
  <section class="panel">
    <h2>Heartbeat Wording</h2>
    <form method="post" action="/actions/heartbeat-preference">
      <label for="heartbeatPreference">Tell Selvedge what you want to see in heartbeat blocks.</label>
      <textarea id="heartbeatPreference" name="preference">${escapeHtml(preferenceText)}</textarea>
      <p>Normalized display fields: ${escapeHtml(normalizedFields)}</p>
      <button type="submit">Save heartbeat preference</button>
    </form>
  </section>
  <h2>Goal Workflows</h2>
  <table>
    <thead><tr><th>Id</th><th>Title</th><th>Mode</th><th>Progress</th><th>Next Step</th><th>Target</th><th>Loop</th><th>Action</th></tr></thead>
    <tbody>${goalRows}</tbody>
  </table>
  <details>
    <summary>Technical details</summary>
    <pre>${escapedModel}</pre>
  </details>
</main>
</body>
</html>`;
}

function latestLoopStatusForGoals(cwd: string, goals: ReturnType<typeof listGoalSummaries>): Record<string, unknown> | null {
  const candidateIds = new Set(goals.map((goal) => goal.id));
  const statusRoot = localStatePath(cwd, 'status');
  if (existsSync(statusRoot)) {
    for (const entry of readdirSync(statusRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.loop-status.json')) {
        candidateIds.add(entry.name.slice(0, -'.loop-status.json'.length));
      }
    }
  }
  let latest: Record<string, unknown> | null = null;
  for (const goalId of candidateIds) {
    const status = readStatusJson(localStatePath(cwd, 'status', `${goalId}.loop-status.json`));
    if (!status || typeof status.updatedAt !== 'string') {
      continue;
    }
    if (!latest || String(status.updatedAt).localeCompare(String(latest.updatedAt ?? '')) > 0) {
      latest = status;
    }
  }
  return latest;
}

function renderLatestHeartbeat(status: Record<string, unknown> | null, copy: DashboardCopy): string {
  if (!status) {
    return `<p class="muted">${escapeHtml(copy.noHeartbeat)}</p>`;
  }
  const rows: Array<[string, unknown]> = [
    [copy.statusLabel, status.status],
    [copy.totalGoalHeartbeat, status.totalGoal],
    [copy.phaseHeartbeat, `${status.phaseLabel ?? '-'} ${status.phaseProgress ? `(${status.phaseProgress})` : ''}`],
    [copy.taskHeartbeat, `${status.taskProgress ?? '-'} ${status.taskDisplayName ?? status.taskTitle ?? '-'}`],
    [copy.currentActionHeartbeat, status.currentAction],
    [copy.elapsedHeartbeat, status.elapsed],
    [copy.idleHeartbeat, status.idle],
    [copy.migrationTargetHeartbeat, status.migrationTarget],
    ['本机时间 / Local time', status.localTime],
    [copy.logHeartbeat, status.logDisplayPath ?? status.logPath],
    [copy.updatedHeartbeat, status.updatedAt]
  ];
  return `<pre class="heartbeat">${rows
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(String(value))}`)
    .join('\n')}</pre>`;
}

function renderTaskQueue(goal: DashboardGoalSummary, copy: DashboardCopy): string {
  if (goal.tasks.length === 0) {
    return `<p class="muted">${escapeHtml(copy.noCurrentTask)}</p>`;
  }
  return `<ol class="task-queue">${goal.tasks
    .map((task) => {
      if (!task.isCurrent) {
        return `<li class="task-item" title="${escapeHtml(task.detailText)}"><span class="task-title"><span class="task-name">${escapeHtml(task.taskProgress)} ${escapeHtml(task.displayName)}</span></span><strong>${escapeHtml(task.statusLabel)}</strong></li>`;
      }
      return `<li class="task-item current">
        <div class="task-row" title="${escapeHtml(task.detailText)}"><span class="task-title"><span class="task-name">${escapeHtml(task.taskProgress)} ${escapeHtml(task.displayName)}</span><span class="task-note">${escapeHtml(task.description)}</span></span><strong>${escapeHtml(task.statusLabel)}</strong></div>
        <dl class="task-details">
          <div><dt>${escapeHtml(copy.taskDescriptionLabel)}</dt><dd>${escapeHtml(task.description)}</dd></div>
          <div><dt>${escapeHtml(copy.phaseHeartbeat)}</dt><dd>${escapeHtml(task.phaseLabel)}</dd></div>
          <div><dt>${escapeHtml(copy.runnerLabel)}</dt><dd title="${escapeHtml(task.runner)}">${escapeHtml(task.runnerLabel)}</dd></div>
          <div><dt>${escapeHtml(copy.roleLabel)}</dt><dd title="${escapeHtml(task.role)}">${escapeHtml(task.roleLabel)}</dd></div>
          <div><dt>${escapeHtml(copy.roadmapLabel)}</dt><dd title="${escapeHtml(task.roadmapNode)}">${escapeHtml(task.roadmapLabel)}</dd></div>
        </dl>
      </li>`;
    })
    .join('')}</ol>`;
}

function renderActiveWorkflow(goal: DashboardGoalSummary | null, copy: DashboardCopy, objective: SelvedgeProjectObjective | null): string {
  if (!goal) {
    return `<section class="panel"><h2>${escapeHtml(copy.activeWorkflow)}</h2><p class="muted">${escapeHtml(copy.noGoalRows)}</p></section>`;
  }
  const current = goal.currentTask;
  const totalGoal = objective?.totalGoal ?? goal.totalGoal;
  return `<section class="panel workflow-panel">
    <div class="section-heading">
      <h2>${escapeHtml(copy.activeWorkflow)}</h2>
      <span class="muted">${escapeHtml(copy.serialQueueNotice)}</span>
    </div>
    <div class="workflow-grid">
      <div>
        <div class="label">${escapeHtml(copy.totalGoalSection)}</div>
        <p class="workflow-goal">${escapeHtml(totalGoal)}</p>
      </div>
      <div>
        <div class="label">${escapeHtml(copy.runState)}</div>
        <p>${escapeHtml(goal.loopStatus ?? 'Ready')}${goal.loopMessage ? `<br /><span>${escapeHtml(goal.loopMessage)}</span>` : ''}</p>
      </div>
      <div>
        <div class="label">${escapeHtml(copy.currentTaskSection)}</div>
        <p>${current ? `<span title="${escapeHtml(current.detailText)}">${escapeHtml(current.taskProgress)} ${escapeHtml(current.displayName)}</span> <span>${escapeHtml(current.statusLabel)}</span>` : escapeHtml(copy.noCurrentTask)}</p>
      </div>
    </div>
    <h3>${escapeHtml(copy.taskQueue)}</h3>
    ${renderTaskQueue(goal, copy)}
  </section>`;
}

function joinForTextarea(items: readonly string[]): string {
  return items.join('\n');
}

function renderProjectObjectivePanel(
  objective: SelvedgeProjectObjective | null,
  goals: ReturnType<typeof listGoalSummaries>,
  copy: DashboardCopy,
  locale: DashboardLocale,
  loadingAttrs: string,
  runControl: Record<string, unknown> | null
): string {
  const reviewStatus = typeof runControl?.projectObjectiveReviewStatus === 'string'
    ? runControl.projectObjectiveReviewStatus
    : objective?.review.status ?? 'none';
  const reviewMessage = typeof runControl?.projectObjectiveReviewMessage === 'string'
    ? runControl.projectObjectiveReviewMessage
    : objective?.review.summary ?? copy.projectObjectiveHint;
  const totalGoal = objective?.totalGoal ?? '';
  const scopes = objective?.scopes.map((scope) => `${scope.path}|${scope.title}|${scope.workstream}`) ?? [];
  const scopeLabels = objective?.scopes.map((scope) => `${scope.title} - ${scope.path} (${scope.workstream})`) ?? [];
  const activeGoal = goals[0] ?? null;
  const defaultWorkstream =
    objective?.scopes[0]?.workstream ??
    (activeGoal?.profileId === 'kg-slots-migration' || activeGoal?.profileId === 'kg-game-migration' ? 'kg-micro-shell' : 'assigned-work');
  const hasObjective = objective !== null;
  const formHiddenAttr = hasObjective ? 'hidden' : '';
  const summaryHint = hasObjective ? copy.projectObjectiveViewHint : copy.projectObjectiveHint;
  const objectiveView = hasObjective
    ? `<div id="projectObjectiveView" class="objective-view">
        <div class="section-heading">
          <div>
            <div class="label">${escapeHtml(copy.totalGoalSection)}</div>
            <p class="objective-text">${escapeHtml(totalGoal)}</p>
          </div>
          <button type="button" class="secondary" onclick="toggleProjectObjectiveEdit(true)">${escapeHtml(copy.editProjectObjective)}</button>
        </div>
        <div class="workflow-grid objective-summary-grid">
          <div>
            <div class="label">${escapeHtml(copy.monorepoScopesLabel)}</div>
            ${renderMiniList(scopeLabels, '-')}
          </div>
          <div>
            <div class="label">${escapeHtml(copy.authoritySourcesLabel)}</div>
            ${renderMiniList(objective.authoritySources, '-')}
          </div>
          <div>
            <div class="label">${escapeHtml(copy.validationLabel)}</div>
            ${renderMiniList(objective.validationExpectations, '-')}
          </div>
        </div>
        <div class="workflow-grid objective-summary-grid">
          <div>
            <div class="label">${escapeHtml(copy.writeSetLabel)}</div>
            ${renderMiniList(objective.writeBoundaries, '-')}
          </div>
          <div>
            <div class="label">${escapeHtml(copy.stopExpectationsLabel)}</div>
            ${renderMiniList(objective.stopExpectations, '-')}
          </div>
          <div>
            <div class="label">${escapeHtml(copy.notesLabel)}</div>
            <p>${escapeHtml(objective.notes || '-')}</p>
          </div>
        </div>
      </div>`
    : `<div class="callout"><p>${escapeHtml(copy.projectObjectiveEmpty)}</p></div>`;
  return `<details class="panel objective-panel" open>
    <summary><strong>${escapeHtml(copy.projectObjective)}</strong><span class="muted"> ${escapeHtml(summaryHint)}</span></summary>
    <div class="callout">
      <strong>${escapeHtml(copy.objectiveReview)}: ${escapeHtml(reviewStatus)}</strong>
      <p>${escapeHtml(reviewMessage)}</p>
    </div>
    ${objectiveView}
    <form id="projectObjectiveForm" method="post" action="${dashboardAction('/actions/project-objective', locale)}" ${loadingAttrs} ${formHiddenAttr}>
      <label for="projectTotalGoal">${escapeHtml(copy.totalGoalLabel)}</label>
      <textarea id="projectTotalGoal" name="totalGoal" required placeholder="${escapeHtml(copy.totalGoalPlaceholder)}">${escapeHtml(totalGoal)}</textarea>
      <label for="projectWorkstream">${escapeHtml(copy.workstreamLabel)}</label>
      <input id="projectWorkstream" name="workstream" value="${escapeHtml(defaultWorkstream)}" placeholder="${escapeHtml(copy.workstreamPlaceholder)}" />
      <label for="projectScopes">${escapeHtml(copy.monorepoScopesLabel)}</label>
      <textarea id="projectScopes" name="scopes" placeholder="${escapeHtml(copy.monorepoScopesPlaceholder)}">${escapeHtml(joinForTextarea(scopes))}</textarea>
      <label for="projectAuthoritySources">${escapeHtml(copy.authoritySourcesLabel)}</label>
      <textarea id="projectAuthoritySources" name="authoritySources" placeholder="${escapeHtml(copy.authoritySourcesPlaceholder)}">${escapeHtml(joinForTextarea(objective?.authoritySources ?? []))}</textarea>
      <label for="projectWriteSet">${escapeHtml(copy.writeSetLabel)}</label>
      <textarea id="projectWriteSet" name="writeSet" placeholder="${escapeHtml(copy.writeSetPlaceholder)}">${escapeHtml(joinForTextarea(objective?.writeBoundaries ?? []))}</textarea>
      <label for="projectValidation">${escapeHtml(copy.validationLabel)}</label>
      <textarea id="projectValidation" name="validation" placeholder="${escapeHtml(copy.validationPlaceholder)}">${escapeHtml(joinForTextarea(objective?.validationExpectations ?? []))}</textarea>
      <label for="projectStopExpectations">${escapeHtml(copy.stopExpectationsLabel)}</label>
      <textarea id="projectStopExpectations" name="stopExpectations" placeholder="${escapeHtml(copy.stopExpectationsPlaceholder)}">${escapeHtml(joinForTextarea(objective?.stopExpectations ?? []))}</textarea>
      <label for="projectNotes">${escapeHtml(copy.notesLabel)}</label>
      <textarea id="projectNotes" name="notes" placeholder="${escapeHtml(copy.notesPlaceholder)}">${escapeHtml(objective?.notes ?? '')}</textarea>
      <div class="actions">
        <button type="submit">${escapeHtml(copy.saveProjectObjective)}</button>
        ${hasObjective ? `<button class="secondary" type="button" onclick="toggleProjectObjectiveEdit(false)">${escapeHtml(copy.cancelProjectObjectiveEdit)}</button>` : ''}
      </div>
    </form>
  </details>`;
}

function renderMiniList(items: readonly string[], emptyText: string): string {
  if (items.length === 0) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderArchitecturePanel(
  goal: DashboardGoalSummary | null,
  copy: DashboardCopy,
  locale: DashboardLocale,
  loadingAttrs: string
): string {
  if (!goal || !goal.architectureStatus) {
    return '';
  }
  if (goal.architectureStatus === 'not-required') {
    return `<section class="panel">
      <h2>${escapeHtml(copy.architectureProposal)}</h2>
      <p class="muted">${escapeHtml(goal.architectureSummary ?? copy.architectureNotRequired)}</p>
    </section>`;
  }
  return `<section class="panel architecture-panel">
    <div class="section-heading">
      <h2>${escapeHtml(copy.architectureProposal)}</h2>
      <span class="muted">${escapeHtml(goal.architectureStatus)}</span>
    </div>
    <p>${escapeHtml(goal.architectureSummary ?? copy.architectureProposalHint)}</p>
    <div class="workflow-grid">
      <div>
        <div class="label">${escapeHtml(copy.architectureStack)}</div>
        ${renderMiniList(goal.architectureStack, '-')}
      </div>
      <div>
        <div class="label">${escapeHtml(copy.architectureStructure)}</div>
        ${renderMiniList(goal.architectureStructure, '-')}
      </div>
      <div>
        <div class="label">${escapeHtml(copy.architectureInitPlan)}</div>
        ${renderMiniList(goal.architectureInitPlan, '-')}
      </div>
    </div>
    <div class="subpanel">
      <div class="label">${escapeHtml(copy.architectureRisks)}</div>
      ${renderMiniList(goal.architectureRisks, '-')}
    </div>
    ${goal.architectureConfirmationRequired
      ? `<form method="post" action="${dashboardAction('/actions/confirm-architecture', locale)}" ${loadingAttrs}>
          <input type="hidden" name="goalId" value="${escapeHtml(goal.id)}" />
          <button type="submit">${escapeHtml(copy.confirmArchitecture)}</button>
        </form>`
      : ''}
  </section>`;
}

function renderIntakeOptions(goal: DashboardGoalSummary, copy: DashboardCopy): string {
  if (goal.nextQuestionOptions.length === 0) {
    return '';
  }
  return `<div class="option-list" aria-label="${escapeHtml(copy.chooseAnswerOption)}">
    <div class="label">${escapeHtml(copy.chooseAnswerOption)}</div>
    <p class="muted">${escapeHtml(copy.answerSelectionHint)}</p>
    ${goal.nextQuestionOptions
      .map(
        (option) => `<label class="option-item">
          <input type="radio" name="selectedOption" value="${escapeHtml(option.id)}" />
          <div>
            <strong>${escapeHtml(option.label)}</strong>
            <p class="muted">${escapeHtml(option.description)}</p>
          </div>
        </label>`
      )
      .join('')}
  </div>`;
}

function resolveActiveDashboardGoal(
  goals: ReturnType<typeof listGoalSummaries>,
  runControl: Record<string, unknown> | null,
  latestLoopStatus: Record<string, unknown> | null
): DashboardGoalSummary | null {
  const latestActiveGoalId =
    loopStatusLooksActive(latestLoopStatus) && typeof latestLoopStatus?.workflowId === 'string'
      ? latestLoopStatus.workflowId
      : null;
  const runControlGoalId = typeof runControl?.goalId === 'string' ? runControl.goalId : null;
  const activeGoalId =
    latestActiveGoalId ??
    runControlGoalId ??
    (typeof latestLoopStatus?.workflowId === 'string' ? latestLoopStatus.workflowId : null);
  return (activeGoalId ? goals.find((goal) => goal.id === activeGoalId) : null) ?? goals[0] ?? null;
}

function dashboardGoalIsCompletedHistory(goal: DashboardGoalSummary): boolean {
  return goal.total > 0 && goal.completed >= goal.total && goal.blocked === 0 && goal.nextTask === 'No pending task';
}

function dashboardStartableGoals(goals: ReturnType<typeof listGoalSummaries>): DashboardGoalSummary[] {
  return goals.filter((goal) => !dashboardGoalIsCompletedHistory(goal));
}

function dashboardNoStartableGoalText(locale: DashboardLocale): string {
  return locale === 'zh'
    ? '按项目总目标启动下一次任务'
    : 'Start next task from the project objective';
}

function dashboardNextTaskGoalLabel(locale: DashboardLocale): string {
  return locale === 'zh'
    ? '下一次任务目标（可选）'
    : 'Next task goal (optional)';
}

function dashboardNextTaskGoalPlaceholder(locale: DashboardLocale): string {
  return locale === 'zh'
    ? '可留空。留空表示由 Selvedge 总控根据项目总目标、当前状态和历史记录自动拆解下一次任务；也可以输入明确的迁移类型、gameCode 或任务目标。'
    : 'Leave blank to let the Selvedge master controller derive the next task from the project objective, current state, and history. Or enter a migration type, gameCode, or task goal.';
}

function dashboardNextTaskGoalHint(locale: DashboardLocale): string {
  return locale === 'zh'
    ? '如果选择了未完成 workflow，会继续原队列；如果没有可启动 workflow，会按项目总目标创建并启动下一次执行队列。'
    : 'If an unfinished workflow is selected, Selvedge continues that queue. If no workflow is startable, Selvedge creates and starts the next execution queue under the project objective.';
}

function renderGoalOptions(goals: ReturnType<typeof listGoalSummaries>, copy: DashboardCopy, locale: DashboardLocale, selectedGoalId: string | null = null): string {
  const goalOptionLabel = (goal: DashboardGoalSummary): string => {
    const lifecycleLabel =
      goal.blocked > 0
        ? 'blocked'
        : goal.completed >= goal.total && goal.total > 0
          ? 'completed/history'
          : goal.nextTask === 'No pending task'
            ? 'no pending'
            : 'runnable';
    const targetLabel = goal.migrationTarget ? ` / ${goal.migrationTarget}` : '';
    return `${goal.id} [${lifecycleLabel} ${goal.completed}/${goal.total}${targetLabel}] - ${goal.title}`;
  };
  return goals.length === 0
    ? `<option value="">${escapeHtml(dashboardNoStartableGoalText(locale))}</option>`
    : goals
        .map((goal) => `<option value="${escapeHtml(goal.id)}" ${goal.id === selectedGoalId ? 'selected' : ''}>${escapeHtml(goalOptionLabel(goal))}</option>`)
        .join('');
}

function renderIntakeCards(
  goals: ReturnType<typeof listGoalSummaries>,
  copy: DashboardCopy,
  locale: DashboardLocale,
  loadingAttrs: string
): string {
  return goals
    .filter((goal) => goal.nextQuestionId && goal.nextQuestion)
    .map(
      (goal) => `<article class="subpanel">
        <div class="label">${escapeHtml(copy.guidedIntake)}</div>
        <h3>${escapeHtml(goal.title)}</h3>
        <p>${escapeHtml(goal.nextQuestion ?? '')}</p>
        <form method="post" action="${dashboardAction('/actions/answer-intake', locale)}" ${loadingAttrs}>
          <input type="hidden" name="goalId" value="${escapeHtml(goal.id)}" />
          <input type="hidden" name="questionId" value="${escapeHtml(goal.nextQuestionId ?? '')}" />
          ${renderIntakeOptions(goal, copy)}
          <label for="answer-${escapeHtml(goal.id)}">${escapeHtml(goal.nextQuestionOptions.length > 0 ? copy.answerDetailsLabel : copy.answerPlaceholder)}</label>
          <textarea id="answer-${escapeHtml(goal.id)}" name="answer" ${goal.nextQuestionOptions.length === 0 ? 'required' : ''} placeholder="${escapeHtml(goal.nextQuestionOptions.length > 0 ? copy.answerDetailsPlaceholder : copy.answerPlaceholder)}"></textarea>
          <button type="submit">${escapeHtml(copy.saveAnswer)}</button>
          <span class="muted">${goal.needsUserQuestions} ${escapeHtml(copy.questionsRemaining)}</span>
        </form>
      </article>`
    )
    .join('');
}

function renderGoalRows(
  goals: ReturnType<typeof listGoalSummaries>,
  copy: DashboardCopy,
  locale: DashboardLocale,
  loadingAttrs: string,
  runActive: boolean
): string {
  return goals.length === 0
    ? `<tr><td colspan="8">${escapeHtml(copy.noGoalRows)}</td></tr>`
    : goals
        .map(
          (goal) => {
            const completedHistory = dashboardGoalIsCompletedHistory(goal);
            const buttonText = completedHistory
              ? locale === 'zh' ? '历史记录' : 'History'
              : runActive
                ? copy.runningButton
                : goal.blocked > 0
                  ? copy.recoverAndRunButton
                  : copy.runContinuous;
            const canRunGoal = !completedHistory && goal.canQuickRun && !runActive;
            return `<tr>
              <td>${escapeHtml(goal.id)}</td>
              <td>${escapeHtml(goal.title)}</td>
              <td>${goal.completed}/${goal.total}${goal.blocked > 0 ? ` / ${escapeHtml(copy.blocked)} ${goal.blocked}` : ''}</td>
              <td>${goal.needsUserQuestions > 0 ? `${escapeHtml(copy.needsAnswers)} ${goal.needsUserQuestions}` : escapeHtml(copy.ready)}</td>
              <td>${escapeHtml(goal.nextPhase)}<br /><span>${escapeHtml(goal.nextTask)}</span></td>
              <td>${escapeHtml(goal.migrationTarget ?? '-')}</td>
              <td>${escapeHtml(goal.loopStatus ?? '-')}<br /><span>${escapeHtml(goal.loopMessage ?? '')}</span></td>
              <td><form method="post" action="${dashboardAction('/actions/start-loop', locale)}" ${loadingAttrs}><input type="hidden" name="goalId" value="${escapeHtml(goal.id)}" /><input type="hidden" name="stopCondition" value="" /><button type="submit" ${canRunGoal ? '' : 'disabled'}>${escapeHtml(buttonText)}</button></form></td>
            </tr>`;
          }
        )
        .join('');
}

function dashboardStartBlockerMessage(goal: DashboardGoalSummary | null, copy: DashboardCopy): string {
  if (!goal || goal.blocked <= 0) {
    return '';
  }
  const parts = [copy.startBlockedMessage];
  if (goal.currentTask) {
    parts.push(`${copy.currentTaskSection}: ${goal.currentTask.taskProgress} ${goal.currentTask.displayName} (${goal.currentTask.statusLabel}).`);
  }
  if (goal.blockingReason) {
    parts.push(goal.blockingReason);
  }
  return parts.join(' ');
}

function dashboardRunView(
  model: GameHubReadOnlyModel,
  runControl: Record<string, unknown> | null,
  copy: DashboardCopy,
  savedStopCondition: StopConditionRecord | null = null
): { runStatus: string; runMessage: string; stopConditionSummary: string } {
  const runStatus = typeof runControl?.status === 'string' ? runControl.status : model.stopFile.exists ? 'Stopped' : 'Ready';
  const runMessage =
    typeof runControl?.message === 'string'
      ? runControl.message
      : model.stopFile.exists
        ? copy.defaultStoppedMessage
        : copy.defaultReadyMessage;
  const stopCondition = savedStopCondition ?? (runControl?.stopCondition as StopConditionRecord | undefined) ?? null;
  const stopConditionSummary = stopConditionSummaryText(stopCondition, copy);
  return { runStatus, runMessage, stopConditionSummary };
}

function dashboardSnapshot(
  cwd: string,
  locale: DashboardLocale,
  thinkingModelLabel: string
): Record<string, unknown> {
  const model = buildReadOnlyModel(cwd);
  const goals = listGoalSummaries(cwd);
  const projectObjective = readProjectObjective(cwd);
  const runControl = readDashboardRunControl(cwd);
  const latestLoopStatus = latestLoopStatusForGoals(cwd, goals);
  const copy = DASHBOARD_COPY[locale];
  const loadingMessage = dashboardThinkingMessage(locale, thinkingModelLabel);
  const loadingAttrs = `data-loading-message="${escapeHtml(loadingMessage)}" data-loading-button="${escapeHtml(copy.loadingButton)}"`;
  const activeGoal = resolveActiveDashboardGoal(goals, runControl, latestLoopStatus);
  const startableGoals = dashboardStartableGoals(goals);
  const selectedStartGoal = resolveActiveDashboardGoal(startableGoals, runControl, latestLoopStatus);
  const savedStopCondition = selectedStartGoal ? readSavedStopCondition(cwd, selectedStartGoal.id) : null;
  const run = dashboardRunView(model, runControl, copy, savedStopCondition);
  const runActive = dashboardRunLooksActive(runControl, latestLoopStatus);
  const startBlocked = Boolean(selectedStartGoal && selectedStartGoal.blocked > 0);
  const startBlockedMessage = dashboardStartBlockerMessage(selectedStartGoal, copy);
  return {
    type: 'dashboard-snapshot',
    generatedAt: new Date().toISOString(),
    runStateText: `${copy.runState}: ${run.runStatus}`,
    runStatus: run.runStatus,
    runMessage: run.runMessage,
    stopConditionText: `${copy.stopCondition}: ${run.stopConditionSummary}`,
    savedStopConditionText: savedStopCondition?.requestedText ?? '',
    goalsCount: goals.length,
    stopAgent: model.stopFile.exists ? 'present' : 'absent',
    canStart: model.selvedgeMainline.canStartInCodexApp ? 'yes' : 'no',
    aiQa: String(model.aiQaSwitch.enabled),
    activeWorkflowHtml: renderActiveWorkflow(activeGoal, copy, projectObjective),
    architectureHtml: renderArchitecturePanel(activeGoal, copy, locale, loadingAttrs),
    latestHeartbeatHtml: renderLatestHeartbeat(latestLoopStatus, copy),
    workflowRowsHtml: renderGoalRows(goals, copy, locale, loadingAttrs, runActive),
    runActive,
    startBlocked,
    canStartSelectedGoal: Boolean(selectedStartGoal || projectObjective),
    startBlockedMessage,
    startButtonText: runActive ? copy.runningButton : startBlocked ? copy.recoverAndRunButton : copy.startContinue,
    updatedAt: new Date().toISOString()
  };
}

function dashboardHtmlV2(
  cwd: string,
  model: GameHubReadOnlyModel,
  goals: ReturnType<typeof listGoalSummaries>,
  projectObjective: SelvedgeProjectObjective | null,
  heartbeatPreference: HeartbeatPreferenceRecord | null,
  runControl: Record<string, unknown> | null,
  latestLoopStatus: Record<string, unknown> | null,
  locale: DashboardLocale,
  thinkingModelLabel: string
): string {
  const copy = DASHBOARD_COPY[locale];
  const loadingMessage = dashboardThinkingMessage(locale, thinkingModelLabel);
  const loadingAttrs = `data-loading-message="${escapeHtml(loadingMessage)}" data-loading-button="${escapeHtml(copy.loadingButton)}"`;
  const escapedModel = JSON.stringify(model, null, 2)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const preferenceText =
    heartbeatPreference?.requestedText ?? copy.heartbeatPreferenceDefault;
  const normalizedFields = heartbeatPreference?.optionalFields.join(', ') ?? 'selvedge.yaml default';
  const activeGoal = resolveActiveDashboardGoal(goals, runControl, latestLoopStatus);
  const startableGoals = dashboardStartableGoals(goals);
  const selectedStartGoal = resolveActiveDashboardGoal(startableGoals, runControl, latestLoopStatus);
  const savedStopCondition = selectedStartGoal ? readSavedStopCondition(cwd, selectedStartGoal.id) : null;
  const stopConditionInput = savedStopCondition?.requestedText ?? '';
  const goalOptions = renderGoalOptions(startableGoals, copy, locale, selectedStartGoal?.id ?? null);
  const intakeCards = renderIntakeCards(goals, copy, locale, loadingAttrs);
  const runActive = dashboardRunLooksActive(runControl, latestLoopStatus);
  const startBlocked = Boolean(selectedStartGoal && selectedStartGoal.blocked > 0);
  const startBlockedMessage = dashboardStartBlockerMessage(selectedStartGoal, copy);
  const goalRows = renderGoalRows(goals, copy, locale, loadingAttrs, runActive);
  const runView = dashboardRunView(model, runControl, copy, savedStopCondition);
  const liveCopy = {
    connecting: copy.liveConnecting,
    connected: copy.liveConnected,
    reconnecting: copy.liveReconnecting,
    updatedPrefix: copy.lastUpdatedPrefix
  };
  return `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #172033; background: #f6f7f9; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 18px; margin: 0 0 12px; }
    h3 { font-size: 16px; margin: 4px 0 8px; }
    p { line-height: 1.5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 18px 0; }
    .tile, .panel, .subpanel { background: white; border: 1px solid #d7dce3; border-radius: 8px; padding: 14px; }
    .panel { margin: 18px 0; }
    .subpanel { margin: 12px 0; }
    .callout { background: #eef7ff; border: 1px solid #b9ddff; border-radius: 8px; padding: 14px; margin: 18px 0; }
    .label { font-size: 12px; text-transform: uppercase; color: #6a7280; letter-spacing: .02em; }
    .value { font-size: 20px; font-weight: 650; margin-top: 4px; }
    .muted, span { color: #6a7280; font-size: 13px; }
    [hidden] { display: none !important; }
    form { margin: 0; }
    label { display: block; font-weight: 600; margin: 10px 0 6px; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid #cfd6df; border-radius: 6px; padding: 9px 10px; font: inherit; background: white; }
    textarea { min-height: 86px; resize: vertical; }
    .objective-view { border: 1px solid #e1e5eb; border-radius: 8px; padding: 14px; background: #fbfcfd; }
    .objective-text { margin: 4px 0 0; font-size: 16px; font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
    .objective-summary-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .option-list { display: grid; gap: 8px; margin: 12px 0; }
    .option-item { display: flex; gap: 10px; align-items: flex-start; border: 1px solid #d7dce3; border-radius: 8px; padding: 10px; margin: 0; font-weight: 400; cursor: pointer; background: #fbfcfd; }
    .option-item:hover { border-color: #9aa6b2; background: #f8fbff; }
    .option-item input[type="radio"] { width: auto; flex: 0 0 auto; margin-top: 4px; }
    .option-item p { margin: 3px 0 0; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    button { border: 1px solid #1f2937; background: #1f2937; color: white; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button.secondary { background: white; color: #1f2937; }
    button.danger { border-color: #b42318; background: #b42318; }
    button:disabled { opacity: .62; cursor: wait; }
    .loading-banner { display: none; position: sticky; top: 0; z-index: 20; border: 1px solid #c6d4e1; background: #fff; border-left: 4px solid #1f2937; border-radius: 8px; padding: 12px 14px; margin: 0 0 16px; box-shadow: 0 8px 18px rgba(15, 23, 42, .08); }
    body.is-loading .loading-banner { display: flex; gap: 10px; align-items: center; }
    .spinner { width: 16px; height: 16px; border: 2px solid #c6d4e1; border-top-color: #1f2937; border-radius: 50%; animation: selvedge-spin .8s linear infinite; flex: 0 0 auto; }
    @keyframes selvedge-spin { to { transform: rotate(360deg); } }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d7dce3; border-radius: 8px; overflow: hidden; margin: 18px 0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e7eaf0; font-size: 14px; vertical-align: top; }
    th { background: #eef1f5; color: #374151; font-weight: 650; }
    pre { background: #111827; color: #e5e7eb; border-radius: 8px; padding: 14px; overflow: auto; }
    pre.heartbeat { white-space: pre-wrap; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .live-indicator { display: inline-flex; align-items: center; gap: 6px; color: #3b4658; border: 1px solid #cfd6df; border-radius: 999px; padding: 6px 9px; background: white; font-size: 13px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
    .live-indicator.connected .live-dot { background: #15803d; }
    .live-indicator.disconnected .live-dot { background: #b42318; }
    .language { display: flex; gap: 8px; align-items: center; white-space: nowrap; }
    .language a { color: #1f2937; text-decoration: none; border: 1px solid #cfd6df; border-radius: 6px; padding: 6px 8px; background: white; }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .workflow-grid { display: grid; grid-template-columns: 2fr 1fr 1.4fr; gap: 16px; margin: 12px 0 18px; }
    .workflow-goal { font-size: 16px; font-weight: 650; }
    .task-queue { list-style: none; padding: 0; margin: 8px 0 0; border: 1px solid #e1e5eb; border-radius: 8px; overflow: hidden; }
    .task-item { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #e7eaf0; background: #fff; cursor: help; }
    .task-item:last-child { border-bottom: 0; }
    .task-item.current { display: block; background: #f8fbff; border-left: 4px solid #1f2937; }
    .task-row { display: flex; justify-content: space-between; gap: 12px; cursor: help; }
    .task-title { min-width: 0; }
    .task-name { color: #172033; font-size: 14px; font-weight: 500; }
    .task-note { display: block; color: #6a7280; font-size: 13px; margin-top: 3px; overflow-wrap: anywhere; }
    .task-item strong { flex: 0 0 auto; color: #172033; font-weight: 700; }
    .task-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 12px 0 0; }
    .task-details div { min-width: 0; }
    .task-details dt { color: #6a7280; font-size: 12px; text-transform: uppercase; }
    .task-details dd { margin: 3px 0 0; overflow-wrap: anywhere; }
  </style>
  <script>
    const defaultLoadingMessage = ${JSON.stringify(loadingMessage)};
    function setDashboardLoading(form) {
      if (!form || form.dataset.loadingStarted === 'true') {
        return;
      }
      form.dataset.loadingStarted = 'true';
      document.body.classList.add('is-loading');
      const message = form.dataset.loadingMessage || defaultLoadingMessage;
      const textNode = document.getElementById('loadingText');
      if (textNode) {
        textNode.textContent = message;
      }
      const loadingButton = form.dataset.loadingButton || ${JSON.stringify(copy.loadingButton)};
      form.querySelectorAll('button').forEach(function(button) {
        if (!button.dataset.originalText) {
          button.dataset.originalText = button.textContent || '';
        }
        button.textContent = loadingButton;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      });
      form.querySelectorAll('input, textarea').forEach(function(control) {
        control.readOnly = true;
      });
      form.querySelectorAll('select').forEach(function(control) {
        control.setAttribute('aria-disabled', 'true');
      });
    }
    function toggleProjectObjectiveEdit(editing) {
      const view = document.getElementById('projectObjectiveView');
      const form = document.getElementById('projectObjectiveForm');
      if (!form) {
        return;
      }
      if (view) {
        view.hidden = Boolean(editing);
      }
      form.hidden = !editing;
      if (editing) {
        const totalGoal = document.getElementById('projectTotalGoal');
        if (totalGoal) {
          totalGoal.focus();
        }
      }
    }
    const dashboardLocale = ${JSON.stringify(locale)};
    const liveCopy = ${JSON.stringify(liveCopy)};
    let liveFallbackTimer = null;
    let snapshotRefreshTimer = null;
    function setLiveStatus(status, label) {
      const indicator = document.getElementById('liveIndicator');
      const text = document.getElementById('liveStatusText');
      if (!indicator || !text) {
        return;
      }
      indicator.classList.remove('connected', 'disconnected');
      if (status) {
        indicator.classList.add(status);
      }
      text.textContent = label;
    }
    function setText(id, value) {
      const node = document.getElementById(id);
      if (node && value !== undefined && value !== null) {
        node.textContent = String(value);
      }
    }
    function setFieldValueIfIdle(id, value) {
      const node = document.getElementById(id);
      if (!node || document.activeElement === node || node.dataset.userEdited === 'true') {
        return;
      }
      node.value = String(value || '');
    }
    function isEditingInside(node) {
      const active = document.activeElement;
      return Boolean(active && node.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
    }
    function replaceLiveHtml(id, html) {
      const node = document.getElementById(id);
      if (!node || typeof html !== 'string' || isEditingInside(node)) {
        return;
      }
      node.innerHTML = html;
    }
    function applyDashboardSnapshot(snapshot) {
      if (!snapshot || snapshot.type !== 'dashboard-snapshot') {
        return;
      }
      setText('runStateText', snapshot.runStateText);
      setText('runMessageText', snapshot.runMessage);
      setText('stopConditionText', snapshot.stopConditionText);
      setFieldValueIfIdle('stopCondition', snapshot.savedStopConditionText);
      setText('goalsMetricValue', snapshot.goalsCount);
      setText('stopAgentMetricValue', snapshot.stopAgent);
      setText('canStartMetricValue', snapshot.canStart);
      setText('aiQaMetricValue', snapshot.aiQa);
      setText('lastLiveUpdate', snapshot.updatedAt ? liveCopy.updatedPrefix + ' ' + snapshot.updatedAt : '');
      const startButton = document.getElementById('dashboardStartButton');
      if (startButton) {
        startButton.disabled = Boolean(snapshot.runActive || !snapshot.canStartSelectedGoal);
        if (snapshot.startButtonText) {
          startButton.textContent = String(snapshot.startButtonText);
        }
      }
      setText('startBlockedMessage', snapshot.startBlockedMessage || '');
      replaceLiveHtml('activeWorkflowPanel', snapshot.activeWorkflowHtml);
      replaceLiveHtml('architecturePanel', snapshot.architectureHtml);
      replaceLiveHtml('latestHeartbeatContent', snapshot.latestHeartbeatHtml);
      replaceLiveHtml('workflowRows', snapshot.workflowRowsHtml);
    }
    async function fetchDashboardSnapshot() {
      try {
        const response = await fetch('/dashboard-snapshot?lang=' + encodeURIComponent(dashboardLocale), { cache: 'no-store' });
        if (response.ok) {
          applyDashboardSnapshot(await response.json());
        }
      } catch {
        // Keep the current page state; the next retry may recover.
      }
    }
    function startLiveFallback() {
      if (liveFallbackTimer) {
        return;
      }
      setLiveStatus('disconnected', liveCopy.reconnecting);
      liveFallbackTimer = window.setInterval(fetchDashboardSnapshot, 10000);
      fetchDashboardSnapshot();
    }
    function stopLiveFallback() {
      if (liveFallbackTimer) {
        window.clearInterval(liveFallbackTimer);
        liveFallbackTimer = null;
      }
    }
    function startSnapshotRefresh() {
      if (snapshotRefreshTimer) {
        return;
      }
      snapshotRefreshTimer = window.setInterval(fetchDashboardSnapshot, 5000);
      fetchDashboardSnapshot();
    }
    function connectDashboardLiveSocket() {
      if (!('WebSocket' in window)) {
        startLiveFallback();
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(protocol + '//' + window.location.host + '/dashboard-live?lang=' + encodeURIComponent(dashboardLocale));
      socket.addEventListener('open', function() {
        stopLiveFallback();
        setLiveStatus('connected', liveCopy.connected);
      });
      socket.addEventListener('message', function(event) {
        try {
          applyDashboardSnapshot(JSON.parse(event.data));
        } catch {
          // Ignore malformed live messages.
        }
      });
      socket.addEventListener('close', function() {
        startLiveFallback();
        window.setTimeout(connectDashboardLiveSocket, 3000);
      });
      socket.addEventListener('error', function() {
        startLiveFallback();
      });
    }
    document.addEventListener('submit', function(event) {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.dataset.loadingMessage) {
        return;
      }
      if (event.defaultPrevented || form.dataset.loadingStarted === 'true') {
        event.preventDefault();
        return;
      }
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        return;
      }
      setDashboardLoading(form);
    });
    document.addEventListener('input', function(event) {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.id === 'stopCondition') {
        target.dataset.userEdited = 'true';
      }
    });
    document.addEventListener('DOMContentLoaded', function() {
      startSnapshotRefresh();
      connectDashboardLiveSocket();
    });
    function confirmSafeStop() {
      return window.confirm(${JSON.stringify(copy.confirmSafeStop1)}) &&
        window.confirm(${JSON.stringify(copy.confirmSafeStop2)});
    }
    function confirmForceStop() {
      return window.confirm(${JSON.stringify(copy.confirmForceStop1)}) &&
        window.confirm(${JSON.stringify(copy.confirmForceStop2)}) &&
        window.confirm(${JSON.stringify(copy.confirmForceStop3)});
    }
  </script>
</head>
<body>
<main>
  <section class="loading-banner" role="status" aria-live="polite" aria-atomic="true">
    <span class="spinner" aria-hidden="true"></span>
    <strong id="loadingText">${escapeHtml(loadingMessage)}</strong>
  </section>
  <div class="topbar">
    <div>
      <h1>${escapeHtml(copy.pageTitle)}</h1>
      <p class="muted">${escapeHtml(copy.subtitle)}</p>
    </div>
    <nav class="language" aria-label="${escapeHtml(copy.languageLabel)}">
      <span id="liveIndicator" class="live-indicator"><span class="live-dot" aria-hidden="true"></span><span id="liveStatusText">${escapeHtml(copy.liveConnecting)}</span></span>
      <span class="muted">${escapeHtml(copy.languageLabel)}</span>
      <a href="${dashboardPath('zh')}">${escapeHtml(copy.chinese)}</a>
      <a href="${dashboardPath('en')}">${escapeHtml(copy.english)}</a>
    </nav>
  </div>
  <section class="callout">
    <strong id="runStateText">${escapeHtml(`${copy.runState}: ${runView.runStatus}`)}</strong>
    <p id="runMessageText">${escapeHtml(runView.runMessage)}</p>
    <p id="stopConditionText" class="muted">${escapeHtml(`${copy.stopCondition}: ${runView.stopConditionSummary}`)}</p>
    <p id="lastLiveUpdate" class="muted"></p>
  </section>
  <section class="grid">
    <div class="tile"><div class="label">${escapeHtml(copy.goalsMetric)}</div><div id="goalsMetricValue" class="value">${goals.length}</div></div>
    <div class="tile"><div class="label">${escapeHtml(copy.stopAgentMetric)}</div><div id="stopAgentMetricValue" class="value">${model.stopFile.exists ? 'present' : 'absent'}</div></div>
    <div class="tile"><div class="label">${escapeHtml(copy.canStartMetric)}</div><div id="canStartMetricValue" class="value">${model.selvedgeMainline.canStartInCodexApp ? 'yes' : 'no'}</div></div>
    <div class="tile"><div class="label">${escapeHtml(copy.aiQaMetric)}</div><div id="aiQaMetricValue" class="value">${String(model.aiQaSwitch.enabled)}</div></div>
  </section>
  ${renderProjectObjectivePanel(projectObjective, goals, copy, locale, loadingAttrs, runControl)}
  <div id="activeWorkflowPanel">${renderActiveWorkflow(activeGoal, copy, projectObjective)}</div>
  <div id="architecturePanel">${renderArchitecturePanel(activeGoal, copy, locale, loadingAttrs)}</div>
  <section class="panel">
    <h2>${escapeHtml(copy.guidedIntake)}</h2>
    <p class="muted">${escapeHtml(copy.aiGuidanceNotice)}</p>
    ${intakeCards || `<p class="muted">${escapeHtml(copy.noPendingIntake)}</p>`}
  </section>
  <section class="panel">
    <h2>${escapeHtml(copy.startStop)}</h2>
    <form method="post" action="${dashboardAction('/actions/start-loop', locale)}" ${loadingAttrs}>
      <label for="goalId">${escapeHtml(copy.goalLabel)}</label>
      <select id="goalId" name="goalId">${goalOptions}</select>
      <label for="continuationGoal">${escapeHtml(dashboardNextTaskGoalLabel(locale))}</label>
      <textarea id="continuationGoal" name="continuationGoal" placeholder="${escapeHtml(dashboardNextTaskGoalPlaceholder(locale))}"></textarea>
      <p class="muted">${escapeHtml(dashboardNextTaskGoalHint(locale))}</p>
      <label for="stopCondition">${escapeHtml(copy.stopConditionBeforeStart)}</label>
      <textarea id="stopCondition" name="stopCondition" placeholder="${escapeHtml(copy.stopConditionPlaceholder)}">${escapeHtml(stopConditionInput)}</textarea>
      <p class="muted">${escapeHtml(dashboardRuntimeText(locale, 'stopConditionHint'))}</p>
      <p id="startBlockedMessage" class="muted">${escapeHtml(startBlockedMessage)}</p>
      <div class="actions">
        <button id="dashboardStartButton" type="submit" ${(!selectedStartGoal && !projectObjective) || runActive ? 'disabled' : ''}>${escapeHtml(runActive ? copy.runningButton : startBlocked ? copy.recoverAndRunButton : copy.startContinue)}</button>
        <button class="secondary" type="submit" formaction="${dashboardAction('/actions/update-stop-condition', locale)}" ${!selectedStartGoal ? 'disabled' : ''}>${escapeHtml(dashboardRuntimeText(locale, 'saveStopCondition'))}</button>
        <button class="secondary" type="submit" formaction="${dashboardAction('/actions/clear-stop-condition', locale)}" ${!selectedStartGoal ? 'disabled' : ''}>${escapeHtml(dashboardRuntimeText(locale, 'clearStopCondition'))}</button>
      </div>
    </form>
    <div class="actions">
      <form method="post" action="${dashboardAction('/actions/stop-safe', locale)}" ${loadingAttrs} onsubmit="return confirmSafeStop()"><button class="secondary" type="submit">${escapeHtml(copy.safeStop)}</button></form>
      <form method="post" action="${dashboardAction('/actions/stop-force', locale)}" ${loadingAttrs} onsubmit="return confirmForceStop()"><button class="danger" type="submit">${escapeHtml(copy.forceStop)}</button></form>
    </div>
  </section>
  <section class="panel">
    <h2>${escapeHtml(copy.latestHeartbeat)}</h2>
    <div id="latestHeartbeatContent">${renderLatestHeartbeat(latestLoopStatus, copy)}</div>
  </section>
  <section class="panel">
    <h2>${escapeHtml(copy.heartbeatWording)}</h2>
    <form method="post" action="${dashboardAction('/actions/heartbeat-preference', locale)}" ${loadingAttrs}>
      <label for="heartbeatPreference">${escapeHtml(copy.heartbeatPreferenceLabel)}</label>
      <textarea id="heartbeatPreference" name="preference">${escapeHtml(preferenceText)}</textarea>
      <p class="muted">${escapeHtml(copy.normalizedFields)}: ${escapeHtml(normalizedFields)}</p>
      <button type="submit">${escapeHtml(copy.saveHeartbeatPreference)}</button>
    </form>
  </section>
  <section class="panel">
    <h2>${escapeHtml(copy.workflowSummary)}</h2>
    <table>
      <thead><tr><th>${escapeHtml(copy.idHeader)}</th><th>${escapeHtml(copy.goalHeader)}</th><th>${escapeHtml(copy.progressHeader)}</th><th>${escapeHtml(copy.intakeHeader)}</th><th>${escapeHtml(copy.nextStepHeader)}</th><th>${escapeHtml(copy.targetHeader)}</th><th>${escapeHtml(copy.loopHeader)}</th><th>${escapeHtml(copy.quickRunHeader)}</th></tr></thead>
      <tbody id="workflowRows">${goalRows}</tbody>
    </table>
  </section>
  <details>
    <summary>${escapeHtml(copy.technicalState)}</summary>
    <pre>${escapedModel}</pre>
  </details>
</main>
</body>
</html>`;
}

export function renderDashboardHtmlForTest(cwd: string, locale: DashboardLocale = 'en'): string {
  const model = buildReadOnlyModel(cwd);
  const goals = listGoalSummaries(cwd);
  return dashboardHtmlV2(
    cwd,
    model,
    goals,
    readProjectObjective(cwd),
    readHeartbeatPreference(cwd),
    readDashboardRunControl(cwd),
    latestLoopStatusForGoals(cwd, goals),
    locale,
    'gpt-5.5-xhigh'
  );
}

function openDashboardUrl(url: string): void {
  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', (error) => {
      console.error(`Could not open Selvedge dashboard automatically: ${error.message}`);
      console.error(`Open it manually: ${url}`);
    });
    child.unref();
  } catch (error) {
    console.error(`Could not open Selvedge dashboard automatically: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Open it manually: ${url}`);
  }
}

function isExistingSelvedgeDashboard(url: string): Promise<boolean> {
  const snapshotUrl = new URL('/dashboard-snapshot?lang=zh', url);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const request = httpGet(snapshotUrl, { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (body.length < 4096) {
          body += chunk;
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish(false);
          return;
        }
        try {
          const parsed = JSON.parse(body) as { readonly type?: unknown };
          finish(parsed.type === 'dashboard-snapshot');
        } catch {
          finish(false);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });
}

async function reuseExistingDashboard(port: number, shouldOpenBrowser: boolean): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const isSelvedge = await isExistingSelvedgeDashboard(url);
  if (!isSelvedge) {
    console.error(`Selvedge dashboard is already bound or another process is using port ${port}.`);
    console.error(`Open the existing dashboard if it is Selvedge: ${url}`);
    console.error(`Or start this one on another port: pnpm selvedge dashboard --port <free-port>`);
    console.error(`On Windows, inspect the owner with: Get-NetTCPConnection -LocalPort ${port} -State Listen`);
    console.error('No new dashboard was started.');
    return;
  }
  console.log(`Selvedge dashboard is already running: ${url}`);
  if (shouldOpenBrowser) {
    console.log(`Opening existing Selvedge dashboard: ${url}`);
    openDashboardUrl(url);
  } else {
    console.log(`Open existing Selvedge dashboard manually: ${url}`);
  }
}

const DASHBOARD_WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function websocketAcceptKey(key: string): string {
  return createHash('sha1').update(`${key}${DASHBOARD_WEBSOCKET_GUID}`).digest('base64');
}

function websocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function sendDashboardLiveSnapshot(
  socket: Duplex,
  cwd: string,
  locale: DashboardLocale,
  thinkingModelLabel: string
): void {
  if (socket.destroyed) {
    return;
  }
  try {
    socket.write(websocketTextFrame(JSON.stringify(dashboardSnapshot(cwd, locale, thinkingModelLabel))));
  } catch {
    socket.destroy();
  }
}

function upgradeDashboardLiveSocket(
  request: IncomingMessage,
  socket: Duplex,
  cwd: string,
  port: number,
  thinkingModelLabel: string,
  registerCleanup: (socket: Duplex, timer: NodeJS.Timeout) => void,
  unregisterCleanup: (socket: Duplex) => void
): void {
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (requestUrl.pathname !== '/dashboard-live') {
    socket.destroy();
    return;
  }
  const keyHeader = request.headers['sec-websocket-key'];
  const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  if (!key) {
    socket.destroy();
    return;
  }
  const locale = resolveDashboardLocale(requestUrl, request);
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
    '',
    ''
  ].join('\r\n'));
  sendDashboardLiveSnapshot(socket, cwd, locale, thinkingModelLabel);
  const timer = setInterval(() => {
    sendDashboardLiveSnapshot(socket, cwd, locale, thinkingModelLabel);
  }, 5000);
  timer.unref();
  registerCleanup(socket, timer);
  const cleanup = () => unregisterCleanup(socket);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', cleanup);
  socket.on('data', (chunk: Buffer) => {
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x8) {
      socket.end();
    }
  });
}

export function runServe(options: CliOptions): number {
  const portIndex = options.args.findIndex((arg) => arg === '--port');
  const parsedPort = portIndex >= 0 ? Number(options.args[portIndex + 1]) : 17371;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 17371;
  const shouldOpenBrowser = !options.args.includes('--no-open');
  let dashboardServerStarted = false;
  const liveSocketTimers = new Map<Duplex, NodeJS.Timeout>();
  const registerLiveSocket = (socket: Duplex, timer: NodeJS.Timeout) => {
    liveSocketTimers.set(socket, timer);
  };
  const unregisterLiveSocket = (socket: Duplex) => {
    const timer = liveSocketTimers.get(socket);
    if (timer) {
      clearInterval(timer);
    }
    liveSocketTimers.delete(socket);
  };
  const closeLiveSockets = () => {
    for (const [socket, timer] of liveSocketTimers.entries()) {
      clearInterval(timer);
      if (!socket.destroyed) {
        socket.end();
      }
    }
    liveSocketTimers.clear();
  };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const locale = resolveDashboardLocale(requestUrl, request);
    if (request.method === 'GET' && requestUrl.pathname === '/dashboard-snapshot') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(dashboardSnapshot(options.cwd, locale, dashboardThinkingModelLabel(options.args))));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/project-objective') {
      const body = await readRequestBody(request);
      const model = buildReadOnlyModel(options.cwd);
      const existing = readProjectObjective(options.cwd);
      const plannedWorkflowId =
        dashboardWorkflowIds(options.cwd).length === 0
          ? uniqueGoalId(options.cwd, body.get('totalGoal')?.trim() || 'project-objective')
          : null;
      const draft = createDashboardProjectObjectiveDraft(options.cwd, body, existing, plannedWorkflowId);
      if (!draft) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Project objective total goal is required.');
        return;
      }
      const saveResult = saveProjectObjectiveWithReview(options.cwd, draft, dashboardCodexRunnerArgs(options.args));
      if (saveResult.saved && plannedWorkflowId && saveResult.objective) {
        const workflow = enhanceDashboardWorkflowWithAi(
          options.cwd,
          createGoalWorkflow(
            createWorkflowInputFromProjectObjective(saveResult.objective, body, plannedWorkflowId),
            model
          ),
          model,
          dashboardCodexRunnerArgs(options.args)
        );
        writeWorkflowResult(options.cwd, workflow, model);
      }
      writeJson(dashboardRunControlPath(options.cwd), {
        ...compactDashboardRunControl(readDashboardRunControl(options.cwd)),
        status: saveResult.saved ? 'ProjectObjectiveSaved' : 'ProjectObjectiveNeedsRevision',
        updatedAt: new Date().toISOString(),
        projectObjectiveReviewStatus: saveResult.review.status,
        projectObjectiveReviewMessage: saveResult.saved ? DASHBOARD_COPY[locale].projectObjectiveSaved : DASHBOARD_COPY[locale].projectObjectiveBlocked,
        projectObjectiveReviewSummary: saveResult.review.summary,
        projectObjectiveReviewConflicts: saveResult.review.conflicts,
        projectObjectivePath: saveResult.saved ? projectObjectiveMarkdownPath(options.cwd) : null
      });
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/create-goal') {
      const body = await readRequestBody(request);
      const model = buildReadOnlyModel(options.cwd);
      const input = createDashboardGoalInput(options.cwd, body);
      if (!input) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal is required.');
        return;
      }
      const workflow = enhanceDashboardWorkflowWithAi(
        options.cwd,
        createGoalWorkflow(input, model),
        model,
        dashboardCodexRunnerArgs(options.args)
      );
      writeWorkflowResult(options.cwd, workflow, model);
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/answer-intake') {
      const body = await readRequestBody(request);
      const goalId = body.get('goalId')?.trim();
      const questionId = body.get('questionId')?.trim();
      const selectedOptionId = body.get('selectedOption')?.trim();
      const answerText = body.get('answer')?.trim() ?? '';
      const workflow = goalId ? readGoalWorkflow(options.cwd, goalId) : null;
      const answer = workflow && questionId
        ? resolveDashboardIntakeAnswer(workflow, questionId, selectedOptionId, answerText)
        : null;
      if (!goalId || !questionId || !answer || !workflow) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal, question, and either an option or custom answer are required.');
        return;
      }
      const aiAnswer = normalizeIntakeAnswerWithAi(
        options.cwd,
        workflow,
        questionId,
        answer,
        dashboardCodexRunnerArgs(options.args)
      );
      answerWorkflowIntakeQuestion(
        options.cwd,
        workflow,
        questionId,
        aiAnswer.answer,
        buildReadOnlyModel(options.cwd),
        aiAnswer.followUpQuestion
      );
      if (aiAnswer.evidence) {
        writeJson(localStatePath(options.cwd, 'status', `${workflow.id}.last-intake-ai.json`), {
          workflowId: workflow.id,
          questionId,
          updatedAt: new Date().toISOString(),
          evidence: aiAnswer.evidence,
          addedFollowUpQuestion: aiAnswer.followUpQuestion?.id ?? null
        });
      }
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/confirm-architecture') {
      const body = await readRequestBody(request);
      const goalId = body.get('goalId')?.trim();
      const workflow = goalId ? readGoalWorkflow(options.cwd, goalId) : null;
      if (!goalId || !workflow) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal workflow not found.');
        return;
      }
      confirmWorkflowArchitecture(options.cwd, workflow, buildReadOnlyModel(options.cwd));
      writeJson(dashboardRunControlPath(options.cwd), {
        ...compactDashboardRunControl(readDashboardRunControl(options.cwd)),
        status: 'ArchitectureConfirmed',
        updatedAt: new Date().toISOString(),
        goalId,
        message: 'Architecture proposal confirmed. The workflow may now start when intake is complete.'
      });
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && (requestUrl.pathname === '/actions/stop-safe' || requestUrl.pathname === '/actions/stop')) {
      requestSafeStop(options.cwd, 'Safe stop requested from Selvedge dashboard.');
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/stop-force') {
      requestForceStop(options.cwd, 'Force stop requested from Selvedge dashboard.');
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/start-loop') {
      const body = await readRequestBody(request);
      const goalId = body.get('goalId')?.trim();
      const model = buildReadOnlyModel(options.cwd);
      const runnerArgs = dashboardCodexRunnerArgs(options.args);
      if (!goalId) {
        const objective = readProjectObjective(options.cwd);
        if (!objective) {
          writeJson(dashboardRunControlPath(options.cwd), {
            ...compactDashboardRunControl(readDashboardRunControl(options.cwd)),
            status: 'NeedsProjectObjective',
            updatedAt: new Date().toISOString(),
            goalId: null,
            message: 'Save the project objective before starting the next task from the dashboard.'
          });
          redirectDashboard(response, locale);
          return;
        }
        const nextWorkflow = createNextDashboardWorkflowForProjectObjectiveStart(
          options.cwd,
          objective,
          body.get('continuationGoal')?.trim() ?? '',
          model
        );
        startGoalLoopFromDashboard(
          options.cwd,
          nextWorkflow.id,
          body.get('stopCondition') ?? '',
          runnerArgs
        );
        redirectDashboard(response, locale);
        return;
      }
      if (!goalId || !readGoalWorkflow(options.cwd, goalId)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal workflow not found.');
        return;
      }
      const workflow = readGoalWorkflow(options.cwd, goalId)!;
      if (!workflow.profile || !workflow.aiIntake || !Array.isArray(workflow.tasks)) {
        writeJson(dashboardRunControlPath(options.cwd), {
          status: 'LegacyWorkflowNeedsMigration',
          updatedAt: new Date().toISOString(),
          goalId,
          message: 'This workflow uses an older Selvedge schema. Create a new dashboard goal or migrate the workflow before starting it.'
        });
        redirectDashboard(response, locale);
        return;
      }
      if (workflow.aiIntake.userDialogueRequired) {
        writeJson(dashboardRunControlPath(options.cwd), {
          status: 'NeedsIntake',
          updatedAt: new Date().toISOString(),
          goalId,
          message: 'Answer the guided intake questions before starting this goal.'
        });
        redirectDashboard(response, locale);
        return;
      }
      if (workflow.architecture?.status === 'pending-confirmation') {
        writeJson(dashboardRunControlPath(options.cwd), {
          status: 'NeedsArchitectureConfirmation',
          updatedAt: new Date().toISOString(),
          goalId,
          message: DASHBOARD_COPY[locale].architectureStartBlocked
        });
        redirectDashboard(response, locale);
        return;
      }
      const continuationWorkflow = createContinuousWorkflowContinuationForDashboardStart(
        options.cwd,
        workflow,
        model,
        body.get('continuationGoal')?.trim() ?? ''
      );
      if (continuationWorkflow) {
        startGoalLoopFromDashboard(
          options.cwd,
          continuationWorkflow.id,
          body.get('stopCondition') ?? '',
          runnerArgs
        );
        redirectDashboard(response, locale);
        return;
      }
      if (workflowIsFullyCompleted(workflow) && !selectNextWorkflowTask(workflow)) {
        writeJson(dashboardRunControlPath(options.cwd), {
          ...compactDashboardRunControl(readDashboardRunControl(options.cwd)),
          status: 'NoPendingRunnableTask',
          updatedAt: new Date().toISOString(),
          goalId,
          message: 'The selected workflow is complete and has no pending runnable task. Create a new goal, or use a KG slots completed workflow so Selvedge can create the next continuation workflow.'
        });
        writeLoopStatus(options.cwd, goalId, 'Completed', 'No pending runnable task remains for this completed workflow.');
        redirectDashboard(response, locale);
        return;
      }
      const startPreparation = prepareBlockedWorkflowForDashboardStart(options.cwd, workflow);
      if (startPreparation.blockingReason && !startPreparation.prepared) {
        writeJson(dashboardRunControlPath(options.cwd), {
          ...compactDashboardRunControl(readDashboardRunControl(options.cwd)),
          status: 'NeedsHumanInput',
          updatedAt: new Date().toISOString(),
          goalId,
          message: startPreparation.message
        });
        writeLoopStatus(options.cwd, goalId, 'NeedsHumanInput', startPreparation.message);
        redirectDashboard(response, locale);
        return;
      }
      if (startPreparation.prepared) {
        writeLoopStatus(options.cwd, goalId, 'Preparing', startPreparation.message, {
          recoveryTaskId: startPreparation.recoveryTaskId,
          blockedTaskId: startPreparation.blockedTaskId
        });
      }
      startGoalLoopFromDashboard(
        options.cwd,
        goalId,
        body.get('stopCondition') ?? '',
        runnerArgs,
        startPreparation.prepared ? startPreparation : null
      );
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/update-stop-condition') {
      const body = await readRequestBody(request);
      const goalId = body.get('goalId')?.trim();
      if (!goalId || !readGoalWorkflow(options.cwd, goalId)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal workflow not found.');
        return;
      }
      updateDashboardStopCondition(
        options.cwd,
        goalId,
        body.get('stopCondition') ?? '',
        dashboardCodexRunnerArgs(options.args),
        locale
      );
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/clear-stop-condition') {
      const body = await readRequestBody(request);
      const goalId = body.get('goalId')?.trim();
      if (!goalId || !readGoalWorkflow(options.cwd, goalId)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Goal workflow not found.');
        return;
      }
      clearDashboardStopCondition(options.cwd, goalId, locale);
      redirectDashboard(response, locale);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/heartbeat-preference') {
      const body = await readRequestBody(request);
      saveHeartbeatPreference(options.cwd, body.get('preference') ?? '', dashboardCodexRunnerArgs(options.args));
      redirectDashboard(response, locale);
      return;
    }
    const model = buildReadOnlyModel(options.cwd);
    const goals = listGoalSummaries(options.cwd);
    const projectObjective = readProjectObjective(options.cwd);
    const heartbeatPreference = readHeartbeatPreference(options.cwd);
    const runControl = readDashboardRunControl(options.cwd);
    const latestLoopStatus = latestLoopStatusForGoals(options.cwd, goals);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(dashboardHtmlV2(
      options.cwd,
      model,
      goals,
      projectObjective,
      heartbeatPreference,
      runControl,
      latestLoopStatus,
      locale,
      dashboardThinkingModelLabel(options.args)
    ));
  });
  server.on('upgrade', (request, socket) => {
    upgradeDashboardLiveSocket(
      request,
      socket,
      options.cwd,
      port,
      dashboardThinkingModelLabel(options.args),
      registerLiveSocket,
      unregisterLiveSocket
    );
  });
  const shutdown = (reason: string) => {
    if (!dashboardServerStarted) {
      closeLiveSockets();
      process.exitCode = 0;
      process.exit();
      return;
    }
    requestDashboardShutdownSafeStop(options.cwd, reason);
    closeLiveSockets();
    server.close(() => {
      process.exitCode = 0;
      process.exit();
    });
    setTimeout(() => {
      process.exitCode = 0;
      process.exit();
    }, 1000).unref();
  };
  process.once('SIGINT', () => shutdown('Safe stop requested because the Selvedge dashboard process received SIGINT.'));
  process.once('SIGTERM', () => shutdown('Safe stop requested because the Selvedge dashboard process received SIGTERM.'));
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => shutdown('Safe stop requested because the Selvedge dashboard process received SIGHUP.'));
  }
  process.once('exit', () => {
    if (dashboardServerStarted) {
      requestDashboardShutdownSafeStop(options.cwd, 'Safe stop requested because the Selvedge dashboard process exited.');
    }
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      void reuseExistingDashboard(port, shouldOpenBrowser).catch((reuseError) => {
        console.error(`Could not inspect the existing dashboard on port ${port}: ${reuseError instanceof Error ? reuseError.message : String(reuseError)}`);
        console.error(`Open the existing dashboard manually if it is Selvedge: http://127.0.0.1:${port}/`);
      });
      process.exitCode = 0;
    } else {
      console.error(`Selvedge dashboard failed to start on port ${port}: ${error.message}`);
      process.exitCode = 1;
    }
  });
  server.listen(port, '127.0.0.1', () => {
    dashboardServerStarted = true;
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Selvedge control console: ${url}`);
    if (shouldOpenBrowser) {
      console.log(`Opening Selvedge dashboard: ${url}`);
      openDashboardUrl(url);
    }
  });
  return 0;
}
