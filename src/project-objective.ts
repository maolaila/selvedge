import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir, localStatePath, writeJson, writeText } from './fs-utils';
import { buildCodexExecArgs, resolveCodexRunnerOptions } from './runner';
import type {
  SelvedgeProjectObjective,
  SelvedgeProjectObjectiveReview,
  SelvedgeProjectScope
} from './types';

export interface ProjectObjectiveDraftInput {
  readonly totalGoal: string;
  readonly scopes: readonly string[];
  readonly authoritySources: readonly string[];
  readonly writeBoundaries: readonly string[];
  readonly validationExpectations: readonly string[];
  readonly stopExpectations: readonly string[];
  readonly notes: string;
  readonly workstream: string;
  readonly activeWorkflowIds: readonly string[];
  readonly existing?: SelvedgeProjectObjective | null;
}

export interface ProjectObjectiveSaveResult {
  readonly objective: SelvedgeProjectObjective | null;
  readonly draft: SelvedgeProjectObjective;
  readonly review: SelvedgeProjectObjectiveReview;
  readonly saved: boolean;
}

export function projectObjectiveRoot(cwd: string): string {
  return localStatePath(cwd, 'project');
}

export function projectObjectivePath(cwd: string): string {
  return join(projectObjectiveRoot(cwd), 'objective.json');
}

export function projectObjectiveMarkdownPath(cwd: string): string {
  return join(projectObjectiveRoot(cwd), 'objective.md');
}

export function projectObjectiveDraftPath(cwd: string): string {
  return join(projectObjectiveRoot(cwd), 'objective-draft.json');
}

export function projectObjectiveReviewPath(cwd: string): string {
  return join(projectObjectiveRoot(cwd), 'objective-review.md');
}

