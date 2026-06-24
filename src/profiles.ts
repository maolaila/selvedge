import type { SelvedgeWorkflowProfile, SelvedgeWorkflowProfileId } from './types';

export const UNIVERSAL_AUTOPILOT_PROFILE: SelvedgeWorkflowProfile = {
  id: 'universal-autopilot',
  title: 'Universal Autopilot Workflow',
  purpose: 'Run any approved long-running project task through bounded AI intake, documented requirements, decomposition, development, QA, and handoff.',
  appliesTo: 'Any project, workstream, or task type that can declare authority sources, WriteSet, validation, runner, evidence, and stop policy.',
  lifecycle: ['intake', 'planning', 'development', 'qa', 'handoff'],
  intakeQuestions: [
    'business-outcome',
    'users-and-entry',
    'authority-sources',
    'write-boundary',
    'development-flow',
    'qa-flow',
    'stop-and-recovery',
    'handoff'
  ],
  planningGates: [
    'Write a durable goal document before implementation.',
    'Write durable requirements and assumptions before implementation.',
    'Decompose the total goal into dependency-ordered tasks.',
    'Every task must declare runner, WriteSet, validation, artifacts, stop policy, and handoff evidence.',
    'Decomposition must preserve the old Autopilot small-step loop: one dependency-ready task, one validation boundary, one commit boundary.'
  ],
  developmentGates: [
    'Execute only dependency-ready tasks.',
    'Do not execute a generic all-in-one development task when the work can be split by surface, contract, or validation gate.',
    'Do not write outside the task WriteSet.',
    'Do not skip authority-source reads for behavior-changing work.',
    'Classify unsupported runner, missing context, environment, and validation failures before retrying.'
  ],
  qaGates: [
    'QA is a separate phase from development.',
    'Run declared validation and record evidence.',
    'Use independent review for user-visible behavior, money/order/audit paths, platform contracts, migration compatibility, or reusable product surfaces.',
    'Record Match, MismatchBlocker, IntentionalDifferenceWithAuthorityReason, or NotApplicable when authority-source comparison matters.'
  ],
  stopGates: [
    'Missing required user decision.',
    'Unsafe or undeclared WriteSet.',
    'Missing authority source for behavior-changing work.',
    'Failed validation without classification.',
    'Unsupported runner.',
    'Unclear next action or rollback path.'
  ],
  notes: [
    'This is the default Selvedge profile. KG, quick-games, admin, backend, crawled-game, docs, and external projects specialize it instead of replacing it.',
    'The profile intentionally mirrors the useful Autopilot constraints while making them project-agnostic.'
  ]
};

export const KG_SLOTS_MIGRATION_PROFILE: SelvedgeWorkflowProfile = {
  id: 'kg-slots-migration',
  title: 'KG Slots Migration Workflow',
  purpose: 'Continue KG slots-class migrations through Selvedge while preserving KG Cocos/PHP source authority and GameHub money-path authority.',
  appliesTo: 'KG Cocos/PHP slots-class game migration or migration review tasks. It should remain the first business dogfood profile until Selvedge proves stable enough for new KG game types.',
  lifecycle: ['intake', 'planning', 'development', 'qa', 'handoff'],
  intakeQuestions: [
    'business-outcome',
    'target-game',
    'authority-sources',
    'kg-source-paths',
    'write-boundary',
    'development-flow',
    'qa-flow',
    'stop-and-recovery',
    'handoff'
  ],
  planningGates: [
    'Select or confirm one slots-class target before implementation; if the user authorized auto-selection, the master controller must choose and document the candidate set, exclusion reasons, selected route/gameCode, and evidence.',
    'Complete docs-only micro-shell profile fit before source inventory; only Slot - Down / Cocos Bundle may reuse the current same-document profile without new profile work.',
    'Complete docs-only source intake.',
    'Complete minimum-granularity source feature inventory from KG Cocos and KG PHP before runtime work.',
    'Before runtime work, record GameHub config scopes and RTP/control layering: global `*`, category `type:slot`, shell profile `profile:kg-slot-down-cocos-bundle`, concrete gameCode, merchant/campaign override, and player policy.',
    'Complete source functional-detail parity ledger before bridge, mapper, backend handler, package staging, live play, browser smoke, or readiness.',
    'Split runtime work into smallest bridge, mapper, backend, package staging, browser smoke, and parity tasks.',
    'Do not generate or execute a single generic development task for a slots runtime migration.'
  ],
  developmentGates: [
    'Use the accepted MJHL2 same-document micro-shell path as shape reference only.',
    'Execute runtime migration as small serial slices: backend handler, shell room/start primitives, result mapper/runtime, history/detail bridge, then final route/context integration.',
    'Do not infer game features from MJHL2 or another slots template.',
    'Consume RTP and KG control/money overlays only through the shared GameHub config-scope resolver; do not add game-local settlement or control side channels.',
    'Keep KG Cocos/PHP as read-only authority sources.',
    'Keep money, round, order, ledger, wallet, and audit authority inside GameHub services.',
    'Do not modify ../kg-cocos-client, ../kg-php, or ../kg.',
    'Temporary forced/debug probability or trigger changes must be reverted before final diff.'
  ],
  qaGates: [
    'Run source existence check before functional or visual claims.',
    'Run pure source-logic/data-flow regression before browser smoke.',
    'Run browser smoke after logic parity is established.',
    'Run an independent post-migration source-vs-implementation audit after migration and before ReadyForHumanReview.',
    'Independent audit must freshly rescan KG original code and migrated GameHub frontend/backend code; it must not reuse the earlier inventory as proof.'
  ],
  stopGates: [
    'Missing source paths, or no eligible slots candidate can be selected from documented authority sources.',
    'Feature inventory is too broad to drive implementation.',
    'Functional-detail ledger is missing for an existing source feature.',
    'MismatchBlocker in source-vs-implementation audit.',
    'Attempt to start a new KG game type before Selvedge slots-class stabilization.'
  ],
  notes: [
    'Continuation is not limited to a fixed number of slots games after the accepted five-game set.',
    'Each slots target still enters the Selvedge queue through intake and source mapping before implementation; the master controller may select the next slots target when the user has authorized it.',
    'New KG game types should wait until this slots-class profile runs stably.'
  ]
};

