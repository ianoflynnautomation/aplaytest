/**
 * The heal ledger.
 *
 * One git-tracked JSON file per heal, written when a patch is applied. It is
 * the audit trail, and it belongs in the repository alongside the change it
 * justifies: six months later, "why is this selector called that?" should be
 * answerable from the repo rather than from a dashboard nobody kept.
 *
 * The record stores the ORIGINAL FILE TEXT rather than a diff. Reverting from
 * a stored diff means re-deriving context that may have moved on; storing the
 * text makes revert exact and total, which is the property you want from an
 * undo button for automated edits.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { patchConstant } from './patch.js';
import type { HealProposal } from './propose.js';
import type { ValidationRecord } from './validate.js';

export const DEFAULT_LEDGER_DIR = '.atest/heals';
export const HEAL_SCHEMA_VERSION = 1 as const;

export type HealStatus = 'applied' | 'reverted';

export interface HealRecord {
  readonly schemaVersion: typeof HEAL_SCHEMA_VERSION;
  readonly healId: string;
  readonly createdAt: string;
  readonly atestVersion: string;
  readonly evidenceId: string;
  readonly test: {
    readonly title: string;
    readonly file: string;
    readonly project: string;
  };
  readonly failureKind: string;
  readonly strategy: 'selector';
  /** 0 = deterministic; a model tier would record 1 here. */
  readonly tier: 0 | 1;
  readonly model: string | null;
  readonly patch: {
    readonly file: string;
    readonly from: string;
    readonly to: string;
    readonly constants: readonly string[];
    readonly stabilityDelta: number;
  };
  readonly candidatesConsidered: number;
  readonly semanticDistance: number;
  readonly validation: ValidationRecord | null;
  readonly status: HealStatus;
  /** The file exactly as it was before the heal. Revert restores this verbatim. */
  readonly revertText: string;
  readonly revertedAt: string | null;
}

/** Derived, not random: the same heal always resolves to the same id. */
export function healId(evidenceId: string, from: string, to: string): string {
  const digest = createHash('sha256').update(`${evidenceId} ${from} ${to}`).digest('hex');
  return `heal_${digest.slice(0, 10)}`;
}

export function buildRecord(
  proposal: HealProposal,
  context: {
    readonly project: string;
    readonly failureKind: string;
    readonly atestVersion: string;
    readonly testFile: string;
  },
): HealRecord | null {
  const patch = proposal.patch;
  const chosen = proposal.chosen;
  if (patch === null || chosen === null || patch.after === null) return null;

  const from = patch.from;

  return {
    schemaVersion: HEAL_SCHEMA_VERSION,
    healId: healId(proposal.evidenceId, from, chosen.value),
    createdAt: new Date().toISOString(),
    atestVersion: context.atestVersion,
    evidenceId: proposal.evidenceId,
    test: { title: proposal.testTitle, file: context.testFile, project: context.project },
    failureKind: context.failureKind,
    strategy: 'selector',
    tier: proposal.tierOne?.used === true ? 1 : 0,
    model: proposal.tierOne?.model ?? null,
    patch: {
      file: patch.file,
      from,
      to: chosen.value,
      constants: patch.touched.map(t => t.path),
      stabilityDelta: chosen.stabilityDelta,
    },
    candidatesConsidered: proposal.candidates.length,
    semanticDistance: chosen.semanticDistance,
    validation: proposal.validation,
    status: 'applied',
    revertText: patch.before,
    revertedAt: null,
  };
}

export async function writeRecord(record: HealRecord, dir = DEFAULT_LEDGER_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${record.healId}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

const JSON_EXTENSION = '.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHealStatus(value: unknown): value is HealStatus {
  return value === 'applied' || value === 'reverted';
}

function isHealRecord(value: unknown): value is HealRecord {
  if (!isRecord(value)) return false;
  return (
    value['schemaVersion'] === HEAL_SCHEMA_VERSION &&
    typeof value['healId'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    isHealStatus(value['status']) &&
    isRecord(value['patch']) &&
    typeof value['patch']['file'] === 'string' &&
    typeof value['revertText'] === 'string'
  );
}

function parseHealRecord(raw: string): HealRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHealRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readRecords(dir = DEFAULT_LEDGER_DIR): Promise<HealRecord[]> {
  const files = (await readdir(dir).catch(() => [])).filter(file => file.endsWith(JSON_EXTENSION));
  const records: HealRecord[] = [];

  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (raw === null) continue;
    const record = parseHealRecord(raw);
    // A malformed ledger entry must not hide the rest of the ledger.
    if (record !== null) records.push(record);
  }

  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RevertResult {
  readonly status: 'reverted' | 'not-found' | 'already-reverted' | 'file-changed';
  readonly message: string;
  readonly record: HealRecord | null;
}

/**
 * Restore the file exactly as it was before the heal.
 *
 * Refuses when the file has changed since — a revert that silently discards
 * someone's later edit is worse than the heal it is undoing.
 */
export async function revertHeal(
  id: string,
  options: { dir?: string; force?: boolean } = {},
): Promise<RevertResult> {
  const dir = options.dir ?? DEFAULT_LEDGER_DIR;
  const records = await readRecords(dir);
  const record = records.find(r => r.healId === id);

  if (record === undefined) {
    return { status: 'not-found', message: `No heal ${id} in ${dir}.`, record: null };
  }
  if (record.status === 'reverted') {
    return {
      status: 'already-reverted',
      message: `${id} was already reverted on ${record.revertedAt ?? 'an earlier date'}.`,
      record,
    };
  }

  const current = await readFile(record.patch.file, 'utf8').catch(() => null);
  if (current === null) {
    return { status: 'not-found', message: `Cannot read ${record.patch.file}.`, record };
  }

  // Replay the original patch, quote-aware and for every shared literal.
  // `String.replace` would only change the first occurrence and ignore quotes,
  // so a two-constant heal would look "changed" and refuse to revert.
  const replayed = patchConstant(record.revertText, {
    file: record.patch.file,
    from: record.patch.from,
    to: record.patch.to,
  });
  const expected = replayed.after ?? record.revertText;
  if (options.force !== true && current !== expected) {
    return {
      status: 'file-changed',
      message:
        `${record.patch.file} has changed since this heal was applied. Reverting would discard ` +
        'those edits. Re-apply the original value by hand, or pass --force.',
      record,
    };
  }

  await writeFile(record.patch.file, record.revertText, 'utf8');
  const updated: HealRecord = { ...record, status: 'reverted', revertedAt: new Date().toISOString() };
  await writeRecord(updated, dir);

  return {
    status: 'reverted',
    message: `Restored ${record.patch.file} to its state before ${id}.`,
    record: updated,
  };
}
