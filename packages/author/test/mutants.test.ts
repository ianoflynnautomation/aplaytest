import ts from 'typescript';
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
  it('given the default options -> when buildMutants runs -> then three mutants are produced, each registering a beforeEach route hook', { tags: ['@unit', '@author'] }, () => {
    const mutants = buildMutants();
    expect(mutants).toHaveLength(3);
    for (const mutant of mutants) {
      expect(mutant.code).toContain('test.beforeEach');
      expect(mutant.code).toContain('page.route');
    }
  });

  it('given a custom apiPattern -> when buildMutants runs -> then the generated code routes that pattern', { tags: ['@unit', '@author'] }, () => {
    const [first] = buildMutants({ apiPattern: '**/graphql' });
    expect(first?.code).toContain('**/graphql');
  });

  it('given the empty-page mutant -> when its generated code is inspected -> then it refetches rather than fulfilling a Response whose body was already read', { tags: ['@unit', '@author'] }, () => {
    // Playwright disposes the body after json()/text(). Passing that Response
    // to route.fulfill throws, the test fails, and the gate treats a vacuous
    // test as falsifiable.
    const empty = buildMutants().find(m => m.name === 'empty-page');
    expect(empty?.code).toContain('await fetch(request.url()');
    expect(empty?.code).not.toContain('route.fetch()');
    expect(empty?.code).not.toMatch(/fulfill\(\{\s*response/);
  });

  /**
   * REGRESSION GUARD, measured in CI: 3 failures in 6 runs, never once locally.
   *
   * A test whose last assertion reads something already in the initial HTML —
   * `expect(header).toBeVisible()`, the canonical VACUOUS shape — finishes
   * while the mutant's route handler is still awaiting the network. Playwright
   * closes the page, the in-flight call rejects, and an unhandled rejection in
   * a route handler fails the test. The gate scored that as a kill.
   *
   * That is the worst bug available in a falsifiability gate: it certifies a
   * vacuous test as meaningful, which is the exact failure the gate exists to
   * prevent. A mutant may only kill a test by changing what the app RETURNS.
   *
   * The signature that identified it: the vacuous fixture was killed by
   * `unfiltered` while SURVIVING `http-500`, which breaks the API outright. A
   * kill that a total outage does not reproduce was never about data.
   */
  describe('a closing page cannot count as a kill', () => {
    /** Runs a mutant's handler against fakes, so no browser is involved. */
    async function invokeHandler(
      code: string,
      { pageClosed, error }: { pageClosed: boolean; error: Error },
    ): Promise<'threw' | 'swallowed'> {
      const js = ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;

      let handler: ((route: unknown) => Promise<void>) | null = null;
      const page = {
        isClosed: () => pageClosed,
        route: (_pattern: string, fn: (route: unknown) => Promise<void>) => {
          handler = fn;
          return Promise.resolve();
        },
      };
      const fakeTest = { beforeEach: (fn: (args: unknown) => Promise<void>) => fn({ page }) };

      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      await new Function('test', `return (async () => { ${js} })()`)(fakeTest);
      if (handler === null) throw new Error('the mutant registered no route handler');

      // Every call the handler might make fails the way a disposed context does.
      const thrower = () => Promise.reject(error);
      const route = {
        request: () => ({
          url: () => 'http://localhost/api/gyms?county=Dublin',
          method: () => 'GET',
          headers: () => ({}),
        }),
        continue: thrower,
        fetch: thrower,
        fulfill: thrower,
      };

      try {
        await (handler as (route: unknown) => Promise<void>)(route);
        return 'swallowed';
      } catch {
        return 'threw';
      }
    }

    const teardown = new Error('Target page, context or browser has been closed');

    for (const mutant of buildMutants()) {
      it(`given the ${mutant.name} mutant and a page already closed -> when its route handler hits a teardown error -> then the error is swallowed`, { tags: ['@unit', '@author'] }, async () => {
        expect(await invokeHandler(mutant.code, { pageClosed: true, error: teardown })).toBe(
          'swallowed',
        );
      });

      /**
       * The other half of the contract. Swallowing unconditionally would hide a
       * genuinely broken mutant, which reports "killed 0/3" and blames the test
       * — a quieter version of the same lie.
       */
      it(`given the ${mutant.name} mutant and a page still open -> when its route handler hits a real failure -> then the error is thrown rather than swallowed`, { tags: ['@unit', '@author'] }, async () => {
        expect(
          await invokeHandler(mutant.code, { pageClosed: false, error: new Error('real failure') }),
        ).toBe('threw');
      });
    }
  });

  it('given the built mutants -> when their classes are inspected -> then http-500 is liveness and only content and discrimination count as meaningful', { tags: ['@unit', '@author'] }, () => {
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
  it('given a spec whose mutant block references its own test binding -> when applyMutant injects the block -> then it lands after the imports and before the first test', { tags: ['@unit', '@author'] }, () => {
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

  it('given a spec whose import statement spans several lines -> when applyMutant injects the block -> then it lands after the closing import line', { tags: ['@unit', '@author'] }, () => {
    const source = `import {
  expect,
  test,
} from './fixtures.js';

test('x', async () => {});
`;
    const out = applyMutant(source, buildMutants()[0]!);
    expect(out.indexOf("} from './fixtures.js';")).toBeLessThan(out.indexOf('test.beforeEach'));
  });

  it('given a spec whose leading block comment contains the word import -> when applyMutant injects the block -> then it lands after the real import', { tags: ['@unit', '@author'] }, () => {
    const source = `/**
 * This spec is important.
 */
import { test } from './fixtures.js';

test('x', async () => {});
`;
    const out = applyMutant(source, buildMutants()[0]!);
    expect(out.indexOf("import { test }")).toBeLessThan(out.indexOf('test.beforeEach'));
  });

  it('given a spec carrying an applied mutant -> when stripMutant restores it -> then the source matches the original exactly and no mutant is detected', { tags: ['@unit', '@author'] }, () => {
    const out = applyMutant(SPEC, buildMutants()[0]!);
    expect(hasMutant(out)).toBe(true);
    expect(stripMutant(out)).toBe(SPEC);
    expect(hasMutant(stripMutant(out))).toBe(false);
  });
});

describe('extractSignatures', () => {
  it('given a page object exporting two functions -> when extractSignatures reads it -> then the signatures are returned without their bodies', { tags: ['@unit', '@author'] }, () => {
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

  it('given an exported signature spanning several lines -> when extractSignatures reads it -> then the signature is flattened to one line', { tags: ['@unit', '@author'] }, () => {
    const source = `export async function search(
  page: Page,
  term: string,
): Promise<void> {}`;
    expect(extractSignatures(source)[0]).toBe('search(page: Page, term: string): Promise<void>');
  });

  it('given a non-exported helper function -> when extractSignatures reads it -> then no signature is returned', { tags: ['@unit', '@author'] }, () => {
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

  it('given a test killed only by the liveness mutant -> when evaluateGate scores it -> then the verdict is REJECTED', { tags: ['@unit', '@author'] }, () => {
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

  it('given a test killed by a content mutant -> when evaluateGate scores it -> then the gate passes', { tags: ['@unit', '@author'] }, () => {
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

  it('given a passing test that survived the unfiltered mutant -> when evaluateGate scores it -> then the summary still names the survivor', { tags: ['@unit', '@author'] }, () => {
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

  it('given a test no mutant killed -> when evaluateGate scores it -> then the gate fails', { tags: ['@unit', '@author'] }, () => {
    const result = evaluateGate({
      checks: stable,
      outcomes: [outcome('empty-page', 'content', false)],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(false);
  });

  it('given a killed content mutant but a failed stability check -> when evaluateGate scores it -> then the gate still fails', { tags: ['@unit', '@author'] }, () => {
    const result = evaluateGate({
      checks: [{ name: 'stability', ok: false, detail: 'passed 2/3' }],
      outcomes: [outcome('empty-page', 'content', true)],
      stabilityRuns: 3,
      stabilityPassed: 2,
    });
    expect(result.passed).toBe(false);
  });
});

describe('evaluateGate — an unreadable mutant run is not evidence', () => {
  const outcome = (
    name: MutantName,
    cls: MutantClass,
    killed: boolean,
    inconclusive = false,
  ): MutantOutcome => ({ name, class: cls, killed, kills: '', inconclusive });

  const stable = [{ name: 'stability' as const, ok: true, detail: 'passed 3/3' }];

  /**
   * REGRESSION GUARD, found by a CI failure that would not reproduce locally.
   *
   * A mutant "kill" used to fall back to the run's overall exit status when the
   * candidate could not be found in the results. Every environmental failure —
   * a crashed globalSetup, a port already bound, a dead worker — then produced
   * a run with no matching spec and `ok: false`, which the gate recorded as
   * the mutant killing the test.
   *
   * That is the worst direction for this error: a false kill makes a test that
   * asserts nothing look falsifiable, which is the single thing the gate exists
   * to catch.
   */
  it('given data mutants that could not be read -> when evaluateGate scores them -> then no unreadable mutant counts as a kill', { tags: ['@unit', '@author'] }, () => {
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', false, true),
        outcome('unfiltered', 'discrimination', false, true),
        outcome('http-500', 'liveness', true),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(false);
  });

  it('given one unreadable data mutant and one survivor -> when evaluateGate scores them -> then the verdict is UNDECIDABLE rather than REJECTED', { tags: ['@unit', '@author'] }, () => {
    // Rejecting on runs that never executed would say "this test asserts
    // nothing" when the truth is "we did not find out".
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', false, true),
        outcome('unfiltered', 'discrimination', false),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.undecidable).toBe(true);
    expect(result.summary).toContain('UNDECIDABLE');
    expect(result.summary).not.toContain('REJECTED');
  });

  it('given every data mutant read and none killing -> when evaluateGate scores them -> then the verdict is REJECTED and not undecidable', { tags: ['@unit', '@author'] }, () => {
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
    expect(result.undecidable).toBe(false);
    expect(result.summary).toContain('REJECTED');
  });

  it('given one killed content mutant and one unreadable mutant -> when evaluateGate scores them -> then the gate passes and is not undecidable', { tags: ['@unit', '@author'] }, () => {
    // Evidence of falsifiability is evidence, whatever happened elsewhere.
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', true),
        outcome('unfiltered', 'discrimination', false, true),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.passed).toBe(true);
    expect(result.undecidable).toBe(false);
  });

  it('given a content mutant inconclusive because the app was unreachable -> when evaluateGate scores it -> then the verdict is UNDECIDABLE rather than REJECTED', { tags: ['@unit', '@author'] }, () => {
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        {
          name: 'empty-page',
          class: 'content',
          killed: false,
          kills: '',
          inconclusive: true,
          detail: 'the app or browser was not reachable',
        },
        outcome('unfiltered', 'discrimination', false),
        outcome('http-500', 'liveness', false),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.undecidable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.summary).not.toContain('REJECTED');
  });

  it('given an unreadable liveness mutant alongside read data mutants -> when evaluateGate scores them -> then the gate is not undecidable and reports REJECTED', { tags: ['@unit', '@author'] }, () => {
    // http-500 never counts towards the verdict, so failing to read it
    // changes nothing.
    const result = evaluateGate({
      checks: stable,
      outcomes: [
        outcome('empty-page', 'content', false),
        outcome('unfiltered', 'discrimination', false),
        outcome('http-500', 'liveness', false, true),
      ],
      stabilityRuns: 3,
      stabilityPassed: 3,
    });
    expect(result.undecidable).toBe(false);
    expect(result.summary).toContain('REJECTED');
  });
});
