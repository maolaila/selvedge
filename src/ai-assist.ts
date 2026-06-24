import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, localStatePath, writeText } from './fs-utils';
import { buildCodexExecArgs, resolveCodexRunnerOptions } from './runner';

export interface SelvedgeAiJsonEvidence {
  readonly provider: 'codex-cli';
  readonly operation: string;
  readonly status: 'parsed' | 'unavailable';
  readonly generatedAt: string;
  readonly summary: string;
  readonly promptPath: string;
  readonly logPath: string;
  readonly lastMessagePath: string;
}

export interface SelvedgeAiJsonResult {
  readonly parsed: Record<string, unknown> | null;
  readonly evidence: SelvedgeAiJsonEvidence;
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
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

function operationSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'ai-json';
}

export function runSelvedgeAiJson(
  cwd: string,
  operation: string,
  prompt: string,
  runnerArgs: readonly string[],
  timeoutMs = 180_000
): SelvedgeAiJsonResult {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = operationSlug(operation);
  const root = localStatePath(cwd, 'ai', slug);
  ensureDir(root);
  const promptPath = join(root, `${timestamp}.prompt.md`);
  const logPath = join(root, `${timestamp}.log`);
  const lastMessagePath = join(root, `${timestamp}.last-message.md`);
  writeText(promptPath, prompt);
  let parsed: Record<string, unknown> | null = null;
  let ok = false;
  try {
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
      timeout: options.timeoutMs ?? timeoutMs,
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
    parsed = extractJsonObject(lastMessage || result.stdout || '');
    ok = result.status === 0 && Boolean(parsed);
  } catch (error) {
    writeText(
      logPath,
      [
        'Selvedge AI JSON runner setup failed.',
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        ''
      ].join('\n')
    );
  }
  return {
    parsed: ok ? parsed : null,
    evidence: {
      provider: 'codex-cli',
      operation,
      status: ok ? 'parsed' : 'unavailable',
      generatedAt: new Date().toISOString(),
      summary: ok
        ? 'AI returned parseable JSON.'
        : 'AI did not return parseable JSON or the runner failed; Selvedge used the safe fallback path.',
      promptPath,
      logPath,
      lastMessagePath
    }
  };
}
