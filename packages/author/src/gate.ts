/**
 * The falsifiability gate.
 *
 * A generated test earns trust in exactly one way: it passes reliably AND it
 * fails when the world breaks. Neither half is sufficient. A test that always
 * passes is indistinguishable from a test that asserts nothing, and that is
 * the failure mode LLM-authored tests actually exhibit — not syntax errors,
 * not hallucinated selectors, but confident, green, empty assertions.
 *
 * Wholly deterministic. No model is consulted here, and none can overrule it:
 * the model proposes a test, Playwright decides whether it means anything.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runPlaywright, type PlaywrightRunResult } from '@atest/runner-playwright';

import {
  MEANINGFUL_CLASSES,
  applyMutant,
  buildMutants,
  type MutantClass,
  type MutantName,
} from './mutants.js';

export type CheckName = 'stability' | 'falsifiability';

export interface GateCheck {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

export interface MutantOutcome {
  readonly name: MutantName;
  readonly class: MutantClass;
  /** True when the mutant made the test fail — the outcome we want. */
  readonly killed: boolean;
  readonly kills: string;
  /** Set when the run could not be interpreted; never counted as a kill. */
  readonly inconclusive: boolean;
  /** Why it was inconclusive. Present only then, so a CI log can say. */
  readonly detail?: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly checks: readonly GateCheck[];
  readonly mutants: readonly MutantOutcome[];
  readonly stabilityRuns: number;
  readonly stabilityPassed: number;
  /**
   * True when the gate could not decide: no data mutant killed the candidate,
   * and at least one data mutant run failed to execute it. Distinct from
   * `passed: false`, which is a verdict about the test.
   */
  readonly undecidable: boolean;
  /** One-line verdict suitable for a CLI or a PR comment. */
  readonly summary: string;
}

export interface GateOptions {
  readonly cwd: string;
  /** Spec file holding the candidate test. */
  readonly specFile: string;
  readonly testTitle: string;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  /** Consecutive passing runs required. */
  readonly stabilityRuns?: number | undefined;
  readonly apiPattern?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Restrict which mutants run; defaults to all of them. */
  readonly only?: readonly MutantName[] | undefined;
}

const BACKUP_SUFFIX = '.atest-gate-backup';
const DEFAULT_STABILITY_RUNS = 3;

interface Tally {
  readonly passed: number;
  readonly failed: number;
  readonly found: boolean;
}

/**
 * Total one test's outcomes across every entry that names it.
 *
 * `repeatEach: N` emits N SEPARATE outcome entries for the same title, each
 * with `passed: 1` — not one entry with `passed: N`. Taking the first match
 * caps stability at 1, so a three-run gate reports "passed 1/3" for a test
 * that passed three times and rejects every candidate as flaky. The gate
 * would have looked like it was working, and it would have been rejecting
 * good tests.
 *
 * Filtering by title also judges the CANDIDATE rather than the file: a spec
 * file usually holds neighbours, and aggregate counts would let a neighbour's
 * failure read as the candidate being killed.
 */
function tally(result: PlaywrightRunResult, title: string): Tally {
  const matching = result.specs.filter(s => s.title === title);
  if (matching.length === 0) return { passed: 0, failed: 0, found: false };
  return {
    passed: matching.reduce((sum, s) => sum + s.passed, 0),
    failed: matching.reduce((sum, s) => sum + s.failed, 0),
    found: true,
  };
}

/**
 * What one mutant run actually established.
 *
 * `killed` REQUIRES the candidate to have run and failed. The earlier version
 * fell back to the run's overall exit status when the test could not be found
 * in the results, which quietly turned every environmental failure into
 * evidence: a crashed globalSetup, a port already bound, a worker that died —
 * each produced a run with no matching spec and `ok: false`, and the gate
 * recorded "the mutant killed it".
 *
 * That is the worst possible direction for this particular error. A false kill
 * makes a test that asserts nothing look falsifiable, which is exactly the
 * thing the gate exists to catch.
 */
type MutantVerdict = 'killed' | 'survived' | 'inconclusive';

const ENVIRONMENT_FAILURE =
  /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_|browserType\.launch|Executable doesn't exist/i;

function environmentFailure(result: PlaywrightRunResult, title: string): string | null {
  if (ENVIRONMENT_FAILURE.test(result.stderr)) return 'the app or browser was not reachable';
  const matching = result.specs.filter(spec => spec.title === title);
  for (const spec of matching) {
    if (spec.error !== null && ENVIRONMENT_FAILURE.test(spec.error)) {
      return spec.error;
    }
  }
  return null;
}

