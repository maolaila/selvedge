import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function repoPath(cwd: string, relativePath: string): string {
  return resolve(cwd, relativePath);
}

export function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(path: string, value: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, value, 'utf8');
}

export function localStatePath(cwd: string, ...parts: readonly string[]): string {
  return join(cwd, '.selvedge', ...parts);
}
