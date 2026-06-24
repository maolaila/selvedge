import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, localStatePath, writeJson, writeText } from './fs-utils';
import { getWorkflowProfile } from './profiles';
import type {
  GameHubReadOnlyModel,
  GoalWorkflowInput,
  SelvedgeGoalWorkflow,
  SelvedgeRequirementQuestionOption,
  SelvedgeRequirementQuestion,
  SelvedgeArchitectureProposal,
  SelvedgeWorkflowControlPolicy,
  SelvedgeWorkflowPhase,
  SelvedgeTaskStatus,
  SelvedgeWorkflowTask
} from './types';

const DEFAULT_GOAL_WRITE_SET = ['NeedsDecision: declare implementation WriteSet before development execution'];
const DEFAULT_GOAL_VALIDATION = [
  'git diff --check',
  'NeedsDecision: add goal-specific typecheck, tests, browser smoke, or QA evidence'
];
export const SMALL_STEP_CONTROL_POLICY: SelvedgeWorkflowControlPolicy = {
  executionMode: 'small-step-queue',
  longGoalExecution: 'forbidden',
  codexInvocation: 'single-subtask-only',
  notes: [
    'The total goal is a durable requirements and planning input only.',
    'Selvedge must never send the total goal as one broad Codex /goal-style execution.',
    'Every runner invocation receives exactly one dependency-ready subtask with WriteSet, validation, artifacts, and stop policy.',
    'Resume after stop uses the persisted subtask queue instead of re-running the broad objective.'
  ]
};

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function workflowRoot(cwd: string, id: string): string {
  return localStatePath(cwd, 'goals', id);
}

export function workflowPath(cwd: string, id: string): string {
  return join(workflowRoot(cwd, id), 'goal.workflow.json');
}

function docPath(id: string, fileName: string): string {
  return join('.selvedge', 'goals', id, fileName);
}

function parseAnswer(answer: string): { id: string; value: string } | null {
  const index = answer.indexOf('=');
  if (index <= 0) {
    return null;
  }
  return {
    id: answer.slice(0, index).trim(),
    value: answer.slice(index + 1).trim()
  };
}

function buildAnswerMap(answers: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of answers) {
    const parsed = parseAnswer(raw);
    if (parsed && parsed.value.length > 0) {
      result.set(parsed.id, parsed.value);
    }
  }
  return result;
}

function option(id: string, label: string, description: string, answer: string): SelvedgeRequirementQuestionOption {
  return { id, label, description, answer };
}

const QUESTION_OPTIONS: Record<string, readonly SelvedgeRequirementQuestionOption[]> = {
  'business-outcome': [
    option('build', 'Build or extend a product', 'Selvedge should deliver working product behavior.', 'Build or extend a working product capability and keep unrelated scope out.'),
    option('migrate', 'Migrate existing behavior', 'Selvedge should preserve authority-source behavior while moving it into this project.', 'Migrate existing behavior from authority sources with parity evidence before handoff.'),
    option('qa-repair', 'QA and repair', 'Selvedge should test, classify defects, repair, and regress.', 'Run QA, classify defects, repair blockers, and produce regression evidence.')
  ],
  'users-and-entry': [
    option('nontechnical-dashboard', 'Dashboard for non-technical users', 'The dashboard is the primary control surface.', 'Primary users operate through the Selvedge dashboard; terminal output is only a heartbeat monitor.'),
    option('developer-cli-dashboard', 'Developer plus dashboard', 'Developers may still use CLI commands for setup and diagnostics.', 'Developers can use CLI commands, but dashboard remains the normal task control surface.'),
    option('automation-only', 'Automation operator', 'The workflow is mostly scheduled or unattended.', 'The result should support long unattended operation with durable logs, stop policies, and handoff evidence.')
  ],
  'authority-sources': [
    option('repo-docs-code', 'Current repo docs and code', 'Use this repository as the source of truth.', 'Use current repository docs, code, tests, and runtime state as authority sources.'),
    option('external-source', 'External source project or system', 'A source repo, legacy app, API, or package must be read first.', 'Use the named external source project/system as read-only authority before implementation.'),
    option('ask-before-changing', 'Ask before behavior changes', 'If authority is unclear, stop and ask.', 'Stop and ask for authority-source clarification before behavior-changing work.')
  ],
  'write-boundary': [
    option('infer-safe', 'Let Selvedge infer safe areas', 'Selvedge proposes the WriteSet during planning.', 'Selvedge may infer a conservative WriteSet and must stop before writing outside it.'),
    option('docs-first', 'Docs and planning first', 'No product code until requirements and task boundaries are clear.', 'Start with docs/planning only; product code requires a later explicit task boundary.'),
    option('explicit-only', 'Only explicitly listed areas', 'If not listed, do not write.', 'Only write explicitly approved paths; missing WriteSet is a blocker.')
  ],
  'development-flow': [
    option('standard', 'Standard Selvedge flow', 'Intake, planning, development, QA, handoff.', 'Use intake -> requirements -> task decomposition -> bounded development -> QA -> handoff.'),
    option('docs-first', 'Planning before implementation', 'Map facts and tasks before code.', 'Complete authority mapping and task decomposition before implementation starts.'),
    option('small-slices', 'Small execution slices', 'Split large work into small safe tasks.', 'Split development into small dependency-ready slices with one task boundary at a time.')
  ],
  'qa-flow': [
    option('standard-validation', 'Standard validation', 'Run typecheck/tests/build/diff checks where applicable.', 'Run declared validation, classify failures, and keep evidence paths in handoff.'),
    option('independent-audit', 'Independent review required', 'Use a fresh source-vs-implementation review before handoff.', 'Run independent QA/audit after implementation and block handoff on mismatch blockers.'),
    option('browser-smoke', 'Browser/runtime smoke required', 'Use real runtime checks when user-facing behavior matters.', 'Run browser or runtime smoke after logic validation, then record evidence.')
  ],
  'stop-and-recovery': [
    option('safe-default', 'Safe stop on uncertainty', 'Stop on missing authority, unsafe write, or failed validation.', 'Stop on validation failure, missing authority, unsafe WriteSet, unsupported runner, or unclear next action.'),
    option('ask-human', 'Ask human for decisions', 'Use human review when scope or risk is unclear.', 'Ask the user before expanding scope, changing authority boundaries, or retrying ambiguous failures.'),
    option('recover-before-restart', 'Recover before restart', 'If prior stop was unsafe, inspect and repair state first.', 'After unsafe stop or crash, run recovery inspection before clearing stop markers and continuing.')
  ],
  handoff: [
    option('dashboard-summary', 'Dashboard summary', 'Show final status and next action clearly.', 'Show final status, evidence paths, validation results, blockers, and next action in dashboard/handoff docs.'),
    option('review-ready', 'Human review package', 'Prepare evidence for a human accept/reject decision.', 'Prepare a review-ready handoff with scope, diff, validation, risks, and rollback guidance.'),
    option('continue-next', 'Continue with next task', 'When complete, prepare the next Selvedge task cleanly.', 'Record what finished, what remains, and how the next Selvedge task should start.')
  ],
  'kg-source-paths': [
    option('primary-kg', 'Use primary KG sources', 'Use the normal read-only KG source paths.', '../kg-cocos-client and ../kg-php are read-only primary sources.'),
    option('with-fallback', 'Use fallback only if missing', 'Use archive fallback only with evidence.', '../kg is a read-only fallback only when primary sources are missing; record reason, path, size/hash, and differences.'),
    option('ask-paths', 'Ask me for paths', 'Stop if the source paths are not clear.', 'Stop and ask for exact source paths before source inventory.')
  ]
};

function question(
  answerMap: Map<string, string>,
  id: string,
  text: string,
  reason: string,
  assumption: string,
  nonInteractive: boolean,
  options: readonly SelvedgeRequirementQuestionOption[] = QUESTION_OPTIONS[id] ?? []
): SelvedgeRequirementQuestion {
  const answer = answerMap.get(id);
  if (answer) {
    return { id, question: text, reason, answer, status: 'answered', options };
  }
  if (nonInteractive) {
    return { id, question: text, reason, answer: assumption, status: 'assumption', options };
  }
  return { id, question: text, reason, answer: null, status: 'needs-user', options };
}

function kgSlotsTargetQuestion(
  answerMap: Map<string, string>,
  nonInteractive: boolean
): SelvedgeRequirementQuestion {
  const rawAnswer = answerMap.get('target-game');
  const answerLooksLikePlaceholder =
    !rawAnswer ||
    rawAnswer.trim().length === 0 ||
    /<.*>/.test(rawAnswer) ||
    /code\/route/i.test(rawAnswer) ||
    /auto|agent|controller|master|总控/i.test(rawAnswer);
  if (answerLooksLikePlaceholder) {
    const options = [
      option('auto-select', '让 Selvedge 选择', 'Selvedge 选择下一款符合条件的 slots 目标，并记录证据。', 'AuthorizedAutoSelect: Selvedge 总控必须在 source inventory 阶段选择下一款符合条件的 KG slots 目标，记录候选集、排除原因、route/gameCode 和选择证据，然后才能进入 runtime work。'),
      option('specific-target', '我提供目标', '已知道 route/gameCode 时使用。', 'NeedsUserTarget: 用户会在 runtime work 前提供明确的 KG slots 目标、route 和 gameCode。'),
      option('pause-selection', '不清楚就停止', '源码证据不足时不要猜。', '如果无法从权威事实源证明存在符合条件的 slots 候选，停止并请求用户确认。')
    ];
    return {
      id: 'target-game',
      question: '下一款 KG slots 类游戏目标是哪一个？GameHub 应该使用哪个 route/gameCode？',
      reason: 'slots 迁移进入 runtime work 前必须有明确目标；如果用户授权 Selvedge 自动选择，也必须先记录选择证据。',
      answer:
        'AuthorizedAutoSelect: Selvedge 总控必须在 source inventory 阶段选择下一款符合条件的 KG slots 目标，记录候选集、排除原因、route/gameCode 和选择证据，然后才能进入 runtime work。',
      status: nonInteractive ? 'assumption' : 'answered',
      options
    };
  }
  return {
    id: 'target-game',
    question: '下一款 KG slots 类游戏目标是哪一个？GameHub 应该使用哪个 route/gameCode？',
    reason: 'slots 迁移不能从未命名的目录项开始。',
    answer: rawAnswer,
    status: 'answered',
    options: [
      option('auto-select', '让 Selvedge 选择', 'Selvedge 选择下一款符合条件的 slots 目标，并记录证据。', 'AuthorizedAutoSelect: Selvedge 总控必须在 source inventory 阶段选择下一款符合条件的 KG slots 目标，记录候选集、排除原因、route/gameCode 和选择证据，然后才能进入 runtime work。'),
      option('specific-target', '我提供目标', '已知道 route/gameCode 时使用。', 'NeedsUserTarget: 用户会在 runtime work 前提供明确的 KG slots 目标、route 和 gameCode。')
    ]
  };
}

