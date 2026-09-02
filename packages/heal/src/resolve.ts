/**
 * Find the file that actually holds a drifted locator.
 *
 * Healing used to require `--constants` because the first suite kept every
 * selector in `*.constants.ts`. Suites also inline literals in page objects
 * and specs (`getByTestId('page-header')`). The engine walks configured globs
 * and prefers the most reviewable target.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { findConstant, type TouchedConstant } from './patch.js';

export const DEFAULT_HEAL_TARGET_GLOBS = [
  'src/**/*.constants.ts',
  'src/**/*.page.ts',
  'src/**/*.section.ts',
  'tests/**/*.spec.ts',
  'tests/**/*.test.ts',
] as const;

export type HealTargetKind = 'constants' | 'page-object' | 'spec';

export interface ResolvedSelectorSource {
  readonly kind: HealTargetKind;
  readonly file: string;
  readonly text: string;
  readonly hits: readonly TouchedConstant[];
}

const KIND_RANK: Readonly<Record<HealTargetKind, number>> = {
  constants: 0,
  'page-object': 1,
  spec: 2,
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', '.git', 'test-results', 'playwright-report']);

export function classifyHealTarget(file: string): HealTargetKind {
  const normalized = file.replace(/\\/g, '/');
  if (/\.constants\.ts$/.test(normalized) || /\/constants\//.test(normalized)) return 'constants';
  if (/\.(?:page|section)\.ts$/.test(normalized)) return 'page-object';
  return 'spec';
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withBraces = escaped.replace(/\{([^}]+)\}/g, (_, inner: string) => {
    const options = inner.split(',').map(part => part.trim()).join('|');
    return `(?:${options})`;
  });
  const withDouble = withBraces.replace(/\*\*/g, '\u0000');
  const withSingle = withDouble.replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${withSingle}$`);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walkFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

export async function resolveSelectorSource(input: {
  readonly cwd: string;
  readonly value: string;
  readonly globs?: readonly string[] | undefined;
}): Promise<ResolvedSelectorSource | null> {
  const globs = input.globs ?? DEFAULT_HEAL_TARGET_GLOBS;
  const patterns = globs.map(globToRegExp);
  const files = await walkFiles(input.cwd);
  const matches: ResolvedSelectorSource[] = [];

  for (const absolute of files) {
    const relativePath = relative(input.cwd, absolute).split('\\').join('/');
    if (!patterns.some(pattern => pattern.test(relativePath))) continue;

    const text = await readFile(absolute, 'utf8').catch(() => null);
    if (text === null) continue;
    const hits = findConstant(text, relativePath, input.value);
    if (hits.length === 0) continue;

    matches.push({
      kind: classifyHealTarget(relativePath),
      file: relativePath,
      text,
      hits,
    });
  }

  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0] ?? null;
}
