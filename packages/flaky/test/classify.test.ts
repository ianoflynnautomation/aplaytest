import { describe, expect, it } from 'vitest';

import { classifyFlake, shouldRetry } from '../src/classify.js';
import { extractFeatures } from '../src/features.js';
import { scoreTest } from '../src/score.js';
import { attempt, NOW, series } from './helpers.js';
import type { HistoricalAttempt } from '@aplaytest/core';

function verdict(scoped: HistoricalAttempt[], all: HistoricalAttempt[] = scoped) {
  const score = scoreTest(scoped, undefined, NOW);
  const features = extractFeatures(scoped, all);
  return { score, features, classification: classifyFlake(features, score) };
}

describe('resource-contention: one project fails under load, others stay green', () => {
  /**
   * "footer.ui 'Stores' quick link on firefox-desktop occasionally fails to
   *  navigate under full-suite parallel load (passes in isolation)."
   *
   * This is the acceptance test for the whole engine. It must reach
   * resource-contention from measurements alone — and must NOT call it a
   * selector problem, which would send it to the healing engine, or a
   * regression, which would send someone hunting a commit that does not exist.
   */
  const firefoxUnderLoad: HistoricalAttempt[] = [
    // Low worker counts: green.
    ...Array.from({ length: 12 }, (_, i) =>
      attempt({ outcome: 'passed', daysAgo: 30 - i, project: 'firefox-desktop', workers: 1 }, i),
    ),
    // High worker counts: intermittent.
    ...Array.from({ length: 18 }, (_, i) =>
      attempt(
        {
          outcome: i % 3 === 0 ? 'failed' : 'passed',
          daysAgo: 18 - i,
          project: 'firefox-desktop',
          workers: 8,
          failureKind: 'assertion_value_mismatch',
          durationMs: i % 3 === 0 ? 5_200 : 900,
        },
        i + 100,
      ),
    ),
  ];

  // Same test, other browsers, always green — this is what makes the failure
  // "confined to one project" measurable rather than asserted.
  const otherProjects: HistoricalAttempt[] = [
    ...Array.from({ length: 20 }, (_, i) =>
      attempt({ outcome: 'passed', daysAgo: 20 - i, project: 'chromium-desktop', workers: 8 }, i + 200),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      attempt({ outcome: 'passed', daysAgo: 20 - i, project: 'webkit-desktop', workers: 8 }, i + 300),
    ),
  ];

  it('given the firefox-under-load history -> when scoreTest scores it -> then the data is sufficient and the score clears the flake threshold', { tags: ['@unit', '@flaky'] }, () => {
    const { score } = verdict(firefoxUnderLoad, [...firefoxUnderLoad, ...otherProjects]);
    expect(score.insufficientData).toBe(false);
    expect(score.score).toBeGreaterThan(0.15);
  });

  it('given a test failing only at high worker counts on one project -> when classifyFlake runs -> then the class is resource-contention, evidenced by the worker-count delta', { tags: ['@unit', '@flaky'] }, () => {
    const { classification, features } = verdict(firefoxUnderLoad, [
      ...firefoxUnderLoad,
      ...otherProjects,
    ]);

    expect(classification.class).toBe('resource-contention');
    // The load signal is the rate difference, not the correlation: this test
    // never fails at one worker and fails a third of the time at eight, yet
    // point-biserial r is only ~0.41 because the outcome is rare.
    expect(features.workerLoadDelta).toBeGreaterThan(0.15);
    expect(features.workerCorrelation).toBeLessThan(0.5);
    expect(features.projectConcentration).toBe(1);
    expect(classification.evidence.join(' ')).toMatch(/worker count/);
  });

  it('given a test failing only under parallel load -> when classifyFlake runs -> then the class is not genuine-regression', { tags: ['@unit', '@flaky'] }, () => {
    // A regression verdict would send someone bisecting for a commit that
    // does not exist.
    const { classification } = verdict(firefoxUnderLoad, [...firefoxUnderLoad, ...otherProjects]);
    expect(classification.class).not.toBe('genuine-regression');
  });

  it('given a load-related flake whose selectors resolved -> when features are extracted -> then no locator_not_found kind is recorded, so healing is not invoked', { tags: ['@unit', '@flaky'] }, () => {
    const { features } = verdict(firefoxUnderLoad);
    expect(features.failureKinds['locator_not_found']).toBeUndefined();
  });
});

describe('classifyFlake — regressions must not be filed as flake', () => {
  it('given ten passes on one commit followed by ten failures on the next -> when classifyFlake runs -> then the class is genuine-regression and retry is refused', { tags: ['@unit', '@flaky'] }, () => {
    const attempts: HistoricalAttempt[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        attempt({ outcome: 'passed', daysAgo: 20 - i, commit: 'good-sha' }, i),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        attempt({ outcome: 'failed', daysAgo: 10 - i, commit: 'bad-sha' }, i + 50),
      ),
    ];

    const { classification } = verdict(attempts);
    expect(classification.class).toBe('genuine-regression');
    expect(classification.retryable).toBe(false);
    expect(shouldRetry(classification)).toBe(false);
  });

  it('given intermittent failures all recorded against one commit -> when features are extracted -> then no commit boundary is detected', { tags: ['@unit', '@flaky'] }, () => {
    // With only one commit there is no boundary to detect; treating it as a
    // regression would silence every flake on a quiet branch.
    const attempts = series('PPPPPFPPFPPPFPPPPFPP', { commit: 'only-sha' });
    const { features } = verdict(attempts);
    expect(features.commitBoundary).toBe(false);
  });
});

