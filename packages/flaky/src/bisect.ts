/**
 * Bisect: turn a hypothesis into a fact.
 *
 * Classification reads history and produces a likely cause. Bisect re-runs the
 * test under CONTROLLED PERTURBATIONS and measures what actually changes the
 * outcome. That difference matters: "this looks load-dependent" is a hunch
 * someone can argue with, whereas "20/20 at one worker, 11/20 at eight" ends
 * the argument.
 *
 * Deliberately no model. The whole value here is that the numbers came from
 * running the test.
 */

import { runPlaywright, type PlaywrightRunOptions } from '@atest/runner-playwright';

import type { FlakeClass } from './classify.js';

export type BisectDimension = 'workers' | 'isolation';

export interface BisectProbe {
  readonly dimension: BisectDimension;
  /** Human-readable setting, e.g. "workers=8" or "alone". */
  readonly setting: string;
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly durationMs: number;
  readonly inconclusive: boolean;
}

export interface BisectVerdict {
  readonly class: FlakeClass | 'not-reproduced';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly mechanism: string;
  readonly evidence: readonly string[];
  readonly recommendation: string;
}

export interface BisectResult {
  readonly title: string;
  readonly file: string;
  readonly probes: readonly BisectProbe[];
  readonly verdict: BisectVerdict;
}

export interface BisectOptions {
  readonly cwd: string;
  readonly file: string;
  readonly title: string;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  /** Repetitions per probe. Higher is slower and more decisive. */
  readonly repeat: number;
  readonly workerLevels: readonly number[];
  readonly dimensions: readonly BisectDimension[];
  readonly timeoutMs?: number | undefined;
  onProbe?: ((probe: BisectProbe) => void) | undefined;
}

export const DEFAULT_BISECT_OPTIONS = {
  repeat: 10,
  workerLevels: [1, 4, 8],
  dimensions: ['workers', 'isolation'] as const,
};

const failureRate = (probe: BisectProbe): number =>
  probe.total === 0 ? 0 : probe.failed / probe.total;

async function probe(
  dimension: BisectDimension,
  setting: string,
  options: BisectOptions,
  run: Partial<PlaywrightRunOptions>,
): Promise<BisectProbe> {
  const result = await runPlaywright({
    cwd: options.cwd,
    config: options.config,
    file: options.file,
    grepTitle: options.title,
    project: options.project,
    repeatEach: options.repeat,
    timeoutMs: options.timeoutMs,
    ...run,
  });

  // Always attribute to the TARGET test, never to the run as a whole. The
  // co-scheduling probe deliberately runs neighbours too, and aggregate stats
  // would charge their failures to the test under examination — which reads
  // as "passes alone, fails together" and manufactures a test-pollution
  // verdict out of an unrelated broken test in the same file.
  const target = result.specs.filter(spec => spec.title === options.title);
  const passed = target.reduce((sum, spec) => sum + spec.passed, 0);
  const failed = target.reduce((sum, spec) => sum + spec.failed, 0);
  const total = passed + failed;

  return {
    dimension,
    setting,
    passed,
    failed,
    total,
    durationMs: result.durationMs,
    // The target never ran: a wrong title, a filtered project, a broken
    // config. Silence about the target is not evidence of health.
    inconclusive: result.inconclusive || total === 0,
  };
}

/**
 * Run the probes. `isolation` compares the test alone against the whole file,
 * which is the cheapest available proxy for co-scheduling pressure without
 * running the entire suite for every level.
 */
export async function bisect(options: BisectOptions): Promise<BisectResult> {
  const probes: BisectProbe[] = [];

  const record = (p: BisectProbe): void => {
    probes.push(p);
    options.onProbe?.(p);
  };

  if (options.dimensions.includes('workers')) {
    for (const workers of options.workerLevels) {
      record(await probe('workers', `workers=${workers}`, options, { workers }));
    }
  }

  if (options.dimensions.includes('isolation')) {
    // Alone: only this test, single worker — no neighbour can interfere.
    record(await probe('isolation', 'alone', options, { workers: 1 }));
    // File: every test in the file, full parallelism.
    record(
      await probe('isolation', 'whole file', options, {
        grepTitle: undefined,
        workers: Math.max(...options.workerLevels),
      }),
    );
  }

  return { title: options.title, file: options.file, probes, verdict: interpret(probes) };
}

