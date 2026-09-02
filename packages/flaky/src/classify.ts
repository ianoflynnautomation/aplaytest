/**
 * Root-cause classification for flaky tests.
 *
 * Rules over measured features, evaluated by priority, first match wins. Each
 * verdict carries the evidence that produced it, because a prescription a
 * human cannot check is a prescription a human will not follow.
 *
 * The highest-priority rule is `genuine-regression`, and it is the one that
 * matters most: a real regression misfiled as flake gets retried, quarantined,
 * and shipped. The engine must be able to say "this is not flaky" and mean it.
 */

import type { FlakeFeatures } from './features.js';
import type { FlakeScore } from './score.js';

export const FLAKE_CLASSES = [
  'genuine-regression',
  'consistently-failing',
  'test-pollution',
  'resource-contention',
  'network',
  'animation',
  'timing',
  'data-dependency',
  'environment',
  'unclassified',
] as const;

export type FlakeClass = (typeof FLAKE_CLASSES)[number];

/** What to do about it. Deliberately not "retry" for most classes. */
export type Prescription =
  | 'investigate-regression'
  | 'fix-or-delete'
  | 'isolate'
  | 'reduce-parallelism-or-harden'
  | 'harden-wait-or-fix-app'
  | 'wait-for-stable'
  | 'web-first-assertion'
  | 'narrow-the-view'
  | 'browser-specific-investigation'
  | 'needs-more-data';

export interface Classification {
  readonly class: FlakeClass;
  readonly prescription: Prescription;
  readonly confidence: 'low' | 'medium' | 'high';
  /** Measured statements that justify the verdict. */
  readonly evidence: readonly string[];
  /** Whether retrying this class masks the problem instead of surviving it. */
  readonly retryable: boolean;
}

