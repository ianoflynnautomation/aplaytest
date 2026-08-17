import { describe, expect, it } from 'vitest';

import {
  domainStringArgs,
  extractSteps,
  findFailingStep,
  parseStepTitle,
  type StepLike,
} from '../src/steps.js';

function step(partial: Partial<StepLike> & { title: string }): StepLike {
  return {
    category: 'test.step',
    duration: 10,
    startTime: new Date('2026-08-16T12:00:00.000Z'),
    steps: [],
    ...partial,
  };
}

describe('parseStepTitle', () => {
  it('splits a bound page-object call into object and method', () => {
    expect(parseStepTitle("gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })")).toEqual({
      pageObject: 'gymsPage',
      method: 'expectCardData',
      argsPreview: "{ name: 'Blackwater Valley BJJ' }",
    });
  });

  it('handles a no-argument call', () => {
    expect(parseStepTitle('gymsPage.goTo()')).toMatchObject({
      pageObject: 'gymsPage',
      method: 'goTo',
      argsPreview: '',
    });
  });

  it('returns null for a free-form step title', () => {
    expect(parseStepTitle('given the user is signed in')).toBeNull();
  });
});

describe('domainStringArgs', () => {
  it('pulls the domain values a heal engine can match against the ARIA tree', () => {
    expect(domainStringArgs("{ name: 'Blackwater Valley BJJ', county: 'Cork' }")).toEqual([
      'Blackwater Valley BJJ',
      'Cork',
    ]);
  });

  it('de-duplicates repeated values', () => {
    expect(domainStringArgs("'Cork', 'Cork'")).toEqual(['Cork']);
  });

  it('ignores single characters that are almost certainly not domain values', () => {
    expect(domainStringArgs("'a', 'Cork'")).toEqual(['Cork']);
  });
});

describe('extractSteps', () => {
  it('flattens nested user steps in order and ignores runner-internal ones', () => {
    const steps = extractSteps([
      step({ title: 'gymsPage.goTo()' }),
      step({
        title: 'gymsPage.searchFor(\'Blackwater\')',
        steps: [
          // Playwright's own categories must not pollute the domain trail.
          step({ title: 'locator.fill', category: 'pw:api' }),
        ],
      }),
    ]);

    expect(steps.map(s => `${s.pageObject}.${s.method}`)).toEqual([
      'gymsPage.goTo',
      'gymsPage.searchFor',
    ]);
  });

  it('records domain arguments on each step', () => {
    const [first] = extractSteps([step({ title: "gymsPage.searchFor('Blackwater')" })]);
    expect(first?.args).toEqual(['Blackwater']);
  });
});

describe('findFailingStep', () => {
  it('returns the DEEPEST failing step, not the outermost', () => {
    // Playwright marks every ancestor of a failure as failed, so the outermost
    // failed step is usually the whole test body — useless for diagnosis.
    const failing = findFailingStep([
      step({
        title: 'gymsPage.runScenario()',
        error: new Error('outer'),
        steps: [
          step({
            title: "gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })",
            error: new Error('inner'),
          }),
        ],
      }),
    ]);

    expect(failing?.method).toBe('expectCardData');
    expect(failing?.args).toEqual(['Blackwater Valley BJJ']);
  });

  it('returns null when nothing failed', () => {
    expect(findFailingStep([step({ title: 'gymsPage.goTo()' })])).toBeNull();
  });
});