/**
 * Read the probes.
 *
 * Rules, not judgement — the same measurements must always produce the same
 * verdict, or bisect is just a slower way of guessing.
 */
export function interpret(probes: readonly BisectProbe[]): BisectVerdict {
  const usable = probes.filter(p => !p.inconclusive && p.total > 0);

  if (usable.length === 0) {
    return {
      class: 'unclassified',
      confidence: 'low',
      mechanism: 'No probe produced a result.',
      evidence: ['every probe was inconclusive — check the file path, title, and project'],
      recommendation: 'Verify the test runs at all: npx playwright test <file> -g "<title>"',
    };
  }

  const totalFailures = usable.reduce((sum, p) => sum + p.failed, 0);
  if (totalFailures === 0) {
    // Not reproducing is a real, reportable outcome. Reaching for a cause
    // anyway is how a bisect tool starts inventing them.
    return {
      class: 'not-reproduced',
      confidence: 'high',
      mechanism: 'The test passed under every perturbation tried.',
      evidence: usable.map(p => `${p.setting}: ${p.passed}/${p.total} passed`),
      recommendation:
        'Raise --repeat, add worker levels, or bisect against the full suite — the trigger is ' +
        'outside the dimensions probed.',
    };
  }

  const workerProbes = usable.filter(p => p.dimension === 'workers');
  const evidence: string[] = usable.map(
    p => `${p.setting}: ${p.passed}/${p.total} passed${p.failed > 0 ? ` (${p.failed} failed)` : ''}`,
  );

  if (workerProbes.length >= 2) {
    const sorted = [...workerProbes].sort(
      (a, b) => Number(a.setting.split('=')[1]) - Number(b.setting.split('=')[1]),
    );
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];

    if (lowest !== undefined && highest !== undefined) {
      const delta = failureRate(highest) - failureRate(lowest);
      const monotonic = sorted.every(
        (p, i) => i === 0 || failureRate(p) >= failureRate(sorted[i - 1] ?? p) - 0.01,
      );

      if (delta >= 0.2) {
        return {
          class: 'resource-contention',
          confidence: monotonic ? 'high' : 'medium',
          mechanism:
            'Failure probability rises with parallelism. The test is racing something that ' +
            'contention makes slower — most often a navigation or animation it does not wait for.',
          evidence: [
            ...evidence,
            `failure rate ${(failureRate(lowest) * 100).toFixed(0)}% → ` +
              `${(failureRate(highest) * 100).toFixed(0)}% across the worker range`,
            monotonic ? 'rate rises monotonically with worker count' : 'rate rises but not monotonically',
          ],
          recommendation:
            'Await the signal instead of the timeout — e.g. wait for the navigation response ' +
            'before asserting the URL. Healing is not applicable: the selector is correct.',
        };
      }
    }
  }

  const alone = usable.find(p => p.setting === 'alone');
  const wholeFile = usable.find(p => p.setting === 'whole file');
  if (alone !== undefined && wholeFile !== undefined) {
    const delta = failureRate(wholeFile) - failureRate(alone);
    if (delta >= 0.2) {
      return {
        class: 'test-pollution',
        confidence: 'high',
        mechanism:
          'The test passes alone and fails alongside its neighbours — shared state, not timing.',
        evidence: [
          ...evidence,
          `alone ${(failureRate(alone) * 100).toFixed(0)}% failures, ` +
            `with neighbours ${(failureRate(wholeFile) * 100).toFixed(0)}%`,
        ],
        recommendation:
          'Find the shared state: module-level caches, storage, seeded data mutated by a ' +
          'sibling test. Retrying will not help.',
      };
    }
  }

  // "Consistently failing" means it NEVER passes — not merely that each probe
  // saw at least one failure. Three failures in twenty is intermittent, and
  // calling that broken would send an ordinary flake to the wrong queue.
  const neverPasses = usable.every(p => failureRate(p) >= 0.95);
  if (neverPasses) {
    return {
      class: 'consistently-failing',
      confidence: 'high',
      mechanism: 'The test failed under every perturbation — it is broken, not flaky.',
      evidence,
      recommendation: 'Fix it or delete it. Quarantine is not the answer for a test that never passes.',
    };
  }

  return {
    class: 'unclassified',
    confidence: 'low',
    mechanism: 'Failures reproduced, but no dimension explained them.',
    evidence,
    recommendation:
      'Probe further: --repeat higher, more worker levels, or a different project. ' +
      'The trigger is real but outside what was measured.',
  };
}