function kgGameTargetQuestion(
  answerMap: Map<string, string>,
  fallbackGoal: string,
  nonInteractive: boolean
): SelvedgeRequirementQuestion {
  const rawAnswer = answerMap.get('target-game')?.trim();
  return {
    id: 'target-game',
    question: '要迁移哪一种 KG 游戏类型和哪一款具体游戏？GameHub 应该使用哪个 route/gameCode？',
    reason: '新的 KG 游戏类型迁移必须从一个明确的源码目标开始，不能复用 slots 假设。',
    answer: rawAnswer || fallbackGoal,
    status: rawAnswer || nonInteractive ? 'answered' : 'needs-user',
    options: [
      option('specific-target', '使用指定目标', '已知道 route/gameCode 或源码目录时使用。', '用户已在 runtime work 前提供明确的 KG 目标、源码目录、route 和 gameCode。'),
      option('source-intake-first', '先从源码盘点', '类型已批准但具体源码入口还需要盘点时使用。', 'Selvedge 必须先做 docs-only KG source intake，识别一个明确目标；如果目标证据不清楚，停止并请求用户确认。'),
      option('pause-selection', '不清楚就停止', '不要猜测新类型目标。', '如果无法从权威事实源证明 KG 目标、route 或游戏类型，停止并请求用户确认。')
    ]
  };
}

function buildQuestions(input: GoalWorkflowInput, model: GameHubReadOnlyModel): readonly SelvedgeRequirementQuestion[] {
  const answers = buildAnswerMap(input.answers);
  const baseQuestions = [
    question(
      answers,
      'business-outcome',
      '这个目标最终要交付什么业务结果？哪些内容明确不在范围内？',
      '防止规划器把目标扩展成无关的产品工作。',
      input.goal,
      input.nonInteractive
    ),
    question(
      answers,
      'users-and-entry',
      '谁会使用这个结果？他们第一次应该通过什么安装或执行方式使用？',
      '明确产品入口、包形态和首次运行路径。',
      '优先支持 npm/pnpm CLI 和本地 dashboard 控制台；原生安装器属于后续企业包装。',
      input.nonInteractive
    ),
    question(
      answers,
      'authority-sources',
      '哪些文档、API、源码项目或运行证据是权威事实源？',
      '在写实现前锁定事实来源。',
      '使用当前用户指令、selvedge.yaml、Selvedge 文档、TASK_BOARD、AGENTS.md 和现有 autopilot 脚本。',
      input.nonInteractive
    ),
    question(
      answers,
      'write-boundary',
      '这项工作允许修改哪些文件？哪些文件或系统禁止修改？',
      '防止长期自动执行产生失控改动。',
      input.writeSet.length > 0 ? input.writeSet.join(', ') : DEFAULT_GOAL_WRITE_SET.join(', '),
      input.nonInteractive
    ),
    question(
      answers,
      'development-flow',
      '进入 QA 前应该经历哪些开发阶段？',
      '把需求澄清、实现和验证分开。',
      'intake -> 目标文档 -> 任务拆解 -> 有边界的开发任务',
      input.nonInteractive
    ),
    question(
      answers,
      'qa-flow',
      '哪些 QA 阶段或证据可以证明工作可接受？',
      '让验收证据明确，而不是只依赖实现者描述。',
      input.validation.length > 0 ? input.validation.join('; ') : DEFAULT_GOAL_VALIDATION.join('; '),
      input.nonInteractive
    ),
    question(
      answers,
      'stop-and-recovery',
      'Selvedge 在什么情况下应该停止、询问用户、重试或记录 blocker？',
      '无人值守或长期运行必须有清晰停机策略。',
      '遇到验证失败、不安全 WriteSet、缺少权威事实源、不支持的 runner、STOP policy 冲突或用户决策不清楚时停止。',
      input.nonInteractive
    ),
    question(
      answers,
      'handoff',
      '运行完成或阻塞时，用户应该看到哪些状态和证据？',
      '定义建立信任所需的状态和证据界面。',
      '目标文档、任务队列状态、命令日志、验证结果、失败分类、下一步动作和回滚指引。',
      input.nonInteractive
    ),
    question(
      answers,
      'gamehub-current-state',
      '当前 GameHub adapter 对可执行工作有什么判断？',
      '让 Selvedge 与既有 Autopilot 阶段门保持一致。',
      `${model.firstExecutableTask.reason} ${model.selvedgeMainline.reason}`,
      true
    )
  ];
  if (input.profile === 'kg-slots-migration') {
    return [
      baseQuestions[0],
      kgSlotsTargetQuestion(answers, input.nonInteractive),
      baseQuestions[1],
      baseQuestions[2],
      question(
        answers,
        'kg-source-paths',
        '哪些 KG Cocos 和 KG PHP 路径可以证明目标游戏行为？',
        '进入 runtime work 前，功能盘点和 parity ledger 必须有源码证据。',
        '../kg-cocos-client 和 ../kg-php 是只读主事实源；仅当主事实源缺失时，../kg 才作为只读兜底来源。',
        input.nonInteractive
      ),
      ...baseQuestions.slice(3)
    ].filter((item): item is SelvedgeRequirementQuestion => Boolean(item));
  }
  if (input.profile === 'kg-game-migration') {
    return [
      baseQuestions[0],
      kgGameTargetQuestion(answers, input.goal, input.nonInteractive),
      baseQuestions[1],
      baseQuestions[2],
      question(
        answers,
        'kg-source-paths',
        '哪些 KG Cocos 和 KG PHP 路径可以证明目标游戏行为？',
        '进入 runtime work 前，功能盘点和 parity ledger 必须有源码证据。',
        '../kg-cocos-client 和 ../kg-php 是只读主事实源；仅当主事实源缺失时，../kg 才作为只读兜底来源。',
        input.nonInteractive
      ),
      ...baseQuestions.slice(3)
    ].filter((item): item is SelvedgeRequirementQuestion => Boolean(item));
  }
  return baseQuestions;
}

function makeTask(input: Omit<SelvedgeWorkflowTask, 'status' | 'statusUpdatedAt'>): SelvedgeWorkflowTask {
  return {
    ...input,
    status: 'Pending',
    statusUpdatedAt: new Date().toISOString()
  };
}

const EXECUTABLE_VALIDATION_COMMAND_PATTERN =
  /^(?:pnpm|npm|bun|node|npx|yarn|git|powershell|pwsh|python|py|pytest|vitest|tsc|turbo|docker|docker-compose|cmd(?:\.exe)?|\.\\|\.\/|scripts[\\/])/i;

function isExecutableValidationCommand(item: string): boolean {
  const command = item.trim();
  if (!command || /^NeedsDecision:/i.test(command)) {
    return false;
  }
  return EXECUTABLE_VALIDATION_COMMAND_PATTERN.test(command);
}

function createMicroShellProfileFitTask(
  input: GoalWorkflowInput,
  profileName: string,
  existingProfileExpectation: string
): SelvedgeWorkflowTask {
  return makeTask({
    id: `${input.id}-micro-shell-profile-fit`,
    title: `Docs-only micro-shell profile fit and feature-shape gate for ${input.title}`,
    phase: 'planning',
    stage: 'planning',
    role: 'kg-micro-shell-architect',
    workstream: input.workstream,
    roadmapNode: `${profileName} / micro-shell profile fit`,
    runner: 'codex-app-agent',
    writeSet: [
      'apps/kg-micro-shell/docs/**',
      'docs/kg-micro-shell-agent-reference/**',
      docPath(input.id, 'task-queue.md'),
      docPath(input.id, 'shell-profile-fit.md')
    ],
    validation: [
      'Confirm one concrete KG catalog class is recorded: Slot - Down / Cocos Bundle, Slot - Web Entry, Fish, Poker / Card, Bingo / Table, or NeedsHumanInput.',
      'Confirm KG Config.js evidence records type, inType, main, brand, direction, route/gameCode, and whether assets/<KG key>/ exists.',
      `Compare the target against existing GameHub micro-shell support: ${existingProfileExpectation}.`,
      'Record exactly one fit verdict: ReuseExistingProfile, ExtendExistingProfile, NewShellProfileRequired, or NeedsHumanInput.',
      'Record the required GameHub config scopes before implementation: global `*`, category `type:<slot|card|fish|table>`, shell profile `profile:<profile-code>`, and concrete game code.',
      'Record whether RTP and KG control/money policy can reuse existing category/profile/game scope resolution or require a new type/profile config foundation task.',
      'Sketch the required feature-shape map before source inventory: launch/entry, protocol or launch URL, start/play flow, result/callback chain, history/detail or room state, control/risk boundary, browser smoke surface, and independent audit focus.',
      'If the verdict is ExtendExistingProfile, NewShellProfileRequired, or the RTP/control scope is missing, update task-queue.md to add or require a profile/config foundation task before runtime slices, or mark the workflow NeedsHumanInput before implementation.',
      'Confirm no runtime, bridge, handler, package staging, browser smoke, or sibling source files are changed.'
    ],
    dependsOn: [`${input.id}-intake`],
    artifacts: [docPath(input.id, 'shell-profile-fit.md'), docPath(input.id, 'task-queue.md')],
    stopPolicy: 'stop-if-micro-shell-profile-fit-is-unclear-or-new-profile-work-is-not-queued',
    notes: [
      'This gate decides whether the next task reuses an existing micro-shell profile or must first define a new shell carrying profile.',
      'The backend money path remains one RoundService/WalletGateway/ledger line; this gate only defines the type/profile/game config shape that feeds it.',
      'Slot - Web Entry is still a slots game class, but it is not the current down/Cocos bundle same-document profile.'
    ]
  });
}

