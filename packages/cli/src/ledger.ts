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

import type { QuarantineEntry } from '@atest/flaky';

export const DEFAULT_LEDGER_PATH = '.atest/quarantine.json';

interface LedgerFile {
  readonly schemaVersion: 1;
  readonly entries: QuarantineEntry[];
}

const EMPTY: LedgerFile = { schemaVersion: 1, entries: [] };

export async function readLedger(path = DEFAULT_LEDGER_PATH): Promise<QuarantineEntry[]> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const entries = (parsed as Partial<LedgerFile>).entries;
    return Array.isArray(entries) ? entries : [];
  } catch {
    // A corrupt ledger must not silently read as "nothing is quarantined" —
    // that would let the budget gate pass while tests stay excluded.
    throw new Error(`Quarantine ledger at ${path} is not valid JSON.`);
  }
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
