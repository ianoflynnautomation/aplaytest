/**
 * Read run records and evidence bundles off disk.
 *
 * Everything here degrades rather than throws. Report generation runs at the
 * end of a CI job that has often already failed, frequently over artifacts
 * downloaded from four shards where one upload was cancelled. Refusing to
 * produce a report because one file is corrupt would withhold the other three
 * shards' worth of information at exactly the moment it is wanted.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvidenceBundle, RunRecord } from '@aplaytest/core';

export interface LoadResult<T> {
  readonly items: readonly T[];
  /** Files that could not be used, with the reason — surfaced, never silent. */
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

async function readJsonDir<T>(
  dir: string,
  validate: (value: unknown) => value is T,
  recurse: boolean,
): Promise<LoadResult<T>> {
  const items: T[] = [];
  const skipped: { file: string; reason: string }[] = [];

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!recurse) continue;
      const nested = await readJsonDir(path, validate, false);
      items.push(...nested.items);
      skipped.push(...nested.skipped);
      continue;
    }

    if (!entry.name.endsWith('.json')) continue;

    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (validate(parsed)) items.push(parsed);
      else skipped.push({ file: entry.name, reason: 'not the expected shape' });
    } catch (error) {
      skipped.push({ file: entry.name, reason: error instanceof Error ? error.message : 'unreadable' });
    }
  }

  return { items, skipped };
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['runId'] === 'string' && Array.isArray(record['attempts']);
}

function isEvidenceBundle(value: unknown): value is EvidenceBundle {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['failure'] === 'object' &&
    record['failure'] !== null &&
    typeof record['test'] === 'object' &&
    record['test'] !== null
  );
}

export function loadRuns(dir: string): Promise<LoadResult<RunRecord>> {
  return readJsonDir(dir, isRunRecord, false);
}

/** Evidence is stored one directory per run, so this recurses one level. */
export function loadEvidence(dir: string): Promise<LoadResult<EvidenceBundle>> {
  return readJsonDir(dir, isEvidenceBundle, true);
}

/**
 * Order failures so the most informative card is first.
 *
 * Kind ordering is a judgement, not a preference: an app error or a contract
 * violation is a real defect and should be read before a locator miss, which
 * is frequently a consequence of it. Sorting by test name instead puts an
 * alphabetically lucky symptom above its own cause.
 */
const KIND_PRIORITY: readonly string[] = [
  'app_error',
  'schema_violation',
  'http_status',
  'network_error',
  'navigation_failure',
  'assertion_value',
  'locator_not_found',
  'locator_ambiguous',
  'assertion_visibility',
  'timeout',
  'infra',
];

export function orderFailures(bundles: readonly EvidenceBundle[]): EvidenceBundle[] {
  return [...bundles].sort((a, b) => {
    const rankA = KIND_PRIORITY.indexOf(a.failure.kind);
    const rankB = KIND_PRIORITY.indexOf(b.failure.kind);
    const normA = rankA === -1 ? KIND_PRIORITY.length : rankA;
    const normB = rankB === -1 ? KIND_PRIORITY.length : rankB;
    if (normA !== normB) return normA - normB;
    return a.test.title.localeCompare(b.test.title);
  });
}