function createWorkflowTasks(input: GoalWorkflowInput): readonly SelvedgeWorkflowTask[] {
  const writeSet = input.writeSet.length > 0 ? input.writeSet : DEFAULT_GOAL_WRITE_SET;
  const validation = input.validation.length > 0 ? input.validation : DEFAULT_GOAL_VALIDATION;
  const devCommands =
    input.commands.length > 0
      ? input.commands
      : input.mode === 'autopilot-next'
        ? [
            'pnpm typecheck',
            'pnpm test'
          ]
        : [];
  const qaCommands =
    input.mode === 'autopilot-next'
      ? [
          'pnpm build',
          'pnpm selvedge validate',
          'git diff --check'
        ]
      : validation.filter(isExecutableValidationCommand);
  const devRunner = devCommands.length > 0 ? 'shell' : 'codex-app-agent';
  const qaRunner = qaCommands.length > 0 ? 'shell' : 'codex-app-agent';
  if (input.profile === 'kg-slots-migration') {
    return createKgSlotsWorkflowTasks(input, writeSet, validation, devCommands, qaCommands, devRunner, qaRunner);
  }
  if (input.profile === 'kg-game-migration') {
    return createKgGameWorkflowTasks(input, writeSet, validation, devCommands, qaCommands, devRunner, qaRunner);
  }

  return [
    makeTask({
      id: `${input.id}-intake`,
      title: `AI-assisted intake for ${input.title}`,
      phase: 'intake',
      stage: 'intake',
      role: 'selvedge-ai-intake-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge goal workflow / intake',
      runner: 'builtin:intake-doc',
      writeSet: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      validation: [
        'Confirm questions are answered, explicitly assumed, or marked NeedsHumanInput.',
        'Confirm goal document records scope, authority, WriteSet, validation, and stop policy.'
      ],
      dependsOn: [],
      artifacts: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      stopPolicy: 'needs-human-input-if-required-answers-are-missing',
      notes: [
        'This task is the productized AI dialogue contract.',
        'Codex App can ask these questions directly; external AI adapters can implement the same question schema later.'
      ]
    }),
    makeTask({
      id: `${input.id}-planning`,
      title: `Decompose goal into development and QA tasks for ${input.title}`,
      phase: 'planning',
      stage: 'planning',
      role: 'selvedge-planner',
      workstream: input.workstream,
      roadmapNode: 'Selvedge goal workflow / task decomposition',
      runner: 'builtin:task-decomposition',
      writeSet: [docPath(input.id, 'task-queue.md'), docPath(input.id, 'goal.workflow.json')],
      validation: [
        'Confirm every executable task has phase, runner, WriteSet, validation, dependencies, artifacts, and stop policy.',
        'Confirm QA tasks are separate from development tasks.',
        'Confirm the total goal is not being sent as one broad runner task; split by module, surface, contract, or validation gate when needed.'
      ],
      dependsOn: [`${input.id}-intake`],
      artifacts: [docPath(input.id, 'task-queue.md'), docPath(input.id, 'goal.workflow.json')],
      stopPolicy: 'stop-if-task-boundaries-are-incomplete',
      notes: [
        'Task queue is resumable through selvedge run next.',
        'If the local fallback queue is too coarse for the actual goal, this planning task must rewrite it into smaller subtasks before development starts.'
      ]
    }),
    makeTask({
      id: `${input.id}-development`,
      title: `Execute one bounded development slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'selvedge-dev-runner',
      workstream: input.workstream,
      roadmapNode: 'Selvedge goal workflow / development',
      runner: devRunner,
      commands: devCommands,
      writeSet,
      validation,
      dependsOn: [`${input.id}-planning`],
      artifacts: [docPath(input.id, 'development-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-development.log`)],
      stopPolicy: 'stop-on-validation-failure-boundary-miss-unsupported-runner-or-overbroad-slice',
      notes: [
        'This task is not permission to execute the whole total goal. If the scope is not one small independently reviewable slice, stop and rewrite the queue.',
        devRunner === 'shell'
          ? 'Development task will execute declared shell commands.'
          : 'Development task requires an AI/Codex runner adapter or a human-controlled Codex App agent.'
      ]
    }),
    makeTask({
      id: `${input.id}-qa`,
      title: `Run QA and regression checks for ${input.title}`,
      phase: 'qa',
      stage: 'qa',
      role: 'selvedge-qa-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge goal workflow / QA',
      runner: qaRunner,
      commands: qaCommands,
      writeSet: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa.log`)],
      validation: [
        'Confirm development evidence exists.',
        'Confirm declared validation commands passed or failures are classified.',
        'Confirm no unsupported runner is treated as passed.'
      ],
      dependsOn: [`${input.id}-development`],
      artifacts: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa.log`)],
      stopPolicy: 'stop-on-failed-qa-or-unclassified-risk',
      notes: ['QA is a separate phase and must not be collapsed into development claims.']
    }),
    makeTask({
      id: `${input.id}-handoff`,
      title: `Write final handoff for ${input.title}`,
      phase: 'handoff',
      stage: 'handoff',
      role: 'selvedge-handoff-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge goal workflow / handoff',
      runner: 'builtin:handoff',
      writeSet: [docPath(input.id, 'handoff.md')],
      validation: [
        'Confirm final status, evidence paths, failures, next actions, and rollback guidance are recorded.'
      ],
      dependsOn: [`${input.id}-qa`],
      artifacts: [docPath(input.id, 'handoff.md')],
      stopPolicy: 'complete-or-record-blocker',
      notes: ['Every workflow issue discovered during the run should feed back into Selvedge product work.']
    })
  ];
}

function createKgGameWorkflowTasks(
  input: GoalWorkflowInput,
  writeSet: readonly string[],
  validation: readonly string[],
  devCommands: readonly string[],
  qaCommands: readonly string[],
  devRunner: string,
  qaRunner: string
): readonly SelvedgeWorkflowTask[] {
  return [
    makeTask({
      id: `${input.id}-intake`,
      title: `AI-assisted KG game intake for ${input.title}`,
      phase: 'intake',
      stage: 'intake',
      role: 'selvedge-ai-intake-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / intake',
      runner: 'builtin:intake-doc',
      writeSet: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      validation: [
        'Confirm target KG game type, route/gameCode, and source folder are explicit or marked NeedsHumanInput.',
        'Confirm KG Cocos source, KG PHP source, WriteSet, validation, and stop policy are explicit.',
        'Confirm this workflow is not using the slots profile unless the target is explicitly slots-class.'
      ],
      dependsOn: [],
      artifacts: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      stopPolicy: 'needs-human-input-only-if-source-authority-or-target-identity-is-missing',
      notes: [
        'KG new game types use the same Selvedge lifecycle with source-specific gates.',
        'Completed slots migrations are process evidence only, not feature templates.'
      ]
    }),
    createMicroShellProfileFitTask(
      input,
      'Selvedge KG game profile',
      'current reusable profile is proven only for Slot - Down / Cocos Bundle same-document Cocos package migration; Slot - Web Entry, Fish, Poker / Card, and Bingo / Table require ExtendExistingProfile or NewShellProfileRequired evidence before runtime work'
    ),
    makeTask({
      id: `${input.id}-source-feature-inventory`,
      title: `Docs-only KG source feature inventory for ${input.title}`,
      phase: 'planning',
      stage: 'planning',
      role: 'kg-micro-shell-architect',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / source feature inventory',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'task-queue.md'),
        docPath(input.id, 'source-feature-inventory.md')
      ],
      validation: [
        'Confirm one concrete KG target, route/gameCode, source folder, and game type are recorded before runtime details.',
        'Confirm shell-profile-fit.md exists and its verdict is compatible with the current task queue before continuing.',
        'Confirm KG Cocos and KG PHP source paths are listed with exact read-only references.',
        'Confirm source-feature-inventory.md records GameHub config scope mapping for this target: global `*`, category `type:<slot|card|fish|table>`, shell profile `profile:<profile-code>`, concrete gameCode, and resolver precedence.',
        'Confirm RTP and KG control/money policy inventory is split into platform, category, shell-profile, game, merchant/campaign override, and player-policy layers; record source-proven handler boundaries or NotApplicable evidence.',
        'Inventory source events, protocol fields, state machine, callbacks, animation/visual entry fields, room/reconnect, betting/play flow, history/detail, control/risk boundaries, and failure branches at minimum practical granularity.',
        'Record NotApplicable evidence for absent features.',
        'Confirm no runtime, bridge, handler, package staging, browser smoke, or sibling repo files are changed.'
      ],
      dependsOn: [`${input.id}-micro-shell-profile-fit`],
      artifacts: [docPath(input.id, 'source-feature-inventory.md'), docPath(input.id, 'task-queue.md')],
      stopPolicy: 'stop-if-target-or-feature-map-is-too-broad-or-source-authority-missing',
      notes: ['This is the required docs-only source gate before any runtime migration work.']
    }),
    makeTask({
      id: `${input.id}-functional-detail-ledger`,
      title: `KG source functional-detail parity ledger for ${input.title}`,
      phase: 'planning',
      stage: 'planning',
      role: 'kg-micro-shell-architect',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / functional-detail parity ledger',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'functional-detail-ledger.md')
      ],
      validation: [
        'Confirm every existing source feature has frontend/backend/mapper invariants and validation obligations.',
        'Confirm callback order, state fields, animation entry, history/detail, room/reconnect, failure branch, and display-only boundaries are recorded where applicable.',
        'Confirm no runtime implementation is included in this docs-only gate.'
      ],
      dependsOn: [`${input.id}-source-feature-inventory`],
      artifacts: [docPath(input.id, 'functional-detail-ledger.md')],
      stopPolicy: 'stop-if-existing-source-feature-lacks-implementation-and-test-invariants',
      notes: ['This gate must prove what to implement before bridge, mapper, backend handler, package staging, live play, or browser smoke.']
    }),
    ...createKgGameRuntimeSliceTasks(input, writeSet, validation, devCommands, devRunner),
    makeTask({
      id: `${input.id}-qa-self-test`,
      title: `Run KG game migration self-test for ${input.title}`,
      phase: 'qa',
      stage: 'qa',
      role: 'kg-micro-shell-qa-reviewer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / source logic and browser self-test',
      runner: qaRunner,
      commands: qaCommands,
      writeSet: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa-self-test.log`)],
      validation: [
        'Confirm source existence check precedes functional claims.',
        'Confirm pure source-logic/data-flow regression precedes browser smoke.',
        'Confirm browser smoke proves launch, context/init, play/start path, result consumption, history/detail or room-state behavior when source-proven, and no authority leaks.'
      ],
      dependsOn: [kgGameRuntimeFinalTaskId(input.id)],
      artifacts: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa-self-test.log`)],
      stopPolicy: 'stop-on-failed-qa-or-unclassified-source-parity-risk',
      notes: ['Self-test cannot replace the independent post-migration audit.']
    }),
    makeTask({
      id: `${input.id}-independent-audit`,
      title: `Independent source-vs-implementation audit for ${input.title}`,
      phase: 'qa',
      stage: 'qa',
      role: 'kg-micro-shell-independent-auditor',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / independent audit',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'independent-audit.md')
      ],
      validation: [
        'Freshly rescan KG original Cocos and PHP code.',
        'Freshly rescan migrated GameHub frontend and backend code.',
        'Record Match, MismatchBlocker, IntentionalDifferenceWithAuthorityReason, or NotApplicable for each functional detail.',
        'Block ReadyForHumanReview on any MismatchBlocker.'
      ],
      dependsOn: [`${input.id}-qa-self-test`],
      artifacts: [docPath(input.id, 'independent-audit.md')],
      stopPolicy: 'stop-on-mismatch-blocker',
      notes: ['This audit must not reuse source inventory or earlier summaries as proof.']
    }),
    makeTask({
      id: `${input.id}-handoff`,
      title: `Write KG game migration handoff for ${input.title}`,
      phase: 'handoff',
      stage: 'handoff',
      role: 'selvedge-handoff-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / handoff',
      runner: 'builtin:handoff',
      writeSet: [docPath(input.id, 'handoff.md')],
      validation: ['Confirm final status, evidence paths, known blockers, next target decision, and rollback guidance are recorded.'],
      dependsOn: [`${input.id}-independent-audit`],
      artifacts: [docPath(input.id, 'handoff.md')],
      stopPolicy: 'complete-or-record-blocker',
      notes: ['If Selvedge workflow friction appears, record it as a Selvedge product improvement.']
    })
  ];
}

