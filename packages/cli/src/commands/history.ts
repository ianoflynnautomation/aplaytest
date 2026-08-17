/**
 * `atest history` — inspect and trim the run history.
 *
 * The history database is the one piece of atest state that OUTLIVES a run.
 * Everything else is derived from the current run's artifacts and can be
 * thrown away; flake statistics cannot, because a single run tells you nothing
 * about whether a test is unstable. That makes it the one thing needing a
 * retention story and an answer to "what is actually in there?".
 *
 * Deliberately storage-agnostic: this operates on a local file, and moving
 * that file to and from Azure Blob (or S3, or a cache) is the workflow's job.
 * Putting a cloud SDK in here would buy nothing and pin every consumer to one
 * provider, for an operation `az storage blob` already does in one line.
 */

import { stat } from 'node:fs/promises';

import { SqliteHistoryStore, ingestDirectory } from '@atest/core';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style, warn } from '../ui/output.js';

export interface HistoryFlags {
  readonly db: string;
  readonly runs: string;
  readonly json: boolean;
  /** Retention in days for `history prune`. */
  readonly keepDays?: string | undefined;
}

const DEFAULT_KEEP_DAYS = 90;

function requireFileDb(db: string): void {
  if (db === ':memory:') {
    throw new UsageError(
      'history commands need a file database — pass --db <path>.\n' +
        '  The default (:memory:) is discarded when the process exits, which is why\n' +
        '  flake scoring reports "insufficient data" when it is left at the default in CI.',
    );
  }
}

export async function historyStats(flags: HistoryFlags): Promise<ExitCode> {
  requireFileDb(flags.db);

  const size = await stat(flags.db).then(
    s => s.size,
    () => null,
  );

  const store = new SqliteHistoryStore(flags.db);
  const [runs, keys, attempts] = await Promise.all([
    store.runCount(),
    store.testKeys(),
    store.attempts(),
  ]);
  await store.close();

  const oldest = attempts.reduce<string | null>(
    (min, a) => (min === null || a.startedAt < min ? a.startedAt : min),
    null,
  );
  const newest = attempts.reduce<string | null>(
    (max, a) => (max === null || a.startedAt > max ? a.startedAt : max),
    null,
  );

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ db: flags.db, sizeBytes: size, runs, tests: keys.length, attempts: attempts.length, oldest, newest }, null, 2)}\n`,
    );
    return EXIT.OK;
  }

  heading(`history · ${flags.db}`);
  if (size === null) {
    warn('  file does not exist yet — nothing has been ingested');
    return EXIT.OK;
  }

  line(`  ${runs} runs · ${keys.length} tests · ${attempts.length} attempts · ${(size / 1024).toFixed(0)} KB`);
  if (oldest !== null && newest !== null) line(`  ${oldest.slice(0, 10)} → ${newest.slice(0, 10)}`);

  // Scoring needs a window, and the most common way this looks broken is a
  // history that is technically present but too shallow to say anything.
  if (runs < 10) {
    line();
    warn(`  ${runs} runs is below the scoring minimum (10) — flake verdicts will read "insufficient data"`);
    line(style.dim('  This is expected while history accumulates; it is not a failure.'));
  }
  return EXIT.OK;
}

export async function historyIngest(flags: HistoryFlags): Promise<ExitCode> {
  requireFileDb(flags.db);

  const store = new SqliteHistoryStore(flags.db);
  const result = await ingestDirectory(store, flags.runs);
  const runs = await store.runCount();
  await store.close();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...result, totalRuns: runs }, null, 2)}\n`);
    return EXIT.OK;
  }

  heading('history ingest');
  line(`  +${result.runsIngested} runs · +${result.attemptsIngested} attempts · ${runs} total`);

  // Never silent. A skipped record is history that will not exist later, and
  // the failure mode it produces — "insufficient data" weeks from now — gives
  // no hint that anything was dropped today.
  if (result.skipped.length > 0) {
    line();
    warn(`${result.skipped.length} file(s) skipped:`);
    for (const s of result.skipped.slice(0, 10)) line(style.dim(`  ${s.file} — ${s.reason}`));
  }
  return EXIT.OK;
}

export async function historyPrune(flags: HistoryFlags): Promise<ExitCode> {
  requireFileDb(flags.db);

  const days = Number.parseInt(flags.keepDays ?? String(DEFAULT_KEEP_DAYS), 10);
  if (!Number.isInteger(days) || days < 1) {
    throw new UsageError('--keep-days must be a positive integer.');
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const store = new SqliteHistoryStore(flags.db);
  const before = await store.runCount();
  const removed = await store.prune(cutoff);
  const after = await store.runCount();
  await store.close();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ cutoff, removed, before, after }, null, 2)}\n`);
    return EXIT.OK;
  }

  heading('history prune');
  line(`  removed ${removed} run(s) older than ${cutoff.slice(0, 10)} · ${after} remain`);
  line(
    style.dim(
      `  Scoring reads a rolling window, so older runs were already ignored — this reclaims space.`,
    ),
  );
  return EXIT.OK;
}
