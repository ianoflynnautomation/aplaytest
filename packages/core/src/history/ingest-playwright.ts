/**
 * Ingest a Playwright JSON report into the history store.
 *
 * The I/O half of the adapter: read, parse, hand to `mapPlaywrightReport`,
 * store. All of the mapping decisions — identity, timestamps, classification —
 * live in `playwright-report.ts` and are unit-tested without a database.
 *
 * Like `ingestDirectory`, this NEVER throws. A bad report is reported through
 * `IngestResult.skipped` so that one unreadable artifact among many cannot cost
 * the others, and so a CI analyze job degrades to "nothing ingested" rather
 * than to a red build.
 */

import { readFile } from 'node:fs/promises';

import { mapPlaywrightReport, type JsonReport, type RunIdentity } from './playwright-report.js';
import type { HistoryStore } from './store.js';
import type { IngestResult } from './ingest.js';

export interface IngestPlaywrightJsonOptions {
  /**
   * Run-level facts the report may not carry. Defaults read the GitHub Actions
   * environment, matching the reporter's own convention so both paths label a
   * run the same way. The report still wins wherever it has an answer.
   */
  readonly identity?: Partial<RunIdentity>;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The same environment variables the reporter reads. Kept identical on purpose:
 * a run ingested through the JSON path and one written by the reporter should
 * be labelled by the same rules, or comparing them later means comparing the
 * conventions of two different code paths.
 */
function identityFromEnv(overrides: Partial<RunIdentity> | undefined): RunIdentity {
  const env = process.env;
  return {
    commit: overrides?.commit ?? env['GITHUB_SHA'] ?? null,
    branch: overrides?.branch ?? env['GITHUB_REF_NAME'] ?? null,
    appEnv: overrides?.appEnv ?? env['APP_ENV'] ?? null,
    ci: overrides?.ci ?? (env['CI'] === 'true' || env['CI'] === '1'),
  };
}

function failed(path: string, reason: string): IngestResult {
  return { filesRead: 1, runsIngested: 0, attemptsIngested: 0, skipped: [{ file: path, reason }] };
}

export async function ingestPlaywrightJson(
  store: HistoryStore,
  path: string,
  options: IngestPlaywrightJsonOptions = {},
): Promise<IngestResult> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return { filesRead: 0, runsIngested: 0, attemptsIngested: 0, skipped: [{ file: path, reason: 'unreadable' }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failed(path, 'not valid JSON');
  }

  if (!isRecord(parsed)) return failed(path, 'not a Playwright JSON report');

  const { run, collapsed } = mapPlaywrightReport(parsed as JsonReport, {
    identity: identityFromEnv(options.identity),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  try {
    await store.ingest(run);
  } catch (error) {
    return failed(
      path,
      `could not be stored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    filesRead: 1,
    runsIngested: 1,
    attemptsIngested: run.attempts.length,
    // Surfaced through the channel the CLI already prints as warnings. A
    // collapsed duplicate is a real loss of an attempt and has to be visible;
    // it is not a reason to reject the other hundred-odd rows.
    skipped: collapsed.map(what => ({
      file: path,
      reason: `duplicate attempt collapsed: ${what}`,
    })),
  };
}
