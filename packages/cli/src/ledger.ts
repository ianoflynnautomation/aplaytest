/**
 * The quarantine ledger.
 *
 * Two sources of truth, deliberately, each authoritative over a different
 * thing:
 *
 *   the `@quarantine` TAG in the spec  → what actually runs. The suite's own
 *                                        grep already honours it; no new
 *                                        runtime machinery, and deleting the
 *                                        test deletes the quarantine.
 *   this LEDGER                        → why, since when, until when, who.
 *                                        Policy needs metadata that a tag
 *                                        cannot carry.
 *
 * The ledger is git-tracked JSON rather than a row in the history database:
 * history is derived and disposable, whereas "we agreed to ignore this test
 * until the 30th" is a decision that belongs in review alongside the code.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { QuarantineEntry } from '@aplaytest/flaky';

export const DEFAULT_LEDGER_PATH = '.atest/quarantine.json';
export const LEDGER_SCHEMA_VERSION = 1 as const;

interface LedgerFile {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly entries: QuarantineEntry[];
}

const EMPTY: LedgerFile = { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQuarantineEntry(value: unknown): value is QuarantineEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value['testId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['flakeScore'] === 'number' &&
    typeof value['rootCause'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['expiresAt'] === 'string' &&
    (value['project'] === null || typeof value['project'] === 'string') &&
    (value['issueUrl'] === null || typeof value['issueUrl'] === 'string') &&
    (value['justification'] === null || typeof value['justification'] === 'string')
  );
}

function parseLedgerEntries(value: unknown, path: string): QuarantineEntry[] {
  if (!isRecord(value)) return [];
  const entries = value['entries'];
  if (!Array.isArray(entries)) return [];
  if (!entries.every(isQuarantineEntry)) {
    throw new Error(`Quarantine ledger at ${path} contains an invalid entry.`);
  }
  return entries;
}

export async function readLedger(path = DEFAULT_LEDGER_PATH): Promise<QuarantineEntry[]> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt ledger must not silently read as "nothing is quarantined" —
    // that would let the budget gate pass while tests stay excluded.
    throw new Error(`Quarantine ledger at ${path} is not valid JSON.`);
  }

  return parseLedgerEntries(parsed, path);
}

export async function writeLedger(
  entries: readonly QuarantineEntry[],
  path = DEFAULT_LEDGER_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file: LedgerFile = { ...EMPTY, entries: [...entries] };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

export function upsertEntry(
  entries: readonly QuarantineEntry[],
  entry: QuarantineEntry,
): QuarantineEntry[] {
  const others = entries.filter(
    e => !(e.testId === entry.testId && e.project === entry.project),
  );
  return [...others, entry];
}

export function removeEntry(
  entries: readonly QuarantineEntry[],
  testId: string,
  project: string | null,
): QuarantineEntry[] {
  return entries.filter(e => !(e.testId === testId && e.project === project));
}