function kgGameRuntimeFinalTaskId(id: string): string {
  return `${id}-route-context-integration`;
}

function createKgGameRuntimeSliceTasks(
  input: GoalWorkflowInput,
  declaredWriteSet: readonly string[],
  declaredValidation: readonly string[],
  declaredCommands: readonly string[],
  devRunner: string
): readonly SelvedgeWorkflowTask[] {
  const inheritedBoundaryNotes = [
    'This is one small Autopilot-style slice: finish, validate, record evidence, and stop at the task boundary.',
    'Do not use a generic all-in-one development task or combine unrelated runtime surfaces.',
    'Do not reuse slots-specific behavior unless the current target source proves the same contract.'
  ];
  const declaredCommandNote =
    declaredCommands.length > 0
      ? [`Declared goal-level commands are deferred to the final integration slice: ${declaredCommands.join(' && ')}`]
      : [];
  const declaredBoundaryNote =
    declaredWriteSet.length > 0 || declaredValidation.length > 0
      ? [
          `Original requested WriteSet: ${declaredWriteSet.join(', ') || 'none'}.`,
          `Original requested validation: ${declaredValidation.join(', ') || 'none'}.`
        ]
      : [];

  return [
    makeTask({
      id: `${input.id}-backend-handler`,
      title: `Implement source-specific backend handler slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / backend handler slice',
      runner: devRunner,
      writeSet: [
        'apps/backend/src/modules/games/**',
        docPath(input.id, 'backend-handler-evidence.md')
      ],
      validation: [
        'Implement only the current target handler and handler-local tests.',
        'Do not register the live route or mark the game supported in shared route lists in this slice.',
        'Consume only resolved GameHub config scopes for RTP/control overlays: global, category, shell-profile, game, merchant/campaign, then player policy.',
        'Preserve GameHub RoundService, WalletGateway, OrderService, LedgerService, and audit authority.',
        'Run focused backend handler tests for source bet/play validation, state, control/risk behavior where source-proven, failure branches, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-functional-detail-ledger`],
      artifacts: [docPath(input.id, 'backend-handler-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-backend-handler.log`)],
      stopPolicy: 'stop-on-handler-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-shell-protocol-primitives`,
      title: `Implement Shell protocol, room-state, and start primitives for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / shell protocol primitives',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'shell-protocol-primitives-evidence.md')
      ],
      validation: [
        'Implement only source-shaped room/context normalization and request payload creation.',
        'Do not install the live shell route or call GameAPI rounds/play in this slice.',
        'Run focused KG micro-shell primitive tests for source event names, payload fields, failure envelopes, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-backend-handler`],
      artifacts: [docPath(input.id, 'shell-protocol-primitives-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-shell-protocol-primitives.log`)],
      stopPolicy: 'stop-on-shell-primitive-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-result-callback-runtime`,
      title: `Implement result mapper, callback chain, and ingress runtime slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / result callback runtime',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'result-callback-runtime-evidence.md')
      ],
      validation: [
        'Map only GameHub play output into the current target Cocos event/callback shape.',
        'Cover source-shaped visual, animation, state, bonus/free, room, or multi-step fields only when source-proven.',
        'Do not wire live route support until backend handler, shell primitives, mapper/runtime, and tests exist together.',
        'Run focused mapper/runtime tests and leak scans.'
      ],
      dependsOn: [`${input.id}-shell-protocol-primitives`],
      artifacts: [docPath(input.id, 'result-callback-runtime-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-result-callback-runtime.log`)],
      stopPolicy: 'stop-on-mapper-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-history-detail-room-state-bridge`,
      title: `Implement history/detail and room-state bridge slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / history detail and room-state bridge',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'history-detail-room-state-bridge-evidence.md')
      ],
      validation: [
        'Bridge only source-proven history/detail, resume, reconnect, or room-state events to GameHub APIs.',
        'Bind detail lookups and room-state projections to verified GameHub round/session ids.',
        'Run focused tests for field shape, ordering, blocked unlisted ids, resume/reconnect behavior where source-proven, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-result-callback-runtime`],
      artifacts: [docPath(input.id, 'history-detail-room-state-bridge-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-history-detail-room-state-bridge.log`)],
      stopPolicy: 'stop-on-history-detail-room-state-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: kgGameRuntimeFinalTaskId(input.id),
      title: `Integrate route, context, shell install, and viewport slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG game profile / route and context integration',
      runner: devRunner,
      commands: declaredCommands,
      writeSet: [
        'packages/shared-types/src/**',
        'apps/backend/src/modules/games/**',
        'apps/backend/src/routes/gameapi/**',
        'apps/kg-micro-shell/src/**',
        'apps/game-template/src/app/kg/micro-shell/**',
        docPath(input.id, 'route-context-integration-evidence.md')
      ],
      validation: [
        'Register or expose the current target route only after backend handler, shell primitives, result/callback runtime, bridge, and focused tests exist together.',
        'Run focused launch/context/backend/shell integration tests.',
        'Run the declared goal-level validation commands or classify each failure.',
        'Run git diff --check before handing off to QA.'
      ],
      dependsOn: [`${input.id}-history-detail-room-state-bridge`],
      artifacts: [docPath(input.id, 'route-context-integration-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-route-context-integration.log`)],
      stopPolicy: 'stop-on-integration-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote, ...declaredCommandNote]
    })
  ];
}

