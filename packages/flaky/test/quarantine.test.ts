import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUARANTINE_POLICY,
  DEFAULT_QUARANTINE_REASON,
  UNCLASSIFIED_CAUSE,
  buildQuarantineEntry,
  daysUntilExpiry,
  effectiveBudget,
  evaluateQuarantinePolicy,
  expiryFor,
  renderQuarantineComment,
  type QuarantineEntry,
} from '../src/quarantine.js';
import { DAY, NOW } from './helpers.js';

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testId: 'test-1',
    project: 'firefox-desktop',
    title: 'Given the footer, when a visitor clicks Stores, then the stores page opens',
    reason: 'firefox nav race under parallel load',
    flakeScore: 0.34,
    rootCause: 'resource-contention',
    issueUrl: 'https://github.com/example/repo/issues/214',
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    expiresAt: new Date(NOW + 12 * DAY).toISOString(),
    justification: null,
    ...overrides,
  };
}

describe('effectiveBudget', () => {
  it('given suites of 100 and 1000 tests -> when effectiveBudget resolves the policy -> then the larger of the floor and the ratio is taken', { tags: ['@unit', '@flaky'] }, () => {
    // A small suite gets the floor; a large one gets the percentage.
    expect(effectiveBudget(100, DEFAULT_QUARANTINE_POLICY)).toBe(5);
    expect(effectiveBudget(1000, DEFAULT_QUARANTINE_POLICY)).toBe(20);
  });
});

describe('evaluateQuarantinePolicy', () => {
  it('given one unexpired quarantine well inside budget -> when evaluateQuarantinePolicy runs -> then the result is ok with no violations', { tags: ['@unit', '@flaky'] }, () => {
    const result = evaluateQuarantinePolicy([entry()], 271, DEFAULT_QUARANTINE_POLICY, NOW);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.budget).toBe(5);
  });

  it('given a quarantine whose expiry has passed -> when evaluateQuarantinePolicy runs -> then the result fails with an expired violation', { tags: ['@unit', '@flaky'] }, () => {
    // Expiry is the mechanism that turns "fix or delete promptly" from a
    // convention into something the build enforces.
    const result = evaluateQuarantinePolicy(
      [entry({ expiresAt: new Date(NOW - 6 * DAY).toISOString() })],
      271,
      DEFAULT_QUARANTINE_POLICY,
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('expired');
    expect(result.expired).toHaveLength(1);
  });

  it('given more quarantines than the budget allows -> when evaluateQuarantinePolicy runs -> then the result fails with a budget-exceeded violation', { tags: ['@unit', '@flaky'] }, () => {
    const many = Array.from({ length: 6 }, (_, i) => entry({ testId: `test-${i}` }));
    const result = evaluateQuarantinePolicy(many, 271, DEFAULT_QUARANTINE_POLICY, NOW);

    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.kind === 'budget-exceeded')).toBe(true);
  });

  it('given a list both over budget and holding an expired entry -> when evaluateQuarantinePolicy runs -> then both violations are reported together', { tags: ['@unit', '@flaky'] }, () => {
    // Being told about one problem per CI run is how a gate becomes hated.
    const many = [
      ...Array.from({ length: 6 }, (_, i) => entry({ testId: `test-${i}` })),
      entry({ testId: 'expired-one', expiresAt: new Date(NOW - DAY).toISOString() }),
    ];
    const result = evaluateQuarantinePolicy(many, 271, DEFAULT_QUARANTINE_POLICY, NOW);

    expect(result.violations.map(v => v.kind).sort()).toEqual(['budget-exceeded', 'expired']);
  });

  it('given quarantines expiring at mixed distances -> when evaluateQuarantinePolicy runs -> then the imminent ones are listed soonest first', { tags: ['@unit', '@flaky'] }, () => {
    const result = evaluateQuarantinePolicy(
      [
        entry({ testId: 'later', expiresAt: new Date(NOW + 3 * DAY).toISOString() }),
        entry({ testId: 'sooner', expiresAt: new Date(NOW + 1 * DAY).toISOString() }),
        entry({ testId: 'far-off', expiresAt: new Date(NOW + 12 * DAY).toISOString() }),
      ],
      271,
      DEFAULT_QUARANTINE_POLICY,
      NOW,
    );

    expect(result.ok).toBe(true);
    expect(result.expiringSoon.map(e => e.testId)).toEqual(['sooner', 'later']);
  });
});

describe('buildQuarantineEntry', () => {
  it('given only a title and a clock -> when buildQuarantineEntry runs -> then the reason, root cause, score and expiry are filled from policy defaults', { tags: ['@unit', '@flaky'] }, () => {
    const built = buildQuarantineEntry({ title: 'a gym can be found by name', now: NOW });
    expect(built.testId).toBe('a gym can be found by name');
    expect(built.project).toBeNull();
    expect(built.reason).toBe(DEFAULT_QUARANTINE_REASON);
    expect(built.rootCause).toBe(UNCLASSIFIED_CAUSE);
    expect(built.flakeScore).toBe(0);
    expect(built.expiresAt).toBe(expiryFor(DEFAULT_QUARANTINE_POLICY, NOW));
  });
});

describe('expiry helpers', () => {
  it('given the default policy window -> when expiryFor computes an expiry -> then daysUntilExpiry reports 14 days', { tags: ['@unit', '@flaky'] }, () => {
    const expires = expiryFor(DEFAULT_QUARANTINE_POLICY, NOW);
    expect(daysUntilExpiry(entry({ expiresAt: expires }), NOW)).toBeCloseTo(14, 5);
  });
});

describe('renderQuarantineComment', () => {
  it('given a quarantine entry with a reason, cause and issue -> when renderQuarantineComment renders it -> then the comment carries all three and a dated expiry', { tags: ['@unit', '@flaky'] }, () => {
    const lines = renderQuarantineComment(entry(), '0.0.0');
    const text = lines.join('\n');

    expect(text).toContain('firefox nav race under parallel load');
    expect(text).toContain('resource-contention');
    expect(text).toContain('issues/214');
    expect(text).toMatch(/expires \d{4}-\d{2}-\d{2}/);
  });

  it('given a quarantine entry with no issue URL -> when renderQuarantineComment renders it -> then the comment says no issue linked', { tags: ['@unit', '@flaky'] }, () => {
    expect(renderQuarantineComment(entry({ issueUrl: null }), '0.0.0').join('\n')).toContain(
      'no issue linked',
    );
  });
});
