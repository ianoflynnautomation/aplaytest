import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { defineAtestConfig } from '../src/config/schema.js';
import { ATEST_VERSION } from '../src/version.js';

describe('defineAtestConfig', () => {
  it('given an empty config object -> when defineAtestConfig resolves it -> then the safe defaults apply: strict mode, propose-only healing and collateral validation', { tags: ['@unit', '@config'] }, () => {
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

  it('given an empty config object -> when defineAtestConfig resolves it -> then minStabilityRank is 4 and css and xpath are excluded from allowedStrategies', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({});
    // 4 = text. css (5) and xpath (6) are excluded outright.
    expect(c.heal.minStabilityRank).toBe(4);
    expect(c.heal.allowedStrategies).not.toContain('xpath');
    expect(c.heal.allowedStrategies).not.toContain('css');
    expect(c.heal.allowedStrategies).toEqual(['testid', 'role', 'label', 'text']);
  });

  it('given an empty config object -> when defineAtestConfig resolves it -> then heal.targets covers constants, page objects and specs', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({});
    expect(c.heal.targets).toContain('src/**/*.constants.ts');
    expect(c.heal.targets).toContain('src/**/*.page.ts');
    expect(c.heal.targets).toContain('tests/**/*.spec.ts');
  });

  it('given an empty config object -> when defineAtestConfig resolves it -> then conventions.forbidWriteTo protects seeded testdata and screenshots', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({});
    expect(c.conventions.forbidWriteTo).toContain('tests/testdata/seeded/**');
    expect(c.conventions.forbidWriteTo).toContain('**/__screenshots__/**');
  });

  it('given an empty config object -> when defineAtestConfig resolves it -> then evidence.redact includes authorization and token', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({});
    expect(c.evidence.redact).toContain('authorization');
    expect(c.evidence.redact).toContain('token');
  });

  it('given identity hooks for runId and traceId -> when defineAtestConfig resolves the config -> then both hooks stay callable and return their values', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({
      identity: {
        runId: () => 'run-123',
        traceId: test => `trace-${test.id}`,
      },
    });
    expect(c.identity.runId?.()).toBe('run-123');
    expect(c.identity.traceId?.({ id: 'abc' }, 0)).toBe('trace-abc');
  });

  it('given a config setting heal.validationRuns to 0 -> when defineAtestConfig validates it -> then it throws an Invalid atest.config.ts error rather than starting up wrong', { tags: ['@unit', '@config'] }, () => {
    expect(() =>
      defineAtestConfig({ heal: { validationRuns: 0 } } as never),
    ).toThrowError(/Invalid atest\.config\.ts/);
  });

  it('given a config overriding mode and heal.aggressiveness -> when defineAtestConfig resolves it -> then the user values replace the defaults', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({ mode: 'assisted', heal: { aggressiveness: 'conservative' } });
    expect(c.mode).toBe('assisted');
    expect(c.heal.aggressiveness).toBe('conservative');
    expect(c.heal.allowedStrategies).toEqual(['testid', 'role']);
    expect(c.heal.validationRuns).toBe(5);
    expect(c.heal.apply).toBe('propose');
  });

  it('given heal.aggressiveness aggressive and no other heal fields -> when defineAtestConfig resolves it -> then the aggressive preset fills strategies and apply', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({ heal: { aggressiveness: 'aggressive' } });
    expect(c.heal.strategies).toEqual(['selector', 'flow']);
    expect(c.heal.apply).toBe('local');
  });

  it('given heal.aggressiveness aggressive and an explicit apply -> when defineAtestConfig resolves it -> then the explicit field wins over the preset', { tags: ['@unit', '@config'] }, () => {
    const c = defineAtestConfig({ heal: { aggressiveness: 'aggressive', apply: 'propose' } });
    expect(c.heal.apply).toBe('propose');
    expect(c.heal.strategies).toEqual(['selector', 'flow']);
  });

  it('given llm.provider set to an unimplemented value -> when defineAtestConfig validates it -> then it throws rather than silently using Anthropic', { tags: ['@unit', '@config'] }, () => {
    expect(() =>
      defineAtestConfig({ llm: { provider: 'openai' } } as never),
    ).toThrowError(/Invalid atest\.config\.ts/);
  });
});

describe('ATEST_VERSION', () => {
  it('given the published package.json -> when ATEST_VERSION is read -> then it matches the package version', { tags: ['@unit', '@config'] }, () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(ATEST_VERSION).toBe(pkg.version);
  });
});
