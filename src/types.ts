export type JsonObject = Record<string, unknown>;

export type SelvedgeCommand =
  | 'help'
  | 'init'
  | 'status'
  | 'validate'
  | 'goal'
  | 'plan'
  | 'run'
  | 'dashboard'
  | 'serve';

export interface CliOptions {
  readonly command: SelvedgeCommand;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SelvedgeValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly file?: string;
}

export const SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS = [
  'machine',
  'migrationTarget',
  'profile',
  'progress',
  'role',
  'roadmapNode',
  'runner',
  'taskTitle',
  'paths'
] as const;

export type SelvedgeHeartbeatOptionalField = (typeof SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS)[number];

export interface SelvedgeHeartbeatTemplate {
  readonly format: 'block';
  readonly optionalFields: readonly SelvedgeHeartbeatOptionalField[];
}

export interface SelvedgeHeartbeatDisplayContext {
  readonly workflowId: string;
  readonly taskId: string;
  readonly updatedAt: string;
  readonly projectTotalGoal?: string;
  readonly migrationTarget: string | null;
  readonly generationTiming: 'after-ai-decomposition' | 'before-human-assigned-start' | 'before-task-start-refresh';
  readonly reviewer: 'selvedge-controller' | 'ai-decomposition-agent';
  readonly instruction: string;
}

export interface AiQaSwitchState {
  readonly exists: boolean;
  readonly enabled: boolean | 'unknown';
  readonly workstream: string | null;
  readonly campaignId: string | null;
  readonly disabledReason: string | null;
}

export interface TaskBoardState {
  readonly exists: boolean;
  readonly pendingRaw: string | null;
  readonly pendingCount: number;
  readonly firstPendingId: string | null;
  readonly inProgressRaw: string | null;
  readonly inProgressCount: number;
  readonly approvedAfterAiQaMentionsSelvedge: boolean;
  readonly manualAcceptancePassed: boolean;
}

export interface StopFileState {
  readonly exists: boolean;
  readonly path: string;
  readonly summary: string | null;
}

export interface SelvedgeConfigState {
  readonly exists: boolean;
  readonly path: string;
  readonly projectName: string | null;
  readonly currentPhase: string | null;
  readonly currentAutopilotIsAuthoritative: boolean | 'unknown';
  readonly packageName: string | null;
  readonly primaryBuilder: string | null;
  readonly firstDogfoodPreferred: string | null;
  readonly heartbeatFormat: string | null;
  readonly heartbeatTemplate: SelvedgeHeartbeatTemplate;
  readonly heartbeatInvalidOptionalFields: readonly string[];
}

export interface GameHubReadOnlyModel {
  readonly generatedAt: string;
  readonly cwd: string;
  readonly config: SelvedgeConfigState;
  readonly taskBoard: TaskBoardState;
  readonly aiQaSwitch: AiQaSwitchState;
  readonly stopFile: StopFileState;
  readonly firstExecutableTask: {
    readonly verdict: 'none' | 'pending' | 'blocked' | 'unknown';
    readonly reason: string;
    readonly taskId: string | null;
  };
  readonly selvedgeMainline: {
    readonly canStartInCodexApp: boolean;
    readonly reason: string;
  };
  readonly issues: readonly SelvedgeValidationIssue[];
}

export interface SelvedgeTask {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  readonly role: string;
  readonly workstream: string;
  readonly roadmapNode: string;
  readonly runner: string;
  readonly commands?: readonly string[];
  readonly writeSet: readonly string[];
  readonly validation: readonly string[];
  readonly dependsOn: readonly string[];
  readonly artifacts: readonly string[];
  readonly stopPolicy: string;
  readonly notes: readonly string[];
}

export type SelvedgeWorkflowPhase =
  | 'intake'
  | 'planning'
  | 'development'
  | 'qa'
  | 'handoff';

export type SelvedgeWorkflowProfileId =
  | 'universal-autopilot'
  | 'kg-game-migration'
  | 'kg-slots-migration';

export interface SelvedgeWorkflowProfile {
  readonly id: SelvedgeWorkflowProfileId;
  readonly title: string;
  readonly purpose: string;
  readonly appliesTo: string;
  readonly lifecycle: readonly SelvedgeWorkflowPhase[];
  readonly intakeQuestions: readonly string[];
  readonly planningGates: readonly string[];
  readonly developmentGates: readonly string[];
  readonly qaGates: readonly string[];
  readonly stopGates: readonly string[];
  readonly notes: readonly string[];
}

export type SelvedgeTaskStatus =
  | 'Pending'
  | 'InProgress'
  | 'Completed'
  | 'Failed'
  | 'Blocked'
  | 'NeedsHumanInput'
  | 'NeedsRunner';

