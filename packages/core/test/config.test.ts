import { describe, expect, it } from 'vitest';

import { defineAtestConfig } from '../src/config/schema.js';

describe('defineAtestConfig', () => {
  it('produces the SAFE system from an empty config', () => {
    // The defaults are the project's stance. A consumer who configures
    // nothing must not end up with an unguarded system.
    const c = defineAtestConfig({});
    expect(c.mode).toBe('strict');
    expect(c.heal.apply).toBe('propose');
    expect(c.heal.strategies).toEqual(['selector']);
    expect(c.heal.validateCollateral).toBe(true);
    expect(c.flaky.quarantine.expiryDays).toBe(14);
    expect(c.llm.provider).toBe('anthropic');
  });

  it('refuses to generate locators below the stability floor by default', () => {
    const c = defineAtestConfig({});
    // 4 = text. css (5) and xpath (6) are excluded outright.
    expect(c.heal.minStabilityRank).toBe(4);
    expect(c.heal.allowedStrategies).not.toContain('xpath');
    expect(c.heal.allowedStrategies).not.toContain('css');
  });

  it('protects the test-data oracle by default', () => {
    const c = defineAtestConfig({});
    expect(c.conventions.forbidWriteTo).toContain('tests/testdata/seeded/**');
    expect(c.conventions.forbidWriteTo).toContain('**/__screenshots__/**');
  });

  it('redacts credentials from evidence by default', () => {
    const c = defineAtestConfig({});
    expect(c.evidence.redact).toContain('authorization');
    expect(c.evidence.redact).toContain('token');
  });

  it('carries identity hooks through so trace ids can be reused', () => {
    const c = defineAtestConfig({
      identity: {
        runId: () => 'run-123',
        traceId: test => `trace-${test.id}`,
      },
    });
    expect(c.identity.runId?.()).toBe('run-123');
    expect(c.identity.traceId?.({ id: 'abc' }, 0)).toBe('trace-abc');
  });

  it('throws a readable error on invalid config rather than starting up wrong', () => {
    expect(() =>
      defineAtestConfig({ heal: { validationRuns: 0 } } as never),
    ).toThrowError(/Invalid atest\.config\.ts/);
  });

  it('accepts user overrides over defaults', () => {
    const c = defineAtestConfig({ mode: 'assisted', heal: { aggressiveness: 'conservative' } });
    expect(c.mode).toBe('assisted');
    expect(c.heal.aggressiveness).toBe('conservative');
  });
});
