/**
 * Map a merged Playwright JSON report onto history records.
 *
 * This is a runner adapter for suites that cannot install the atest reporter —
 * most importantly, a suite whose test job is owned by a shared CI template
 * that only uploads `blob-report/` and the merged JSON. Playwright's own
 * `--reporter=json` output is then the ONLY channel through which run data
 * escapes, and it carries more than it first appears to.
 *
 * Pure and synchronous, over structural interfaces: the whole mapping is
 * unit-testable against a plain object, with no store and no filesystem.
 * `ingestPlaywrightJson` does the I/O and hands the result in.
 *
 * ── What this path gives up, and what it does not ───────────────────────────
 * No evidence bundle: no ARIA snapshot, no locator candidates, no network
 * ledger, no console capture. Healing therefore still requires the reporter.
 *
 * What it does NOT give up is identity. Every field below is read from the
 * report rather than invented, because a history row that cannot be joined to
 * the rows around it is worse than no row at all — it looks like data and
 * scores like noise.
 */

import { createHash } from 'node:crypto';

import { classify } from '../taxonomy/classify.js';
import { joinErrors, parsePlaywrightError } from '../taxonomy/parse-error.js';
import type { FailureKind } from '../taxonomy/kinds.js';
import { ATEST_VERSION } from '../version.js';
import { RUN_SCHEMA_VERSION, type AttemptRecord, type Outcome, type RunRecord } from './types.js';

// ── The subset of Playwright's JSON report this adapter reads ───────────────
// Structural and fully optional: a report from an older or newer Playwright
// must degrade field by field, never throw. Verified against 1.61 output.

export interface JsonError {
  readonly message?: string;
  readonly stack?: string;
}

export interface JsonResult {
  readonly status?: string;
  readonly duration?: number;
  readonly retry?: number;
  readonly workerIndex?: number;
  /** ISO timestamp of the attempt. The reason history can be back-filled. */
  readonly startTime?: string;
  readonly errors?: readonly JsonError[];
}

export interface JsonTest {
  readonly projectName?: string;
  readonly timeout?: number;
  readonly results?: readonly JsonResult[];
}

export interface JsonSpec {
  /** Playwright's stable test id. Present since 1.38; see `attemptTestId`. */
  readonly id?: string;
  readonly title?: string;
  readonly file?: string;
  readonly line?: number;
  readonly tags?: readonly string[];
  readonly tests?: readonly JsonTest[];
}

export interface JsonSuite {
  readonly title?: string;
  readonly file?: string;
  readonly specs?: readonly JsonSpec[];
  readonly suites?: readonly JsonSuite[];
}

export interface JsonReport {
  readonly config?: {
    readonly version?: string;
    readonly workers?: number;
    readonly shard?: { readonly current?: number; readonly total?: number } | null;
    readonly metadata?: {
      readonly actualWorkers?: number;
      readonly ci?: {
        readonly commitHash?: string;
        readonly branch?: string;
        readonly buildHref?: string;
      };
    };
  };
  readonly suites?: readonly JsonSuite[];
}

/**
 * Run-level facts the report cannot supply, from the environment doing the
 * ingest. The report always wins where it has an answer — it describes the run
 * being ingested, whereas the environment describes whoever is ingesting it,
 * and those differ whenever history is back-filled from an archived artifact.
 */
export interface RunIdentity {
  readonly commit: string | null;
  readonly branch: string | null;
  readonly appEnv: string | null;
  readonly ci: boolean;
}

export interface MappedReport {
  readonly run: RunRecord;
  /**
   * Attempts that collided on the store's primary key and had to be collapsed.
   * Reported rather than swallowed — see `collapseDuplicates`.
   */
  readonly collapsed: readonly string[];
}

const RUN_ID_PREFIX = 'pwjson_';
const RUN_ID_LENGTH = 12;

