import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUARANTINE_POLICY,
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
  it('takes the larger of the floor and the ratio', () => {
    // A small suite gets the floor; a large one gets the percentage.
    expect(effectiveBudget(100, DEFAULT_QUARANTINE_POLICY)).toBe(5);
    expect(effectiveBudget(1000, DEFAULT_QUARANTINE_POLICY)).toBe(20);
  });
});

describe('evaluateQuarantinePolicy', () => {
  it('passes a healthy list', () => {
    const result = evaluateQuarantinePolicy([entry()], 271, DEFAULT_QUARANTINE_POLICY, NOW);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.budget).toBe(5);
  });

  it('fails on an expired quarantine', () => {
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

  it('fails when the budget is exceeded', () => {
    const many = Array.from({ length: 6 }, (_, i) => entry({ testId: `test-${i}` }));
    const result = evaluateQuarantinePolicy(many, 271, DEFAULT_QUARANTINE_POLICY, NOW);

    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.kind === 'budget-exceeded')).toBe(true);
  });

  it('reports every violation at once rather than only the first', () => {
    // Being told about one problem per CI run is how a gate becomes hated.
    const many = [
      ...Array.from({ length: 6 }, (_, i) => entry({ testId: `test-${i}` })),
      entry({ testId: 'expired-one', expiresAt: new Date(NOW - DAY).toISOString() }),
    ];
    const result = evaluateQuarantinePolicy(many, 271, DEFAULT_QUARANTINE_POLICY, NOW);

    expect(result.violations.map(v => v.kind).sort()).toEqual(['budget-exceeded', 'expired']);
  });

  it('warns about quarantines expiring shortly, soonest first', () => {
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

describe('expiry helpers', () => {
  it('computes an expiry from the policy window', () => {
    const expires = expiryFor(DEFAULT_QUARANTINE_POLICY, NOW);
    expect(daysUntilExpiry(entry({ expiresAt: expires }), NOW)).toBeCloseTo(14, 5);
  });
});

describe('renderQuarantineComment', () => {
  it('is self-documenting, so nobody has to open a dashboard to understand it', () => {
    const lines = renderQuarantineComment(entry(), '0.0.0');
    const text = lines.join('\n');

    expect(text).toContain('firefox nav race under parallel load');
    expect(text).toContain('resource-contention');
    expect(text).toContain('issues/214');
    expect(text).toMatch(/expires \d{4}-\d{2}-\d{2}/);
  });

  it('says plainly when no issue is linked', () => {
    expect(renderQuarantineComment(entry({ issueUrl: null }), '0.0.0').join('\n')).toContain(
      'no issue linked',
    );
  });
});
