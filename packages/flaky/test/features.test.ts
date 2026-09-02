import { describe, expect, it } from 'vitest';

import { correlation, extractFeatures } from '../src/features.js';
import { attempt, series } from './helpers.js';
import type { HistoricalAttempt } from '@aplaytest/core';

describe('workerLoadDelta', () => {
  it('given a test never failing at 1 worker and failing a third of the time at 8 -> when extractFeatures runs -> then workerLoadDelta measures the dependency the correlation understates', { tags: ['@unit', '@flaky'] }, () => {
    // Never fails at 1 worker, fails a third of the time at 8. Unmistakable —
    // yet point-biserial r is only ~0.41 because the outcome is rare, which is
    // why the rule gates on this delta and not on the correlation.
    const attempts: HistoricalAttempt[] = [
      ...Array.from({ length: 12 }, (_, i) => attempt({ outcome: 'passed', daysAgo: 30 - i, workers: 1 }, i)),
      ...Array.from({ length: 18 }, (_, i) =>
        attempt({ outcome: i % 3 === 0 ? 'failed' : 'passed', daysAgo: 18 - i, workers: 8 }, i + 100),
      ),
    ];

    const features = extractFeatures(attempts);
    expect(features.workerLoadDelta).toBeCloseTo(0.333, 2);
    expect(features.workerCorrelation).toBeLessThan(0.5);
  });

  it('given a worker distribution skewed so the median sits at the busiest setting -> when extractFeatures runs -> then the load delta still registers rather than zeroing out', { tags: ['@unit', '@flaky'] }, () => {
    // REGRESSION GUARD. Splitting at the median used to zero this signal
    // silently: with 18 of 30 attempts at 8 workers the median IS 8, so
    // "above the median" was empty and a real load dependency read as 0.
    // Suites that mostly run at full parallelism and occasionally in isolation
    // have exactly this shape.
    const attempts: HistoricalAttempt[] = [
      ...Array.from({ length: 2 }, (_, i) => attempt({ outcome: 'passed', daysAgo: 30 - i, workers: 1 }, i)),
      ...Array.from({ length: 28 }, (_, i) =>
        attempt({ outcome: i % 2 === 0 ? 'failed' : 'passed', daysAgo: 28 - i, workers: 8 }, i + 100),
      ),
    ];

    const features = extractFeatures(attempts);
    expect(features.workerCountVaried).toBe(true);
    expect(features.workerLoadDelta).toBeGreaterThan(0.15);
  });

  it('given every attempt recorded at one worker count -> when extractFeatures runs -> then workerCountVaried is false and the load delta is 0', { tags: ['@unit', '@flaky'] }, () => {
    const features = extractFeatures(series('PPFPPFPPFPPFPPFP', { workers: 4 }));
    expect(features.workerCountVaried).toBe(false);
    expect(features.workerLoadDelta).toBe(0);
  });
});

describe('correlation', () => {
  it('given a series in which one variable never moves -> when correlation scores it -> then the result is 0 rather than NaN', { tags: ['@unit', '@flaky'] }, () => {
    expect(correlation([4, 4, 4, 4], [0, 1, 0, 1])).toBe(0);
    expect(correlation([1, 2, 3, 4], [1, 1, 1, 1])).toBe(0);
  });

  it('given a single data point -> when correlation scores it -> then the result is 0', { tags: ['@unit', '@flaky'] }, () => {
    expect(correlation([1], [1])).toBe(0);
  });

  it('given two series that rise together -> when correlation scores them -> then the coefficient exceeds 0.7', { tags: ['@unit', '@flaky'] }, () => {
    expect(correlation([1, 2, 3, 4, 5], [0, 0, 1, 1, 1])).toBeGreaterThan(0.7);
  });
});

describe('projectConcentration', () => {
  it('given failures confined to one project while others stay green -> when extractFeatures runs -> then projectConcentration is 1', { tags: ['@unit', '@flaky'] }, () => {
    const firefox = Array.from({ length: 10 }, (_, i) =>
      attempt({ outcome: i % 2 === 0 ? 'failed' : 'passed', daysAgo: 10 - i, project: 'firefox-desktop' }, i),
    );
    const chromium = Array.from({ length: 10 }, (_, i) =>
      attempt({ outcome: 'passed', daysAgo: 10 - i, project: 'chromium-desktop' }, i + 50),
    );

    expect(extractFeatures(firefox, [...firefox, ...chromium]).projectConcentration).toBe(1);
  });

  it('given failures split evenly across two projects -> when extractFeatures runs -> then projectConcentration is 0.5', { tags: ['@unit', '@flaky'] }, () => {
    const all = [
      ...Array.from({ length: 4 }, (_, i) =>
        attempt({ outcome: 'failed', daysAgo: 10 - i, project: 'firefox-desktop' }, i),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        attempt({ outcome: 'failed', daysAgo: 10 - i, project: 'chromium-desktop' }, i + 50),
      ),
    ];
    expect(extractFeatures(all, all).projectConcentration).toBeCloseTo(0.5, 5);
  });
});

describe('retryFlips', () => {
  it('given a failure and a passing retry within one run -> when extractFeatures runs -> then one retry flip is counted', { tags: ['@unit', '@flaky'] }, () => {
    // The strongest possible flake signal: same commit, same environment,
    // different outcome, minutes apart.
    const attempts: HistoricalAttempt[] = [
      attempt({ outcome: 'failed', daysAgo: 1, retry: 0, runId: 'run-x' }),
      attempt({ outcome: 'passed', daysAgo: 1, retry: 1, runId: 'run-x' }),
    ];
    expect(extractFeatures(attempts).retryFlips).toBe(1);
  });

  it('given a run that failed on every retry -> when extractFeatures runs -> then no retry flip is counted', { tags: ['@unit', '@flaky'] }, () => {
    const attempts: HistoricalAttempt[] = [
      attempt({ outcome: 'failed', daysAgo: 1, retry: 0, runId: 'run-x' }),
      attempt({ outcome: 'failed', daysAgo: 1, retry: 1, runId: 'run-x' }),
    ];
    expect(extractFeatures(attempts).retryFlips).toBe(0);
  });
});

describe('durationRatio', () => {
  it('given failing runs lasting five times as long as passing ones -> when extractFeatures runs -> then durationRatio is 5', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = [
      ...Array.from({ length: 8 }, (_, i) =>
        attempt({ outcome: 'passed', daysAgo: 10 - i, durationMs: 1_000 }, i),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        attempt({ outcome: 'failed', daysAgo: 4 - i, durationMs: 5_000 }, i + 50),
      ),
    ];
    expect(extractFeatures(attempts).durationRatio).toBeCloseTo(5, 5);
  });
});