function createKgSlotsWorkflowTasks(
  input: GoalWorkflowInput,
  writeSet: readonly string[],
  validation: readonly string[],
  devCommands: readonly string[],
  qaCommands: readonly string[],
  devRunner: string,
  qaRunner: string
): readonly SelvedgeWorkflowTask[] {
  return [
    makeTask({
      id: `${input.id}-intake`,
      title: `AI-assisted KG slots intake for ${input.title}`,
      phase: 'intake',
      stage: 'intake',
      role: 'selvedge-ai-intake-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / intake',
      runner: 'builtin:intake-doc',
      writeSet: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      validation: [
        'Confirm target slots-class game is explicit, or confirm Selvedge master-controller auto-selection authority is recorded.',
        'If target-game is auto-selected, record candidate set, exclusion reasons, selected route/gameCode, and selection evidence before implementation.',
        'Confirm KG Cocos source, KG PHP source, WriteSet, validation, and stop policy are explicit.',
        'Confirm this is not a new KG game type unless Selvedge slots-class stabilization has been approved.'
      ],
      dependsOn: [],
      artifacts: [docPath(input.id, 'goal.md'), docPath(input.id, 'requirements.md')],
      stopPolicy: 'needs-human-input-only-if-source-authority-is-missing-or-no-slots-candidate-can-be-selected',
      notes: [
        'KG slots uses the same Selvedge lifecycle with a stricter source-authority profile.',
        'The user authorized the master controller to choose the next slots target when target-game is not supplied.'
      ]
    }),
    createMicroShellProfileFitTask(
      input,
      'Selvedge KG slots profile',
      'kg-slots-migration may reuse only the current Slot - Down / Cocos Bundle same-document profile; web-entry slots must be treated as ExtendExistingProfile or NewShellProfileRequired instead of a normal slots continuation'
    ),
    makeTask({
      id: `${input.id}-source-feature-inventory`,
      title: `Docs-only source feature inventory for ${input.title}`,
      phase: 'planning',
      stage: 'planning',
      role: 'kg-micro-shell-architect',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / Node 4.5 source feature inventory',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'task-queue.md')
      ],
      validation: [
        'If the target was AuthorizedAutoSelect, choose one next eligible KG slots-class target and write the selection rationale before feature inventory details.',
        'Confirm shell-profile-fit.md exists and records ReuseExistingProfile for Slot - Down / Cocos Bundle before continuing the slots profile.',
        'Confirm KG Cocos and KG PHP source paths are listed with exact read-only references.',
        'Confirm source-feature-inventory.md records GameHub config scope mapping for this target: global `*`, category `type:slot`, shell profile `profile:kg-slot-down-cocos-bundle`, concrete gameCode, and resolver precedence.',
        'Confirm RTP and KG control/money policy inventory is split into platform, category, shell-profile, game, merchant/campaign override, and player-policy layers; record source-proven slot handler boundaries or NotApplicable evidence.',
        'Confirm every source feature is mapped at minimum practical granularity.',
        'Confirm NotApplicable evidence is recorded for absent features.',
        'Confirm no runtime, bridge, handler, package staging, browser smoke, or sibling repo files are changed.'
      ],
      dependsOn: [`${input.id}-micro-shell-profile-fit`],
      artifacts: [docPath(input.id, 'task-queue.md'), docPath(input.id, 'source-feature-inventory.md')],
      stopPolicy: 'stop-if-feature-map-is-too-broad-or-source-authority-missing',
      notes: ['This is the required Node 4.5 gate before runtime migration work.']
    }),
    makeTask({
      id: `${input.id}-functional-detail-ledger`,
      title: `Source functional-detail parity ledger for ${input.title}`,
      phase: 'planning',
      stage: 'planning',
      role: 'kg-micro-shell-architect',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / Node 4.6 functional-detail parity ledger',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'task-queue.md')
      ],
      validation: [
        'Confirm every existing source feature has frontend/backend/mapper invariants and validation obligations.',
        'Confirm callback order, state fields, animation entry, history/detail, room/reconnect, failure branch, and display-only boundaries are recorded where applicable.',
        'Confirm no runtime implementation is included in this docs-only gate.'
      ],
      dependsOn: [`${input.id}-source-feature-inventory`],
      artifacts: [docPath(input.id, 'functional-detail-ledger.md')],
      stopPolicy: 'stop-if-existing-source-feature-lacks-implementation-and-test-invariants',
      notes: ['This is the required Node 4.6 gate before bridge, mapper, backend handler, package staging, live play, or browser smoke.']
    }),
    ...createKgSlotsRuntimeSliceTasks(input, writeSet, validation, devCommands, devRunner),
    makeTask({
      id: `${input.id}-qa-self-test`,
      title: `Run KG slots migration self-test for ${input.title}`,
      phase: 'qa',
      stage: 'qa',
      role: 'kg-micro-shell-qa-reviewer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / source logic and browser self-test',
      runner: qaRunner,
      commands: qaCommands,
      writeSet: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa-self-test.log`)],
      validation: [
        'Confirm source existence check precedes functional claims.',
        'Confirm pure source-logic/data-flow regression precedes browser smoke.',
        'Confirm browser smoke proves launch, context/init, rounds/play, result consumption, and no authority leaks.'
      ],
      dependsOn: [kgSlotsRuntimeFinalTaskId(input.id)],
      artifacts: [docPath(input.id, 'qa-report.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-qa-self-test.log`)],
      stopPolicy: 'stop-on-failed-qa-or-unclassified-source-parity-risk',
      notes: ['Self-test cannot replace the independent post-migration audit.']
    }),
    makeTask({
      id: `${input.id}-independent-audit`,
      title: `Independent source-vs-implementation audit for ${input.title}`,
      phase: 'qa',
      stage: 'qa',
      role: 'kg-micro-shell-independent-auditor',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / Node 8.5 independent audit',
      runner: 'codex-app-agent',
      writeSet: [
        'apps/kg-micro-shell/docs/**',
        'docs/kg-micro-shell-agent-reference/**',
        docPath(input.id, 'independent-audit.md')
      ],
      validation: [
        'Freshly rescan KG original Cocos and PHP code.',
        'Freshly rescan migrated GameHub frontend and backend code.',
        'Record Match, MismatchBlocker, IntentionalDifferenceWithAuthorityReason, or NotApplicable for each functional detail.',
        'Block ReadyForHumanReview on any MismatchBlocker.'
      ],
      dependsOn: [`${input.id}-qa-self-test`],
      artifacts: [docPath(input.id, 'independent-audit.md')],
      stopPolicy: 'stop-on-mismatch-blocker',
      notes: ['This audit must not reuse source inventory or earlier summaries as proof.']
    }),
    makeTask({
      id: `${input.id}-handoff`,
      title: `Write KG slots migration handoff for ${input.title}`,
      phase: 'handoff',
      stage: 'handoff',
      role: 'selvedge-handoff-lead',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / handoff',
      runner: 'builtin:handoff',
      writeSet: [docPath(input.id, 'handoff.md')],
      validation: ['Confirm final status, evidence paths, known blockers, next target decision, and rollback guidance are recorded.'],
      dependsOn: [`${input.id}-independent-audit`],
      artifacts: [docPath(input.id, 'handoff.md')],
      stopPolicy: 'complete-or-record-blocker',
      notes: ['If Selvedge workflow friction appears, record it as a Selvedge product improvement.']
    })
  ];
}

function kgSlotsRuntimeFinalTaskId(id: string): string {
  return `${id}-route-context-integration`;
}

function createKgSlotsRuntimeSliceTasks(
  input: GoalWorkflowInput,
  declaredWriteSet: readonly string[],
  declaredValidation: readonly string[],
  declaredCommands: readonly string[],
  devRunner: string
): readonly SelvedgeWorkflowTask[] {
  const inheritedBoundaryNotes = [
    'This is one small Autopilot-style slice: finish, validate, record evidence, and stop at the task boundary.',
    'Do not use a generic all-in-one development task or combine unrelated runtime surfaces.',
    'MJHL2 is a micro-shell shape reference only; source behavior comes from the current target.'
  ];
  const declaredCommandNote =
    declaredCommands.length > 0
      ? [`Declared goal-level commands are deferred to the final integration slice: ${declaredCommands.join(' && ')}`]
      : [];
  const declaredBoundaryNote =
    declaredWriteSet.length > 0 || declaredValidation.length > 0
      ? [
          `Original requested WriteSet: ${declaredWriteSet.join(', ') || 'none'}.`,
          `Original requested validation: ${declaredValidation.join(', ') || 'none'}.`
        ]
      : [];

  return [
    makeTask({
      id: `${input.id}-backend-handler`,
      title: `Implement source-specific backend handler slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / backend handler slice',
      runner: devRunner,
      writeSet: [
        'apps/backend/src/modules/games/**',
        docPath(input.id, 'backend-handler-evidence.md')
      ],
      validation: [
        'Implement only the current target handler and handler-local tests.',
        'Do not register the live route or mark the game supported in shared route lists in this slice.',
        'Consume only resolved GameHub config scopes for RTP/control overlays: global, category, shell-profile, game, merchant/campaign, then player policy.',
        'Preserve GameHub RoundService, WalletGateway, OrderService, LedgerService, and audit authority.',
        'Run focused backend handler tests for source bet validation, state, bonus/free/continuation behavior where source-proven, failure branches, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-functional-detail-ledger`],
      artifacts: [docPath(input.id, 'backend-handler-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-backend-handler.log`)],
      stopPolicy: 'stop-on-handler-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-shell-start-roominfo-primitives`,
      title: `Implement Shell room-info and start-payload primitives for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / shell room-info and start primitives',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'shell-start-roominfo-evidence.md')
      ],
      validation: [
        'Implement only source-shaped room-info normalization and start payload creation.',
        'Do not install the live shell route or call GameAPI rounds/play in this slice.',
        'Run focused KG micro-shell primitive tests for roomInfo fields, start metadata, failure envelopes, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-backend-handler`],
      artifacts: [docPath(input.id, 'shell-start-roominfo-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-shell-start-roominfo-primitives.log`)],
      stopPolicy: 'stop-on-shell-primitive-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-result-mapper-runtime`,
      title: `Implement result mapper and ingress runtime slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / result mapper and ingress runtime',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'result-mapper-runtime-evidence.md')
      ],
      validation: [
        'Map only GameHub rounds/play output into the current target Cocos event shape.',
        'Cover source-shaped win/line/map/disappear/logo_info/bonus/free fields only when source-proven.',
        'Do not wire live route support until backend handler, room/start primitives, mapper, and tests exist together.',
        'Run focused mapper/runtime tests and leak scans.'
      ],
      dependsOn: [`${input.id}-shell-start-roominfo-primitives`],
      artifacts: [docPath(input.id, 'result-mapper-runtime-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-result-mapper-runtime.log`)],
      stopPolicy: 'stop-on-mapper-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: `${input.id}-history-detail-bridge`,
      title: `Implement history/detail bridge slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / history and detail bridge',
      runner: devRunner,
      writeSet: [
        'apps/kg-micro-shell/src/**',
        docPath(input.id, 'history-detail-bridge-evidence.md')
      ],
      validation: [
        'Bridge only source-proven history/detail events to GameHub history/detail read APIs.',
        'Bind detail lookups to history-proven GameHub round ids.',
        'Run focused history/detail tests for field shape, ordering, blocked unlisted detail ids, and leak boundaries.'
      ],
      dependsOn: [`${input.id}-result-mapper-runtime`],
      artifacts: [docPath(input.id, 'history-detail-bridge-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-history-detail-bridge.log`)],
      stopPolicy: 'stop-on-history-detail-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote]
    }),
    makeTask({
      id: kgSlotsRuntimeFinalTaskId(input.id),
      title: `Integrate route, context, shell install, and viewport slice for ${input.title}`,
      phase: 'development',
      stage: 'development',
      role: 'kg-micro-shell-implementer',
      workstream: input.workstream,
      roadmapNode: 'Selvedge KG slots profile / route and context integration',
      runner: devRunner,
      commands: declaredCommands,
      writeSet: [
        'packages/shared-types/src/**',
        'apps/backend/src/modules/games/**',
        'apps/backend/src/routes/gameapi/**',
        'apps/kg-micro-shell/src/**',
        'apps/game-template/src/app/kg/micro-shell/**',
        docPath(input.id, 'route-context-integration-evidence.md')
      ],
      validation: [
        'Register or expose the current target route only after backend handler, room/start primitives, result mapper/runtime, history/detail bridge, and focused tests exist together.',
        'Run focused launch/context/backend/shell integration tests.',
        'Run the declared goal-level validation commands or classify each failure.',
        'Run git diff --check before handing off to QA.'
      ],
      dependsOn: [`${input.id}-history-detail-bridge`],
      artifacts: [docPath(input.id, 'route-context-integration-evidence.md'), join('.selvedge', 'logs', `${input.id}.${input.id}-route-context-integration.log`)],
      stopPolicy: 'stop-on-integration-validation-failure-boundary-miss-or-source-parity-gap',
      notes: [...inheritedBoundaryNotes, ...declaredBoundaryNote, ...declaredCommandNote]
    })
  ];
}

