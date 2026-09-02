/**
 * `aplaytest history` — inspect and trim the run history.
 *
 * The history store is the one piece of atest state that OUTLIVES a run.
 * Everything else is derived from the current run's artifacts and can be
 * thrown away; flake statistics cannot, because a single run tells you nothing
 * about whether a test is unstable. That makes it the one thing needing a
 * retention story and an answer to "what is actually in there?".
 *
 * Storage-agnostic by construction: `--db` names a target and `openHistoryStore`
 * decides what that is. A local file and an Azure container take the identical
 * code path here, which is the only way the two stay behaviourally the same.
 */

import { stat } from 'node:fs/promises';

import { ingestDirectory, ingestPlaywrightJson, type HistoryTarget } from '@aplaytest/core';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { openHistoryStore, resolveHistoryUrl, storeWarnings } from '../store.js';
import { heading, line, style, warn } from '../ui/output.js';

export interface HistoryFlags {
  readonly db: string | undefined;
  readonly runs: string;
  readonly json: boolean;
  /** Retention in days for `history prune`. */
  readonly keepDays?: string | undefined;
  /** Playwright `--reporter=json` file — API-only suites that have no atest reporter. */
  readonly playwrightJson?: string | undefined;
}

const DEFAULT_KEEP_DAYS = 90;

/**
 * `:memory:` is discarded when the process exits, so a history command run
 * against it always reports an empty store and always succeeds — the exact
 * shape of failure that made "flake scoring says insufficient data forever"
 * take weeks to diagnose. Refuse it here rather than lie.
 */
async function openPersistent(db: string | undefined) {
  const url = resolveHistoryUrl(db, process.env);
  const opened = await openHistoryStore(url);

  if (opened.target.kind === 'memory') {
    await opened.store.close();
    throw new UsageError(
      'history commands need a persistent store — pass --db, or set ATEST_HISTORY_URL.\n' +
        '    --db .atest/history.sqlite                  a local file\n' +
        '    --db azblob://<account>/atest-history       Azure Blob Storage\n' +
        '  The default (:memory:) is discarded when the process exits, which is why flake\n' +
        '  scoring reports "insufficient data" when it is left at the default in CI.',
    );
  }
  return opened;
}

/** Bytes on disk for a file store. A blob container has no single size to report. */
async function localSize(target: HistoryTarget): Promise<number | null> {
  if (target.kind !== 'sqlite') return null;
  return stat(target.path).then(
    s => s.size,
    () => null,
  );
}

export async function historyStats(flags: HistoryFlags): Promise<ExitCode> {
  const { store, target, description } = await openPersistent(flags.db);

  const [runs, keys, attempts] = await Promise.all([
    store.runCount(),
    store.testKeys(),
    store.attempts(),
  ]);
  const size = await localSize(target);
  // Read before close: closing releases the store, and a warning the user
  // never sees is the same as one that was never collected.
  const skipped = storeWarnings(store);
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
      `${JSON.stringify(
        {
          db: flags.db,
          driver: target.kind,
          sizeBytes: size,
          runs,
          tests: keys.length,
          attempts: attempts.length,
          oldest,
          newest,
          skipped,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  heading(`history · ${description}`);
  if (runs === 0 && size === null) {
    warn('  nothing has been ingested yet');
    return EXIT.OK;
  }

  const bytes = size === null ? '' : ` · ${(size / 1024).toFixed(0)} KB`;
  line(`  ${runs} runs · ${keys.length} tests · ${attempts.length} attempts${bytes}`);
  if (oldest !== null && newest !== null) line(`  ${oldest.slice(0, 10)} → ${newest.slice(0, 10)}`);

  // A blob store reads a bounded window, so "what is in there" and "what is
  // scoreable" are different numbers. Saying which one this is prevents the
  // reasonable conclusion that pruning has eaten the history.
  if (target.kind === 'azure-blob') {
    line(
      style.dim(
        `  Windowed read: ${String(target.windowDays ?? 90)} days. Older records may still exist in the container.`,
      ),
    );
  }

  if (skipped.length > 0) {
    line();
    warn(`${skipped.length} stored record(s) could not be read:`);
    for (const item of skipped.slice(0, 10)) line(style.dim(`  ${item.name} — ${item.reason}`));
  }

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
  const { store, description } = await openPersistent(flags.db);

  const result =
    flags.playwrightJson === undefined
      ? await ingestDirectory(store, flags.runs)
      : await ingestPlaywrightJson(store, flags.playwrightJson);
  const runs = await store.runCount();
  await store.close();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...result, totalRuns: runs }, null, 2)}\n`);
    return EXIT.OK;
  }

  heading(`history ingest · ${description}`);
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
  const days = Number.parseInt(flags.keepDays ?? String(DEFAULT_KEEP_DAYS), 10);
  if (!Number.isInteger(days) || days < 1) {
    throw new UsageError('--keep-days must be a positive integer.');
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { store, target, description } = await openPersistent(flags.db);
  const before = await store.runCount();
  const removed = await store.prune(cutoff);
  const after = await store.runCount();
  await store.close();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ cutoff, removed, before, after }, null, 2)}\n`);
    return EXIT.OK;
  }

  heading(`history prune · ${description}`);
  line(`  removed ${removed} run(s) older than ${cutoff.slice(0, 10)} · ${after} remain`);
  line(
    style.dim(
      `  Scoring reads a rolling window, so older runs were already ignored — this reclaims space.`,
    ),
  );
  if (target.kind === 'azure-blob') {
    line(
      style.dim(
        '  Blobs are partitioned by day, so this trims whole days. The account also has a\n' +
          '  lifecycle-management policy doing the same thing on a schedule; this is the\n' +
          '  manual lever, not the only one.',
      ),
    );
  }
  return EXIT.OK;
}
