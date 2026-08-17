/**
 * Ingest run records written by the reporter into the history store.
 *
 * The reporter writes plain JSON; this is the seam where those files become
 * queryable history. Keeping it separate means a CI job can download shard
 * artifacts from anywhere and ingest them in one pass, and a developer can
 * replay months of archived runs to seed history without waiting for it to
 * accumulate.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RUN_SCHEMA_VERSION, type RunRecord } from './types.js';
import type { HistoryStore } from './store.js';

export interface IngestResult {
  readonly filesRead: number;
  readonly runsIngested: number;
  readonly attemptsIngested: number;
  /** Files that could not be ingested, with the reason. Never thrown. */
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

function validate(parsed: unknown, file: string): RunRecord | string {
  if (typeof parsed !== 'object' || parsed === null) return 'not an object';

  const candidate = parsed as Partial<RunRecord>;
  if (candidate.schemaVersion !== RUN_SCHEMA_VERSION) {
    return `schemaVersion ${String(candidate.schemaVersion)} — this build reads ${RUN_SCHEMA_VERSION}`;
  }
  if (typeof candidate.runId !== 'string' || candidate.runId === '') return 'missing runId';
  if (!Array.isArray(candidate.attempts)) return 'missing attempts';
  void file;
  return candidate as RunRecord;
}

/**
 * Ingest every `*.json` in a directory.
 *
 * A malformed or version-mismatched file is SKIPPED and reported, never
 * thrown: one bad artifact among fifty shards must not cost you the other
 * forty-nine, and a partial history is far more useful than none.
 */
export async function ingestDirectory(
  store: HistoryStore,
  dir: string,
): Promise<IngestResult> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = entries.filter(name => name.endsWith('.json'));

  const skipped: { file: string; reason: string }[] = [];
  let runsIngested = 0;
  let attemptsIngested = 0;

  for (const name of files) {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      skipped.push({ file: name, reason: error instanceof Error ? error.message : 'unreadable' });
      continue;
    }

    const validated = validate(parsed, name);
    if (typeof validated === 'string') {
      skipped.push({ file: name, reason: validated });
      continue;
    }

    // The doc comment above promises a bad file is skipped, never thrown —
    // but only the JSON parse and the shape check were guarded. A record that
    // passes both and then fails at the database (an unbindable value, a
    // constraint) threw straight out of here and rolled back the transaction,
    // costing every other file in the batch. In CI that reads as history
    // simply never accumulating.
    try {
      await store.ingest(validated);
    } catch (error) {
      skipped.push({
        file: name,
        reason: `could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    runsIngested += 1;
    attemptsIngested += validated.attempts.length;
  }

  return { filesRead: files.length, runsIngested, attemptsIngested, skipped };
}
