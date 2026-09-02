import { describe, expect, it } from 'vitest';

import { previewArgs, previewValue } from '../src/bind.js';
import { domainStringArgs, parseStepTitle } from '../src/steps.js';

describe('previewValue', () => {
  it('given an object argument -> when previewValue renders it -> then it reads the way a developer would write it rather than as JSON', { tags: ['@unit', '@runner'] }, () => {
    // Load-bearing: domain-value extraction pulls quoted literals out of this
    // string, so JSON's quoted KEYS would arrive looking like values.
    expect(previewValue({ name: 'Blackwater Valley BJJ' })).toBe(
      "{ name: 'Blackwater Valley BJJ' }",
    );
  });

  it('given object keys both valid and invalid as identifiers -> when previewValue renders them -> then only the invalid ones are quoted', { tags: ['@unit', '@runner'] }, () => {
    expect(previewValue({ 'data-id': 1 })).toBe("{ 'data-id': 1 }");
  });

  it('given an object carrying a sensitive key -> when previewValue renders it -> then the value is redacted rather than printed into the step title', { tags: ['@unit', '@runner'] }, () => {
    const out = previewValue({ username: 'ian', password: 'hunter2' });
    expect(out).toContain("username: 'ian'");
    expect(out).not.toContain('hunter2');
  });

  it('given a deeply nested object -> when previewValue renders it -> then the depth is capped', { tags: ['@unit', '@runner'] }, () => {
    expect(previewValue({ a: { b: { c: { d: 1 } } } })).toContain('{…}');
  });

  it('given scalars and collections -> when previewValue renders each -> then every ordinary case is rendered readably', { tags: ['@unit', '@runner'] }, () => {
    expect(previewValue(null)).toBe('null');
    expect(previewValue(undefined)).toBe('undefined');
    expect(previewValue(42)).toBe('42');
    expect(previewValue(true)).toBe('true');
    expect(previewValue(['Cork', 'Dublin'])).toBe("['Cork', 'Dublin']");
    expect(previewValue({})).toBe('{}');
  });

  it('given a string containing a quote -> when previewValue renders it -> then the quote is escaped so the step title stays parseable', { tags: ['@unit', '@runner'] }, () => {
    expect(previewValue("O'Brien's Gym")).toBe("'O\\'Brien\\'s Gym'");
  });
});

describe('previewArgs', () => {
  it('given arguments whose preview exceeds the length limit -> when previewArgs renders them -> then the preview is truncated', { tags: ['@unit', '@runner'] }, () => {
    const long = previewArgs([{ description: 'x'.repeat(400) }]);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('round trip: bind → step title → domain values', () => {
  it('given a bound page-object call -> when it round-trips through the step title back to domain values -> then the values the heal engine needs survive', { tags: ['@unit', '@runner'] }, () => {
    // This is the contract that makes intent useful: whatever bind writes,
    // the reporter must be able to read back as object, method, and the
    // domain values to match against the ARIA tree.
    const title = `gymsPage.expectCardData(${previewArgs([{ name: 'Blackwater Valley BJJ', county: 'Cork' }])})`;

    const parsed = parseStepTitle(title);
    expect(parsed?.pageObject).toBe('gymsPage');
    expect(parsed?.method).toBe('expectCardData');

    // Keys must NOT appear as domain values.
    expect(domainStringArgs(parsed?.argsPreview ?? '')).toEqual([
      'Blackwater Valley BJJ',
      'Cork',
    ]);
  });

  it('given a bound call carrying an object argument -> when domain values are recovered from the step title -> then the object keys are not among them', { tags: ['@unit', '@runner'] }, () => {
    const title = `gymsPage.searchFor(${previewArgs(['Blackwater'])})`;
    const parsed = parseStepTitle(title);
    expect(domainStringArgs(parsed?.argsPreview ?? '')).toEqual(['Blackwater']);
  });
});