function verdictOf(result: PlaywrightRunResult, title: string): MutantVerdict {
  if (result.inconclusive) return 'inconclusive';
  if (environmentFailure(result, title) !== null) return 'inconclusive';

  const counts = tally(result, title);
  // The candidate did not run. Says nothing about the mutant either way.
  if (!counts.found) return 'inconclusive';

  if (counts.failed > 0) return 'killed';
  if (counts.passed > 0) return 'survived';
  return 'inconclusive';
}

/** Why a mutant run could not be read — surfaced so it is diagnosable. */
function inconclusiveReason(result: PlaywrightRunResult, title: string): string {
  const env = environmentFailure(result, title);
  if (env !== null) return env;
  if (result.inconclusive) return 'the run output could not be parsed';
  if (!tally(result, title).found) {
    const ran = result.specs.length;
    return ran === 0
      ? 'no test ran at all — the suite failed before reaching it'
      : `the candidate was not among the ${ran} test(s) that ran`;
  }
  return 'the candidate neither passed nor failed';
}

/**
 * Prove a test asserts something, by mutating the world around it.
 *
 * The candidate must pass repeatedly **and** fail when a data mutant (empty
 * list, HTTP 500, field rename, …) is injected. A test that always passes is
 * indistinguishable from a test that asserts nothing — the failure mode
 * LLM-authored tests actually exhibit.
 *
 * Always restores the spec byte-for-byte, including on crash. No model is
 * consulted, and none can overrule the verdict.
 *
 * @param options - Spec, title, and Playwright spawn settings.
 * @returns `passed: true` only when stability holds and at least one
 *   meaningful mutant is killed. `undecidable` is distinct from a failing
 *   verdict — the mutant run never executed the test.
 * @throws Never swallows a restore failure: if the spec cannot be put back,
 *   the error propagates so a mutated file is not mistaken for source.
 *
 * @example
 * ```ts
 * const result = await falsifiabilityGate({
 *   cwd: process.cwd(),
 *   specFile: 'tests/gyms.spec.ts',
 *   testTitle: 'shows the gym name',
 * });
 * if (!result.passed) throw new Error(result.summary);
 * ```
 */
