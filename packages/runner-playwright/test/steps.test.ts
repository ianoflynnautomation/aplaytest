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
  it('given a step title written as a bound page-object call -> when parseStepTitle reads it -> then the object and method are split out', { tags: ['@unit', '@runner'] }, () => {
    expect(parseStepTitle("gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })")).toEqual({
      pageObject: 'gymsPage',
      method: 'expectCardData',
      argsPreview: "{ name: 'Blackwater Valley BJJ' }",
    });
  });

  it('given a bound call taking no arguments -> when parseStepTitle reads it -> then the object and method are still recovered', { tags: ['@unit', '@runner'] }, () => {
    expect(parseStepTitle('gymsPage.goTo()')).toMatchObject({
      pageObject: 'gymsPage',
      method: 'goTo',
      argsPreview: '',
    });
  });

  it('given a free-form step title -> when parseStepTitle reads it -> then it returns null rather than a guess', { tags: ['@unit', '@runner'] }, () => {
    expect(parseStepTitle('given the user is signed in')).toBeNull();
  });
});

describe('domainStringArgs', () => {
  it('given a bound call carrying string arguments -> when domainStringArgs reads it -> then the domain values a heal engine can match are returned', { tags: ['@unit', '@runner'] }, () => {
    expect(domainStringArgs("{ name: 'Blackwater Valley BJJ', county: 'Cork' }")).toEqual([
      'Blackwater Valley BJJ',
      'Cork',
    ]);
  });

  it('given a bound call repeating one argument value -> when domainStringArgs reads it -> then the value appears once', { tags: ['@unit', '@runner'] }, () => {
    expect(domainStringArgs("'Cork', 'Cork'")).toEqual(['Cork']);
  });

  it('given a bound call carrying single-character arguments -> when domainStringArgs reads it -> then those are ignored', { tags: ['@unit', '@runner'] }, () => {
    expect(domainStringArgs("'a', 'Cork'")).toEqual(['Cork']);
  });
});

describe('extractSteps', () => {
  it('given nested user steps alongside runner-internal ones -> when extractSteps reads them -> then the user steps are flattened in order and the internal ones dropped', { tags: ['@unit', '@runner'] }, () => {
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

  it('given steps carrying bound call titles -> when extractSteps reads them -> then each step records its domain arguments', { tags: ['@unit', '@runner'] }, () => {
    const [first] = extractSteps([step({ title: "gymsPage.searchFor('Blackwater')" })]);
    expect(first?.args).toEqual(['Blackwater']);
  });
});

describe('findFailingStep', () => {
  it('given nested steps where an inner one failed -> when findFailingStep searches them -> then the deepest failing step is returned', { tags: ['@unit', '@runner'] }, () => {
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

  it('given steps in which nothing failed -> when findFailingStep searches them -> then it returns null', { tags: ['@unit', '@runner'] }, () => {
    expect(findFailingStep([step({ title: 'gymsPage.goTo()' })])).toBeNull();
  });
});