interface Rule {
  readonly class: FlakeClass;
  readonly priority: number;
  readonly prescription: Prescription;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly retryable: boolean;
  evaluate(features: FlakeFeatures, score: FlakeScore): string[] | null;
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

function kindShare(features: FlakeFeatures, kinds: readonly string[]): number {
  if (features.totalFailures === 0) return 0;
  const matched = kinds.reduce((sum, kind) => sum + (features.failureKinds[kind] ?? 0), 0);
  return matched / features.totalFailures;
}

const RULES: readonly Rule[] = [
  {
    class: 'genuine-regression',
    priority: 100,
    prescription: 'investigate-regression',
    confidence: 'high',
    retryable: false,
    evaluate: (features, score) => {
      if (!features.commitBoundary) return null;
      if (score.transitionDensity >= 0.2) return null;
      if (features.retryFlips > 0) return null;
      return [
        `failures begin at a commit boundary and persist (${features.commitsObserved} commits observed)`,
        `outcome flips are rare (density ${score.transitionDensity.toFixed(2)}) — this is a state change, not noise`,
        `no failed-then-passed retry within a single run`,
      ];
    },
  },
  {
    // Checked ahead of every flake class. A test that always fails is not
    // flaky in any sense, and handing it a flake prescription ("add a
    // web-first assertion", "retry helps: yes") sends someone tuning waits on
    // a test that is simply broken.
    class: 'consistently-failing',
    priority: 95,
    prescription: 'fix-or-delete',
    confidence: 'high',
    retryable: false,
    evaluate: features => {
      if (features.totalAttempts === 0) return null;
      if (features.totalFailures !== features.totalAttempts) return null;
      return [
        `every one of ${features.totalAttempts} attempts failed — this is deterministic, not flaky`,
        'fix it or delete it; quarantine is not the answer for a test that never passes',
      ];
    },
  },
  {
    class: 'test-pollution',
    priority: 90,
    prescription: 'isolate',
    confidence: 'high',
    retryable: false,
    evaluate: features => {
      if (features.coScheduleLift <= 2.5 || features.coScheduleSuspects.length === 0) return null;
      return [
        `failure is ${features.coScheduleLift.toFixed(1)}× more likely when co-scheduled with another test`,
        `suspects: ${features.coScheduleSuspects.join(', ')}`,
      ];
    },
  },
  {
    class: 'resource-contention',
    priority: 80,
    prescription: 'reduce-parallelism-or-harden',
    confidence: 'high',
    retryable: true,
    evaluate: features => {
      // Gate on the rate DIFFERENCE, not the correlation: with a rare outcome
      // the correlation ceiling collapses, and a test that never fails at one
      // worker but fails a third of the time at eight scores only ~0.41.
      if (!features.workerCountVaried) return null;
      if (features.workerLoadDelta <= 0.15) return null;
      if (features.projectConcentration < 0.8) return null;
      return [
        `failures are ${percent(features.workerLoadDelta)} more likely above the median worker count`,
        `${percent(features.projectConcentration)} of failures land in a single project`,
        `worker/failure correlation r = ${features.workerCorrelation.toFixed(2)}`,
      ];
    },
  },
  {
    class: 'network',
    priority: 70,
    prescription: 'harden-wait-or-fix-app',
    confidence: 'medium',
    retryable: true,
    evaluate: features => {
      const share = kindShare(features, ['network_error', 'navigation_failure']);
      if (share < 0.3) return null;
      return [`${percent(share)} of failures are network or navigation errors`];
    },
  },
  {
    class: 'animation',
    priority: 60,
    prescription: 'wait-for-stable',
    confidence: 'medium',
    retryable: true,
    evaluate: features => {
      const share = kindShare(features, ['locator_not_actionable']);
      if (share < 0.5) return null;
      return [
        `${percent(share)} of failures are "element found but not actionable" — intercepted, unstable, or mid-transition`,
      ];
    },
  },
  {
    class: 'timing',
    priority: 50,
    prescription: 'web-first-assertion',
    confidence: 'medium',
    retryable: true,
    evaluate: features => {
      const share = kindShare(features, ['assertion_visibility', 'locator_not_found']);
      if (share < 0.5) return null;
      if (features.durationRatio < 1.5) return null;
      return [
        `${percent(share)} of failures are waiting for something that never appeared`,
        `failing runs take ${features.durationRatio.toFixed(1)}× as long as passing ones — the test waits, then gives up`,
      ];
    },
  },
  {
    class: 'data-dependency',
    priority: 40,
    prescription: 'narrow-the-view',
    confidence: 'medium',
    retryable: false,
    evaluate: features => {
      const share = kindShare(features, ['assertion_value_mismatch']);
      if (share < 0.5) return null;
      return [
        `${percent(share)} of failures are value mismatches — the data moved, not the timing`,
        `retrying will not help; narrow the view (search or filter) before asserting`,
      ];
    },
  },
  {
    class: 'environment',
    priority: 30,
    prescription: 'browser-specific-investigation',
    confidence: 'medium',
    retryable: true,
    evaluate: features => {
      if (features.projectConcentration < 0.95) return null;
      if (features.totalFailures < 3) return null;
      return [
        `every failure is confined to one project (${percent(features.projectConcentration)}) — browser or device specific`,
      ];
    },
  },
];

/**
 * Classify a scored test into a flake class.
 *
 * Priority-ordered rules; `genuine-regression` and `consistently-failing`
 * outrank every flake class, because misfiling a broken test as flaky gets
 * it retried and quarantined instead of fixed.
 *
 * @param features - Measurements from `extractFeatures`.
 * @param score - Result of `scoreTest`.
 * @returns A class, a prescription, the evidence strings that fired, and
 *   whether retries would help.
 *
 * @example
 * ```ts
 * const score = scoreTest(attempts);
 * const features = extractFeatures(attempts, allAttempts);
 * const verdict = classifyFlake(features, score);
 * // verdict.class === 'resource-contention'
 * ```
 */
export function classifyFlake(features: FlakeFeatures, score: FlakeScore): Classification {
  if (score.insufficientData) {
    return {
      class: 'unclassified',
      prescription: 'needs-more-data',
      confidence: 'low',
      evidence: [`only ${score.rawN} conclusive attempts recorded — not enough to judge`],
      retryable: false,
    };
  }

  for (const rule of [...RULES].sort((a, b) => b.priority - a.priority)) {
    const evidence = rule.evaluate(features, score);
    if (evidence !== null && evidence.length > 0) {
      return {
        class: rule.class,
        prescription: rule.prescription,
        confidence: rule.confidence,
        evidence,
        retryable: rule.retryable,
      };
    }
  }

  return {
    class: 'unclassified',
    prescription: 'needs-more-data',
    confidence: 'low',
    evidence: [
      `flake score ${score.score.toFixed(2)} over ${score.rawN} attempts, but no rule matched`,
      'bisect to gather a decisive signal',
    ],
    retryable: false,
  };
}

/**
 * Retry only what retrying can actually survive.
 *
 * Blanket retries hide real bugs, which is the failure mode a flaky-test tool
 * is most likely to cause. A regression, a polluted test, or a data-dependent
 * assertion fails just as reliably the second time — retrying them only
 * converts a red build into a slow red build, or worse, a false green.
 */
export function shouldRetry(classification: Classification): boolean {
  return classification.retryable;
}