function toOutcome(status: string | undefined): Outcome {
  if (status === 'passed') return 'passed';
  if (status === 'timedOut') return 'timedOut';
  if (status === 'skipped') return 'skipped';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

/**
 * Playwright's stable test id, which the JSON reporter emits as `spec.id` and
 * which is exactly what `AttemptRecord.testId` is documented to hold. It is
 * unique per (test, project) and survives a title rename.
 *
 * Taking it from the report rather than composing one is the single most
 * important line in this file. A composed `file::title` id is a DIFFERENT ID
 * SPACE from the reporter's, so history gathered on this path would never join
 * to history gathered after the reporter is installed: every test would look
 * new, every score would reset to "insufficient data", and the old rows would
 * linger as phantom tests forever. The adoption sequence that starts on JSON
 * and later adds the reporter is the normal one, so that migration cliff has to
 * not exist.
 *
 * The fallback exists only for a report old enough to lack `spec.id`. It
 * includes the title path, so two same-titled tests in different `describe`
 * blocks stay distinct — but it is still a separate id space, and the caller is
 * told about it.
 */
function attemptTestId(spec: JsonSpec, file: string, titlePath: readonly string[]): string {
  if (typeof spec.id === 'string' && spec.id !== '') return spec.id;
  return [file, ...titlePath, spec.title ?? ''].join('::');
}

/**
 * Classify a failing attempt from its error text.
 *
 * The classifier reads `message + stack` for nearly every rule, so this path
 * recovers most of the taxonomy without an evidence bundle — including `infra`,
 * which matters more than it looks: doc 06 requires infra attempts to be
 * excluded from flake statistics, and a hard-coded `'unknown'` would have let
 * every browser crash count as evidence of flakiness.
 *
 * One honest gap. `contract.app-error` needs captured console output, which
 * only the reporter has. Without it, an application exception whose sole trace
 * was a console message classifies as whatever assertion failed downstream of
 * it — typically `assertion_visibility`. That over-weights a real bug as flake
 * rather than hiding it, which is the safer direction to be wrong in, but it is
 * a reason to prefer the reporter once evidence egress exists.
 */
function classifyAttempt(result: JsonResult, timeoutMs: number): FailureKind {
  const { message, stack } = joinErrors(result.errors);
  if (message === '' && stack === '') return 'unknown';

  const parsed = parsePlaywrightError(message, stack);
  const duration = result.duration ?? 0;

  return classify({
    message,
    stack,
    matcher: parsed.matcher,
    timedOut: parsed.timedOut || result.status === 'timedOut',
    // The reporter's sidecars. Absent here by construction, not by accident.
    consoleErrors: [],
    failedRequests: [],
    budgetUsedRatio: timeoutMs > 0 ? duration / timeoutMs : 0,
  }).kind;
}

function collectAttempts(
  suites: readonly JsonSuite[] | undefined,
  file: string,
  titlePath: readonly string[],
): AttemptRecord[] {
  const out: AttemptRecord[] = [];

  for (const suite of suites ?? []) {
    const suiteFile = suite.file ?? file;
    const path =
      suite.title !== undefined && suite.title !== '' ? [...titlePath, suite.title] : titlePath;

    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? suiteFile;
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const outcome = toOutcome(result.status);
          const failing = outcome === 'failed' || outcome === 'timedOut';
          out.push({
            testId: attemptTestId(spec, specFile, path),
            title: spec.title ?? '',
            titlePath: path,
            file: specFile,
            line: spec.line ?? 0,
            project: test.projectName ?? 'default',
            tags: spec.tags ?? [],
            retry: result.retry ?? 0,
            outcome,
            failureKind: failing ? classifyAttempt(result, test.timeout ?? 0) : null,
            durationMs: result.duration ?? 0,
            workerIndex: result.workerIndex ?? 0,
            // A merged report has already folded its shards together and does
            // not record which one an attempt came from.
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

/** Ordered so a duplicate can never mask the worse outcome. */
const SEVERITY: Readonly<Record<Outcome, number>> = {
  skipped: 0,
  passed: 1,
  interrupted: 2,
  timedOut: 3,
  failed: 4,
};

interface CollapseResult {
  readonly kept: readonly AttemptRecord[];
  readonly collapsed: readonly string[];
}

/**
 * Collapse attempts that share the store's primary key
 * `(run_id, test_id, project, retry)`.
 *
 * With a real `spec.id` this should never fire — it did before, only because
 * the composed id mapped two genuinely distinct setup tests onto one key. It
 * stays as a safety net because the failure mode it guards is severe out of all
 * proportion to its cause: `store.ingest` is a single transaction, so ONE
 * duplicate row used to roll back the entire run. On a real 8-shard acceptance
 * report that cost all 120 attempts, and the only symptom was a single
 * "could not be stored" warning — history silently never accumulated while
 * every CI job reported success.
 *
 * Collisions are returned, not swallowed. A silent dedupe here would be the
 * same class of bug one level down: quietly discarding evidence and looking
 * healthy while doing it.
 */
function collapseDuplicates(attempts: readonly AttemptRecord[]): CollapseResult {
  const byKey = new Map<string, AttemptRecord>();
  const collapsed: string[] = [];

  for (const attempt of attempts) {
    const key = `${attempt.testId}\x00${attempt.project}\x00${attempt.retry}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, attempt);
      continue;
    }
    // Keep the more severe outcome. A duplicate that passed must never mask
    // one that failed — that is precisely the instability scoring exists for.
    const keep = SEVERITY[attempt.outcome] > SEVERITY[existing.outcome] ? attempt : existing;
    byKey.set(key, keep);
    collapsed.push(`${attempt.title} [${attempt.project}] retry ${attempt.retry}`);
  }

  return { kept: [...byKey.values()], collapsed };
}

/**
 * A run id derived from the report, never from the clock.
 *
 * `store.ingest` promises idempotency — "CI re-runs, shard merges, and repeated
 * artifact ingestion all replay the same run id" — and enforces it by deleting
 * a run's attempts before reinserting them. A `Date.now()` id opts out of that
 * guarantee silently: re-ingesting one artifact twice (a re-run of the analyze
 * job, a replay of an archived report) writes both copies and double-counts
 * every attempt, which corrupts every score derived from them.
 *
 * The CI build URL is the natural key where the report carries one. Otherwise
 * digest the attempt tuples, which is stable for a given report and distinct
 * across runs because attempt start times are millisecond-precision.
 */
function deriveRunId(report: JsonReport, attempts: readonly AttemptRecord[]): string {
  const buildHref = report.config?.metadata?.ci?.buildHref;
  const seed =
    buildHref !== undefined && buildHref !== ''
      ? buildHref
      : attempts
          .map(a => `${a.testId} ${a.project} ${a.retry} ${a.durationMs}`)
          .sort()
          .join('\n');

  const digest = createHash('sha256').update(seed).digest('hex');
  return `${RUN_ID_PREFIX}${digest.slice(0, RUN_ID_LENGTH)}`;
}

/**
 * The wall-clock window the run actually occupied.
 *
 * Flake scoring weights attempts by recency (`halfLifeDays`), so the timestamp
 * has to be when the test RAN, not when somebody ingested the file. Using
 * ingest time would make a replayed six-month-old archive weigh as heavily as
 * this morning's run — and back-filling history from archived artifacts is one
 * of the reasons this adapter exists.
 */
function runWindow(
  report: JsonReport,
  now: () => number,
): { readonly startedAt: string; readonly finishedAt: string | null } {
  const spans: { start: number; end: number }[] = [];

  const walk = (suites: readonly JsonSuite[] | undefined): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? []) {
            if (result.startTime === undefined) continue;
            const start = Date.parse(result.startTime);
            if (Number.isNaN(start)) continue;
            spans.push({ start, end: start + (result.duration ?? 0) });
          }
        }
      }
      walk(suite.suites);
    }
  };
  walk(report.suites);

  if (spans.length === 0) {
    const fallback = new Date(now()).toISOString();
    return { startedAt: fallback, finishedAt: fallback };
  }

  return {
    startedAt: new Date(Math.min(...spans.map(s => s.start))).toISOString(),
    finishedAt: new Date(Math.max(...spans.map(s => s.end))).toISOString(),
  };
}

export interface MapReportOptions {
  readonly identity: RunIdentity;
  /** Injectable clock, for the no-timestamps fallback. Tests pin it. */
  readonly now?: () => number;
}

export function mapPlaywrightReport(report: JsonReport, options: MapReportOptions): MappedReport {
  const { identity } = options;
  const now = options.now ?? Date.now;

  const { kept, collapsed } = collapseDuplicates(collectAttempts(report.suites, '', []));
  const { startedAt, finishedAt } = runWindow(report, now);

  const ci = report.config?.metadata?.ci;
  const shard = report.config?.shard;

  const run: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: deriveRunId(report, kept),
    startedAt,
    finishedAt,
    // Report first, environment second. Same-commit variance is a documented
    // flake signal and it needs the commit the tests actually ran against, not
    // whatever is checked out in the job doing the ingest.
    commit: ci?.commitHash ?? identity.commit,
    branch: ci?.branch ?? identity.branch,
    appEnv: identity.appEnv,
    ci: ci !== undefined || identity.ci,
    // `actualWorkers` is what the run really used; `workers` is what was asked
    // for, and the two differ under sharding.
    workers: report.config?.metadata?.actualWorkers ?? report.config?.workers ?? 0,
    shard:
      shard !== null && shard !== undefined && shard.current !== undefined && shard.total !== undefined
        ? { current: shard.current, total: shard.total }
        : null,
    atestVersion: ATEST_VERSION,
    playwrightVersion: report.config?.version ?? null,
    attempts: kept,
  };

  return { run, collapsed };
}