function goalMarkdown(workflow: SelvedgeGoalWorkflow, model: GameHubReadOnlyModel): string {
  return [
    `# ${workflow.title}`,
    '',
    `GoalId: ${workflow.id}`,
    `Mode: ${workflow.mode}`,
    `Profile: ${workflow.profile.id} / ${workflow.profile.title}`,
    `Workstream: ${workflow.workstream}`,
    `Created: ${workflow.createdAt}`,
    '',
    '## Execution Control',
    '',
    '- The total goal is not an executable long prompt.',
    '- Selvedge executes one dependency-ready subtask at a time.',
    '- Each subtask must have its own WriteSet, validation, artifacts, stop policy, and evidence boundary.',
    '- A stopped workflow resumes from the persisted subtask queue instead of restarting the whole goal.',
    '',
    '## Architecture Gate',
    '',
    workflow.architecture
      ? `- Status: ${workflow.architecture.status}`
      : '- Status: not generated for this workflow.',
    workflow.architecture?.confirmationRequired
      ? '- User confirmation is required before project initialization or execution can start.'
      : '- No architecture confirmation is currently required.',
    workflow.architecture
      ? '- Proposal document: architecture-proposal.md'
      : '- Proposal document: n/a',
    '',
    '## Total Goal',
    '',
    workflow.target,
    '',
    '## Current GameHub Gate',
    '',
    `- First executable task: ${model.firstExecutableTask.verdict} / ${model.firstExecutableTask.reason}`,
    `- Selvedge mainline: ${model.selvedgeMainline.canStartInCodexApp ? 'can-start' : 'blocked'} / ${model.selvedgeMainline.reason}`,
    `- STOP_AGENT: ${model.stopFile.exists ? 'present' : 'absent'}`,
    '',
    '## Success Criteria',
    '',
    '- Requirements and assumptions are recorded before implementation.',
    '- The goal is decomposed into resumable tasks with dependencies.',
    '- Development and QA phases are separate.',
    '- Every executable task has WriteSet, validation, artifacts, and stop policy.',
    '- Failures are classified before retry or handoff.',
    '',
    '## Workflow Profile',
    '',
    `Purpose: ${workflow.profile.purpose}`,
    '',
    'Planning gates:',
    ...workflow.profile.planningGates.map((item) => `- ${item}`),
    '',
    'Development gates:',
    ...workflow.profile.developmentGates.map((item) => `- ${item}`),
    '',
    'QA gates:',
    ...workflow.profile.qaGates.map((item) => `- ${item}`),
    ''
  ].join('\n');
}

