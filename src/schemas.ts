export const SELVEDGE_CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Selvedge project config',
  type: 'object',
  required: ['version', 'project', 'product', 'compatibility'],
  properties: {
    version: { type: ['string', 'number'] },
    project: {
      type: 'object',
      required: ['name', 'currentPhase'],
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        repoType: { type: 'string' },
        currentPhase: { type: 'string' }
      }
    },
    product: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        promise: { type: 'string' },
        adoptionSequence: { type: 'string' }
      }
    },
    compatibility: {
      type: 'object',
      required: ['currentAutopilotIsAuthoritative', 'stateRoot', 'stopFile'],
      properties: {
        currentAutopilotIsAuthoritative: { type: 'boolean' },
        stateRoot: { type: 'string' },
        singleLaneEntry: { type: 'string' },
        aiQaEntry: { type: 'string' },
        teamAutopilotGuide: { type: 'string' },
        stopFile: { type: 'string' }
      }
    },
    heartbeat: {
      type: 'object',
      properties: {
        format: { const: 'block' },
        requiredFieldsLocked: { type: 'array', items: { type: 'string' } },
        optionalFields: {
          type: 'array',
          items: {
            enum: ['machine', 'migrationTarget', 'profile', 'progress', 'role', 'roadmapNode', 'runner', 'taskTitle', 'paths']
          }
        },
        allowedOptionalFields: { type: 'array', items: { type: 'string' } }
      }
    }
  }
} as const;

export const SELVEDGE_TASK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Selvedge task',
  type: 'object',
  required: [
    'id',
    'title',
    'stage',
    'role',
    'workstream',
    'roadmapNode',
    'runner',
    'writeSet',
    'validation',
    'dependsOn',
    'artifacts',
    'stopPolicy'
  ],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    stage: { type: 'string' },
    role: { type: 'string' },
    workstream: { type: 'string' },
    roadmapNode: { type: 'string' },
    runner: { type: 'string' },
    commands: { type: 'array', items: { type: 'string' } },
    writeSet: { type: 'array', items: { type: 'string' } },
    validation: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    stopPolicy: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } }
  }
} as const;

export const SELVEDGE_GOAL_WORKFLOW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Selvedge goal workflow',
  type: 'object',
  required: ['version', 'id', 'title', 'target', 'mode', 'profile', 'aiIntake', 'documents', 'tasks'],
  properties: {
    version: { const: 1 },
    id: { type: 'string' },
    title: { type: 'string' },
    target: { type: 'string' },
    mode: { enum: ['goal-workflow', 'autopilot-next'] },
    workstream: { type: 'string' },
    profile: {
      type: 'object',
      required: ['id', 'title', 'lifecycle', 'planningGates', 'developmentGates', 'qaGates', 'stopGates'],
      properties: {
        id: { enum: ['universal-autopilot', 'kg-game-migration', 'kg-slots-migration'] },
        title: { type: 'string' },
        purpose: { type: 'string' },
        appliesTo: { type: 'string' },
        lifecycle: {
          type: 'array',
          items: { enum: ['intake', 'planning', 'development', 'qa', 'handoff'] }
        },
        intakeQuestions: { type: 'array', items: { type: 'string' } },
        planningGates: { type: 'array', items: { type: 'string' } },
        developmentGates: { type: 'array', items: { type: 'string' } },
        qaGates: { type: 'array', items: { type: 'string' } },
        stopGates: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } }
      }
    },
    aiIntake: {
      type: 'object',
      required: ['provider', 'userDialogueRequired', 'questions'],
      properties: {
        provider: { type: 'string' },
        promptPath: { type: 'string' },
        userDialogueRequired: { type: 'boolean' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'question', 'reason', 'status'],
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              reason: { type: 'string' },
              answer: { type: ['string', 'null'] },
              status: { enum: ['answered', 'assumption', 'needs-user'] },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'label', 'description', 'answer'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                    answer: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    documents: {
      type: 'object',
      required: ['goal', 'requirements', 'taskQueue', 'handoff'],
      properties: {
        goal: { type: 'string' },
        requirements: { type: 'string' },
        taskQueue: { type: 'string' },
        handoff: { type: 'string' }
      }
    },
    tasks: {
      type: 'array',
      items: {
        allOf: [
          SELVEDGE_TASK_SCHEMA,
          {
            type: 'object',
            required: ['phase', 'status'],
            properties: {
              phase: { enum: ['intake', 'planning', 'development', 'qa', 'handoff'] },
              status: {
                enum: ['Pending', 'InProgress', 'Completed', 'Failed', 'Blocked', 'NeedsHumanInput', 'NeedsRunner']
              },
              statusReason: { type: 'string' }
            }
          }
        ]
      }
    }
  }
} as const;
