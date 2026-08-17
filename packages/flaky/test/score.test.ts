import { describe, expect, it } from 'vitest';

import { isFlaky, scoreTest, usableAttempts, wilsonLowerBound } from '../src/score.js';
import { attempt, NOW, series } from './helpers.js';

const THRESHOLD = 0.15;

describe('wilsonLowerBound', () => {
  it('stays conservative when observations are few', () => {
    // The whole point: 1-in-5 must not read as confidently as 20-in-100.
    expect(wilsonLowerBound(1, 5)).toBeLessThan(wilsonLowerBound(20, 100));
  });

  it('is zero for no observations rather than NaN', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('scoreTest — determinism is not flakiness', () => {
  it('does NOT flag a test that fails every single time', () => {
    // REGRESSION GUARD, found by running against a real suite: scoring on the
    // failure rate gave a 12-of-12 failure a 0.45 and labelled it FLAKY.
    // Always-fail is deterministic — it belongs to whoever broke it, not to
    // the quarantine list.
    const score = scoreTest(series('F'.repeat(20)), undefined, NOW);
    expect(score.transitionDensity).toBe(0);
    expect(score.instability).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('does NOT flag a test that passes every single time', () => {
    const score = scoreTest(series('P'.repeat(20)), undefined, NOW);
    expect(score.instability).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });
});

describe('scoreTest — the patterns that must be told apart', () => {
  it('does NOT flag a test that was broken and has since been fixed', () => {
    // Ten failures then forty passes. Raw failure rate is 20% — high enough to
    // look alarming — but the failures are old, contiguous, and over.
    const attempts = series('FFFFFFFFFF' + 'P'.repeat(40));
    const score = scoreTest(attempts, undefined, NOW);

    expect(score.transitionDensity).toBeLessThan(0.1);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('flags an alternating pass/fail pattern strongly', () => {
    const score = scoreTest(series('PF'.repeat(25)), undefined, NOW);

    expect(score.transitionDensity).toBeGreaterThan(0.9);
    expect(score.score).toBeGreaterThan(0.4);
    expect(isFlaky(score, THRESHOLD)).toBe(true);
  });

  it('does NOT flag a single failure in fifty runs', () => {
    const score = scoreTest(series('P'.repeat(30) + 'F' + 'P'.repeat(19)), undefined, NOW);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('flags scattered intermittent failures', () => {
    // The shape of a real flake: no boundary, no run of failures, just noise.
    const score = scoreTest(series('PPFPPPFPPFPPPPFPPFPPPFPPPPFPPFPPPPFPPFPPPPFPPFPPPP'), undefined, NOW);
    expect(isFlaky(score, THRESHOLD)).toBe(true);
    expect(score.transitionDensity).toBeGreaterThan(0.2);
  });

  it('weights recent failures above old ones', () => {
    const recent = scoreTest(series('P'.repeat(40) + 'FFFFFFFFFF'), undefined, NOW);
    const old = scoreTest(series('FFFFFFFFFF' + 'P'.repeat(40)), undefined, NOW);

    // Identical raw failure counts; only the timing differs.
    expect(recent.failures).toBe(old.failures);
    expect(recent.instability).toBeGreaterThan(old.instability);
  });
});

describe('scoreTest — refusing to guess', () => {
  it('reports insufficient data rather than scoring a handful of runs', () => {
    const score = scoreTest(series('PFPFP'), undefined, NOW);
    expect(score.insufficientData).toBe(true);
    expect(score.score).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('grades confidence by sample size', () => {
    expect(scoreTest(series('PF'.repeat(6)), undefined, NOW).confidence).toBe('low');
    expect(scoreTest(series('PF'.repeat(10)), undefined, NOW).confidence).toBe('medium');
    expect(scoreTest(series('PF'.repeat(20)), undefined, NOW).confidence).toBe('high');
  });
});

describe('usableAttempts', () => {
  it('excludes infra failures — a dead browser says nothing about the test', () => {
    // Counting an outage as flakiness would manufacture flake across the whole
    // suite the moment a runner loses its network.
    const attempts = [
      attempt({ outcome: 'failed', daysAgo: 1, failureKind: 'infra' }),
      attempt({ outcome: 'passed', daysAgo: 2 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(1);
  });

  it('excludes skipped and interrupted attempts', () => {
    const attempts = [
      attempt({ outcome: 'skipped', daysAgo: 1 }),
      attempt({ outcome: 'interrupted', daysAgo: 2 }),
      attempt({ outcome: 'passed', daysAgo: 3 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(1);
  });

  it('keeps ordinary failures', () => {
    const attempts = [
      attempt({ outcome: 'failed', daysAgo: 1, failureKind: 'locator_not_found' }),
      attempt({ outcome: 'passed', daysAgo: 2 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(2);
  });
});