function requirementsMarkdown(workflow: SelvedgeGoalWorkflow): string {
  const lines = [
    `# Requirements For ${workflow.title}`,
    '',
    '## AI Intake Questions',
    ''
  ];
  for (const item of workflow.aiIntake.questions) {
    lines.push(`### ${item.id}`);
    lines.push('');
    lines.push(`Question: ${item.question}`);
    lines.push(`Reason: ${item.reason}`);
    lines.push(`Status: ${item.status}`);
    if (item.options?.length) {
      lines.push('Options:');
      for (const option of item.options) {
        lines.push(`- ${option.id}: ${option.label} - ${option.description}`);
      }
    }
    lines.push(`Answer: ${item.answer ?? 'NeedsHumanInput'}`);
    lines.push('');
  }
  lines.push('## Requirement Contract');
  lines.push('');
  lines.push('- Treat answered questions as requirements.');
  lines.push('- Treat assumptions as provisional requirements until a user overrides them.');
  lines.push('- Treat AI answer options as suggestions only; a user-written custom answer is equally authoritative.');
  lines.push('- Treat the total goal as planning context only; runner prompts must execute one bounded subtask at a time.');
  lines.push('- Do not execute a task when a missing answer is required for safety, authority, WriteSet, or acceptance.');
  lines.push(`- Apply workflow profile: ${workflow.profile.id} / ${workflow.profile.title}.`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function architectureMarkdown(proposal: SelvedgeArchitectureProposal): string {
  const list = (items: readonly string[]) => items.length > 0 ? items.map((item) => `- ${item}`) : ['- None.'];
  const lines = [
    '# Selvedge Technical Architecture Proposal',
    '',
    `Generated: ${proposal.generatedAt}`,
    `Reviewer: ${proposal.reviewer}`,
    `Status: ${proposal.status}`,
    `Confirmation required: ${proposal.confirmationRequired ? 'yes' : 'no'}`,
    ...(proposal.confirmedAt ? [`Confirmed: ${proposal.confirmedAt}`] : []),
    '',
    '## Summary',
    '',
    proposal.summary,
    '',
    '## Recommended Stack',
    '',
    ...list(proposal.recommendedStack),
    '',
    '## Reasons',
    '',
    ...list(proposal.reasons),
    '',
    '## Project Structure',
    '',
    ...list(proposal.projectStructure),
    '',
    '## Initialization Plan',
    '',
    ...list(proposal.initializationPlan),
    '',
    '## Risks',
    '',
    ...list(proposal.risks),
    '',
    '## Evidence',
    '',
    `- Prompt: ${proposal.promptPath ?? 'n/a'}`,
    `- Log: ${proposal.logPath ?? 'n/a'}`,
    `- Last message: ${proposal.lastMessagePath ?? 'n/a'}`,
    ''
  ];
  return `${lines.join('\n')}\n`;
}

function taskQueueMarkdown(workflow: SelvedgeGoalWorkflow): string {
  const lines = [
    `# Task Queue For ${workflow.title}`,
    '',
    `Workflow: ${workflow.id}`,
    `Profile: ${workflow.profile.id} / ${workflow.profile.title}`,
    '',
    '## Queue',
    ''
  ];
  for (const task of workflow.tasks) {
    lines.push(`### ${task.id}`);
    lines.push('');
    lines.push(`- Status: ${task.status}`);
    lines.push(`- Phase: ${task.phase}`);
    lines.push(`- Runner: ${task.runner}`);
    lines.push(`- DependsOn: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'}`);
    lines.push(`- StopPolicy: ${task.stopPolicy}`);
    lines.push('- WriteSet:');
    for (const item of task.writeSet) {
      lines.push(`  - ${item}`);
    }
    lines.push('- Validation:');
    for (const item of task.validation) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return `${lines.join('\n')}\n`;
}

type ParsedQueueTask = Pick<
  SelvedgeWorkflowTask,
  'id' | 'phase' | 'status' | 'runner' | 'writeSet' | 'validation' | 'dependsOn' | 'stopPolicy'
>;

const TASK_STATUSES: readonly SelvedgeTaskStatus[] = [
  'Pending',
  'InProgress',
  'Completed',
  'Failed',
  'Blocked',
  'NeedsHumanInput',
  'NeedsRunner'
];

const WORKFLOW_PHASES: readonly SelvedgeWorkflowPhase[] = [
  'intake',
  'planning',
  'development',
  'qa',
  'handoff'
];

function parseTaskStatus(input: string): SelvedgeTaskStatus | null {
  return TASK_STATUSES.find((status) => status === input.trim()) ?? null;
}

function parseWorkflowPhase(input: string): SelvedgeWorkflowPhase | null {
  return WORKFLOW_PHASES.find((phase) => phase === input.trim()) ?? null;
}

function parseDependsOn(input: string): readonly string[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed === 'none') {
    return [];
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readIndentedBulletBlock(lines: readonly string[], start: number): readonly string[] {
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{2,}-\s+(.*)$/);
    if (!match) {
      break;
    }
    values.push(match[1]);
  }
  return values;
}

function parseTaskQueueMarkdownTasks(markdown: string, workflowId: string): readonly ParsedQueueTask[] {
  if (!markdown.includes(`Workflow: ${workflowId}`)) {
    return [];
  }
  const lines = markdown.split(/\r?\n/);
  const tasks: ParsedQueueTask[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^###\s+(.+?)\s*$/);
    if (!heading) {
      continue;
    }
    const id = heading[1].trim();
    let sectionEnd = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^###\s+/.test(lines[next])) {
        sectionEnd = next;
        break;
      }
    }
    const section = lines.slice(index + 1, sectionEnd);
    let status: SelvedgeTaskStatus | null = null;
    let phase: SelvedgeWorkflowPhase | null = null;
    let runner: string | null = null;
    let dependsOn: readonly string[] | null = null;
    let stopPolicy: string | null = null;
    let writeSet: readonly string[] | null = null;
    let validation: readonly string[] | null = null;
    for (let item = 0; item < section.length; item += 1) {
      const line = section[item];
      const field = line.match(/^-\s+([^:]+):\s*(.*)$/);
      if (!field) {
        continue;
      }
      const name = field[1];
      const value = field[2];
      if (name === 'Status') {
        status = parseTaskStatus(value);
      } else if (name === 'Phase') {
        phase = parseWorkflowPhase(value);
      } else if (name === 'Runner') {
        runner = value.trim();
      } else if (name === 'DependsOn') {
        dependsOn = parseDependsOn(value);
      } else if (name === 'StopPolicy') {
        stopPolicy = value.trim();
      } else if (name === 'WriteSet') {
        writeSet = readIndentedBulletBlock(section, item);
      } else if (name === 'Validation') {
        validation = readIndentedBulletBlock(section, item);
      }
    }
    if (status && phase && runner && dependsOn && stopPolicy && writeSet && validation) {
      tasks.push({ id, status, phase, runner, dependsOn, stopPolicy, writeSet, validation });
    }
    index = sectionEnd - 1;
  }
  return tasks;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parsedTaskChangesStructure(parsed: ParsedQueueTask, task: SelvedgeWorkflowTask): boolean {
  return (
    parsed.phase !== task.phase ||
    parsed.runner !== task.runner ||
    parsed.stopPolicy !== task.stopPolicy ||
    !sameStringList(parsed.dependsOn, task.dependsOn) ||
    !sameStringList(parsed.writeSet, task.writeSet) ||
    !sameStringList(parsed.validation, task.validation)
  );
}

function isBlockerRecoveryTaskId(id: string): boolean {
  return /-blocker-recovery(?:-\d+)?$/.test(id);
}

function mergeDependsOnPreservingRuntimeRecovery(
  parsed: ParsedQueueTask,
  existing: SelvedgeWorkflowTask
): readonly string[] {
  const parsedDependencies = new Set(parsed.dependsOn);
  const runtimeRecoveryDependencies = existing.dependsOn.filter(
    (id) => isBlockerRecoveryTaskId(id) && !parsedDependencies.has(id)
  );
  return runtimeRecoveryDependencies.length > 0
    ? [...parsed.dependsOn, ...runtimeRecoveryDependencies]
    : parsed.dependsOn;
}

function mergeParsedQueueTaskIntoWorkflowTask(
  parsed: ParsedQueueTask,
  existing: SelvedgeWorkflowTask
): SelvedgeWorkflowTask {
  return {
    ...existing,
    phase: parsed.phase,
    stage: parsed.phase,
    runner: parsed.runner,
    writeSet: parsed.writeSet,
    validation: parsed.validation,
    dependsOn: mergeDependsOnPreservingRuntimeRecovery(parsed, existing),
    stopPolicy: parsed.stopPolicy
  };
}

function parsedQueueOrdersRecoveryAfterDependentTask(
  workflow: SelvedgeGoalWorkflow,
  parsedTasks: readonly ParsedQueueTask[]
): boolean {
  const parsedOrder = new Map(parsedTasks.map((task, index) => [task.id, index]));
  for (const task of workflow.tasks) {
    const taskIndex = parsedOrder.get(task.id);
    if (taskIndex === undefined) {
      continue;
    }
    for (const dependencyId of task.dependsOn) {
      if (!isBlockerRecoveryTaskId(dependencyId)) {
        continue;
      }
      const dependencyIndex = parsedOrder.get(dependencyId);
      if (dependencyIndex !== undefined && dependencyIndex > taskIndex) {
        return true;
      }
    }
  }
  return false;
}

function taskTitleFromQueueId(workflow: SelvedgeGoalWorkflow, taskId: string): string {
  const suffix = taskId.startsWith(`${workflow.id}-`) ? taskId.slice(workflow.id.length + 1) : taskId;
  if (suffix === 'slot-web-profile-config-foundation') {
    return `Define Slot - Web Entry shell profile and config foundation for ${workflow.title}`;
  }
  const label = suffix
    .split('-')
    .filter(Boolean)
    .map((item) => item[0].toUpperCase() + item.slice(1))
    .join(' ');
  return `${label} for ${workflow.title}`;
}

function roleForQueuePhase(phase: SelvedgeWorkflowPhase): string {
  if (phase === 'development') {
    return 'kg-micro-shell-implementer';
  }
  if (phase === 'qa') {
    return 'kg-micro-shell-qa-reviewer';
  }
  if (phase === 'handoff') {
    return 'selvedge-handoff-owner';
  }
  return 'kg-micro-shell-architect';
}

function artifactsFromQueueWriteSet(writeSet: readonly string[]): readonly string[] {
  const artifacts = writeSet.filter((item) => /\.(md|json|log)$/i.test(item));
  return artifacts.length > 0 ? artifacts : writeSet;
}

function taskFromParsedQueue(workflow: SelvedgeGoalWorkflow, parsed: ParsedQueueTask): SelvedgeWorkflowTask {
  return {
    id: parsed.id,
    title: taskTitleFromQueueId(workflow, parsed.id),
    phase: parsed.phase,
    stage: parsed.phase,
    role: roleForQueuePhase(parsed.phase),
    workstream: workflow.workstream,
    roadmapNode: `${workflow.profile.title} / task-queue override`,
    runner: parsed.runner,
    writeSet: parsed.writeSet,
    validation: parsed.validation,
    dependsOn: parsed.dependsOn,
    artifacts: artifactsFromQueueWriteSet(parsed.writeSet),
    stopPolicy: parsed.stopPolicy,
    notes: ['Imported from task-queue.md so runner-created queue changes survive workflow status saves.'],
    status: parsed.status
  };
}

function mergeWorkflowWithTaskQueueMarkdown(
  cwd: string,
  workflow: SelvedgeGoalWorkflow
): SelvedgeGoalWorkflow {
  const queuePath = join(workflowRoot(cwd, workflow.id), 'task-queue.md');
  if (!existsSync(queuePath)) {
    return workflow;
  }
  const parsedTasks = parseTaskQueueMarkdownTasks(readFileSync(queuePath, 'utf8'), workflow.id);
  if (parsedTasks.length === 0) {
    return workflow;
  }
  const workflowTasks = new Map(workflow.tasks.map((task) => [task.id, task]));
  const hasQueueOnlyTask = parsedTasks.some((task) => !workflowTasks.has(task.id));
  const hasStructuralOverride = parsedTasks.some((task) => {
    const existing = workflowTasks.get(task.id);
    return existing ? parsedTaskChangesStructure(task, existing) : false;
  });
  if (!hasQueueOnlyTask && !hasStructuralOverride) {
    return workflow;
  }

  const parsedTasksById = new Map(parsedTasks.map((task) => [task.id, task]));
  const parsedTaskIds = new Set(parsedTasks.map((task) => task.id));
  const workflowHasRuntimeOnlyTask = workflow.tasks.some((task) => !parsedTaskIds.has(task.id));
  const parsedOrderHasStaleRecoveryDependency = parsedQueueOrdersRecoveryAfterDependentTask(workflow, parsedTasks);
  const preserveWorkflowOrder = workflowHasRuntimeOnlyTask || parsedOrderHasStaleRecoveryDependency;
  const workflowTaskIds = new Set(workflow.tasks.map((task) => task.id));
  const mergedTasks = preserveWorkflowOrder
    ? workflow.tasks.map((task) => {
        const parsed = parsedTasksById.get(task.id);
        return parsed ? mergeParsedQueueTaskIntoWorkflowTask(parsed, task) : task;
      })
    : parsedTasks.map((parsed) => {
        const existing = workflowTasks.get(parsed.id);
        return existing
          ? mergeParsedQueueTaskIntoWorkflowTask(parsed, existing)
          : taskFromParsedQueue(workflow, parsed);
      });
  if (preserveWorkflowOrder) {
    for (const parsed of parsedTasks) {
      if (!workflowTaskIds.has(parsed.id)) {
        mergedTasks.push(taskFromParsedQueue(workflow, parsed));
      }
    }
  }
  return {
    ...workflow,
    tasks: mergedTasks
  };
}

function aiPromptMarkdown(workflow: SelvedgeGoalWorkflow): string {
  return [
    `# AI Intake Prompt For ${workflow.title}`,
    '',
    'You are the Selvedge intake agent. Ask the user concise questions until the',
    'goal, scope, authority sources, WriteSet, validation, stop policy, and',
    'handoff expectations are explicit enough to create a bounded workflow.',
    '',
    'Rules:',
    '',
    '- Use Simplified Chinese as the primary language when asking the user intake questions and when summarizing answers.',
    '- Keep technical identifiers, paths, commands, package names, and JSON field names in their original form.',
    '- Do not start implementation during intake.',
    '- Do not guess authority sources when project safety depends on them.',
    '- Convert every answer into durable requirements.',
    '- Mark assumptions explicitly when running non-interactively.',
    '- Generate development and QA tasks separately.',
    '- Do not create or execute an all-in-one long-goal runner task; split work into bounded subtasks with stop points.',
    '- Ask in plain, non-judgmental language for users who may not know technical terms or may not be able to express the full need at first.',
    '- Treat answer options as optional suggestions, not as the only valid answers.',
    '- When asking a user, show the provided answer options and always allow custom details or a fully custom answer.',
    '',
    'Questions:',
    '',
    ...workflow.aiIntake.questions.flatMap((item) => [
      `- ${item.id}: ${item.question}`,
      ...(item.options?.map((option) => `  - Option ${option.id}: ${option.label} - ${option.description}`) ?? [])
    ]),
    ''
  ].join('\n');
}

export function createGoalWorkflow(input: GoalWorkflowInput, model: GameHubReadOnlyModel): SelvedgeGoalWorkflow {
  const questions = buildQuestions(input, model);
  const id = input.id || `goal-${slug(input.title) || 'workflow'}`;
  const profile = getWorkflowProfile(input.profile);
  return {
    version: 1,
    id,
    title: input.title,
    createdAt: new Date().toISOString(),
    target: input.goal,
    source: input.source,
    mode: input.mode,
    profile,
    workstream: input.workstream,
    controlPolicy: SMALL_STEP_CONTROL_POLICY,
    aiIntake: {
      provider: 'codex-app-agent',
      promptPath: docPath(id, 'ai-intake-prompt.md'),
      userDialogueRequired: questions.some((item) => item.status === 'needs-user'),
      questions,
      notes: [
        'Selvedge uses a stable AI intake contract so Codex App, a future OpenAI adapter, or another AI runner can ask the same questions.',
        'Non-interactive runs must mark assumptions and keep them visible in requirements.'
      ]
    },
    documents: {
      goal: docPath(id, 'goal.md'),
      requirements: docPath(id, 'requirements.md'),
      taskQueue: docPath(id, 'task-queue.md'),
      handoff: docPath(id, 'handoff.md')
    },
    tasks: createWorkflowTasks({ ...input, id })
  };
}

export function createAutopilotNextWorkflow(id: string, model: GameHubReadOnlyModel): SelvedgeGoalWorkflow {
  const target =
    model.taskBoard.pendingCount > 0
      ? `Execute current GameHub first Pending task ${model.taskBoard.firstPendingId ?? 'unknown'} through a Selvedge-controlled wrapper.`
      : 'Complete Selvedge commercial productization as the approved post-quick-games mainline, then prepare the first KG slots-class dogfood workflow.';
  return createGoalWorkflow(
    {
      id,
      title: 'GameHub Autopilot Next Objective',
      goal: target,
      workstream: model.taskBoard.pendingCount > 0 ? 'gamehub-autopilot-wrapper' : 'selvedge-productization',
      source: 'selvedge plan autopilot-next',
      mode: 'autopilot-next',
      profile: 'universal-autopilot',
      commands:
        model.taskBoard.pendingCount > 0
          ? [
              'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-master-loop.ps1 -StopAfterCurrentRound -ExitOnNoExecutableWork'
            ]
          : [],
      writeSet:
        model.taskBoard.pendingCount > 0
          ? [
              'docs/autopilot/state/**',
              '.codex-run-logs/**',
              '.selvedge/**'
            ]
          : [
              'packages/selvedge-cli/**',
              'tools/selvedge/**',
              'selvedge.yaml',
              'docs/autopilot/**',
              '.selvedge/**'
            ],
      validation:
        model.taskBoard.pendingCount > 0
          ? ['git diff --check', 'Task-specific validation from TASK_BOARD first Pending item']
          : [
              'pnpm typecheck',
              'pnpm test',
              'pnpm build',
              'pnpm selvedge validate',
              'git diff --check'
            ],
      answers: [
        'business-outcome=Finish Selvedge as the commercial-quality long-running task controller approved after quick-games acceptance.',
        'development-flow=AI intake, durable goal docs, task decomposition, bounded development, separate QA, handoff, and feedback capture.',
        'qa-flow=Typecheck, tests, build, Selvedge validation, CLI smoke, local console smoke, and git diff checks.',
        'stop-and-recovery=Stop on missing user decision, unsupported runner, failed validation, unsafe WriteSet, STOP policy conflict, or unclear next action.'
      ],
      nonInteractive: true
    },
    model
  );
}

export function writeGoalWorkflow(cwd: string, workflow: SelvedgeGoalWorkflow, model: GameHubReadOnlyModel): void {
  const root = workflowRoot(cwd, workflow.id);
  ensureDir(root);
  writeJson(workflowPath(cwd, workflow.id), workflow);
  writeText(join(root, 'goal.md'), goalMarkdown(workflow, model));
  writeText(join(root, 'requirements.md'), requirementsMarkdown(workflow));
  writeText(join(root, 'task-queue.md'), taskQueueMarkdown(workflow));
  writeText(join(root, 'ai-intake-prompt.md'), aiPromptMarkdown(workflow));
  if (workflow.architecture) {
    writeText(join(root, 'architecture-proposal.md'), architectureMarkdown(workflow.architecture));
  }
}

export function readGoalWorkflow(cwd: string, id: string): SelvedgeGoalWorkflow | null {
  const path = workflowPath(cwd, id);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SelvedgeGoalWorkflow;
}

function taskById(workflow: SelvedgeGoalWorkflow, id: string): SelvedgeWorkflowTask | null {
  return workflow.tasks.find((task) => task.id === id) ?? null;
}

function dependencySatisfied(workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): boolean {
  return task.dependsOn.every((id) => taskById(workflow, id)?.status === 'Completed');
}

export function selectNextWorkflowTask(workflow: SelvedgeGoalWorkflow): SelvedgeWorkflowTask | null {
  return workflow.tasks.find((task) => task.status === 'Pending' && dependencySatisfied(workflow, task)) ?? null;
}

export function setWorkflowTaskStatus(
  workflow: SelvedgeGoalWorkflow,
  taskId: string,
  status: SelvedgeTaskStatus,
  reason?: string
): SelvedgeGoalWorkflow {
  const now = new Date().toISOString();
  return {
    ...workflow,
    tasks: workflow.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      return {
        ...task,
        status,
        statusUpdatedAt: now,
        startedAt: status === 'InProgress' ? now : task.startedAt,
        completedAt: status === 'Completed' || status === 'Failed' || status === 'Blocked' ? now : task.completedAt,
        statusReason: reason ?? task.statusReason
      };
    })
  };
}

