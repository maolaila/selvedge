import { existsSync } from 'node:fs';
import { repoPath, readTextIfExists } from './fs-utils';
import { SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS } from './types';
import type { SelvedgeConfigState, SelvedgeHeartbeatOptionalField, SelvedgeHeartbeatTemplate, SelvedgeValidationIssue } from './types';

const DEFAULT_HEARTBEAT_TEMPLATE: SelvedgeHeartbeatTemplate = {
  format: 'block',
  optionalFields: ['machine']
};
const VALID_PHASES = new Set([
  'parasite-boundary',
  'shadow-validation',
  'wrapper-delegation',
  'gamehub-default-entry',
  'product-extraction-ready'
]);
const VALID_PRIMARY_BUILDERS = new Set(['codex-app-agent', 'codex-cli']);

function matchScalar(text: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escapedKey}:\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!match) {
    return null;
  }
  return match[1]?.replace(/^"|"$/g, '') ?? null;
}

function matchBoolean(text: string, key: string): boolean | 'unknown' {
  const scalar = matchScalar(text, key);
  if (scalar === 'true') {
    return true;
  }
  if (scalar === 'false') {
    return false;
  }
  return 'unknown';
}

function sectionText(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startIndex = lines.findIndex((line) => new RegExp(`^(\\s*)${escapedKey}:\\s*$`).test(line));
  if (startIndex < 0) {
    return null;
  }
  const baseIndent = lines[startIndex].match(/^(\s*)/)?.[1]?.length ?? 0;
  const result: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      result.push(line);
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= baseIndent) {
      break;
    }
    result.push(line);
  }
  return result.join('\n');
}

function matchListInSection(section: string | null, key: string): readonly string[] | null {
  if (!section) {
    return null;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^\\s*${escapedKey}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(section);
  if (inline) {
    const value = inline[1]?.trim() ?? '';
    return value.length === 0 ? [] : value.split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  const lines = section.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^(\\s*)${escapedKey}:\\s*$`).test(line));
  if (keyIndex < 0) {
    return null;
  }
  const baseIndent = lines[keyIndex].match(/^(\s*)/)?.[1]?.length ?? 0;
  const values: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= baseIndent) {
      break;
    }
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) {
      values.push(match[1].replace(/^"|"$/g, ''));
    }
  }
  return values;
}

function readHeartbeatTemplate(text: string): Pick<SelvedgeConfigState, 'heartbeatFormat' | 'heartbeatTemplate' | 'heartbeatInvalidOptionalFields'> {
  const heartbeat = sectionText(text, 'heartbeat');
  const rawFormat = heartbeat ? matchScalar(heartbeat, 'format') : null;
  const rawOptionalFields = matchListInSection(heartbeat, 'optionalFields');
  const allowed = new Set<string>(SELVEDGE_HEARTBEAT_OPTIONAL_FIELDS);
  const optionalFields =
    rawOptionalFields === null
      ? DEFAULT_HEARTBEAT_TEMPLATE.optionalFields
      : rawOptionalFields.filter((item): item is SelvedgeHeartbeatOptionalField => allowed.has(item));
  return {
    heartbeatFormat: rawFormat,
    heartbeatTemplate: {
      format: 'block',
      optionalFields
    },
    heartbeatInvalidOptionalFields: rawOptionalFields?.filter((item) => !allowed.has(item)) ?? []
  };
}

export function readSelvedgeConfig(cwd: string): SelvedgeConfigState {
  const path = repoPath(cwd, 'selvedge.yaml');
  const text = readTextIfExists(path);
  if (!text) {
    return {
      exists: false,
      path,
      projectName: null,
      currentPhase: null,
      currentAutopilotIsAuthoritative: 'unknown',
      packageName: null,
      primaryBuilder: null,
      firstDogfoodPreferred: null,
      heartbeatFormat: null,
      heartbeatTemplate: DEFAULT_HEARTBEAT_TEMPLATE,
      heartbeatInvalidOptionalFields: []
    };
  }
  const heartbeat = readHeartbeatTemplate(text);
  return {
    exists: true,
    path,
    projectName: matchScalar(text, 'name'),
    currentPhase: matchScalar(text, 'currentPhase'),
    currentAutopilotIsAuthoritative: matchBoolean(text, 'currentAutopilotIsAuthoritative'),
    packageName: matchScalar(text, 'packageName'),
    primaryBuilder: matchScalar(text, 'primaryBuilder'),
    firstDogfoodPreferred: matchScalar(text, 'preferred'),
    ...heartbeat
  };
}

export function validateSelvedgeConfig(config: SelvedgeConfigState): readonly SelvedgeValidationIssue[] {
  const issues: SelvedgeValidationIssue[] = [];
  if (!config.exists) {
    issues.push({
      code: 'selvedge.config.missing',
      severity: 'error',
      file: config.path,
      message: 'selvedge.yaml is required before Selvedge can plan or run tasks.'
    });
    return issues;
  }
  if (!config.currentPhase || !VALID_PHASES.has(config.currentPhase)) {
    issues.push({
      code: 'selvedge.config.phase',
      severity: 'warning',
      file: config.path,
      message: `Unexpected Selvedge currentPhase ${config.currentPhase ?? 'missing'}.`
    });
  }
  if (config.currentAutopilotIsAuthoritative === 'unknown') {
    issues.push({
      code: 'selvedge.config.autopilotAuthority',
      severity: 'error',
      file: config.path,
      message: 'Selvedge compatibility.currentAutopilotIsAuthoritative must be explicitly true or false.'
    });
  }
  if (
    (config.currentPhase === 'gamehub-default-entry' || config.currentPhase === 'product-extraction-ready') &&
    config.currentAutopilotIsAuthoritative === true
  ) {
    issues.push({
      code: 'selvedge.config.autopilotAuthority',
      severity: 'error',
      file: config.path,
      message: 'GameHub default-entry phase requires old Autopilot scripts to be compatibility entries, not authoritative.'
    });
  }
  if (config.packageName !== '@maolaila1/selvedge') {
    issues.push({
      code: 'selvedge.config.packageName',
      severity: 'warning',
      file: config.path,
      message: 'Expected commercializationPlan.distribution.packageName to be @maolaila1/selvedge.'
    });
  }
  if (config.primaryBuilder && !VALID_PRIMARY_BUILDERS.has(config.primaryBuilder)) {
    issues.push({
      code: 'selvedge.config.primaryBuilder',
      severity: 'warning',
      file: config.path,
      message: `Unexpected Selvedge primaryBuilder "${config.primaryBuilder}". Expected codex-cli or codex-app-agent.`
    });
  }
  if (config.heartbeatFormat && config.heartbeatFormat !== 'block') {
    issues.push({
      code: 'selvedge.config.heartbeatFormat',
      severity: 'warning',
      file: config.path,
      message: `Selvedge heartbeat format is locked to block output; got ${config.heartbeatFormat}.`
    });
  }
  for (const field of config.heartbeatInvalidOptionalFields) {
    issues.push({
      code: 'selvedge.config.heartbeatOptionalField',
      severity: 'warning',
      file: config.path,
      message: `Unsupported heartbeat optional field "${field}".`
    });
  }
  return issues;
}

export function hasRepoFile(cwd: string, relativePath: string): boolean {
  return existsSync(repoPath(cwd, relativePath));
}
