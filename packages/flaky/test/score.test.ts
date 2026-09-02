import { describe, expect, it } from 'vitest';

import { isFlaky, scoreTest, usableAttempts, wilsonLowerBound } from '../src/score.js';
import { attempt, NOW, series } from './helpers.js';

const THRESHOLD = 0.15;

describe('wilsonLowerBound', () => {
  it('given 1 failure in 5 runs versus 20 in 100 -> when wilsonLowerBound scores each -> then the smaller sample scores lower', { tags: ['@unit', '@flaky'] }, () => {
    // The whole point: 1-in-5 must not read as confidently as 20-in-100.
    expect(wilsonLowerBound(1, 5)).toBeLessThan(wilsonLowerBound(20, 100));
  });

  it('given no observations -> when wilsonLowerBound scores them -> then the bound is 0 rather than NaN', { tags: ['@unit', '@flaky'] }, () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('scoreTest — determinism is not flakiness', () => {
  it('given a test that failed all 20 runs -> when scoreTest scores it -> then instability is 0 and it is not flagged flaky, because always-fail is deterministic', { tags: ['@unit', '@flaky'] }, () => {
    // REGRESSION GUARD, found by running against a real suite: scoring on the
    // failure rate gave a 12-of-12 failure a 0.45 and labelled it FLAKY.
    // Always-fail is deterministic — it belongs to whoever broke it, not to
    // the quarantine list.
    const score = scoreTest(series('F'.repeat(20)), undefined, NOW);
    expect(score.transitionDensity).toBe(0);
    expect(score.instability).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('given a test that passed all 20 runs -> when scoreTest scores it -> then instability is 0 and it is not flagged flaky', { tags: ['@unit', '@flaky'] }, () => {
    const score = scoreTest(series('P'.repeat(20)), undefined, NOW);
    expect(score.instability).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });
});

describe('scoreTest — the patterns that must be told apart', () => {
  it('given ten contiguous old failures followed by forty passes -> when scoreTest scores it -> then transition density stays low and it is not flagged flaky', { tags: ['@unit', '@flaky'] }, () => {
    // Ten failures then forty passes. Raw failure rate is 20% — high enough to
    // look alarming — but the failures are old, contiguous, and over.
    const attempts = series('FFFFFFFFFF' + 'P'.repeat(40));
    const score = scoreTest(attempts, undefined, NOW);

    expect(score.transitionDensity).toBeLessThan(0.1);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('given a strictly alternating pass and fail series -> when scoreTest scores it -> then transition density exceeds 0.9 and it is flagged flaky', { tags: ['@unit', '@flaky'] }, () => {
    const score = scoreTest(series('PF'.repeat(25)), undefined, NOW);

    expect(score.transitionDensity).toBeGreaterThan(0.9);
    expect(score.score).toBeGreaterThan(0.4);
    expect(isFlaky(score, THRESHOLD)).toBe(true);
  });

  it('given one failure among fifty runs -> when scoreTest scores it -> then it is not flagged flaky', { tags: ['@unit', '@flaky'] }, () => {
    const score = scoreTest(series('P'.repeat(30) + 'F' + 'P'.repeat(19)), undefined, NOW);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('given failures scattered with no boundary or run -> when scoreTest scores it -> then it is flagged flaky on transition density', { tags: ['@unit', '@flaky'] }, () => {
    // The shape of a real flake: no boundary, no run of failures, just noise.
    const score = scoreTest(series('PPFPPPFPPFPPPPFPPFPPPFPPPPFPPFPPPPFPPFPPPPFPPFPPPP'), undefined, NOW);
    expect(isFlaky(score, THRESHOLD)).toBe(true);
    expect(score.transitionDensity).toBeGreaterThan(0.2);
  });

  it('given two series with identical failure counts placed recently and long ago -> when scoreTest scores both -> then the recent series scores more unstable', { tags: ['@unit', '@flaky'] }, () => {
    const recent = scoreTest(series('P'.repeat(40) + 'FFFFFFFFFF'), undefined, NOW);
    const old = scoreTest(series('FFFFFFFFFF' + 'P'.repeat(40)), undefined, NOW);

    // Identical raw failure counts; only the timing differs.
    expect(recent.failures).toBe(old.failures);
    expect(recent.instability).toBeGreaterThan(old.instability);
  });
});

describe('scoreTest — refusing to guess', () => {
  it('given only five recorded attempts -> when scoreTest scores them -> then insufficientData is set, the score is 0 and it is not flagged flaky', { tags: ['@unit', '@flaky'] }, () => {
    const score = scoreTest(series('PFPFP'), undefined, NOW);
    expect(score.insufficientData).toBe(true);
    expect(score.score).toBe(0);
    expect(isFlaky(score, THRESHOLD)).toBe(false);
  });

  it('given series of 12, 20 and 40 attempts -> when scoreTest scores each -> then confidence grades low, medium and high by sample size', { tags: ['@unit', '@flaky'] }, () => {
    expect(scoreTest(series('PF'.repeat(6)), undefined, NOW).confidence).toBe('low');
    expect(scoreTest(series('PF'.repeat(10)), undefined, NOW).confidence).toBe('medium');
    expect(scoreTest(series('PF'.repeat(20)), undefined, NOW).confidence).toBe('high');
  });
});

describe('usableAttempts', () => {
  it('given an infra failure alongside a pass -> when usableAttempts filters them -> then the infra attempt is excluded', { tags: ['@unit', '@flaky'] }, () => {
    // Counting an outage as flakiness would manufacture flake across the whole
    // suite the moment a runner loses its network.
    const attempts = [
      attempt({ outcome: 'failed', daysAgo: 1, failureKind: 'infra' }),
      attempt({ outcome: 'passed', daysAgo: 2 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(1);
  });

  it('given skipped and interrupted attempts alongside a pass -> when usableAttempts filters them -> then only the pass survives', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = [
      attempt({ outcome: 'skipped', daysAgo: 1 }),
      attempt({ outcome: 'interrupted', daysAgo: 2 }),
      attempt({ outcome: 'passed', daysAgo: 3 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(1);
  });

  it('given an ordinary locator failure alongside a pass -> when usableAttempts filters them -> then both are kept', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = [
      attempt({ outcome: 'failed', daysAgo: 1, failureKind: 'locator_not_found' }),
      attempt({ outcome: 'passed', daysAgo: 2 }),
    ];
    expect(usableAttempts(attempts)).toHaveLength(2);
  });
});