export function saveGoalWorkflow(cwd: string, workflow: SelvedgeGoalWorkflow): void {
  const merged = mergeWorkflowWithTaskQueueMarkdown(cwd, workflow);
  writeJson(workflowPath(cwd, merged.id), merged);
  writeText(join(workflowRoot(cwd, merged.id), 'task-queue.md'), taskQueueMarkdown(merged));
}

export function writeBuiltinTaskEvidence(cwd: string, workflow: SelvedgeGoalWorkflow, task: SelvedgeWorkflowTask): void {
  const root = workflowRoot(cwd, workflow.id);
  if (task.runner === 'builtin:intake-doc') {
    writeText(join(root, 'goal.md'), goalMarkdown(workflow, {
      generatedAt: workflow.createdAt,
      cwd,
      config: {
        exists: true,
        path: 'selvedge.yaml',
        projectName: null,
        currentPhase: null,
        currentAutopilotIsAuthoritative: 'unknown',
        packageName: null,
        primaryBuilder: null,
        firstDogfoodPreferred: null,
        heartbeatFormat: 'block',
        heartbeatTemplate: {
          format: 'block',
          optionalFields: ['machine']
        },
        heartbeatInvalidOptionalFields: []
      },
      taskBoard: {
        exists: true,
        pendingRaw: null,
        pendingCount: 0,
        firstPendingId: null,
        inProgressRaw: null,
        inProgressCount: 0,
        approvedAfterAiQaMentionsSelvedge: true,
        manualAcceptancePassed: true
      },
      aiQaSwitch: {
        exists: true,
        enabled: false,
        workstream: null,
        campaignId: null,
        disabledReason: null
      },
      stopFile: {
        exists: false,
        path: 'STOP_AGENT',
        summary: null
      },
      firstExecutableTask: {
        verdict: 'none',
        reason: 'Captured at workflow creation.',
        taskId: null
      },
      selvedgeMainline: {
        canStartInCodexApp: true,
        reason: 'Captured at workflow creation.'
      },
      issues: []
    }));
    writeText(join(root, 'requirements.md'), requirementsMarkdown(workflow));
    return;
  }
  if (task.runner === 'builtin:task-decomposition') {
    writeText(join(root, 'task-queue.md'), taskQueueMarkdown(workflow));
    return;
  }
  if (task.runner === 'builtin:handoff') {
    writeText(join(root, 'handoff.md'), handoffMarkdown(workflow));
  }
}

function handoffMarkdown(workflow: SelvedgeGoalWorkflow): string {
  const completed = workflow.tasks.filter((task) => task.status === 'Completed').length;
  const failed = workflow.tasks.filter((task) => task.status === 'Failed').length;
  const blocked = workflow.tasks.filter((task) => task.status === 'Blocked' || task.status === 'NeedsHumanInput' || task.status === 'NeedsRunner').length;
  return [
    `# Handoff For ${workflow.title}`,
    '',
    `Workflow: ${workflow.id}`,
    `Mode: ${workflow.mode}`,
    `Profile: ${workflow.profile.id} / ${workflow.profile.title}`,
    `Target: ${workflow.target}`,
    '',
    '## Final State',
    '',
    `- Completed tasks: ${completed}`,
    `- Failed tasks: ${failed}`,
    `- Blocked / needs action tasks: ${blocked}`,
    '',
    '## Task Status',
    '',
    ...workflow.tasks.map((task) => `- ${task.id}: ${task.status}${task.statusReason ? ` / ${task.statusReason}` : ''}`),
    '',
    '## Evidence',
    '',
    `- Goal: ${workflow.documents.goal}`,
    `- Requirements: ${workflow.documents.requirements}`,
    `- Queue: ${workflow.documents.taskQueue}`,
    '',
    '## Recovery',
    '',
    '- If a shell command failed, inspect the matching .selvedge/logs file and classify it before retry.',
    '- If a runner is unsupported, add the runner adapter or continue through Codex App with the generated AI prompt.',
    '- If requirements are incomplete, resume intake before editing implementation files.',
    ''
  ].join('\n');
}