export const KG_GAME_MIGRATION_PROFILE: SelvedgeWorkflowProfile = {
  id: 'kg-game-migration',
  title: 'KG Game Migration Workflow',
  purpose: 'Migrate a newly approved KG game type through Selvedge while preserving KG Cocos/PHP source authority and GameHub money-path authority.',
  appliesTo: 'KG Cocos/PHP game migrations that are not proven slots-class targets, including newly approved KG game types after slots-class stabilization.',
  lifecycle: ['intake', 'planning', 'development', 'qa', 'handoff'],
  intakeQuestions: [
    'business-outcome',
    'target-game',
    'authority-sources',
    'kg-source-paths',
    'write-boundary',
    'development-flow',
    'qa-flow',
    'stop-and-recovery',
    'handoff'
  ],
  planningGates: [
    'Confirm one concrete KG target game, route/gameCode, and game type before implementation.',
    'Complete docs-only micro-shell profile fit before source inventory; if the target is Slot - Web Entry, Fish, Poker / Card, or Bingo / Table, queue profile foundation/design work before runtime slices.',
    'Complete docs-only source intake.',
    'Complete minimum-granularity source feature inventory from KG Cocos and KG PHP before runtime work.',
    'Before runtime work, record GameHub config scopes and RTP/control layering: global `*`, category `type:<slot|card|fish|table>`, shell profile `profile:<profile-code>`, concrete gameCode, merchant/campaign override, and player policy.',
    'Complete source functional-detail parity ledger before bridge, mapper, backend handler, package staging, live play, browser smoke, or readiness.',
    'Split runtime work into smallest source-shaped backend handler, shell protocol/room-state primitives, result/callback runtime, history/detail or room-state bridge, route/context integration, QA, audit, and handoff tasks.',
    'Do not infer features from slots, MJHL2, or another migrated game type; every feature must be source-proven or recorded as NotApplicable.'
  ],
  developmentGates: [
    'Use completed slots migrations only as Selvedge process evidence, not as feature templates.',
    'Execute runtime migration as small serial slices around the target source protocol and UI state machine.',
    'Consume RTP and KG control/money overlays only through the shared GameHub config-scope resolver; do not add game-local settlement or control side channels.',
    'Keep KG Cocos/PHP as read-only authority sources.',
    'Keep money, round, order, ledger, wallet, and audit authority inside GameHub services.',
    'Do not modify ../kg-cocos-client, ../kg-php, or ../kg.',
    'Temporary forced/debug probability or trigger changes must be reverted before final diff.'
  ],
  qaGates: [
    'Run source existence check before functional or visual claims.',
    'Run pure source-logic/data-flow regression before browser smoke.',
    'Run browser smoke after logic parity is established.',
    'Run an independent post-migration source-vs-implementation audit after migration and before ReadyForHumanReview.',
    'Independent audit must freshly rescan KG original code and migrated GameHub frontend/backend code; it must not reuse the earlier inventory as proof.'
  ],
  stopGates: [
    'Missing source paths, missing target identity, or unclear game type.',
    'Feature inventory is too broad to drive implementation.',
    'Functional-detail ledger is missing for an existing source feature.',
    'MismatchBlocker in source-vs-implementation audit.',
    'Attempt to reuse slots-specific behavior without source authority.'
  ],
  notes: [
    'This profile is unlocked only after the slots-class Selvedge profile has completed a stable end-to-end run.',
    'New game types must preserve their own source protocol, callback chain, state machine, visual-entry fields, and NotApplicable evidence.',
    'Slots-specific assumptions are forbidden unless the new target source proves the same behavior.'
  ]
};

export function getWorkflowProfile(id: SelvedgeWorkflowProfileId): SelvedgeWorkflowProfile {
  switch (id) {
    case 'kg-game-migration':
      return KG_GAME_MIGRATION_PROFILE;
    case 'kg-slots-migration':
      return KG_SLOTS_MIGRATION_PROFILE;
    case 'universal-autopilot':
      return UNIVERSAL_AUTOPILOT_PROFILE;
  }
}

export function parseWorkflowProfileId(value: string | null): SelvedgeWorkflowProfileId {
  if (value === null || value === 'universal-autopilot') {
    return 'universal-autopilot';
  }
  if (value === 'kg-slots-migration') {
    return 'kg-slots-migration';
  }
  if (value === 'kg-game-migration') {
    return 'kg-game-migration';
  }
  throw new Error(`Unsupported Selvedge workflow profile "${value}". Expected universal-autopilot, kg-game-migration, or kg-slots-migration.`);
}