export async function falsifiabilityGate(options: GateOptions): Promise<GateResult> {
  const stabilityRuns = options.stabilityRuns ?? DEFAULT_STABILITY_RUNS;

  // `specFile` is interpreted relative to `cwd`, because that is how Playwright
  // will interpret it. Filesystem calls here run relative to process.cwd(), so
  // they need the resolved form — reading the spec with the unresolved path
  // fails with ENOENT whenever the gate is driven from anywhere but the target
  // repository's own directory, which is the normal case.
  const specPath = resolve(options.cwd, options.specFile);
  const backupPath = `${specPath}${BACKUP_SUFFIX}`;
  const original = await readFile(specPath, 'utf8');

  const baseRun = {
    cwd: options.cwd,
    file: options.specFile,
    grepTitle: options.testTitle,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  // ── Stability, before any mutation ─────────────────────────────────────
  // Runs first because a candidate that cannot pass unmutated makes every
  // mutant result meaningless: it would be "killed" by all of them, and a
  // broken test would score a perfect falsifiability result.
  const stability = await runPlaywright({ ...baseRun, repeatEach: stabilityRuns, workers: 1 });
  const counts = tally(stability, options.testTitle);
  const stabilityPassed = counts.found ? counts.passed : stability.ok ? stabilityRuns : 0;
  const stable = !stability.inconclusive && counts.failed === 0 && stabilityPassed >= stabilityRuns;

  const checks: GateCheck[] = [
    {
      name: 'stability',
      ok: stable,
      detail: stability.inconclusive
        ? 'run could not be interpreted'
        : `passed ${stabilityPassed}/${stabilityRuns}`,
    },
  ];

  if (!stable) {
    return {
      passed: false,
      checks,
      mutants: [],
      stabilityRuns,
      stabilityPassed,
      undecidable: true,
      summary: stability.inconclusive
        ? 'gate inconclusive — the candidate run could not be interpreted'
        : `candidate is not stable (${stabilityPassed}/${stabilityRuns}); mutants not run`,
    };
  }

  // ── Falsifiability ─────────────────────────────────────────────────────
  const all = buildMutants(options.apiPattern === undefined ? {} : { apiPattern: options.apiPattern });
  const mutants =
    options.only === undefined ? all : all.filter(m => options.only?.includes(m.name) === true);

  const outcomes: MutantOutcome[] = [];

  // The original is moved aside rather than held only in memory, so a crash
  // mid-gate leaves a recoverable file instead of a mutated spec.
  await rename(specPath, backupPath);
  try {
    for (const mutant of mutants) {
      await writeFile(specPath, applyMutant(original, mutant), 'utf8');
      // Mutants run sequentially and single-worker: concurrent route
      // interception across workers is a source of noise that would show up
      // as a flaky kill.
      const result = await runPlaywright({ ...baseRun, workers: 1 });
      const verdict = verdictOf(result, options.testTitle);
      outcomes.push({
        name: mutant.name,
        class: mutant.class,
        killed: verdict === 'killed',
        kills: mutant.kills,
        inconclusive: verdict === 'inconclusive',
        ...(verdict === 'inconclusive'
          ? {
              detail:
                `${inconclusiveReason(result, options.testTitle)}` +
                (result.stderr.trim() === '' ? '' : ` — ${result.stderr.trim().split('\n').slice(-3).join(' / ')}`),
            }
          : {}),
      });
    }
  } finally {
    // Atomic restore first: renaming the backup over the mutated file leaves
    // no window in which the spec is missing or half-written. Rewriting from
    // memory is the fallback for the cross-device case where rename fails.
    await rename(backupPath, specPath).catch(async () => {
      await writeFile(specPath, original, 'utf8');
      await unlink(backupPath).catch(() => undefined);
    });
  }

  return evaluateGate({
    checks,
    outcomes,
    stabilityRuns,
    stabilityPassed,
  });
}

export interface EvaluateInput {
  readonly checks: readonly GateCheck[];
  readonly outcomes: readonly MutantOutcome[];
  readonly stabilityRuns: number;
  readonly stabilityPassed: number;
}

/**
 * The verdict, as a pure function.
 *
 * Separated from the run loop so the decision that actually matters can be
 * tested without a browser. A gate whose rule is only reachable through a live
 * Playwright run is a gate whose rule nobody re-checks.
 */
export function evaluateGate(input: EvaluateInput): GateResult {
  const { checks, outcomes, stabilityRuns, stabilityPassed } = input;

  const killed = outcomes.filter(o => o.killed);
  // Liveness kills do not count towards the verdict. A test killed only by
  // http-500 has proved it loads a page, which is not what it claims to test.
  const meaningful = killed.filter(o => MEANINGFUL_CLASSES.has(o.class));
  const falsifiable = meaningful.length > 0;

  // A data mutant that could not be read leaves the evidence incomplete.
  //
  // It only matters when nothing was killed: a positive kill is proof on its
  // own, whatever happened to the other mutants. But rejecting a test as
  // "asserts nothing" on the strength of runs that never executed would blame
  // the test for the environment — so that case is reported as unknown rather
  // than as a verdict.
  const unreadable = outcomes.filter(o => o.inconclusive && MEANINGFUL_CLASSES.has(o.class));
  const undecidable = !falsifiable && unreadable.length > 0;

  const all = [
    ...checks,
    {
      name: 'falsifiability' as const,
      ok: falsifiable,
      detail: falsifiable
        ? `killed ${meaningful.length} data mutant(s): ${meaningful.map(m => m.name).join(', ')}`
        : undecidable
          ? `UNDECIDABLE — ${unreadable.length} data mutant(s) could not be read: ` +
            unreadable.map(u => `${u.name} (${u.detail ?? 'no detail'})`).join('; ')
          : killed.length > 0
            ? `killed only ${killed.map(k => k.name).join(', ')} — proves the page loads, not that anything is asserted about the data`
            : 'survived every mutant — the test asserts nothing meaningful',
    },
  ];

  const survived = outcomes.filter(o => !o.killed && MEANINGFUL_CLASSES.has(o.class));

  return {
    passed: all.every(c => c.ok),
    checks: all,
    mutants: outcomes,
    stabilityRuns,
    stabilityPassed,
    undecidable,
    summary: falsifiable
      ? `stable ${stabilityPassed}/${stabilityRuns} \u00b7 killed ${killed.length}/${outcomes.length} mutants (${killed.map(k => k.name).join(', ')})` +
        (survived.length > 0
          ? ` \u00b7 note: survived ${survived.map(s => s.name).join(', ')}`
          : '')
      : undecidable
        ? `UNDECIDABLE \u2014 ${unreadable.length} data mutant run(s) did not execute the test, so nothing was proved either way`
        : `REJECTED \u2014 stable, but survived every data mutant, so it asserts nothing about what the app returned`,
  };
}