export function readProjectObjective(cwd: string): SelvedgeProjectObjective | null {
  const path = projectObjectivePath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SelvedgeProjectObjective;
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeList(items: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const item of items) {
    const value = item.trim();
    if (value && !result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function normalizeScope(raw: string, index: number, workstream: string): SelvedgeProjectScope {
  const value = raw.trim();
  const parts = value.split('|').map((item) => item.trim()).filter(Boolean);
  const path = parts[0] || value || 'repo-root';
  const title = parts[1] || path;
  return {
    id: slug(path || title) || `scope-${index + 1}`,
    title,
    path,
    workstream: parts[2] || workstream || 'assigned-work'
  };
}

function structuralReview(draft: SelvedgeProjectObjective): SelvedgeProjectObjectiveReview {
  const conflicts: string[] = [];
  if (!draft.totalGoal.trim()) {
    conflicts.push('Total goal is empty.');
  }
  if (draft.scopes.length === 0) {
    conflicts.push('No monorepo scope is declared. Use repo-root if the whole repository is intended.');
  }
  const duplicateScopeIds = draft.scopes
    .map((scope) => scope.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateScopeIds.length > 0) {
    conflicts.push(`Duplicate scope id(s): ${Array.from(new Set(duplicateScopeIds)).join(', ')}.`);
  }
  return {
    version: 1,
    reviewedAt: new Date().toISOString(),
    reviewer: 'local-structural-review',
    status: conflicts.length > 0 ? 'needs-revision' : 'accepted',
    summary:
      conflicts.length > 0
        ? 'Local structural review found objective fields that must be fixed before AI review.'
        : 'Local structural review passed before AI objective review.',
    conflicts,
    suggestions:
      draft.scopes.length > 1
        ? ['Monorepo scopes are allowed under one project objective; route each workflow to a scope/workstream instead of creating another root goal.']
        : ['Keep the project objective stable; create or continue scoped workflows under it.']
  };
}

export function buildProjectObjectiveDraft(input: ProjectObjectiveDraftInput): SelvedgeProjectObjective {
  const now = new Date().toISOString();
  const scopes = normalizeList(input.scopes);
  const normalizedScopes =
    scopes.length > 0
      ? scopes.map((item, index) => normalizeScope(item, index, input.workstream))
      : [normalizeScope('repo-root|Repository root', 0, input.workstream)];
  return {
    version: 1,
    id: 'project-objective',
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    source: 'selvedge dashboard',
    totalGoal: input.totalGoal.trim(),
    monorepoStrategy: 'single-project-objective-with-scoped-workflows',
    scopes: normalizedScopes,
    authoritySources: normalizeList(input.authoritySources),
    writeBoundaries: normalizeList(input.writeBoundaries),
    validationExpectations: normalizeList(input.validationExpectations),
    stopExpectations: normalizeList(input.stopExpectations),
    notes: input.notes.trim(),
    activeWorkflowIds: normalizeList(input.activeWorkflowIds),
    review: structuralReview({
      version: 1,
      id: 'project-objective',
      createdAt: input.existing?.createdAt ?? now,
      updatedAt: now,
      source: 'selvedge dashboard',
      totalGoal: input.totalGoal.trim(),
      monorepoStrategy: 'single-project-objective-with-scoped-workflows',
      scopes: normalizedScopes,
      authoritySources: normalizeList(input.authoritySources),
      writeBoundaries: normalizeList(input.writeBoundaries),
      validationExpectations: normalizeList(input.validationExpectations),
      stopExpectations: normalizeList(input.stopExpectations),
      notes: input.notes.trim(),
      activeWorkflowIds: normalizeList(input.activeWorkflowIds),
      review: {
        version: 1,
        reviewedAt: now,
        reviewer: 'local-structural-review',
        status: 'accepted',
        summary: '',
        conflicts: [],
        suggestions: []
      }
    })
  };
}

export function projectObjectiveMarkdown(objective: SelvedgeProjectObjective): string {
  const lines = [
    '# Selvedge Project Objective',
    '',
    `Updated: ${objective.updatedAt}`,
    '',
    '## Total Goal',
    '',
    objective.totalGoal,
    '',
    '## Monorepo Strategy',
    '',
    '- One Selvedge project has exactly one active project objective.',
    '- Monorepo work is represented by scoped workflows under this objective, not by multiple root objectives.',
    '- Each workflow must declare its scope/workstream and read this objective before execution.',
    '',
    '## Scopes',
    ''
  ];
  for (const scope of objective.scopes) {
    lines.push(`- ${scope.id}: ${scope.title} (${scope.path}) / workstream=${scope.workstream}`);
  }
  lines.push('', '## Authority Sources', '');
  for (const item of objective.authoritySources.length ? objective.authoritySources : ['NeedsHumanInput or workflow-specific source map']) {
    lines.push(`- ${item}`);
  }
  lines.push('', '## Write Boundaries', '');
  for (const item of objective.writeBoundaries.length ? objective.writeBoundaries : ['Workflow-specific WriteSet must be declared before edits']) {
    lines.push(`- ${item}`);
  }
  lines.push('', '## Validation Expectations', '');
  for (const item of objective.validationExpectations.length ? objective.validationExpectations : ['Workflow-specific validation must be declared before handoff']) {
    lines.push(`- ${item}`);
  }
  lines.push('', '## Stop Expectations', '');
  for (const item of objective.stopExpectations.length ? objective.stopExpectations : ['Stop on conflict, unsafe scope, failed validation, or human-review gate']) {
    lines.push(`- ${item}`);
  }
  lines.push('', '## Notes', '', objective.notes || 'None.', '', '## Last AI Review', '');
  lines.push(`- Status: ${objective.review.status}`);
  lines.push(`- Reviewer: ${objective.review.reviewer}`);
  lines.push(`- Summary: ${objective.review.summary}`);
  if (objective.review.conflicts.length) {
    lines.push('- Conflicts:');
    for (const item of objective.review.conflicts) {
      lines.push(`  - ${item}`);
    }
  }
  if (objective.review.suggestions.length) {
    lines.push('- Suggestions:');
    for (const item of objective.review.suggestions) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function buildProjectObjectiveReviewPrompt(
  draft: SelvedgeProjectObjective,
  existing: SelvedgeProjectObjective | null
): string {
  return [
    'You are the Selvedge project-objective review agent.',
    '',
    'Review the operator-edited project objective before it replaces the saved objective.',
    'Selvedge has one active project objective per workspace. In a monorepo, multiple apps/packages/scopes are allowed only as scoped workflows under the same project objective.',
    '',
    'Return only JSON with this exact shape:',
    '{"status":"accepted|needs-revision","summary":"short","conflicts":["..."],"suggestions":["..."]}',
    '',
    'Rules:',
    '- Use Simplified Chinese as the primary language for summary, conflicts, and suggestions. Keep technical identifiers, paths, commands, package names, and JSON keys in their original form.',
    '- Use status "accepted" only when the draft has no logical conflict with itself, the existing objective, or one-root-objective monorepo semantics.',
    '- Use status "needs-revision" when the draft contains contradictory goals, unclear authority, conflicting write boundaries, impossible stop expectations, or multiple unrelated root objectives.',
    '- Do not reject merely because the monorepo has multiple scopes; scopes are expected.',
    '- Suggestions are advisory. Do not silently rewrite the user objective.',
    '',
    'Existing objective:',
    JSON.stringify(existing, null, 2),
    '',
    'Draft objective:',
    JSON.stringify(draft, null, 2),
    ''
  ].join('\n');
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function aiReviewFromJson(
  parsed: Record<string, unknown>,
  promptPath: string,
  logPath: string,
  lastMessagePath: string
): SelvedgeProjectObjectiveReview {
  const conflicts = Array.isArray(parsed.conflicts)
    ? parsed.conflicts.map((item) => String(item)).filter(Boolean)
    : [];
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.map((item) => String(item)).filter(Boolean)
    : [];
  const status = parsed.status === 'accepted' && conflicts.length === 0 ? 'accepted' : 'needs-revision';
  return {
    version: 1,
    reviewedAt: new Date().toISOString(),
    reviewer: 'codex-cli-ai-reviewer',
    status,
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : 'AI objective review completed.',
    conflicts,
    suggestions,
    promptPath,
    logPath,
    lastMessagePath
  };
}

function runAiObjectiveReview(
  cwd: string,
  draft: SelvedgeProjectObjective,
  existing: SelvedgeProjectObjective | null,
  runnerArgs: readonly string[]
): SelvedgeProjectObjectiveReview {
  const structural = structuralReview(draft);
  if (structural.status !== 'accepted') {
    return structural;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const promptPath = join(projectObjectiveRoot(cwd), 'reviews', `objective-review.${timestamp}.prompt.md`);
  const logPath = join(projectObjectiveRoot(cwd), 'reviews', `objective-review.${timestamp}.log`);
  const lastMessagePath = join(projectObjectiveRoot(cwd), 'reviews', `objective-review.${timestamp}.last-message.md`);
  ensureDir(join(projectObjectiveRoot(cwd), 'reviews'));
  const prompt = buildProjectObjectiveReviewPrompt(draft, existing);
  writeText(promptPath, prompt);
  const options = resolveCodexRunnerOptions(runnerArgs);
  const args = buildCodexExecArgs(cwd, lastMessagePath, {
    ...options,
    jsonOutput: false,
    showOutput: false
  });
  const result = spawnSync(options.codexExecutable, args, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
  writeText(
    logPath,
    [
      `Command: ${options.codexExecutable} ${args.join(' ')}`,
      `ExitCode: ${result.status ?? 'null'}`,
      `Signal: ${result.signal ?? 'null'}`,
      '',
      'STDOUT:',
      result.stdout ?? '',
      '',
      'STDERR:',
      result.stderr ?? '',
      ''
    ].join('\n')
  );
  const lastMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : '';
  const parsed = extractJsonObject(lastMessage || result.stdout || '');
  if (result.status !== 0 || !parsed) {
    return {
      version: 1,
      reviewedAt: new Date().toISOString(),
      reviewer: 'codex-cli-ai-reviewer',
      status: 'review-unavailable',
      summary: 'AI objective review did not return a parseable accepted result, so Selvedge kept the previous objective and saved this edit as a draft.',
      conflicts: ['AI review is unavailable or returned unparseable output. The project objective was not replaced.'],
      suggestions: ['Retry save after the model/runner is available, or inspect the review log for runner errors.'],
      promptPath,
      logPath,
      lastMessagePath
    };
  }
  return aiReviewFromJson(parsed, promptPath, logPath, lastMessagePath);
}

export function saveProjectObjectiveWithReview(
  cwd: string,
  draft: SelvedgeProjectObjective,
  runnerArgs: readonly string[]
): ProjectObjectiveSaveResult {
  const existing = readProjectObjective(cwd);
  const review = runAiObjectiveReview(cwd, draft, existing, runnerArgs);
  const reviewedDraft: SelvedgeProjectObjective = {
    ...draft,
    review,
    updatedAt: new Date().toISOString()
  };
  writeJson(projectObjectiveDraftPath(cwd), reviewedDraft);
  writeText(projectObjectiveReviewPath(cwd), projectObjectiveReviewMarkdown(review));
  if (review.status !== 'accepted') {
    return {
      objective: existing,
      draft: reviewedDraft,
      review,
      saved: false
    };
  }
  writeJson(projectObjectivePath(cwd), reviewedDraft);
  writeText(projectObjectiveMarkdownPath(cwd), projectObjectiveMarkdown(reviewedDraft));
  return {
    objective: reviewedDraft,
    draft: reviewedDraft,
    review,
    saved: true
  };
}

export function projectObjectiveReviewMarkdown(review: SelvedgeProjectObjectiveReview): string {
  const lines = [
    '# Selvedge Project Objective Review',
    '',
    `Reviewed: ${review.reviewedAt}`,
    `Reviewer: ${review.reviewer}`,
    `Status: ${review.status}`,
    '',
    '## Summary',
    '',
    review.summary,
    '',
    '## Conflicts',
    ''
  ];
  if (review.conflicts.length === 0) {
    lines.push('- None.');
  } else {
    for (const item of review.conflicts) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('', '## Suggestions', '');
  if (review.suggestions.length === 0) {
    lines.push('- None.');
  } else {
    for (const item of review.suggestions) {
      lines.push(`- ${item}`);
    }
  }
  if (review.logPath) {
    lines.push('', '## Evidence', '', `- Prompt: ${review.promptPath ?? 'n/a'}`, `- Log: ${review.logPath}`, `- Last message: ${review.lastMessagePath ?? 'n/a'}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
