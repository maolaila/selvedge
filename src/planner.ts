import type {
  AssignedWorkPlanInput,
  GameHubReadOnlyModel,
  SelvedgePlan,
  SelvedgeTask
} from './types';

function task(input: SelvedgeTask): SelvedgeTask {
  return input;
}

export function createKgSlotsDogfoodPlan(target: string, model: GameHubReadOnlyModel): SelvedgePlan {
  const planId = `kg-slots-dogfood-${target}`;
  const commonArtifacts = [
    `.selvedge/status/${planId}.json`,
    `.selvedge/evidence/${planId}.md`
  ];

  return {
    version: 1,
    id: planId,
    title: `KG slots dogfood migration plan for ${target}`,
    createdAt: new Date().toISOString(),
    target,
    source: 'selvedge plan kg-slots',
    mode: 'kg-slots-dogfood',
    tasks: [
      task({
        id: `${planId}-source-inventory`,
        title: `Docs-only source inventory for ${target}`,
        stage: 'development',
        role: 'kg-micro-shell-architect',
        workstream: 'kg-micro-shell',
        roadmapNode: 'Selvedge dogfood / KG slots / source inventory',
        runner: 'codex-app-agent',
        writeSet: [
          'apps/kg-micro-shell/docs/**',
          'docs/kg-micro-shell-agent-reference/**',
          '.selvedge/evidence/**',
          '.selvedge/status/**'
        ],
        validation: [
          'Confirm KG Cocos/PHP authority paths are listed with exact read-only references.',
          'Confirm no implementation files are modified in this docs-only task.',
          'git diff --check'
        ],
        dependsOn: [],
        artifacts: commonArtifacts,
        stopPolicy: 'continue-after-source-inventory-match',
        notes: [
          'This is the first Selvedge dogfood task and must stay docs-only.',
          `Current GameHub read-only verdict: ${model.selvedgeMainline.reason}`
        ]
      }),
      task({
        id: `${planId}-task-model-shadow`,
        title: `Generate Selvedge task model and shadow-validate KG gates for ${target}`,
        stage: 'development',
        role: 'selvedge-control-plane',
        workstream: 'kg-micro-shell',
        roadmapNode: 'Selvedge dogfood / KG slots / task model shadow validation',
        runner: '@maolaila1/selvedge',
        writeSet: [
          '.selvedge/tasks/**',
          '.selvedge/status/**',
          '.selvedge/evidence/**',
          'tools/selvedge/**'
        ],
        validation: [
          'selvedge validate',
          'Confirm the first-task verdict matches current GameHub controller semantics.',
          'Confirm KG migration facts are represented as task writeSet, validation, stopPolicy, and artifacts.'
        ],
        dependsOn: [`${planId}-source-inventory`],
        artifacts: commonArtifacts,
        stopPolicy: 'stop-for-human-review-before-wrapper-or-code-work',
        notes: [
          'This task proves Selvedge can model the KG migration gate before any bridge or handler implementation.'
        ]
      }),
      task({
        id: `${planId}-wrapper-dry-run`,
        title: `Dry-run wrapper delegation plan for ${target}`,
        stage: 'development',
        role: 'selvedge-control-plane',
        workstream: 'kg-micro-shell',
        roadmapNode: 'Selvedge dogfood / KG slots / wrapper dry-run',
        runner: '@maolaila1/selvedge',
        writeSet: [
          '.selvedge/status/**',
          '.selvedge/evidence/**',
          'tools/selvedge/**'
        ],
        validation: [
          'Confirm old codex-* rollback commands remain documented.',
          'Confirm STOP_AGENT behavior is not changed.',
          'Confirm no bridge, handler, package staging, browser smoke, or diff QA is executed before human approval.'
        ],
        dependsOn: [`${planId}-task-model-shadow`],
        artifacts: commonArtifacts,
        stopPolicy: 'human-approval-required-before-implementation',
        notes: [
          'This is the last pre-implementation dogfood task. Implementation tasks must be explicitly approved after review.'
        ]
      })
    ]
  };
}

export function createAssignedWorkPlan(input: AssignedWorkPlanInput, model: GameHubReadOnlyModel): SelvedgePlan {
  const writeSet =
    input.writeSet.length > 0
      ? input.writeSet
      : ['NeedsDecision: declare allowed WriteSet before execution'];
  const validation =
    input.validation.length > 0
      ? input.validation
      : ['git diff --check', 'NeedsDecision: add task-specific validation before execution'];

  return {
    version: 1,
    id: input.id,
    title: input.title,
    createdAt: new Date().toISOString(),
    target: input.goal,
    source: 'selvedge plan work',
    mode: 'assigned-work',
    tasks: [
      task({
        id: `${input.id}-intake`,
        title: `Intake and boundary map for ${input.title}`,
        stage: input.stage,
        role: 'selvedge-task-lead',
        workstream: input.workstream,
        roadmapNode: 'Selvedge assigned work / intake and boundary map',
        runner: 'codex-app-agent',
        writeSet: ['.selvedge/status/**', '.selvedge/evidence/**', '.selvedge/tasks/**'],
        validation: [
          'Confirm goal document or user instruction is present.',
          'Confirm authority sources, WriteSet, validation, stop policy, and runner are explicit.',
          'Confirm no implementation files are changed during intake.'
        ],
        dependsOn: [],
        artifacts: [`.selvedge/evidence/${input.id}.md`, `.selvedge/status/${input.id}.json`],
        stopPolicy: 'continue-after-intake-complete',
        notes: [
          `Goal: ${input.goal}`,
          `Current GameHub read-only verdict: ${model.selvedgeMainline.reason}`
        ]
      }),
      task({
        id: `${input.id}-execute`,
        title: `Execute assigned work: ${input.title}`,
        stage: input.stage,
        role: 'assigned-work-runner',
        workstream: input.workstream,
        roadmapNode: 'Selvedge assigned work / execution',
        runner: input.runner,
        commands: input.commands,
        writeSet,
        validation,
        dependsOn: [`${input.id}-intake`],
        artifacts: [
          `.selvedge/logs/${input.id}.log`,
          `.selvedge/evidence/${input.id}.md`,
          `.selvedge/status/${input.id}.json`
        ],
        stopPolicy: 'stop-on-validation-failure-or-boundary-miss',
        notes: [
          'This generic task is not KG-specific.',
          'Long-running execution must preserve WriteSet, validation, evidence, STOP policy, and rollback notes.'
        ]
      }),
      task({
        id: `${input.id}-handoff`,
        title: `Verify and hand off assigned work: ${input.title}`,
        stage: input.stage,
        role: 'selvedge-reviewer',
        workstream: input.workstream,
        roadmapNode: 'Selvedge assigned work / verification and handoff',
        runner: 'codex-app-agent',
        writeSet: ['.selvedge/status/**', '.selvedge/evidence/**'],
        validation: [
          'Review execution evidence.',
          'Confirm validation commands passed or failures are classified.',
          'Confirm next action is complete, blocked, or NeedsDecision.'
        ],
        dependsOn: [`${input.id}-execute`],
        artifacts: [`.selvedge/evidence/${input.id}.md`, `.selvedge/status/${input.id}.json`],
        stopPolicy: 'human-review-if-risk-or-unclear-next-step',
        notes: [
          'Every workflow issue discovered here should feed back into Selvedge product improvements.'
        ]
      })
    ]
  };
}