export interface SelvedgeWorkflowTask extends SelvedgeTask {
  readonly phase: SelvedgeWorkflowPhase;
  readonly status: SelvedgeTaskStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly statusUpdatedAt?: string;
  readonly statusReason?: string;
}

export interface SelvedgeRequirementQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly answer: string;
}

export interface SelvedgeRequirementQuestion {
  readonly id: string;
  readonly question: string;
  readonly reason: string;
  readonly answer: string | null;
  readonly status: 'answered' | 'assumption' | 'needs-user';
  readonly options?: readonly SelvedgeRequirementQuestionOption[];
}

export interface SelvedgeProjectScope {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly workstream: string;
}

export interface SelvedgeProjectObjectiveReview {
  readonly version: 1;
  readonly reviewedAt: string;
  readonly reviewer: 'codex-cli-ai-reviewer' | 'local-structural-review';
  readonly status: 'accepted' | 'needs-revision' | 'review-unavailable';
  readonly summary: string;
  readonly conflicts: readonly string[];
  readonly suggestions: readonly string[];
  readonly promptPath?: string;
  readonly logPath?: string;
  readonly lastMessagePath?: string;
}

export interface SelvedgeProjectObjective {
  readonly version: 1;
  readonly id: 'project-objective';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: 'selvedge dashboard' | 'selvedge cli';
  readonly totalGoal: string;
  readonly monorepoStrategy: 'single-project-objective-with-scoped-workflows';
  readonly scopes: readonly SelvedgeProjectScope[];
  readonly authoritySources: readonly string[];
  readonly writeBoundaries: readonly string[];
  readonly validationExpectations: readonly string[];
  readonly stopExpectations: readonly string[];
  readonly notes: string;
  readonly activeWorkflowIds: readonly string[];
  readonly review: SelvedgeProjectObjectiveReview;
}

export interface SelvedgeArchitectureProposal {
  readonly version: 1;
  readonly generatedAt: string;
  readonly reviewer: 'codex-cli-ai-architect' | 'local-architecture-gate';
  readonly status: 'not-required' | 'pending-confirmation' | 'confirmed';
  readonly confirmationRequired: boolean;
  readonly summary: string;
  readonly recommendedStack: readonly string[];
  readonly reasons: readonly string[];
  readonly projectStructure: readonly string[];
  readonly initializationPlan: readonly string[];
  readonly risks: readonly string[];
  readonly confirmedAt?: string;
  readonly promptPath?: string;
  readonly logPath?: string;
  readonly lastMessagePath?: string;
}

export interface SelvedgeWorkflowControlPolicy {
  readonly executionMode: 'small-step-queue';
  readonly longGoalExecution: 'forbidden';
  readonly codexInvocation: 'single-subtask-only';
  readonly notes: readonly string[];
}

export interface SelvedgeGoalWorkflow {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly target: string;
  readonly source: string;
  readonly mode: 'goal-workflow' | 'autopilot-next';
  readonly profile: SelvedgeWorkflowProfile;
  readonly workstream: string;
  readonly controlPolicy?: SelvedgeWorkflowControlPolicy;
  readonly architecture?: SelvedgeArchitectureProposal;
  readonly aiIntake: {
    readonly provider: 'codex-app-agent' | 'external-ai-adapter';
    readonly promptPath: string;
    readonly userDialogueRequired: boolean;
    readonly questions: readonly SelvedgeRequirementQuestion[];
    readonly notes: readonly string[];
  };
  readonly documents: {
    readonly goal: string;
    readonly requirements: string;
    readonly taskQueue: string;
    readonly handoff: string;
  };
  readonly tasks: readonly SelvedgeWorkflowTask[];
}

export interface SelvedgePlan {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly target: string;
  readonly source: string;
  readonly mode: 'assigned-work' | 'kg-slots-dogfood';
  readonly tasks: readonly SelvedgeTask[];
}

export interface AssignedWorkPlanInput {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly workstream: string;
  readonly stage: string;
  readonly runner: string;
  readonly commands: readonly string[];
  readonly writeSet: readonly string[];
  readonly validation: readonly string[];
}

export interface GoalWorkflowInput {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly workstream: string;
  readonly source: string;
  readonly mode: 'goal-workflow' | 'autopilot-next';
  readonly profile: SelvedgeWorkflowProfileId;
  readonly commands: readonly string[];
  readonly writeSet: readonly string[];
  readonly validation: readonly string[];
  readonly answers: readonly string[];
  readonly nonInteractive: boolean;
}
