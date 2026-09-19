/**
 * Resolve flake-analysis knobs from CLI overrides, then environment, then
 * the shared defaults.
 *
 * The analyze GitHub job has no checkout of the consumer repo, so
 * `atest.config.ts` is unreachable there. Environment variables are the
 * only way a workflow input can reach scoring. CLI flags beat env so a
 * local `aplaytest flaky report --min-runs 3` still works.
 *
 * Ref: @spec docs/specs/stc/flaky/scoring.md#AC-02
 */

import { ANALYZE_ENV, FLAKY_DEFAULTS } from '@aplaytest/core';

import type { AnalyzeConfig } from './analyze.js';

export class AnalyzeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeConfigError';
  }
}

export interface AnalyzeConfigOverrides {
  minRuns?: number;
  halfLifeDays?: number;
  threshold?: number;
  windowRuns?: number;
}

function parseFinite(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new AnalyzeConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseFinite(raw.trim(), name);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AnalyzeConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function parsePositiveNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseFinite(raw.trim(), name);
  if (parsed <= 0) {
    throw new AnalyzeConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function parseUnitInterval(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseFinite(raw.trim(), name);
  if (parsed < 0 || parsed > 1) {
    throw new AnalyzeConfigError(`${name} must be between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function fromEnv(env: NodeJS.ProcessEnv): AnalyzeConfigOverrides {
  const minRuns = parsePositiveInt(env[ANALYZE_ENV.minRuns], ANALYZE_ENV.minRuns);
  const halfLifeDays = parsePositiveNumber(env[ANALYZE_ENV.halfLifeDays], ANALYZE_ENV.halfLifeDays);
  const threshold = parseUnitInterval(env[ANALYZE_ENV.threshold], ANALYZE_ENV.threshold);
  const windowRuns = parsePositiveInt(env[ANALYZE_ENV.windowRuns], ANALYZE_ENV.windowRuns);
  return {
    ...(minRuns === undefined ? {} : { minRuns }),
    ...(halfLifeDays === undefined ? {} : { halfLifeDays }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(windowRuns === undefined ? {} : { windowRuns }),
  };
}

/**
 * CLI flags beat environment variables beat {@link FLAKY_DEFAULTS}.
 *
 * @param env - Process environment. Injected so tests never touch `process.env`.
 * @param overrides - Already-parsed CLI values. `undefined` fields fall through.
 */
export function resolveAnalyzeConfig(
  env: NodeJS.ProcessEnv = {},
  overrides: AnalyzeConfigOverrides = {},
): AnalyzeConfig {
  const envValues = fromEnv(env);
  return {
    minRuns: overrides.minRuns ?? envValues.minRuns ?? FLAKY_DEFAULTS.minRuns,
    halfLifeDays: overrides.halfLifeDays ?? envValues.halfLifeDays ?? FLAKY_DEFAULTS.halfLifeDays,
    threshold: overrides.threshold ?? envValues.threshold ?? FLAKY_DEFAULTS.threshold,
    windowRuns: overrides.windowRuns ?? envValues.windowRuns ?? FLAKY_DEFAULTS.windowRuns,
  };
}