describe('classifyFlake — the other classes', () => {
  it('given failures interleaved with a co-scheduled polluter -> when classifyFlake runs -> then the class is test-pollution, the polluter is named and retry is refused', { tags: ['@unit', '@flaky'] }, () => {
    // Pollution INTERLEAVES: the test fails on the runs where the polluter
    // happened to share its worker, and passes otherwise. Failures that
    // instead start at one point and persist are a regression, and the
    // regression rule is deliberately checked first.
    const attempts: HistoricalAttempt[] = Array.from({ length: 20 }, (_, i) => {
      const polluted = i % 3 === 0;
      return attempt(
        {
          outcome: polluted ? 'failed' : 'passed',
          daysAgo: 20 - i,
          commit: `commit-${i % 4}`,
          coScheduled: polluted ? ['polluter-test'] : ['innocent-test'],
        },
        i,
      );
    });

    const { classification, features } = verdict(attempts);
    expect(features.commitBoundary).toBe(false);
    expect(features.coScheduleLift).toBeGreaterThan(2.5);
    expect(classification.class).toBe('test-pollution');
    expect(classification.evidence.join(' ')).toContain('polluter-test');
    // Retrying does not help: the polluter is still there.
    expect(shouldRetry(classification)).toBe(false);
  });

  it('given intermittent assertion_value_mismatch failures across projects -> when classifyFlake runs -> then the class is data-dependency and retry is refused', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = series('PPFPPFPPPFPPFPPPFPPF', {
      failureKind: 'assertion_value_mismatch',
      workers: 4,
    }).map((a, i) => ({ ...a, project: i % 2 === 0 ? 'chromium-desktop' : 'webkit-desktop' }));

    const { classification } = verdict(attempts);
    expect(classification.class).toBe('data-dependency');
    expect(shouldRetry(classification)).toBe(false);
  });

  it('given intermittent locator_not_actionable failures -> when classifyFlake runs -> then the class is animation and retry is advised', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = series('PPFPFPPFPPFPPFPPPFPP', {
      failureKind: 'locator_not_actionable',
      workers: 4,
    }).map((a, i) => ({ ...a, project: i % 2 === 0 ? 'chromium-desktop' : 'webkit-desktop' }));

    const { classification } = verdict(attempts);
    expect(classification.class).toBe('animation');
    expect(shouldRetry(classification)).toBe(true);
  });

  it('given intermittent network_error failures -> when classifyFlake runs -> then the class is network and retry is advised', { tags: ['@unit', '@flaky'] }, () => {
    const attempts = series('PPFPFPPFPPFPPFPPPFPP', {
      failureKind: 'network_error',
      workers: 4,
    }).map((a, i) => ({ ...a, project: i % 2 === 0 ? 'chromium-desktop' : 'webkit-desktop' }));

    const { classification } = verdict(attempts);
    expect(classification.class).toBe('network');
    expect(shouldRetry(classification)).toBe(true);
  });

  it('given only three recorded attempts -> when classifyFlake runs -> then the class is unclassified and the prescription is needs-more-data', { tags: ['@unit', '@flaky'] }, () => {
    const { classification } = verdict(series('PFP'));
    expect(classification.class).toBe('unclassified');
    expect(classification.prescription).toBe('needs-more-data');
  });
});

describe('classifyFlake — a broken test is not a flaky test', () => {
  it('given a test that failed all 20 runs -> when classifyFlake runs -> then the class is consistently-failing with a fix-or-delete prescription and retry refused', { tags: ['@unit', '@flaky'] }, () => {
    // REGRESSION GUARD from a real run: a 12-of-12 failure was previously
    // handed the `timing` class with "retry helps: yes", which sends someone
    // tuning waits on a test that is simply broken.
    const { classification } = verdict(series('F'.repeat(20)));

    expect(classification.class).toBe('consistently-failing');
    expect(classification.prescription).toBe('fix-or-delete');
    expect(shouldRetry(classification)).toBe(false);
    expect(classification.evidence.join(' ')).toContain('deterministic, not flaky');
  });

  it('given persistent failures that begin at a clean commit boundary -> when classifyFlake runs -> then genuine-regression outranks consistently-failing', { tags: ['@unit', '@flaky'] }, () => {
    // Knowing WHEN it broke is more actionable than knowing THAT it is broken.
    const attempts: HistoricalAttempt[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        attempt({ outcome: 'passed', daysAgo: 20 - i, commit: 'good-sha' }, i),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        attempt({ outcome: 'failed', daysAgo: 10 - i, commit: 'bad-sha' }, i + 50),
      ),
    ];
    expect(verdict(attempts).classification.class).toBe('genuine-regression');
  });
});
