import { describe, expect, it } from 'vitest';

import { interpret, type BisectProbe } from '../src/bisect.js';

function probe(overrides: Partial<BisectProbe> & { setting: string }): BisectProbe {
  const total = overrides.total ?? 20;
  const failed = overrides.failed ?? 0;
  return {
    dimension: 'workers',
    passed: total - failed,
    failed,
    total,
    durationMs: 1_000,
    inconclusive: false,
    ...overrides,
  };
}

describe('interpret — the footer flake shape', () => {
  it('given probes whose failure rate rises monotonically with worker count -> when interpret reads them -> then the class is resource-contention with high confidence and healing is ruled out', { tags: ['@unit', '@flaky'] }, () => {
    // This is the measurement bisect exists to produce: the classifier can
    // only infer load dependency from history, whereas these numbers came from
    // running the test.
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 0 }),
      probe({ setting: 'workers=4', failed: 1 }),
      probe({ setting: 'workers=8', failed: 9 }),
    ]);

    expect(verdict.class).toBe('resource-contention');
    expect(verdict.confidence).toBe('high');
    expect(verdict.evidence.join(' ')).toContain('monotonic');
    // Bisect must say plainly that healing does not apply here.
    expect(verdict.recommendation).toContain('Healing is not applicable');
  });

  it('given probes whose failure rate rises but not monotonically -> when interpret reads them -> then the class is resource-contention with confidence lowered to medium', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 0 }),
      probe({ setting: 'workers=4', failed: 8 }),
      probe({ setting: 'workers=8', failed: 6 }),
    ]);

    expect(verdict.class).toBe('resource-contention');
    expect(verdict.confidence).toBe('medium');
  });

  it('given probes whose failure rate is unchanged by worker count -> when interpret reads them -> then the class is not resource-contention', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 4 }),
      probe({ setting: 'workers=8', failed: 4 }),
    ]);
    expect(verdict.class).not.toBe('resource-contention');
  });
});

describe('interpret — isolation', () => {
  it('given a probe passing alone and failing with the whole file -> when interpret reads them -> then the class is test-pollution and retry is ruled out', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ dimension: 'isolation', setting: 'alone', failed: 0 }),
      probe({ dimension: 'isolation', setting: 'whole file', failed: 9 }),
    ]);

    expect(verdict.class).toBe('test-pollution');
    expect(verdict.recommendation).toContain('shared state');
    expect(verdict.recommendation).toContain('Retrying will not help');
  });
});

describe('interpret — honest non-answers', () => {
  it('given probes in which nothing failed -> when interpret reads them -> then the class is not-reproduced rather than an invented cause', { tags: ['@unit', '@flaky'] }, () => {
    // Reaching for a class when nothing failed is how a bisect tool starts
    // manufacturing explanations.
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 0 }),
      probe({ setting: 'workers=8', failed: 0 }),
    ]);

    expect(verdict.class).toBe('not-reproduced');
    expect(verdict.confidence).toBe('high');
    expect(verdict.recommendation).toContain('outside the dimensions probed');
  });

  it('given probes that were all inconclusive -> when interpret reads them -> then the class is unclassified and the evidence says inconclusive', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ setting: 'workers=1', inconclusive: true, total: 0 }),
      probe({ setting: 'workers=8', inconclusive: true, total: 0 }),
    ]);

    expect(verdict.class).toBe('unclassified');
    expect(verdict.evidence.join(' ')).toContain('inconclusive');
  });

  it('given one inconclusive probe and one that failed outright -> when interpret reads them -> then the class is not not-reproduced', { tags: ['@unit', '@flaky'] }, () => {
    // An inconclusive probe means the run never executed — a config error or a
    // grep that matched nothing. Treating it as a pass would let bisect
    // conclude "not reproduced" from a broken invocation.
    const verdict = interpret([
      probe({ setting: 'workers=1', inconclusive: true, total: 0 }),
      probe({ setting: 'workers=8', failed: 10, total: 10 }),
    ]);

    expect(verdict.class).not.toBe('not-reproduced');
  });

  it('given probes that failed at every setting -> when interpret reads them -> then the class is consistently-failing and the advice is to fix or delete it', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 20 }),
      probe({ setting: 'workers=8', failed: 20 }),
    ]);

    expect(verdict.class).toBe('consistently-failing');
    expect(verdict.recommendation).toContain('Fix it or delete it');
  });

  it('given probes that reproduce failures at a similar rate everywhere -> when interpret reads them -> then the class is unclassified and says the cause is outside what was measured', { tags: ['@unit', '@flaky'] }, () => {
    const verdict = interpret([
      probe({ setting: 'workers=1', failed: 3 }),
      probe({ setting: 'workers=8', failed: 4 }),
    ]);

    expect(verdict.class).toBe('unclassified');
    expect(verdict.recommendation).toContain('outside what was measured');
  });
});

describe('interpret — attribution', () => {
  it('given isolation probes counting only the target spec and neither failing -> when interpret reads them -> then the class is not-reproduced rather than test-pollution', { tags: ['@unit', '@flaky'] }, () => {
    // REGRESSION GUARD from a real bisect run: the "whole file" probe runs
    // neighbours too, and aggregate stats charged THEIR failures to the test
    // under examination — reading as "passes alone, fails together" and
    // manufacturing a test-pollution verdict from an unrelated broken test.
    // Probes now count only the target spec, so this shape means what it says.
    const verdict = interpret([
      probe({ dimension: 'isolation', setting: 'alone', failed: 0, total: 5 }),
      probe({ dimension: 'isolation', setting: 'whole file', failed: 0, total: 5 }),
    ]);

    expect(verdict.class).toBe('not-reproduced');
  });
});
