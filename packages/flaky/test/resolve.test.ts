import { describe, expect, it } from 'vitest';

import { ANALYZE_ENV, FLAKY_DEFAULTS } from '@aplaytest/core';

import { AnalyzeConfigError, resolveAnalyzeConfig } from '../src/resolve.js';

describe('resolveAnalyzeConfig', () => {
  it('given no env and no overrides -> when resolveAnalyzeConfig runs -> then it returns FLAKY_DEFAULTS', { tags: ['@unit', '@flaky', '@config'] }, () => {
    expect(resolveAnalyzeConfig({})).toEqual({
      minRuns: FLAKY_DEFAULTS.minRuns,
      halfLifeDays: FLAKY_DEFAULTS.halfLifeDays,
      threshold: FLAKY_DEFAULTS.threshold,
      windowRuns: FLAKY_DEFAULTS.windowRuns,
    });
  });

  it('given ATEST_FLAKY_MIN_RUNS in the environment -> when resolveAnalyzeConfig runs -> then minRuns comes from the env', { tags: ['@unit', '@flaky', '@config'] }, () => {
    // Ref: @spec docs/specs/stc/flaky/scoring.md#AC-02
    const config = resolveAnalyzeConfig({ [ANALYZE_ENV.minRuns]: '3' });
    expect(config.minRuns).toBe(3);
    expect(config.halfLifeDays).toBe(FLAKY_DEFAULTS.halfLifeDays);
  });

  it('given env and CLI overrides -> when resolveAnalyzeConfig runs -> then CLI flags beat the environment', { tags: ['@unit', '@flaky', '@config'] }, () => {
    const config = resolveAnalyzeConfig({ [ANALYZE_ENV.minRuns]: '3' }, { minRuns: 5, threshold: 0.2 });
    expect(config.minRuns).toBe(5);
    expect(config.threshold).toBe(0.2);
  });

  it('given a non-integer ATEST_FLAKY_MIN_RUNS -> when resolveAnalyzeConfig runs -> then it throws AnalyzeConfigError', { tags: ['@unit', '@flaky', '@config'] }, () => {
    expect(() => resolveAnalyzeConfig({ [ANALYZE_ENV.minRuns]: '1.5' })).toThrow(AnalyzeConfigError);
  });

  it('given ATEST_FLAKY_THRESHOLD outside 0..1 -> when resolveAnalyzeConfig runs -> then it throws AnalyzeConfigError', { tags: ['@unit', '@flaky', '@config'] }, () => {
    expect(() => resolveAnalyzeConfig({ [ANALYZE_ENV.threshold]: '2' })).toThrow(AnalyzeConfigError);
  });

  it('given empty env strings -> when resolveAnalyzeConfig runs -> then it falls through to defaults rather than treating empty as zero', { tags: ['@unit', '@flaky', '@config'] }, () => {
    const config = resolveAnalyzeConfig({
      [ANALYZE_ENV.minRuns]: '',
      [ANALYZE_ENV.threshold]: '  ',
    });
    expect(config.minRuns).toBe(FLAKY_DEFAULTS.minRuns);
    expect(config.threshold).toBe(FLAKY_DEFAULTS.threshold);
  });
});
