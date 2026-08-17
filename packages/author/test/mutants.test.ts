import { describe, expect, it } from 'vitest';

import { MEANINGFUL_CLASSES, applyMutant, buildMutants, hasMutant, stripMutant } from '../src/mutants.js';
import type { MutantClass, MutantName } from '../src/mutants.js';
import { evaluateGate } from '../src/gate.js';
import type { MutantOutcome } from '../src/gate.js';
import { extractSignatures } from '../src/ground.js';

const SPEC = `import { expect, test } from './fixtures.js';

test('a gym can be found', async ({ gymsPage }) => {
  await gymsPage.goTo();
});
`;

describe('buildMutants', () => {
  it('produces every mutant with runnable-looking code', () => {
    const mutants = buildMutants();
    expect(mutants).toHaveLength(3);
    for (const mutant of mutants) {
      expect(mutant.code).toContain('test.beforeEach');
      expect(mutant.code).toContain('page.route');
    }
  });

  it('honours a custom api pattern', () => {
    const [first] = buildMutants({ apiPattern: '**/graphql' });
    expect(first?.code).toContain('**/graphql');
  });

  it('classes http-500 as liveness only', () => {
    // Measured against the live app: a deliberately vacuous test was killed by
    // http-500 and nothing else. Counting that as falsifiability would certify
    // a test whose only assertion is that a header rendered.
    const http500 = buildMutants().find(m => m.name === 'http-500');
    expect(http500?.class).toBe('liveness');
    expect(MEANINGFUL_CLASSES.has('liveness')).toBe(false);
    expect(MEANINGFUL_CLASSES.has('content')).toBe(true);
    expect(MEANINGFUL_CLASSES.has('discrimination')).toBe(true);
  });
});

describe('applyMutant', () => {
  it('injects AFTER the imports', () => {
    // The block references the spec's own `test` binding. Injecting above the
    // import hits the temporal dead zone and throws a ReferenceError, which
    // the gate would misread as the mutant killing the test — certifying a
    // test that asserts nothing.
    const mutant = buildMutants()[0];
    expect(mutant).toBeDefined();
    const out = applyMutant(SPEC, mutant!);

    const importLine = out.indexOf("import { expect, test }");
    const injected = out.indexOf('test.beforeEach');
    const firstTest = out.indexOf("test('a gym can be found'");

    expect(importLine).toBeLessThan(injected);
    expect(injected).toBeLessThan(firstTest);
  });

  it('handles a multi-line import block', () => {
    const source = `import {
  expect,
  test,
} from './fixtures.js';

test('x', async () => {});
`;
    const out = applyMutant(source, buildMutants()[0]!);
    expect(out.indexOf("} from './fixtures.js';")).toBeLessThan(out.indexOf('test.beforeEach'));
  });

  it('is not fooled by the word import inside a leading block comment', () => {
    const source = `/**
 * This spec is important.
 */
import { test } from './fixtures.js';

test('x', async () => {});
`;
    const out = applyMutant(source, buildMutants()[0]!);
    expect(out.indexOf("import { test }")).toBeLessThan(out.indexOf('test.beforeEach'));
  });

  it('round-trips exactly, so a restore cannot leave residue', () => {
    const out = applyMutant(SPEC, buildMutants()[0]!);
    expect(hasMutant(out)).toBe(true);
    expect(stripMutant(out)).toBe(SPEC);
    expect(hasMutant(stripMutant(out))).toBe(false);
  });
});

describe('extractSignatures', () => {
  it('returns signatures, not bodies', () => {
    const source = `
export async function goTo(page: Page): Promise<void> {
  await page.goto('/gyms');
}
export async function expectCardData(page: Page, expected: { name: string }): Promise<void> {
  await expect(page.getByTestId('x')).toBeVisible();
}
`;
    const signatures = extractSignatures(source);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toBe('goTo(page: Page): Promise<void>');
    expect(signatures.join()).not.toContain('page.goto');
  });

  it('flattens a signature that spans several lines', () => {
    const source = `export async function search(
  page: Page,
  term: string,
): Promise<void> {}`;
    expect(extractSignatures(source)[0]).toBe('search(page: Page, term: string): Promise<void>');
  });

  it('ignores non-exported helpers', () => {
    expect(extractSignatures('function helper(x: number): void {}')).toHaveLength(0);
  });
});

describe('evaluateGate — the verdict rule', () => {
  const outcome = (name: MutantName, cls: MutantClass, killed: boolean): MutantOutcome => ({
    name,
    class: cls,
    killed,
    kills: '',
    inconclusive: false,
  });

  const stable = [{ name: 'stability' as const, ok: true, detail: 'passed 3/3' }];

  it('REJECTS a test killed only by the liveness mutant', () => {
    // The exact result a deliberately vacuous test produced against the live
    // app: navigate, assert the header, survive every data mutant.
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', false),
        outcome('unfiltered', 'discrimination', false),
        outcome('http-500', 'liveness', true),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('REJECTED');
  });

  it('accepts a test killed by a content mutant', () => {
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', true),
        outcome('unfiltered', 'discrimination', false),
        outcome('http-500', 'liveness', true),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(true);
  });

  it('still names the data mutants that survived', () => {
    // The real "search narrows the list" test survived `unfiltered`: the card
    // is present in the full dataset too, so the test never proved narrowing.
    // Passing the gate must not hide that.
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', true),
        outcome('unfiltered', 'discrimination', false),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toContain('survived unfiltered');
  });

  it('rejects when nothing was killed at all', () => {
    const result = evaluateGate({
      checks: stable,
      outcomes: [outcome('empty-page', 'content', false)],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(false);
  });

  it('cannot pass on falsifiability alone when stability failed', () => {
    const result = evaluateGate({
      checks: [{ name: 'stability', ok: false, detail: 'passed 2/3' }],
      outcomes: [outcome('empty-page', 'content', true)],
      stabilityRuns: 3,
      stabilityPassed: 2,
    });
    expect(result.passed).toBe(false);
  });
});
