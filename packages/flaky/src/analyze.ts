/**
 * Analysis orchestration: history → score → features → class → verdict.
 *
 * Scoring is per **(test, project)**, never per test. A test that fails only
 * on firefox under load has a real 0.3 on that project; averaged across five
 * green projects it becomes a 0.06 and disappears below the threshold. The
 * aggregate is the number that hides the bug.
 */

import type { HistoricalAttempt, HistoryStore } from '@aplaytest/core';

import { classifyFlake, type Classification } from './classify.js';
import { extractFeatures, type FlakeFeatures } from './features.js';
import { DEFAULT_SCORE_CONFIG, isFlaky, scoreTest, type FlakeScore, type ScoreConfig } from './score.js';

export interface AnalyzeConfig extends ScoreConfig {
  readonly threshold: number;
  /** Only consider runs at or after this ISO timestamp. */
  readonly since?: string;
  /** Cap on attempts pulled per (test, project). */
  readonly windowRuns: number;
}

export const DEFAULT_ANALYZE_CONFIG: AnalyzeConfig = {
  ...DEFAULT_SCORE_CONFIG,
  threshold: 0.15,
  windowRuns: 50,
};

export interface FlakyVerdict {
  readonly testId: string;
  readonly project: string;
  readonly title: string;
  readonly file: string;
  readonly score: FlakeScore;
  readonly features: FlakeFeatures;
  readonly classification: Classification;
  readonly flaky: boolean;
}

export interface FlakyReport {
  readonly generatedAt: string;
  readonly analyzed: number;
  /** Every verdict, ordered by score descending. */
  readonly verdicts: readonly FlakyVerdict[];
  /** Verdicts above threshold. */
  readonly flaky: readonly FlakyVerdict[];
  /** Above threshold but classified as a real regression — the urgent ones. */
  readonly regressions: readonly FlakyVerdict[];
  readonly config: AnalyzeConfig;
}

export async function analyzeTest(
  store: HistoryStore,
  testId: string,
  project: string,
  config: AnalyzeConfig = DEFAULT_ANALYZE_CONFIG,
  now: number = Date.now(),
): Promise<FlakyVerdict> {
  const query = config.since === undefined ? {} : { since: config.since };

  const scoped = await store.attempts({ ...query, testId, project, limit: config.windowRuns });
  // Cross-project attempts feed the concentration signal only — a per-project
  // window can never tell you that a failure is confined to one browser.
  const acrossProjects = await store.attempts({ ...query, testId });

  const score = scoreTest(scoped, config, now);
  const features = extractFeatures(scoped, acrossProjects);
  const classification = classifyFlake(features, score);

  const first = scoped[0];
  return {
    testId,
    project,
    title: first?.title ?? testId,
    file: first?.file ?? '',
    score,
    features,
    classification,
    flaky: isFlaky(score, config.threshold) && classification.class !== 'genuine-regression',
  };
}

export async function analyzeAll(
  store: HistoryStore,
  config: AnalyzeConfig = DEFAULT_ANALYZE_CONFIG,
  now: number = Date.now(),
): Promise<FlakyReport> {
  const keys = await store.testKeys();
  const verdicts: FlakyVerdict[] = [];

  for (const key of keys) {
    verdicts.push(await analyzeTest(store, key.testId, key.project, config, now));
  }

  verdicts.sort((a, b) => b.score.score - a.score.score);

  return {
    generatedAt: new Date(now).toISOString(),
    analyzed: verdicts.length,
    verdicts,
    flaky: verdicts.filter(v => v.flaky),
    // Surfaced separately and deliberately: a regression above the flake
    // threshold is the thing you most need to see, and the thing a naive
    // "flaky tests" list would bury.
    regressions: verdicts.filter(
      v => v.classification.class === 'genuine-regression' && !v.score.insufficientData,
    ),
    config,
  };
}

/** Attempts grouped by (testId, project) — used by the bisect and report paths. */
export function groupByTestAndProject(
  attempts: readonly HistoricalAttempt[],
): Map<string, HistoricalAttempt[]> {
  const grouped = new Map<string, HistoricalAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.testId}::${attempt.project}`;
    const existing = grouped.get(key) ?? [];
    existing.push(attempt);
    grouped.set(key, existing);
  }
  return grouped;
}
