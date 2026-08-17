import { describe, expect, it } from 'vitest';

import { previewArgs, previewValue } from '../src/bind.js';
import { domainStringArgs, parseStepTitle } from '../src/steps.js';

describe('previewValue', () => {
  it('renders objects the way a developer would write them, not as JSON', () => {
    // Load-bearing: domain-value extraction pulls quoted literals out of this
    // string, so JSON's quoted KEYS would arrive looking like values.
    expect(previewValue({ name: 'Blackwater Valley BJJ' })).toBe(
      "{ name: 'Blackwater Valley BJJ' }",
    );
  });

  it('quotes keys only when they are not valid identifiers', () => {
    expect(previewValue({ 'data-id': 1 })).toBe("{ 'data-id': 1 }");
  });

  it('redacts sensitive values rather than printing them into a step title', () => {
    const out = previewValue({ username: 'ian', password: 'hunter2' });
    expect(out).toContain("username: 'ian'");
    expect(out).not.toContain('hunter2');
  });

  it('caps depth instead of expanding an arbitrarily nested object', () => {
    expect(previewValue({ a: { b: { c: { d: 1 } } } })).toContain('{…}');
  });

  it('handles the ordinary scalar and collection cases', () => {
    expect(previewValue(null)).toBe('null');
    expect(previewValue(undefined)).toBe('undefined');
    expect(previewValue(42)).toBe('42');
    expect(previewValue(true)).toBe('true');
    expect(previewValue(['Cork', 'Dublin'])).toBe("['Cork', 'Dublin']");
    expect(previewValue({})).toBe('{}');
  });

  it('escapes embedded quotes so the title stays parseable', () => {
    expect(previewValue("O'Brien's Gym")).toBe("'O\\'Brien\\'s Gym'");
  });
});

describe('previewArgs', () => {
  it('truncates a long preview rather than producing an unreadable title', () => {
    const long = previewArgs([{ description: 'x'.repeat(400) }]);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('round trip: bind → step title → domain values', () => {
  it('survives the whole path the heal engine depends on', () => {
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

  it('does not leak object keys as domain values', () => {
    const title = `gymsPage.searchFor(${previewArgs(['Blackwater'])})`;
    const parsed = parseStepTitle(title);
    expect(domainStringArgs(parsed?.argsPreview ?? '')).toEqual(['Blackwater']);
  });
});
