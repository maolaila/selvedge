import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  autoPushIfClean,
  actionableGitStatusLinesForTaskBoundary,
  actionableGitStatusLines,
  artifactContainsBlockingSignal,
  capacityRetryDelaySeconds,
  checkCodexCliPreflight,
  clearSavedStopCondition,
  createCompletedWorkflowContinuationForDashboardStart,
  createContinuousWorkflowContinuationForDashboardStart,
  createNextDashboardWorkflowForProjectObjectiveStart,
  createProjectObjectiveNextTaskWorkflowForDashboardStart,
  inferDashboardProfile,
  isSelvedgeRuntimeStateStatusLine,
  loopArgsForWorkflow,
  normalizeStopCondition,
  prepareBlockedWorkflowForDashboardStart,
  prepareLoopBlockerRecovery,
  readSavedStopCondition,
  renderDashboardHtmlForTest,
  runInit,
  runStatus,
  saveStopCondition,
  taskNeedsBlockingArtifactScan,
  workflowReadyForHumanReview
} from './commands';
import { readSelvedgeConfig } from './config';
import { buildReadOnlyModel } from './gamehub-adapter';
import { createAssignedWorkPlan } from './planner';
import { parseWorkflowProfileId } from './profiles';
import { buildProjectObjectiveDraft, buildProjectObjectiveReviewPrompt, projectObjectiveMarkdown } from './project-objective';
import {
  buildHeartbeatBlock,
  buildCodexExecArgs,
  buildCodexTaskPrompt,
  buildHeartbeatLine,
  buildRunnerHeartbeat,
  assertCodexServiceTierConfig,
  classifyCodexResult,
  classifyRunnerCurrentAction,
  formatDuration,
  formatLocalTimestamp,
  resolveCodexRunnerOptions,
  resolveStopPolicy,
  staleFinalMessageCompleted
} from './runner';
import {
  createAutopilotNextWorkflow,
  createGoalWorkflow,
  readGoalWorkflow,
  saveGoalWorkflow,
  selectNextWorkflowTask,
  setWorkflowTaskStatus,
  writeGoalWorkflow
} from './workflow';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  expect(result.status, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout ?? '';
}

function fixtureRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'selvedge-gamehub-'));
  mkdirSync(join(cwd, 'docs/autopilot/state'), { recursive: true });
  writeFileSync(
    join(cwd, 'selvedge.yaml'),
    [
      'version: 0.1',
      'project:',
      '  name: game-hub',
      '  currentPhase: gamehub-default-entry',
      'heartbeat:',
      '  format: block',
      '  optionalFields:',
      '    - migrationTarget',
      '    - machine',
      'compatibility:',
      '  currentAutopilotIsAuthoritative: false',
      'commercializationPlan:',
      '  distribution:',
      '    packageName: "@maolaila1/selvedge"',
      '  developmentMode:',
      '    primaryBuilder: codex-app-agent',
      '  firstDogfoodTask:',
      '    preferred: kg-slots-class-migration-or-review',
      ''
    ].join('\n')
  );
  writeFileSync(
    join(cwd, 'docs/autopilot/state/TASK_BOARD.md'),
    [
      '# TASK BOARD',
      '',
      '## Pending',
      '',
      'None. On 2026-06-05 the user reported manual acceptance passed.',
      '',
      '## Approved After AI-QA',
      '',
      'The next approved unattended mainline is Selvedge commercial productization.',
      '',
      '## In Progress',
      '',
      'None.',
      ''
    ].join('\n')
  );
  writeFileSync(
    join(cwd, 'docs/autopilot/state/AI_QA_CAMPAIGN.md'),
    [
      '# AI-QA Campaign Switch',
      '',
      '## Current Switch',
      '',
      '```yaml',
      'aiQa:',
      '  enabled: false',
      '  workstream: quick-games',
      '  campaignId: quick-games-popup-component-parity-2026-06-04',
      '```',
      ''
    ].join('\n')
  );
  writeFileSync(join(cwd, 'STOP_AGENT'), 'Human verification stop.\n');
  return cwd;
}

function writeFixtureProjectObjective(cwd: string): ReturnType<typeof buildProjectObjectiveDraft> {
  const objective = buildProjectObjectiveDraft({
    totalGoal: 'Use Selvedge as the single GameHub controller for scoped KG migration, platform, QA, and delivery tasks.',
    scopes: ['apps/kg-micro-shell|KG micro shell|kg-micro-shell', 'packages/selvedge-cli|Selvedge CLI|selvedge-productization'],
    authoritySources: ['.selvedge/project/objective.md', 'AGENTS.md', 'apps/kg-micro-shell/docs/execution-roadmap.md'],
    writeBoundaries: ['apps/kg-micro-shell/**', 'packages/selvedge-cli/**'],
    validationExpectations: ['git diff --check'],
    stopExpectations: ['Stop on objective conflicts or when the current task reaches human-review readiness.'],
    notes: 'Operator may define the next task at dashboard start; blank means auto-select from the project objective.',
    workstream: 'kg-micro-shell',
    activeWorkflowIds: []
  });
  mkdirSync(join(cwd, '.selvedge/project'), { recursive: true });
  writeFileSync(join(cwd, '.selvedge/project/objective.json'), JSON.stringify(objective, null, 2));
  return objective;
}

function writeFixtureKgNewTypeBatch(cwd: string): void {
  mkdirSync(join(cwd, 'apps/kg-micro-shell/docs'), { recursive: true });
  writeFileSync(
    join(cwd, 'apps/kg-micro-shell/docs/game-migration-list.md'),
    [
      '# KG Micro Shell Game Migration List',
      '',
      '2026-06-09 new-type migration batch note:',
      '',
      '| Batch | KG Catalog Class | Approved Count | Required Target Constraint | Status |',
      '|---:|---|---:|---|---|',
      '| NT-1 | Slot - Web Entry | 2 | Pick exact targets from KG catalog/source evidence during Selvedge intake. | `Planned` |',
      '| NT-2 | Fish | 1 | Pick exact target from KG catalog/source evidence during Selvedge intake. | `Planned` |',
      '| NT-3 | Poker / Card | 2 | Pick exact targets from KG catalog/source evidence during Selvedge intake. | `Planned` |',
      '| NT-4 | Bingo / Table | 2 | One target must be 森林舞会; pick the other exact target from KG catalog/source evidence during Selvedge intake. | `Planned` |',
      ''
    ].join('\n')
  );
}

function writeCompletedBatchWorkflow(
  cwd: string,
  model: ReturnType<typeof buildReadOnlyModel>,
  batch: string,
  catalogClass: string,
  ordinal: number
) {
  let workflow = createGoalWorkflow(
    {
      id: `kg-new-type-${batch.toLowerCase()}-${ordinal}`,
      title: `KG new-type batch ${batch}: ${catalogClass} target ${ordinal}`,
      goal: `KG new-type batch ${batch}: migrate ${catalogClass} target ${ordinal}`,
      workstream: 'kg-micro-shell',
      source: 'test completed batch workflow',
      mode: 'goal-workflow',
      profile: 'kg-game-migration',
      commands: [],
      writeSet: ['apps/kg-micro-shell/**'],
      validation: ['git diff --check'],
      answers: [`target-game=Batch ${batch}: ${catalogClass} target ${ordinal}`],
      nonInteractive: true
    },
    model
  );
  for (const task of [...workflow.tasks]) {
    workflow = setWorkflowTaskStatus(workflow, task.id, 'Completed');
  }
  writeGoalWorkflow(cwd, workflow, model);
  return workflow;
}

