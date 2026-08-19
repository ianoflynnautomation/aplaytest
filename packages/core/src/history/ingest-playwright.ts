/**
 * Ingest a Playwright JSON report into the history store.
 *
 * API-only suites (and any project that already emits `--reporter=json`) can
 * feed flake scoring without installing the atest reporter. This is a runner
 * adapter: the same AttemptRecord shape, a coarser failure kind, no evidence
 * bundle. Healing still requires the reporter + capture fixtures.
 */

import { readFile } from 'node:fs/promises';

import { ATEST_VERSION } from '../version.js';
import { RUN_SCHEMA_VERSION, type AttemptRecord, type Outcome, type RunRecord } from './types.js';
import type { HistoryStore } from './store.js';
import type { IngestResult } from './ingest.js';

interface JsonSpec {
  title?: string;
  file?: string;
  line?: number;
  tags?: string[];
  tests?: {
    projectName?: string;
    results?: { status?: string; duration?: number; retry?: number; workerIndex?: number }[];
  }[];
}

interface JsonSuite {
  title?: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  config?: { version?: string; workers?: number };
  suites?: JsonSuite[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonReport(value: unknown): value is JsonReport {
  return isRecord(value);
}

function toOutcome(status: string | undefined): Outcome {
  if (status === 'passed') return 'passed';
  if (status === 'timedOut') return 'timedOut';
  if (status === 'skipped') return 'skipped';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

function collectAttempts(
  suites: readonly JsonSuite[] | undefined,
  file = '',
  titlePath: readonly string[] = [],
): AttemptRecord[] {
  const out: AttemptRecord[] = [];

  for (const suite of suites ?? []) {
    const suiteFile = suite.file ?? file;
    const path = suite.title !== undefined && suite.title !== '' ? [...titlePath, suite.title] : titlePath;

    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? suiteFile;
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const outcome = toOutcome(result.status);
          out.push({
            testId: `${specFile}::${spec.title ?? ''}`,
            title: spec.title ?? '',
            titlePath: path,
            file: specFile,
            line: spec.line ?? 0,
            project: test.projectName ?? 'default',
            tags: spec.tags ?? [],
            retry: result.retry ?? 0,
            outcome,
            failureKind: outcome === 'failed' || outcome === 'timedOut' ? 'unknown' : null,
            durationMs: result.duration ?? 0,
            workerIndex: result.workerIndex ?? 0,
            shard: null,
            traceId: null,
            evidenceId: null,
            coScheduled: [],
            routes: [],
          });
        }
      }
    }

    out.push(...collectAttempts(suite.suites, suiteFile, path));
  }

  return out;
}

export async function ingestPlaywrightJson(
  store: HistoryStore,
  path: string,
): Promise<IngestResult> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return {
      filesRead: 0,
      runsIngested: 0,
      attemptsIngested: 0,
      skipped: [{ file: path, reason: 'unreadable' }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      filesRead: 1,
      runsIngested: 0,
      attemptsIngested: 0,
      skipped: [{ file: path, reason: 'not valid JSON' }],
    };
  }

  if (!isJsonReport(parsed)) {
    return {
      filesRead: 1,
      runsIngested: 0,
      attemptsIngested: 0,
      skipped: [{ file: path, reason: 'not a Playwright JSON report' }],
    };
  }

  const attempts = collectAttempts(parsed.suites);
  const run: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: `pwjson_${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    commit: null,
    branch: null,
    appEnv: null,
    ci: false,
    workers: parsed.config?.workers ?? 1,
    shard: null,
    atestVersion: ATEST_VERSION,
    playwrightVersion: parsed.config?.version ?? null,
    attempts,
  };

  try {
    await store.ingest(run);
  } catch (error) {
    return {
      filesRead: 1,
      runsIngested: 0,
      attemptsIngested: 0,
      skipped: [
        {
          file: path,
          reason: `could not be stored: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  return {
    filesRead: 1,
    runsIngested: 1,
    attemptsIngested: attempts.length,
    skipped: [],
  };
}
