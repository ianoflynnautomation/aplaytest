import { describe, expect, it } from 'vitest';

import { findConstant, patchConstant } from '../src/patch.js';

/** Modelled on a real constants file, including the shared-literal trap. */
const CONSTANTS = `export const GYM_CARD_TEST_IDS = {
  classes: 'gym-card-classes',
  county: 'gym-card-county',
  name: 'gym-card-name',
} as const;

export const TEST_IDS = {
  cardName: 'gym-card-name',
  countySelect: 'select-filter-select',
  searchInput: 'search-input',
} as const;
`;

const FILE = 'src/ui/pages/gyms/gyms.constants.ts';

describe('patchConstant', () => {
  it('updates EVERY constant sharing the literal', () => {
    // The trap this exists for: 'gym-card-name' is bound to both
    // GYM_CARD_TEST_IDS.name and TEST_IDS.cardName, read by different page
    // objects. A regex fixes one and produces a patch that passes its own
    // validation while breaking the file's other tests.
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });

    expect(result.status).toBe('applied');
    expect(result.touched.map(t => t.path).sort()).toEqual([
      'GYM_CARD_TEST_IDS.name',
      'TEST_IDS.cardName',
    ]);
    expect(result.after).not.toContain('gym-card-name');
    expect((result.after ?? '').match(/gym-card-title/g)).toHaveLength(2);
  });

  it('says how many constants it touched', () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.message).toContain('2 constants sharing that literal');
  });

  it('leaves near-miss literals alone', () => {
    // gym-card-county must survive a rename of gym-card-name.
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.after).toContain("county: 'gym-card-county'");
    expect(result.after).toContain("searchInput: 'search-input'");
  });

  it('reports not-found rather than editing something adjacent', () => {
    const result = patchConstant(CONSTANTS, { file: FILE, from: 'missing-id', to: 'x' });
    expect(result.status).toBe('not-found');
    expect(result.after).toBeNull();
  });

  it('refuses a no-op replacement', () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-name',
    });
    expect(result.status).toBe('unchanged');
  });

  it('records the line of each change', () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.touched.every(t => t.line > 0)).toBe(true);
  });

  it('handles a bare exported constant, not just object properties', () => {
    const source = `export const SEARCH_INPUT = 'search-input';`;
    const result = patchConstant(source, { file: FILE, from: 'search-input', to: 'search-field' });

    expect(result.status).toBe('applied');
    expect(result.touched[0]?.path).toBe('SEARCH_INPUT');
    expect(result.after).toContain("'search-field'");
  });
});

describe('patchConstant — page objects and specs', () => {
  it('rewrites an inline getByTestId in a spec, the snapshot-test shape', () => {
    const source = `await expect(page.getByTestId('gyms-page-header')).toHaveScreenshot('gyms-header.png');\n`;
    const result = patchConstant(source, {
      file: 'tests/features/gyms/gyms.snapshot.acceptance.spec.ts',
      from: 'gyms-page-header',
      to: 'gyms-header',
    });
    expect(result.status).toBe('applied');
    expect(result.after).toContain("getByTestId('gyms-header')");
  });

  it('rewrites a getByRole name in a page object', () => {
    const source = `const typeFilterButton = (page: Page, label: string) => filters(page).getByRole('button', { name: 'Seminars', exact: true });\n`;
    const result = patchConstant(source, {
      file: 'src/ui/pages/events/events.page.ts',
      from: 'Seminars',
      to: 'Seminar',
    });
    expect(result.status).toBe('applied');
    expect(result.after).toContain("name: 'Seminar'");
  });
});

describe('findConstant', () => {
  it('locates a selector without changing anything', () => {
    // The difference between "the selector broke" and "the selector broke,
    // here is the line".
    const found = findConstant(CONSTANTS, FILE, 'gym-card-name');
    expect(found).toHaveLength(2);
    expect(found.map(f => f.path).sort()).toEqual(['GYM_CARD_TEST_IDS.name', 'TEST_IDS.cardName']);
  });

  it('returns empty for an unknown value', () => {
    expect(findConstant(CONSTANTS, FILE, 'nope')).toEqual([]);
  });
});

describe('patchConstant — style preservation', () => {
  it('keeps the quote style the file already uses', () => {
    // A patch that switches a single-quoted file to double quotes fights the
    // formatter and turns a one-word change into a noisy diff.
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.after).toContain("cardName: 'gym-card-title'");
    expect(result.after).not.toContain('"gym-card-title"');
  });

  it('keeps double quotes when that is what the file uses', () => {
    const source = `export const IDS = { name: "gym-card-name" };`;
    const result = patchConstant(source, { file: FILE, from: 'gym-card-name', to: 'gym-card-title' });
    expect(result.after).toContain('"gym-card-title"');
  });

  it('escapes a quote that appears inside the replacement', () => {
    const source = `export const IDS = { label: 'plain' };`;
    const result = patchConstant(source, { file: FILE, from: 'plain', to: "it's" });
    expect(result.after).toContain("'it\\'s'");
  });
});