describe('GameHub read-only adapter', () => {
  test('initializes a generic npm project without requiring GameHub state files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'selvedge-generic-'));
    expect(runInit({ command: 'init', args: [], cwd })).toBe(0);
    expect(existsSync(join(cwd, 'selvedge.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.selvedge/schema/goal-workflow.schema.json'))).toBe(true);

    const model = buildReadOnlyModel(cwd);
    expect(model.config.exists).toBe(true);
    expect(model.taskBoard.exists).toBe(false);
    expect(model.aiQaSwitch.exists).toBe(false);
    expect(model.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(model.selvedgeMainline.canStartInCodexApp).toBe(true);
    expect(runStatus({ command: 'status', args: [], cwd })).toBe(0);
  });

  test('recognizes the post-QA Selvedge mainline gate', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    expect(model.taskBoard.pendingCount).toBe(0);
    expect(model.aiQaSwitch.enabled).toBe(false);
    expect(model.stopFile.exists).toBe(true);
    expect(model.selvedgeMainline.canStartInCodexApp).toBe(true);
  });

  test('reads block heartbeat template configuration from selvedge.yaml', () => {
    const config = readSelvedgeConfig(fixtureRepo());
    expect(config.heartbeatTemplate.format).toBe('block');
    expect(config.heartbeatTemplate.optionalFields).toEqual(['migrationTarget', 'machine']);
    expect(config.heartbeatInvalidOptionalFields).toEqual([]);
  });

  test('preserves generic assigned-work shell commands in the execution task', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const plan = createAssignedWorkPlan(
      {
        id: 'shell-smoke',
        title: 'Shell smoke',
        goal: 'Verify shell runner command planning',
        workstream: 'selvedge-productization',
        stage: 'development',
        runner: 'shell',
        commands: ['echo Selvedge shell runner smoke'],
        writeSet: ['.selvedge/**'],
        validation: ['git diff --check']
      },
      model
    );
    const executeTask = plan.tasks.find((task) => task.id === 'shell-smoke-execute');
    expect(executeTask?.runner).toBe('shell');
    expect(executeTask?.commands).toEqual(['echo Selvedge shell runner smoke']);
    expect(plan.mode).toBe('assigned-work');
  });

  test('builds a resumable autopilot-next workflow with separate development and QA phases', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createAutopilotNextWorkflow('autopilot-next', model);
    expect(workflow.mode).toBe('autopilot-next');
    expect(workflow.profile.id).toBe('universal-autopilot');
    expect(workflow.aiIntake.questions.length).toBeGreaterThan(5);
    expect(workflow.aiIntake.questions.find((item) => item.id === 'authority-sources')?.options?.length).toBeGreaterThan(1);
    expect(workflow.tasks.map((task) => task.phase)).toEqual([
      'intake',
      'planning',
      'development',
      'qa',
      'handoff'
    ]);
    expect(workflow.tasks.find((task) => task.phase === 'development')?.runner).toBe('shell');
    expect(workflow.tasks.find((task) => task.phase === 'qa')?.runner).toBe('shell');

    const first = selectNextWorkflowTask(workflow);
    expect(first?.id).toBe('autopilot-next-intake');
    const afterIntake = setWorkflowTaskStatus(workflow, 'autopilot-next-intake', 'Completed');
    expect(selectNextWorkflowTask(afterIntake)?.id).toBe('autopilot-next-planning');
  });

  test('records AI intake options as suggestions that allow custom answers', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    const workflow = createGoalWorkflow(
      {
        id: 'custom-intake',
        title: 'Custom intake',
        goal: 'Turn a rough user idea into a scoped Selvedge workflow',
        workstream: 'assigned-work',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: [],
        validation: [],
        answers: [],
        nonInteractive: false
      },
      model
    );

    writeGoalWorkflow(cwd, workflow, model);
    const prompt = readFileSync(join(cwd, workflow.aiIntake.promptPath), 'utf8');
    const requirements = readFileSync(join(cwd, workflow.documents.requirements), 'utf8');

    expect(prompt).toContain('Treat answer options as optional suggestions');
    expect(prompt).toContain('fully custom answer');
    expect(requirements).toContain('a user-written custom answer is equally authoritative');
  });

  test('creates Chinese-first intake questions for dashboard workflows', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'zh-intake',
        title: '中文需求引导',
        goal: '把一个新项目想法拆成可自动执行的 Selvedge 工作流',
        workstream: 'assigned-work',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: [],
        validation: [],
        answers: [],
        nonInteractive: false
      },
      model
    );

    expect(workflow.aiIntake.questions.find((item) => item.id === 'business-outcome')?.question).toContain('业务结果');
    expect(workflow.aiIntake.questions.find((item) => item.id === 'stop-and-recovery')?.question).toContain('停止');
  });

  test('reports missing Codex CLI in dashboard readiness panel', () => {
    const cwd = fixtureRepo();
    const preflight = checkCodexCliPreflight(['--codex-executable', 'selvedge-test-missing-codex']);
    const html = renderDashboardHtmlForTest(cwd, 'zh', ['--codex-executable', 'selvedge-test-missing-codex']);

    expect(preflight.available).toBe(false);
    expect(html).toContain('Codex CLI / AI 执行器');
    expect(html).toContain('未配置');
    expect(html).toContain('npm install -g @openai/codex');
  });

  test('records the small-step queue policy on goal workflows', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'small-step-product',
        title: 'Small step product workflow',
        goal: 'Build a large product through Selvedge without running the broad total goal directly',
        workstream: 'assigned-work',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: [],
        validation: [],
        answers: [],
        nonInteractive: true
      },
      model
    );

    expect(workflow.controlPolicy?.executionMode).toBe('small-step-queue');
    expect(workflow.controlPolicy?.longGoalExecution).toBe('forbidden');
    expect(workflow.controlPolicy?.codexInvocation).toBe('single-subtask-only');
    expect(workflow.tasks.find((task) => task.id === 'small-step-product-development')?.title).toContain('one bounded development slice');
    expect(workflow.tasks.find((task) => task.id === 'small-step-product-planning')?.validation.join('\n')).toContain('not being sent as one broad runner task');
  });

  test('preserves runner-created task queue gates during workflow status saves', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-new-type-nt-1-2',
        title: 'KG new type target 2',
        goal: 'Migrate a KG Slot - Web Entry target through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-game-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=shz-955'],
        nonInteractive: true
      },
      model
    );
    writeGoalWorkflow(cwd, workflow, model);

    const queuePath = join(cwd, '.selvedge/goals/kg-new-type-nt-1-2/task-queue.md');
    const foundationTask = [
      '### kg-new-type-nt-1-2-slot-web-profile-config-foundation',
      '',
      '- Status: Pending',
      '- Phase: planning',
      '- Runner: codex-app-agent',
      '- DependsOn: kg-new-type-nt-1-2-functional-detail-ledger',
      '- StopPolicy: stop-if-slot-web-entry-profile-or-config-foundation-remains-unclear',
      '- WriteSet:',
      '  - apps/kg-micro-shell/docs/**',
      '  - docs/kg-micro-shell-agent-reference/**',
      '  - .selvedge\\goals\\kg-new-type-nt-1-2\\task-queue.md',
      '  - .selvedge\\goals\\kg-new-type-nt-1-2\\profile-config-foundation.md',
      '- Validation:',
      '  - Confirm the Slot - Web Entry shell profile boundary before runtime work.',
      ''
    ].join('\n');
    const queueWithFoundation = readFileSync(queuePath, 'utf8').replace(
      '### kg-new-type-nt-1-2-backend-handler',
      `${foundationTask}\n### kg-new-type-nt-1-2-backend-handler`
    );
    const queue = queueWithFoundation.replace(
      [
        '### kg-new-type-nt-1-2-backend-handler',
        '',
        '- Status: Pending',
        '- Phase: development',
        '- Runner: codex-app-agent',
        '- DependsOn: kg-new-type-nt-1-2-functional-detail-ledger'
      ].join('\n'),
      [
        '### kg-new-type-nt-1-2-backend-handler',
        '',
        '- Status: Pending',
        '- Phase: development',
        '- Runner: codex-app-agent',
        '- DependsOn: kg-new-type-nt-1-2-slot-web-profile-config-foundation'
      ].join('\n')
    );
    writeFileSync(queuePath, queue);

    workflow = setWorkflowTaskStatus(workflow, 'kg-new-type-nt-1-2-micro-shell-profile-fit', 'Completed', 'success');
    saveGoalWorkflow(cwd, workflow);

    const savedQueue = readFileSync(queuePath, 'utf8');
    const savedWorkflow = JSON.parse(
      readFileSync(join(cwd, '.selvedge/goals/kg-new-type-nt-1-2/goal.workflow.json'), 'utf8')
    );
    expect(savedQueue).toContain('### kg-new-type-nt-1-2-slot-web-profile-config-foundation');
    expect(savedQueue).toContain('- DependsOn: kg-new-type-nt-1-2-slot-web-profile-config-foundation');
    expect(savedWorkflow.tasks.map((task: { id: string }) => task.id)).toContain(
      'kg-new-type-nt-1-2-slot-web-profile-config-foundation'
    );
    expect(
      savedWorkflow.tasks.find((task: { id: string }) => task.id === 'kg-new-type-nt-1-2-backend-handler')?.dependsOn
    ).toEqual(['kg-new-type-nt-1-2-slot-web-profile-config-foundation']);
  });

  test('writes pending architecture proposals with confirmation status', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    const workflow = createGoalWorkflow(
      {
        id: 'new-product',
        title: 'New product',
        goal: 'Initialize a new dashboard product',
        workstream: 'assigned-work',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: [],
        validation: [],
        answers: [],
        nonInteractive: true
      },
      model
    );
    const withArchitecture = {
      ...workflow,
      architecture: {
        version: 1 as const,
        generatedAt: '2026-06-08T00:00:00.000Z',
        reviewer: 'codex-cli-ai-architect' as const,
        status: 'pending-confirmation' as const,
        confirmationRequired: true,
        summary: 'Use a TypeScript web stack.',
        recommendedStack: ['TypeScript', 'React'],
        reasons: ['Fits the dashboard requirement.'],
        projectStructure: ['apps/web'],
        initializationPlan: ['Create app shell after confirmation.'],
        risks: ['Wrong stack if user intent changes.']
      }
    };

    writeGoalWorkflow(cwd, withArchitecture, model);
    const architectureDoc = readFileSync(join(cwd, '.selvedge/goals/new-product/architecture-proposal.md'), 'utf8');
    const goalDoc = readFileSync(join(cwd, '.selvedge/goals/new-product/goal.md'), 'utf8');

    expect(architectureDoc).toContain('Status: pending-confirmation');
    expect(architectureDoc).toContain('TypeScript');
    expect(goalDoc).toContain('User confirmation is required');
  });

  test('models one project objective with scoped monorepo workflows', () => {
    const objective = buildProjectObjectiveDraft({
      totalGoal: 'Use Selvedge to run long autonomous development and QA work from the dashboard',
      scopes: ['apps/kg-micro-shell|KG micro shell|kg-micro-shell', 'packages/selvedge-cli|Selvedge CLI|selvedge-productization'],
      authoritySources: ['README.md', 'AGENTS.md'],
      writeBoundaries: ['apps/kg-micro-shell/**', 'packages/selvedge-cli/**'],
    validationExpectations: ['pnpm test'],
      stopExpectations: ['Stop when the current independent module reaches human review readiness.'],
      notes: 'Project objective is edited once and workflows run under it.',
      workstream: 'selvedge-productization',
      activeWorkflowIds: ['kg-slots-next']
    });
    expect(objective.id).toBe('project-objective');
    expect(objective.monorepoStrategy).toBe('single-project-objective-with-scoped-workflows');
    expect(objective.scopes.map((scope) => scope.path)).toEqual(['apps/kg-micro-shell', 'packages/selvedge-cli']);
    expect(projectObjectiveMarkdown(objective)).toContain('One Selvedge project has exactly one active project objective.');
  });

  test('builds an AI review prompt that rejects multiple root objectives but allows monorepo scopes', () => {
    const objective = buildProjectObjectiveDraft({
      totalGoal: 'Build a dashboard-first Selvedge product',
      scopes: ['apps/admin-console|Admin console|admin-console', 'apps/kg-micro-shell|KG micro shell|kg-micro-shell'],
      authoritySources: [],
      writeBoundaries: [],
      validationExpectations: [],
      stopExpectations: [],
      notes: '',
      workstream: 'assigned-work',
      activeWorkflowIds: []
    });
    const prompt = buildProjectObjectiveReviewPrompt(objective, null);
    expect(prompt).toContain('one active project objective per workspace');
    expect(prompt).toContain('Do not reject merely because the monorepo has multiple scopes');
    expect(prompt).toContain('"status":"accepted|needs-revision"');
  });

  test('builds a KG slots profile workflow with feature-map and independent-audit gates', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    expect(workflow.profile.id).toBe('kg-slots-migration');
    expect(workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('AuthorizedAutoSelect');
    expect(workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.options?.map((item) => item.id)).toContain('auto-select');
    expect(workflow.tasks.map((task) => task.id)).toEqual([
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test',
      'kg-slots-next-independent-audit',
      'kg-slots-next-handoff'
    ]);
    expect(workflow.tasks.find((task) => task.id === 'kg-slots-next-development')).toBeUndefined();
    expect(workflow.tasks.find((task) => task.id === 'kg-slots-next-source-feature-inventory')?.dependsOn).toEqual([
      'kg-slots-next-micro-shell-profile-fit'
    ]);
    expect(workflow.tasks.find((task) => task.id === 'kg-slots-next-micro-shell-profile-fit')?.validation.join('\n')).toContain('ReuseExistingProfile');
    expect(workflow.tasks.find((task) => task.id === 'kg-slots-next-source-feature-inventory')?.validation.join('\n')).toContain('type:slot');
    expect(workflow.tasks.find((task) => task.id === 'kg-slots-next-source-feature-inventory')?.validation.join('\n')).toContain('RTP and KG control/money policy');
    expect(workflow.tasks.find((task) => task.id.endsWith('independent-audit'))?.phase).toBe('qa');
    let blockedAfterAudit = workflow;
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      blockedAfterAudit = setWorkflowTaskStatus(blockedAfterAudit, taskId, 'Completed');
    }
    blockedAfterAudit = setWorkflowTaskStatus(blockedAfterAudit, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    expect(selectNextWorkflowTask(blockedAfterAudit)).toBeNull();
  });

  test('builds a KG game profile workflow for newly approved non-slots game types', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'kg-game-next',
        title: 'KG new game type migration',
        goal: 'Migrate the next approved KG non-slots game type through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-game-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=Needs concrete non-slots target selected from KG sources'],
        nonInteractive: true
      },
      model
    );

    expect(workflow.profile.id).toBe('kg-game-migration');
    expect(workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('non-slots target');
    expect(workflow.tasks.map((task) => task.id)).toEqual([
      'kg-game-next-intake',
      'kg-game-next-micro-shell-profile-fit',
      'kg-game-next-source-feature-inventory',
      'kg-game-next-functional-detail-ledger',
      'kg-game-next-backend-handler',
      'kg-game-next-shell-protocol-primitives',
      'kg-game-next-result-callback-runtime',
      'kg-game-next-history-detail-room-state-bridge',
      'kg-game-next-route-context-integration',
      'kg-game-next-qa-self-test',
      'kg-game-next-independent-audit',
      'kg-game-next-handoff'
    ]);
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-source-feature-inventory')?.dependsOn).toEqual([
      'kg-game-next-micro-shell-profile-fit'
    ]);
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-micro-shell-profile-fit')?.validation.join('\n')).toContain('NewShellProfileRequired');
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-source-feature-inventory')?.validation.join('\n')).toContain('game type');
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-source-feature-inventory')?.validation.join('\n')).toContain('type:<slot|card|fish|table>');
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-independent-audit')?.validation.join('\n')).toContain('MismatchBlocker');
    expect(workflow.tasks.find((task) => task.id === 'kg-game-next-route-context-integration')?.notes.join('\n')).toContain('Do not reuse slots-specific behavior');
  });

  test('does not execute declarative validation text as shell commands', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'kg-game-next',
        title: 'KG new game type migration',
        goal: 'Migrate the next approved KG non-slots game type through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-game-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: [
          'Selvedge changes must at least run the relevant CLI validation commands.',
          'KG migration tasks must complete source inventory, parity ledger, browser smoke, independent audit, and handoff evidence.'
        ],
        answers: ['target-game=Needs concrete non-slots target selected from KG sources'],
        nonInteractive: true
      },
      model
    );

    const selfTest = workflow.tasks.find((task) => task.id === 'kg-game-next-qa-self-test');
    expect(selfTest?.runner).toBe('codex-app-agent');
    expect(selfTest?.commands).toEqual([]);
  });

  test('dashboard profile inference separates KG new types from slots migrations', () => {
    const kgNewType = new URLSearchParams();
    kgNewType.set('goal', '开启 KG 新类型游戏迁移，先做源码盘点');
    expect(inferDashboardProfile(kgNewType)).toBe('kg-game-migration');

    const kgSlots = new URLSearchParams();
    kgSlots.set('goal', '继续 KG slots 类型迁移');
    expect(inferDashboardProfile(kgSlots)).toBe('kg-slots-migration');

    const kgWebEntry = new URLSearchParams();
    kgWebEntry.set('goal', 'Migrate KG Slot - Web Entry games');
    expect(inferDashboardProfile(kgWebEntry)).toBe('kg-game-migration');

    const explicit = new URLSearchParams();
    explicit.set('goal', 'anything');
    explicit.set('profile', 'kg-game-migration');
    expect(inferDashboardProfile(explicit)).toBe('kg-game-migration');
  });

  test('dashboard renders operator-friendly Chinese task names with hover details', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    const workflow = createGoalWorkflow(
      {
        id: 'kg-game-next',
        title: 'KG new game type migration',
        goal: 'Migrate the next approved KG non-slots game type through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-game-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=Needs concrete non-slots target selected from KG sources'],
        nonInteractive: true
      },
      model
    );
    mkdirSync(join(cwd, '.selvedge/goals/kg-game-next'), { recursive: true });
    writeFileSync(join(cwd, '.selvedge/goals/kg-game-next/goal.workflow.json'), JSON.stringify(workflow, null, 2));

    const html = renderDashboardHtmlForTest(cwd, 'zh');

    expect(html).toContain('1/12 需求确认');
    expect(html).toContain('源码功能盘点');
    expect(html).toContain('自测验收');
    expect(html).toContain('独立复查');
    expect(html).toContain('交付说明');
    expect(html).toContain('任务：需求确认');
    expect(html).toContain('原始标题：AI-assisted KG game intake');
    expect(html).toContain('Codex 自动执行');
    expect(html).toContain('KG 迁移架构');
  });

  test('dashboard keeps polling snapshots even when live socket stalls', () => {
    const cwd = fixtureRepo();
    const html = renderDashboardHtmlForTest(cwd, 'zh');

    expect(html).toContain('let snapshotRefreshTimer = null;');
    expect(html).toContain('window.setInterval(fetchDashboardSnapshot, 5000)');
    expect(html).toContain('startSnapshotRefresh();');
  });

  test('dashboard can start the next task from the project objective when no workflow is startable', () => {
    const cwd = fixtureRepo();
    writeFixtureProjectObjective(cwd);
    const html = renderDashboardHtmlForTest(cwd, 'en');

    expect(html).toContain('Start next task from the project objective');
    expect(html).toContain('name="continuationGoal"');
    expect(html).toContain('action="/actions/start-loop?lang=en"');
    expect(html).not.toContain('action="/actions/create-goal?lang=en"');
    expect(html).not.toContain('id="dashboardStartButton" type="submit" disabled');
  });

  test('project-objective start creates a KG game migration workflow from the next task field', () => {
    const cwd = fixtureRepo();
    const objective = writeFixtureProjectObjective(cwd);
    const model = buildReadOnlyModel(cwd);
    const workflow = createProjectObjectiveNextTaskWorkflowForDashboardStart(
      cwd,
      objective,
      'Start KG new game type migration with source inventory first',
      model
    );

    expect(workflow.profile.id).toBe('kg-game-migration');
    expect(workflow.source).toBe('selvedge dashboard project-objective start');
    expect(workflow.aiIntake.userDialogueRequired).toBe(false);
    expect(workflow.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('KG new game type');
    expect(workflow.tasks.map((task) => task.id)).toContain(`${workflow.id}-micro-shell-profile-fit`);
    expect(selectNextWorkflowTask(workflow)?.id).toBe(`${workflow.id}-intake`);
  });

  test('blank project-objective dashboard start prefers the approved KG new-type batch', () => {
    const cwd = fixtureRepo();
    const objective = writeFixtureProjectObjective(cwd);
    writeFixtureKgNewTypeBatch(cwd);
    const model = buildReadOnlyModel(cwd);

    const workflow = createNextDashboardWorkflowForProjectObjectiveStart(cwd, objective, '', model);

    expect(workflow.profile.id).toBe('kg-game-migration');
    expect(workflow.target).toContain('NT-1');
    expect(workflow.target).toContain('Slot - Web Entry');
    expect(workflow.source).toBe('selvedge continuous planner from NT-1');
    expect(selectNextWorkflowTask(workflow)?.id).toBe(`${workflow.id}-intake`);
  });

  test('audit artifact blocker scan ignores explicit no-blocker verdicts', () => {
    expect(
      artifactContainsBlockingSignal(
        [
          '# Independent Audit',
          '',
          '- Verdict: `PassedForHandoff`',
          '- Stop policy result: no `MismatchBlocker` found.',
          '- ReadyForHumanReview: Not blocked by this audit.',
          '- ReadyForHumanReview: `NotBlockedByIndependentAudit`',
          '- ReadyForHumanReview block check: no `MismatchBlocker` is present in this audit.',
          '',
          '| ID | Status | Audit finding |',
          '|---|---|---|',
          '| FD-001 | Match | Source and migration match. |'
        ].join('\n')
      )
    ).toBe(false);
  });

  test('audit artifact blocker scan catches positive ReadyForHumanReview blockers only', () => {
    expect(artifactContainsBlockingSignal('ReadyForHumanReview: Not blocked by this audit.')).toBe(false);
    expect(artifactContainsBlockingSignal('ReadyForHumanReview: `NotBlockedByIndependentAudit`')).toBe(false);
    expect(artifactContainsBlockingSignal('ReadyForHumanReview is blocked by this audit.')).toBe(true);
  });

  test('audit artifact blocker scan skips dashboard recovery artifacts', () => {
    expect(
      taskNeedsBlockingArtifactScan({
        id: 'kg-next-independent-audit-blocker-recovery-3',
        stopPolicy: 'stop-if-recovery-needs-human-decision',
        validation: ['Record Match, MismatchBlocker, or NotApplicable evidence.'],
        notes: ['RecoverBlockedTask:kg-next-independent-audit']
      } as any)
    ).toBe(false);
    expect(
      taskNeedsBlockingArtifactScan({
        id: 'kg-next-independent-audit-blocker-recovery-3',
        stopPolicy: 'stop-if-recovery-needs-human-decision',
        validation: ['Record Match, MismatchBlocker, or NotApplicable evidence.'],
        notes: []
      } as any)
    ).toBe(false);
    expect(
      taskNeedsBlockingArtifactScan({
        id: 'kg-next-independent-audit',
        stopPolicy: 'stop-on-mismatch-blocker',
        validation: ['Block ReadyForHumanReview on any MismatchBlocker.'],
        notes: []
      } as any)
    ).toBe(true);
  });

  test('audit artifact blocker scan still catches explicit mismatch blockers', () => {
    expect(
      artifactContainsBlockingSignal(
        [
          '# Independent Audit',
          '',
          '| ID | Status | Audit finding |',
          '|---|---|---|',
          '| FD-007 | MismatchBlocker | Source callback is not wired. |'
        ].join('\n')
      )
    ).toBe(true);
  });

  test('capacity retry delay matches Autopilot linear backoff', () => {
    expect(capacityRetryDelaySeconds(1, 300)).toBe(300);
    expect(capacityRetryDelaySeconds(2, 300)).toBe(600);
    expect(capacityRetryDelaySeconds(3.9, 5.8)).toBe(15);
    expect(capacityRetryDelaySeconds(0, 300)).toBe(300);
    expect(capacityRetryDelaySeconds(2, -10)).toBe(0);
  });

  test('loop runner passes the active workflow id after continuous planner switches goals', () => {
    expect(
      loopArgsForWorkflow(
        [
          'loop',
          '--goal',
          'kg-new-type-nt-1-1',
          '--execute',
          '--max-rounds',
          '5',
          '--clear-stop-on-start',
          '--heartbeat-seconds',
          '30'
        ],
        'kg-new-type-nt-1-2'
      )
    ).toEqual(['loop', '--goal', 'kg-new-type-nt-1-2', '--execute', '--heartbeat-seconds', '30', '--max-steps', '1']);
  });

  test('dashboard start creates the next KG slots workflow from a completed workflow', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const task of [...workflow.tasks]) {
      workflow = setWorkflowTaskStatus(workflow, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, workflow, model);

    const next = createCompletedWorkflowContinuationForDashboardStart(cwd, workflow, model, '');

    expect(next).toBeDefined();
    expect(next?.id).toBe('kg-slots-next-2');
    expect(next?.source).toBe('selvedge dashboard continuation from kg-slots-next');
    expect(next?.aiIntake.userDialogueRequired).toBe(false);
    expect(next?.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('AuthorizedAutoSelect');
    expect(selectNextWorkflowTask(next!)?.id).toBe('kg-slots-next-2-intake');
    expect(existsSync(join(cwd, '.selvedge', 'goals', 'kg-slots-next-2', 'goal.workflow.json'))).toBe(true);

    const oldLoopStatus = JSON.parse(readFileSync(join(cwd, '.selvedge', 'status', 'kg-slots-next.loop-status.json'), 'utf8'));
    expect(oldLoopStatus.status).toBe('Completed');
    expect(oldLoopStatus.message).toContain('kg-slots-next-2');
  });

  test('continuous planner starts the approved KG new-type batch before idling', () => {
    const cwd = fixtureRepo();
    writeFixtureProjectObjective(cwd);
    writeFixtureKgNewTypeBatch(cwd);
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const task of [...workflow.tasks]) {
      workflow = setWorkflowTaskStatus(workflow, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, workflow, model);

    const next = createContinuousWorkflowContinuationForDashboardStart(cwd, workflow, model);

    expect(next).toBeDefined();
    expect(next?.profile.id).toBe('kg-game-migration');
    expect(next?.target).toContain('NT-1');
    expect(next?.target).toContain('Slot - Web Entry');
    expect(next?.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('target 1 of 2');
    expect(selectNextWorkflowTask(next!)?.id).toBe(`${next?.id}-intake`);
  });

  test('continuous planner preserves the forest table constraint and then falls back to the project objective', () => {
    const cwd = fixtureRepo();
    writeFixtureProjectObjective(cwd);
    writeFixtureKgNewTypeBatch(cwd);
    const model = buildReadOnlyModel(cwd);
    const current = writeCompletedBatchWorkflow(cwd, model, 'NT-3', 'Poker / Card', 2);
    for (const [batch, catalogClass, count] of [
      ['NT-1', 'Slot - Web Entry', 2],
      ['NT-2', 'Fish', 1],
      ['NT-3', 'Poker / Card', 2]
    ] as const) {
      for (let index = 1; index <= count; index += 1) {
        writeCompletedBatchWorkflow(cwd, model, batch, catalogClass, index);
      }
    }

    const table = createContinuousWorkflowContinuationForDashboardStart(cwd, current, model);

    expect(table?.target).toContain('NT-4');
    expect(table?.aiIntake.questions.find((item) => item.id === 'target-game')?.answer).toContain('森林舞会');
    let completedTable = table!;
    for (const task of [...completedTable.tasks]) {
      completedTable = setWorkflowTaskStatus(completedTable, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, completedTable, model);
    writeCompletedBatchWorkflow(cwd, model, 'NT-4', 'Bingo / Table', 2);

    const projectNext = createContinuousWorkflowContinuationForDashboardStart(cwd, completedTable, model);

    expect(projectNext).toBeDefined();
    expect(projectNext?.source).toBe('selvedge dashboard project-objective start');
    expect(projectNext?.target).toContain('Derive and execute the next bounded task');
  });

  test('continuous planner selects existing real merchant provider workflow after the gap map', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let gapMap = createGoalWorkflow(
      {
        id: 'real-merchant-e2e-gap-map',
        title: 'Real merchant E2E gap map',
        goal: 'Produce real merchant phase-1 gap map.',
        workstream: 'platform-backend-core',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['.selvedge/goals/real-merchant-e2e-gap-map/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=gap map'],
        nonInteractive: true
      },
      model
    );
    for (const task of [...gapMap.tasks]) {
      gapMap = setWorkflowTaskStatus(gapMap, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, gapMap, model);
    const provider = createGoalWorkflow(
      {
        id: 'real-merchant-provider-api-contract-map',
        title: 'Real Merchant Provider API Contract Map',
        goal: 'Map provider API contract.',
        workstream: 'platform-backend-core',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['docs/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=provider contract'],
        nonInteractive: true
      },
      model
    );
    writeGoalWorkflow(cwd, provider, model);

    const next = createContinuousWorkflowContinuationForDashboardStart(cwd, gapMap, model);

    expect(next?.id).toBe('real-merchant-provider-api-contract-map');
    expect(selectNextWorkflowTask(next!)?.id).toBe('real-merchant-provider-api-contract-map-intake');
  });

  test('continuous planner creates the next real merchant stage after provider contract map completes', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let provider = createGoalWorkflow(
      {
        id: 'real-merchant-provider-api-contract-map',
        title: 'Real Merchant Provider API Contract Map',
        goal: 'Map provider API contract.',
        workstream: 'platform-backend-core',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['docs/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=provider contract'],
        nonInteractive: true
      },
      model
    );
    for (const task of [...provider.tasks]) {
      provider = setWorkflowTaskStatus(provider, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, provider, model);

    const next = createContinuousWorkflowContinuationForDashboardStart(cwd, provider, model);

    expect(next?.id).toBe('openapi-security-hardening-foundation');
    expect(next?.source).toBe('selvedge real merchant chain continuation from real-merchant-provider-api-contract-map');
    expect(next?.workstream).toBe('platform-backend-core');
    expect(next?.target).toContain('provider-grade body limits');
    expect(next?.aiIntake.userDialogueRequired).toBe(false);
    expect(selectNextWorkflowTask(next!)?.id).toBe('openapi-security-hardening-foundation-intake');

    const oldLoopStatus = JSON.parse(readFileSync(join(cwd, '.selvedge', 'status', 'real-merchant-provider-api-contract-map.loop-status.json'), 'utf8'));
    expect(oldLoopStatus.message).toContain('openapi-security-hardening-foundation');
  });

  test('continuous planner stops after the final real merchant handoff instead of falling back to project objective', () => {
    const cwd = fixtureRepo();
    writeFixtureProjectObjective(cwd);
    const model = buildReadOnlyModel(cwd);
    let finalReview = createGoalWorkflow(
      {
        id: 'real-merchant-independent-review-and-handoff',
        title: 'Real Merchant Independent Review And Handoff',
        goal: 'Verify real merchant implementation and handoff.',
        workstream: 'docs-governance',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['docs/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=final review'],
        nonInteractive: true
      },
      model
    );
    for (const task of [...finalReview.tasks]) {
      finalReview = setWorkflowTaskStatus(finalReview, task.id, 'Completed');
    }
    writeGoalWorkflow(cwd, finalReview, model);

    const next = createContinuousWorkflowContinuationForDashboardStart(cwd, finalReview, model);

    expect(next).toBeNull();
    expect(existsSync(join(cwd, '.selvedge', 'goals', 'goal-project-next-task', 'goal.workflow.json'))).toBe(false);
    const loopStatus = JSON.parse(readFileSync(join(cwd, '.selvedge', 'status', 'real-merchant-independent-review-and-handoff.loop-status.json'), 'utf8'));
    expect(loopStatus.message).toContain('Real merchant chain complete');
  });

  test('dashboard start preflight converts a blocked workflow into a recovery-first queue', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    expect(prepared.prepared).toBe(true);
    expect(prepared.recoveryTaskId).toBe('kg-slots-next-independent-audit-blocker-recovery');
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe(prepared.recoveryTaskId);

    const recoveryTask = prepared.workflow.tasks.find((task) => task.id === prepared.recoveryTaskId);
    const auditTask = prepared.workflow.tasks.find((task) => task.id === 'kg-slots-next-independent-audit');
    expect(recoveryTask?.status).toBe('Pending');
    expect(recoveryTask?.notes).toContain('RecoverBlockedTask:kg-slots-next-independent-audit');
    expect(auditTask?.status).toBe('Pending');
    expect(auditTask?.dependsOn).toContain(prepared.recoveryTaskId);

    const recoveryArtifact = readFileSync(
      join(cwd, '.selvedge', 'goals', 'kg-slots-next', `${prepared.recoveryTaskId}.md`),
      'utf8'
    );
    expect(recoveryArtifact).toContain('Blocked task: kg-slots-next-independent-audit');
    expect(recoveryArtifact).toContain('recorded blocker found.');
  });

  test('loop auto-recovery converts a round blocker into a recovery-first queue without another dashboard click', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const prepared = prepareLoopBlockerRecovery(cwd, workflow.id);

    expect(prepared.prepared).toBe(true);
    expect(prepared.recoveryTaskId).toBe('kg-slots-next-independent-audit-blocker-recovery');
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe(prepared.recoveryTaskId);

    const status = JSON.parse(readFileSync(join(cwd, '.selvedge', 'status', 'kg-slots-next.workflow-status.json'), 'utf8'));
    expect(status.message).toContain('Loop auto-recovery prepared');
  });

  test('loop auto-recovery stays recovery-first after task queue persistence', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const prepared = prepareLoopBlockerRecovery(cwd, workflow.id);
    const persisted = readGoalWorkflow(cwd, workflow.id);
    const queue = readFileSync(join(cwd, '.selvedge', 'goals', workflow.id, 'task-queue.md'), 'utf8');
    const recoveryHeading = queue.indexOf(`\n### ${prepared.recoveryTaskId}\n`);
    const auditHeading = queue.indexOf('\n### kg-slots-next-independent-audit\n');

    expect(prepared.prepared).toBe(true);
    expect(persisted).not.toBeNull();
    expect(selectNextWorkflowTask(persisted!)?.id).toBe(prepared.recoveryTaskId);
    expect(persisted?.tasks.find((task) => task.id === 'kg-slots-next-independent-audit')?.dependsOn).toContain(prepared.recoveryTaskId);
    expect(recoveryHeading).toBeGreaterThanOrEqual(0);
    expect(auditHeading).toBeGreaterThanOrEqual(0);
    expect(recoveryHeading).toBeLessThan(auditHeading);
  });

  test('save workflow repairs a stale queue that lists a blocker before existing recovery', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const prepared = prepareLoopBlockerRecovery(cwd, workflow.id);
    const recoveryTask = prepared.workflow.tasks.find((task) => task.id === prepared.recoveryTaskId);
    expect(recoveryTask).toBeDefined();

    const staleTasks = prepared.workflow.tasks
      .filter((task) => task.id !== prepared.recoveryTaskId)
      .map((task) =>
        task.id === 'kg-slots-next-independent-audit'
          ? { ...task, dependsOn: task.dependsOn.filter((id) => id !== prepared.recoveryTaskId) }
          : task
      );
    staleTasks.push(recoveryTask!);
    writeGoalWorkflow(cwd, { ...prepared.workflow, tasks: staleTasks }, model);

    saveGoalWorkflow(cwd, prepared.workflow);
    const persisted = readGoalWorkflow(cwd, workflow.id);
    const persistedTaskIds = persisted?.tasks.map((task) => task.id) ?? [];

    expect(selectNextWorkflowTask(persisted!)?.id).toBe(prepared.recoveryTaskId);
    expect(persistedTaskIds.indexOf(prepared.recoveryTaskId!)).toBeLessThan(
      persistedTaskIds.indexOf('kg-slots-next-independent-audit')
    );
    expect(persisted?.tasks.find((task) => task.id === 'kg-slots-next-independent-audit')?.dependsOn).toContain(prepared.recoveryTaskId);
  });

  test('dashboard start preflight creates a new recovery task after a completed recovery blocks again', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const firstPreparation = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    let blockedAgain = setWorkflowTaskStatus(firstPreparation.workflow, firstPreparation.recoveryTaskId!, 'Completed');
    blockedAgain = setWorkflowTaskStatus(blockedAgain, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found again.');

    const retryPreparation = prepareBlockedWorkflowForDashboardStart(cwd, blockedAgain);
    const recoveryTasks = retryPreparation.workflow.tasks.filter((task) => task.id.includes('blocker-recovery'));

    expect(retryPreparation.prepared).toBe(true);
    expect(retryPreparation.recoveryTaskId).toBe('kg-slots-next-independent-audit-blocker-recovery-2');
    expect(recoveryTasks.map((task) => task.id)).toEqual([
      'kg-slots-next-independent-audit-blocker-recovery',
      'kg-slots-next-independent-audit-blocker-recovery-2'
    ]);
    expect(selectNextWorkflowTask(retryPreparation.workflow)?.id).toBe(retryPreparation.recoveryTaskId);

    const secondArtifact = readFileSync(
      join(cwd, '.selvedge', 'goals', 'kg-slots-next', `${retryPreparation.recoveryTaskId}.md`),
      'utf8'
    );
    expect(secondArtifact).toContain('recorded blocker found again.');
  });

  test('dashboard start preflight completes a false-positive audit artifact blocker', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const task of workflow.tasks) {
      if (task.id === 'kg-slots-next-independent-audit') {
        break;
      }
      workflow = setWorkflowTaskStatus(workflow, task.id, 'Completed');
    }
    workflow = setWorkflowTaskStatus(
      workflow,
      'kg-slots-next-independent-audit',
      'Blocked',
      'Blocking audit signal found in .selvedge/goals/kg-slots-next/independent-audit.md. Runner completed, but the task artifact verdict is blocked. success; log=test'
    );
    writeGoalWorkflow(cwd, workflow, model);
    const auditTask = workflow.tasks.find((task) => task.id === 'kg-slots-next-independent-audit');
    expect(auditTask?.artifacts[0]).toBeDefined();
    writeFileSync(
      join(cwd, auditTask!.artifacts[0]),
      [
        '# Independent Audit',
        '',
        '- Verdict: `PassedForHandoff`',
        '- Stop policy result: no `MismatchBlocker` found.',
        '- ReadyForHumanReview block check: no `MismatchBlocker` is present in this audit.'
      ].join('\n')
    );

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    expect(prepared.prepared).toBe(true);
    expect(prepared.recoveryTaskId).toBeNull();
    expect(prepared.blockedTaskId).toBe('kg-slots-next-independent-audit');
    expect(prepared.workflow.tasks.find((task) => task.id === 'kg-slots-next-independent-audit')?.status).toBe('Completed');
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe('kg-slots-next-handoff');
  });

  test('dashboard start preflight retries an existing failed blocker recovery task without nesting recovery tasks', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const firstPreparation = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    let failedRecovery = setWorkflowTaskStatus(firstPreparation.workflow, firstPreparation.recoveryTaskId!, 'Failed', 'Codex config failed.');
    const retryPreparation = prepareBlockedWorkflowForDashboardStart(cwd, failedRecovery);
    const recoveryTasks = retryPreparation.workflow.tasks.filter((task) => task.id.endsWith('-blocker-recovery'));

    expect(retryPreparation.prepared).toBe(true);
    expect(retryPreparation.recoveryTaskId).toBe(firstPreparation.recoveryTaskId);
    expect(recoveryTasks).toHaveLength(1);
    expect(selectNextWorkflowTask(retryPreparation.workflow)?.id).toBe(firstPreparation.recoveryTaskId);
    expect(retryPreparation.workflow.tasks.find((task) => task.id === firstPreparation.recoveryTaskId)?.status).toBe('Pending');
  });

  test('dashboard start preflight retries transient capacity failures without blocker recovery', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-intake', 'Completed');
    workflow = setWorkflowTaskStatus(
      workflow,
      'kg-slots-next-micro-shell-profile-fit',
      'Failed',
      'capacity-interrupted; log=test.log'
    );

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, workflow);

    expect(prepared.prepared).toBe(true);
    expect(prepared.recoveryTaskId).toBeNull();
    expect(prepared.blockedTaskId).toBe('kg-slots-next-micro-shell-profile-fit');
    expect(prepared.workflow.tasks.some((task) => task.id.endsWith('-blocker-recovery'))).toBe(false);
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe('kg-slots-next-micro-shell-profile-fit');
    expect(prepared.workflow.tasks.find((task) => task.id === 'kg-slots-next-micro-shell-profile-fit')?.statusReason).toContain('Retrying after transient runner interruption');
  });

  test('dashboard start preflight removes capacity-failed recovery and retries original task', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    const firstPreparation = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    let failedRecovery = setWorkflowTaskStatus(firstPreparation.workflow, firstPreparation.recoveryTaskId!, 'Failed', 'capacity-interrupted; log=recovery.log');

    const retryPreparation = prepareBlockedWorkflowForDashboardStart(cwd, failedRecovery);

    expect(retryPreparation.prepared).toBe(true);
    expect(retryPreparation.recoveryTaskId).toBeNull();
    expect(retryPreparation.blockedTaskId).toBe('kg-slots-next-independent-audit');
    expect(retryPreparation.workflow.tasks.some((task) => task.id.endsWith('-blocker-recovery'))).toBe(false);
    expect(selectNextWorkflowTask(retryPreparation.workflow)?.id).toBe('kg-slots-next-independent-audit');
    expect(retryPreparation.workflow.tasks.find((task) => task.id === 'kg-slots-next-independent-audit')?.dependsOn).not.toContain(firstPreparation.recoveryTaskId);
  });

  test('dashboard start preflight completes stale in-progress recovery after force stop when evidence is repaired', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    const firstPreparation = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    const recoveryTaskId = firstPreparation.recoveryTaskId!;
    const inProgressWorkflow = setWorkflowTaskStatus(firstPreparation.workflow, recoveryTaskId, 'InProgress');
    writeGoalWorkflow(cwd, inProgressWorkflow, model);

    mkdirSync(join(cwd, '.selvedge', 'status'), { recursive: true });
    mkdirSync(join(cwd, '.selvedge', 'logs'), { recursive: true });
    writeFileSync(
      join(cwd, '.selvedge', 'status', 'last-stop.json'),
      JSON.stringify({ mode: 'force', goalId: 'kg-slots-next', reason: 'test force stop' })
    );
    writeFileSync(
      join(cwd, '.selvedge', 'goals', 'kg-slots-next', `${recoveryTaskId}.md`),
      'Recovery status: `RepairedForRerun`\n'
    );
    writeFileSync(
      join(cwd, '.selvedge', 'logs', `kg-slots-next.${recoveryTaskId}.last-message.md`),
      'Status: `RepairedForRerun`.\n'
    );

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, inProgressWorkflow);
    const recoveredTask = prepared.workflow.tasks.find((task) => task.id === recoveryTaskId);

    expect(prepared.prepared).toBe(true);
    expect(prepared.message).toContain('Recovered stale InProgress recovery task');
    expect(recoveredTask?.status).toBe('Completed');
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe('kg-slots-next-independent-audit');
  });

  test('dashboard start preflight retries stale in-progress task after force stop without repaired evidence', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-intake', 'Completed');
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-micro-shell-profile-fit', 'InProgress');
    writeGoalWorkflow(cwd, workflow, model);
    mkdirSync(join(cwd, '.selvedge', 'status'), { recursive: true });
    writeFileSync(
      join(cwd, '.selvedge', 'status', 'last-stop.json'),
      JSON.stringify({ mode: 'force', goalId: 'kg-slots-next', reason: 'test force stop' })
    );

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    const recoveredTask = prepared.workflow.tasks.find((task) => task.id === 'kg-slots-next-micro-shell-profile-fit');

    expect(prepared.prepared).toBe(true);
    expect(recoveredTask?.status).toBe('Pending');
    expect(selectNextWorkflowTask(prepared.workflow)?.id).toBe('kg-slots-next-micro-shell-profile-fit');
  });

  test('rejects unsupported workflow profiles instead of silently falling back', () => {
    expect(() => parseWorkflowProfileId('kg-row-six-by-typo')).toThrow('Unsupported Selvedge workflow profile');
  });

  test('builds a bounded Codex task prompt for a Selvedge workflow task', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=Needs selection before runtime work'],
        nonInteractive: true
      },
      model
    );
    const task = workflow.tasks.find((item) => item.id === 'kg-slots-next-source-feature-inventory');
    expect(task).toBeDefined();
    const prompt = buildCodexTaskPrompt(workflow, task!);
    expect(prompt).toContain('TaskId: kg-slots-next-source-feature-inventory');
    expect(prompt).toContain('Profile: kg-slots-migration');
    expect(prompt).toContain('apps/kg-micro-shell/docs/**');
    expect(prompt).toContain('Execute exactly this task. Do not advance the next Selvedge task.');
  });

  test('builds Codex CLI arguments with unattended safety defaults', () => {
    const args = buildCodexExecArgs('C:\\total\\game-hub', 'C:\\total\\game-hub\\.selvedge\\logs\\last.md', {
      codexExecutable: 'codex',
      model: 'gpt-5.5',
      serviceTier: 'auto',
      reasoningEffort: 'xhigh',
      jsonOutput: false,
      showOutput: false,
      skipConfigGuard: false,
      ignoreUserConfig: true,
      heartbeatSeconds: 30
    });
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('model_reasoning_effort=xhigh');
    expect(args.some((arg) => arg.includes('service_tier'))).toBe(false);
    expect(args).toContain('exec');
    expect(args).toContain('danger-full-access');
    expect(args).toContain('--output-last-message');
  });

  test('detects stable final message after stale Codex output idle', () => {
    const cwd = fixtureRepo();
    const finalMessage = join(cwd, '.selvedge', 'logs', 'final-message.md');
    mkdirSync(join(cwd, '.selvedge', 'logs'), { recursive: true });
    writeFileSync(finalMessage, 'Status: `RepairedForRerun`.\n');
    const now = Date.now();
    const startedAtMs = now - 10 * 60 * 1000;
    const stableTime = new Date(now - 60 * 1000);
    utimesSync(finalMessage, stableTime, stableTime);

    expect(staleFinalMessageCompleted(finalMessage, startedAtMs, now, 6 * 60 * 1000, 5 * 60 * 1000)).toBe(true);
    expect(staleFinalMessageCompleted(finalMessage, now, now, 6 * 60 * 1000, 5 * 60 * 1000)).toBe(false);
    expect(staleFinalMessageCompleted(finalMessage, startedAtMs, now, 2 * 60 * 1000, 5 * 60 * 1000)).toBe(false);
  });

  test('accepts supported Codex runner service tiers and rejects stale values', () => {
    expect(resolveCodexRunnerOptions([]).serviceTier).toBe('auto');
    expect(resolveCodexRunnerOptions(['--service-tier', 'default']).serviceTier).toBe('auto');
    expect(resolveCodexRunnerOptions(['--service-tier', 'fast']).serviceTier).toBe('fast');
    expect(resolveCodexRunnerOptions(['--service-tier', 'flex']).serviceTier).toBe('flex');
    expect(resolveCodexRunnerOptions(['--service-tier', 'priority']).serviceTier).toBe('priority');
    expect(resolveCodexRunnerOptions([]).ignoreUserConfig).toBe(true);
    expect(resolveCodexRunnerOptions(['--use-user-config']).ignoreUserConfig).toBe(false);
    expect(() => resolveCodexRunnerOptions(['--service-tier', 'legacy'])).toThrow('Unsupported --service-tier');
    const fastArgs = buildCodexExecArgs('C:\\total\\game-hub', 'C:\\total\\game-hub\\.selvedge\\logs\\last.md', {
      codexExecutable: 'codex',
      model: 'gpt-5.5',
      serviceTier: 'fast',
      reasoningEffort: 'xhigh',
      jsonOutput: false,
      showOutput: false,
      skipConfigGuard: false,
      ignoreUserConfig: true,
      heartbeatSeconds: 30
    });
    expect(fastArgs).toContain('service_tier="fast"');
  });

  test('guards Codex user config service tier values before spawn', () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'selvedge-codex-home-'));
    try {
      process.env.CODEX_HOME = codexHome;
      writeFileSync(join(codexHome, 'config.toml'), "service_tier = 'priority'\n");
      expect(() => assertCodexServiceTierConfig()).not.toThrow();

      writeFileSync(join(codexHome, 'config.toml'), "service_tier = 'flex'\n");
      expect(() => assertCodexServiceTierConfig()).not.toThrow();

      writeFileSync(join(codexHome, 'config.toml'), "service_tier = 'legacy'\n");
      expect(() => assertCodexServiceTierConfig()).toThrow('unsupported service tier');

      writeFileSync(join(codexHome, 'config.toml'), '# no service tier override\n');
      expect(() => assertCodexServiceTierConfig()).not.toThrow();
    } finally {
      if (oldCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = oldCodexHome;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('resolves Codex runner heartbeat seconds', () => {
    expect(resolveCodexRunnerOptions(['--heartbeat-seconds', '7']).heartbeatSeconds).toBe(7);
  });

  test('codex result classification ignores historical capacity text on successful runs', () => {
    const recoveredOutput = [
      'Status: recovered. The current blocker is stale/transient Selvedge state.',
      'Validation passed.',
      '+  "classification": "capacity-interrupted",',
      '+  "message": "Selected model is at capacity or the runner hit a transient interruption."'
    ].join('\n');
    expect(classifyCodexResult(0, recoveredOutput, false, false)).toBe('success');
    expect(classifyCodexResult(1, 'Selected model is at capacity. Please retry.', false, false)).toBe('capacity-interrupted');
  });

  test('formats runner heartbeat durations as HH:mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(5_900)).toBe('00:00:05');
    expect(formatDuration(990_000)).toBe('00:16:30');
    expect(formatDuration(3_723_000)).toBe('01:02:03');
  });

  test('builds a human-readable runner heartbeat for goal execution', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    const workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    const task = workflow.tasks.find((item) => item.id === 'kg-slots-next-route-context-integration');
    expect(task).toBeDefined();
    const currentAction = classifyRunnerCurrentAction(task!, 3_000, 'Command: git status --porcelain\n');
    expect(currentAction).toContain('Git Gate:');
    expect(classifyRunnerCurrentAction(task!, 4_000, 'pnpm --filter @gamehub/kg-micro-shell run typecheck\n')).toContain('QA 自测:');
    const heartbeat = buildRunnerHeartbeat(workflow, task!, {
      elapsedMs: 3_723_000,
      idleMs: 990_000,
      logPath: 'C:\\total\\game-hub\\.selvedge\\logs\\kg-slots-next-route-context-integration.codex.log',
      lastMessagePath: 'C:\\total\\game-hub\\.selvedge\\logs\\last-message.md',
      currentAction
    }, {
      workflowId: 'kg-slots-next',
      taskId: 'kg-slots-next-route-context-integration',
      updatedAt: '2026-06-06T00:00:00.000Z',
      migrationTarget: 'KG slots / SBJN (Tenfold Golden Bull) / sbjn-955',
      generationTiming: 'after-ai-decomposition',
      reviewer: 'ai-decomposition-agent',
      instruction: 'test fixture'
    });
    const line = buildHeartbeatLine(heartbeat);
    expect(heartbeat.phaseLabel).toBe('开发执行');
    expect(heartbeat.taskProgress).toBe('9/12');
    expect(heartbeat.taskDisplayName).toBe('Route/context integration slice');
    expect(heartbeat.migrationTarget).toBe('KG slots / SBJN (Tenfold Golden Bull) / sbjn-955');
    expect(heartbeat.logDisplayPath).toBe('.selvedge\\logs\\kg-slots-next-route-context-integration.codex.log');
    expect(heartbeat.localTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/);
    expect(formatLocalTimestamp(new Date('2026-06-08T01:02:03Z'))).toMatch(/2026-06-08 .* UTC[+-]\d{2}:\d{2}$/);
    expect(line).toContain('\n  本机时间: ');
    expect(line).toContain('[Selvedge heartbeat]\n  本机时间: ');
    expect(line).toContain('\n  状态: 运行中');
    expect(line).toContain('\n  总目标: Continue KG slots-class migration through Selvedge');
    expect(line).toContain('\n  阶段: 开发执行 (3/5)');
    expect(line).toContain('\n  任务: 9/12 Route/context integration slice');
    expect(line).toContain('\n  现在: Git Gate:');
    expect(line).toContain('\n  用时: 01:02:03');
    expect(line).toContain('\n  静默: 00:16:30');
    expect(line).toContain('\n  机器: workflow=kg-slots-next | task=kg-slots-next-route-context-integration');
    const customBlock = buildHeartbeatBlock(heartbeat, {
      format: 'block',
      optionalFields: ['migrationTarget', 'progress', 'role', 'roadmapNode']
    });
    expect(customBlock).toContain('\n  状态: 运行中');
    expect(customBlock).toContain('\n  迁移目标: KG slots / SBJN (Tenfold Golden Bull) / sbjn-955');
    expect(customBlock).toContain('\n  进度: 已完成 0/12 | 当前任务 9/12 | 当前阶段 3/5');
    expect(customBlock).toContain('\n  角色: kg-micro-shell-implementer');
    expect(customBlock).toContain('\n  路线节点: Selvedge KG slots profile / route and context integration');
    expect(customBlock).not.toContain('\n  机器: workflow=');
  });

  test('resolves disabled stop-time without a wall-clock cutoff', () => {
    const policy = resolveStopPolicy(fixtureRepo(), 'none');
    expect(policy.cutoff).toBeNull();
    expect(policy.stopFile.endsWith('STOP_AGENT')).toBe(true);
  });

  test('normalizes an empty dashboard stop condition as continuous mode', () => {
    const record = normalizeStopCondition('goal-dashboard', '');
    expect(record.mode).toBe('continuous');
    expect(record.rules).toEqual([]);
  });

  test('normalizes dashboard stop-condition text into configurable rules', () => {
    const record = normalizeStopCondition('goal-dashboard', 'stop after 2 hours or 3 rounds');
    expect(record.mode).toBe('configured');
    expect(record.rules.map((rule) => rule.kind)).toEqual(['maxElapsedSeconds', 'maxRounds']);
  });

  test('normalizes human-review stop conditions to the ReadyForHumanReview gate', () => {
    const record = normalizeStopCondition('kg-slots-next', '当前这个游戏，完成到需要人工验收的阶段，即可停机');
    expect(record.mode).toBe('configured');
    expect(record.rules.map((rule) => rule.kind)).toEqual(['readyForHumanReview']);
  });

  test('normalizes common Chinese dashboard stop conditions locally', () => {
    const humanReview = normalizeStopCondition('kg-slots-next', '当前游戏完成迁移至人工验收状态后，就停机');
    expect(humanReview.generator).toBe('selvedge-local-condition-normalizer');
    expect(humanReview.rules.map((rule) => rule.kind)).toEqual(['readyForHumanReview']);

    const idle = normalizeStopCondition('goal-dashboard', '30 分钟没有输出就停');
    expect(idle.rules).toEqual([
      {
        kind: 'heartbeatIdleSeconds',
        seconds: 1800,
        source: 'operator idle-output request'
      }
    ]);

    const rounds = normalizeStopCondition('goal-dashboard', '跑 3 轮后停');
    expect(rounds.rules.map((rule) => rule.kind)).toEqual(['maxRounds']);
  });

  test('preserves an existing dashboard stop condition when restart input is blank', () => {
    const cwd = fixtureRepo();
    const first = saveStopCondition(cwd, 'kg-slots-next', 'ready for human review');
    expect(first.mode).toBe('configured');
    expect(first.rules.map((rule) => rule.kind)).toEqual(['readyForHumanReview']);

    const second = saveStopCondition(cwd, 'kg-slots-next', '');
    expect(second.mode).toBe('configured');
    expect(second.rules.map((rule) => rule.kind)).toEqual(['readyForHumanReview']);

    const stored = JSON.parse(readFileSync(join(cwd, '.selvedge/stop-conditions/kg-slots-next.json'), 'utf8'));
    expect(stored.rules.map((rule: { readonly kind: string }) => rule.kind)).toEqual(['readyForHumanReview']);
  });

  test('clears a persisted dashboard stop condition only when the operator asks for clear', () => {
    const cwd = fixtureRepo();
    saveStopCondition(cwd, 'kg-slots-next', 'ready for human review');

    expect(readSavedStopCondition(cwd, 'kg-slots-next')?.mode).toBe('configured');
    expect(clearSavedStopCondition(cwd, 'kg-slots-next')).toBe(true);
    expect(readSavedStopCondition(cwd, 'kg-slots-next')).toBeNull();
    expect(existsSync(join(cwd, '.selvedge/stop-conditions/kg-slots-next.json'))).toBe(false);
    expect(existsSync(join(cwd, '.selvedge/stop-conditions/kg-slots-next.request.md'))).toBe(false);
  });

  test('git gates ignore Selvedge controller runtime state but keep product diffs actionable', () => {
    expect(isSelvedgeRuntimeStateStatusLine('?? STOP_AGENT')).toBe(true);
    expect(isSelvedgeRuntimeStateStatusLine(' M .selvedge/goals/kg-slots-next-2/goal.workflow.json')).toBe(true);
    expect(isSelvedgeRuntimeStateStatusLine(' M .selvedge/goals/kg-slots-next-2/task-queue.md')).toBe(true);
    expect(isSelvedgeRuntimeStateStatusLine(' M .selvedge/status/kg-slots-next-2.loop-status.json')).toBe(true);
    expect(isSelvedgeRuntimeStateStatusLine('?? .selvedge/logs/kg-slots-next-2.current.codex.log')).toBe(true);
    expect(isSelvedgeRuntimeStateStatusLine(' M .selvedge/goals/kg-slots-next-2/backend-handler-evidence.md')).toBe(false);
    expect(isSelvedgeRuntimeStateStatusLine(' M apps/backend/src/modules/games/jymt/jymt.handler.ts')).toBe(false);

    expect(actionableGitStatusLines([
      '?? STOP_AGENT',
      ' M .selvedge/goals/kg-slots-next-2/goal.workflow.json',
      ' M .selvedge/status/kg-slots-next-2.loop-status.json',
      ' M apps/backend/src/modules/games/jymt/jymt.handler.ts',
      ''
    ].join('\n'))).toEqual([' M apps/backend/src/modules/games/jymt/jymt.handler.ts']);
  });

  test('post-task git gate allows a successful task to preserve its declared outputs', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    const workflow = createGoalWorkflow(
      {
        id: 'real-merchant-provider-api-contract-map',
        title: 'Real merchant provider API contract map',
        goal: 'Map provider API contracts for the real merchant phase.',
        workstream: 'platform-backend-core',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['.selvedge/goals/real-merchant-provider-api-contract-map/**', 'docs/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=Map contracts only.'],
        nonInteractive: true
      },
      model
    );
    const intakeTask = workflow.tasks.find((task) => task.id === 'real-merchant-provider-api-contract-map-intake');
    expect(intakeTask).toBeDefined();
    const statusOutput = [
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/goal.md',
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/requirements.md',
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/goal.workflow.json',
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/task-queue.md',
      ' M docs/real-merchant-provider-contract-map.md',
      ' M apps/backend/src/routes/openapi/launch.ts',
      '?? STOP_AGENT'
    ].join('\n');

    expect(actionableGitStatusLinesForTaskBoundary(cwd, statusOutput, workflow, intakeTask, 'task-start')).toEqual([
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/goal.md',
      ' M .selvedge/goals/real-merchant-provider-api-contract-map/requirements.md',
      ' M docs/real-merchant-provider-contract-map.md',
      ' M apps/backend/src/routes/openapi/launch.ts'
    ]);
    expect(actionableGitStatusLinesForTaskBoundary(cwd, statusOutput, workflow, intakeTask, 'post-task')).toEqual([
      ' M docs/real-merchant-provider-contract-map.md',
      ' M apps/backend/src/routes/openapi/launch.ts'
    ]);
  });

  test('auto-push commits task-owned outputs before pushing the next loop round', () => {
    const cwd = fixtureRepo();
    const remote = mkdtempSync(join(tmpdir(), 'selvedge-remote-'));
    git(cwd, ['init']);
    git(cwd, ['checkout', '-b', 'develop']);
    git(cwd, ['config', 'user.email', 'selvedge@example.invalid']);
    git(cwd, ['config', 'user.name', 'Selvedge Test']);
    git(remote, ['init', '--bare']);
    writeFileSync(join(cwd, '.gitignore'), ['.selvedge/*', '!.selvedge/README.md', ''].join('\n'));

    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'real-merchant-provider-api-contract-map',
        title: 'Real merchant provider API contract map',
        goal: 'Map provider API contracts for the real merchant phase.',
        workstream: 'platform-backend-core',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'universal-autopilot',
        commands: [],
        writeSet: ['.selvedge/goals/real-merchant-provider-api-contract-map/**', 'docs/**'],
        validation: ['git diff --check'],
        answers: ['business-outcome=Map contracts only.'],
        nonInteractive: true
      },
      model
    );
    writeGoalWorkflow(cwd, workflow, model);
    git(cwd, ['add', '.']);
    git(cwd, ['add', '-f', '.selvedge/goals/real-merchant-provider-api-contract-map']);
    git(cwd, ['commit', '-m', 'initial workflow']);
    git(cwd, ['remote', 'add', 'origin', remote]);
    git(cwd, ['push', '-u', 'origin', 'HEAD:develop']);

    const intakeTask = workflow.tasks.find((task) => task.id === 'real-merchant-provider-api-contract-map-intake');
    expect(intakeTask).toBeDefined();
    workflow = setWorkflowTaskStatus(workflow, intakeTask!.id, 'Completed');
    writeGoalWorkflow(cwd, workflow, model);

    const result = autoPushIfClean(cwd, workflow, intakeTask);
    expect(result.ok, result.details.join('\n')).toBe(true);
    expect(result.message).toBe('Auto-commit and push completed.');
    expect(result.details.join('\n')).toContain('Auto-commit completed');
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
    expect(git(cwd, ['log', '-1', '--pretty=%s']).trim()).toBe(
      'selvedge: complete real-merchant-provider-api-contract-map-intake'
    );
    expect(git(cwd, ['ls-remote', 'origin', 'develop'])).toContain(git(cwd, ['rev-parse', 'HEAD']).trim());
  });

  test('post-task git gate allows recovery to preserve blocked audit artifact only', () => {
    const cwd = fixtureRepo();
    const model = buildReadOnlyModel(cwd);
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const taskId of [
      'kg-slots-next-intake',
      'kg-slots-next-micro-shell-profile-fit',
      'kg-slots-next-source-feature-inventory',
      'kg-slots-next-functional-detail-ledger',
      'kg-slots-next-backend-handler',
      'kg-slots-next-shell-start-roominfo-primitives',
      'kg-slots-next-result-mapper-runtime',
      'kg-slots-next-history-detail-bridge',
      'kg-slots-next-route-context-integration',
      'kg-slots-next-qa-self-test'
    ]) {
      workflow = setWorkflowTaskStatus(workflow, taskId, 'Completed');
    }
    workflow = setWorkflowTaskStatus(workflow, 'kg-slots-next-independent-audit', 'Blocked', 'MismatchBlocker found.');
    writeGoalWorkflow(cwd, workflow, model);

    const prepared = prepareBlockedWorkflowForDashboardStart(cwd, workflow);
    const recoveryTask = prepared.workflow.tasks.find((task) => task.id === prepared.recoveryTaskId);
    expect(recoveryTask).toBeDefined();
    const statusOutput = [
      ' M .selvedge/goals/kg-slots-next/independent-audit.md',
      ' M apps/kg-micro-shell/docs/audit-notes.md',
      ' M apps/backend/src/modules/games/jymt/jymt.handler.ts',
      '?? STOP_AGENT'
    ].join('\n');

    expect(actionableGitStatusLinesForTaskBoundary(cwd, statusOutput, prepared.workflow, recoveryTask, 'task-start')).toEqual([
      ' M apps/backend/src/modules/games/jymt/jymt.handler.ts'
    ]);
    expect(actionableGitStatusLinesForTaskBoundary(cwd, statusOutput, prepared.workflow, recoveryTask, 'post-task')).toEqual([
      ' M apps/kg-micro-shell/docs/audit-notes.md',
      ' M apps/backend/src/modules/games/jymt/jymt.handler.ts'
    ]);
  });

  test('human-review stop condition waits for handoff completion', () => {
    const model = buildReadOnlyModel(fixtureRepo());
    let workflow = createGoalWorkflow(
      {
        id: 'kg-slots-next',
        title: 'KG slots next migration',
        goal: 'Continue KG slots-class migration through Selvedge',
        workstream: 'kg-micro-shell',
        source: 'test',
        mode: 'goal-workflow',
        profile: 'kg-slots-migration',
        commands: [],
        writeSet: ['apps/kg-micro-shell/**'],
        validation: ['git diff --check'],
        answers: ['target-game=auto'],
        nonInteractive: true
      },
      model
    );
    for (const task of workflow.tasks.filter((item) => item.phase !== 'handoff')) {
      workflow = setWorkflowTaskStatus(workflow, task.id, 'Completed');
    }
    expect(workflowReadyForHumanReview(workflow)).toBe(false);

    const handoffTask = workflow.tasks.find((task) => task.phase === 'handoff');
    expect(handoffTask).toBeDefined();
    workflow = setWorkflowTaskStatus(workflow, handoffTask!.id, 'Completed');
    expect(workflowReadyForHumanReview(workflow)).toBe(true);
  });

  test('does not fallback unknown natural-language stop conditions to empty queue', () => {
    const record = normalizeStopCondition('goal-dashboard', '等 AI 判断状态合适的时候停机');
    expect(record.mode).toBe('configured');
    expect(record.rules.map((rule) => rule.kind)).toEqual(['needsAiConditionProgram']);
  });
});
