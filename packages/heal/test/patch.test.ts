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
  it('given one literal bound to two exported constants -> when patchConstant renames it -> then both bindings are updated and the old literal is gone', { tags: ['@unit', '@heal'] }, () => {
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

  it('given a literal shared by two constants -> when patchConstant renames it -> then the message reports how many constants were touched', { tags: ['@unit', '@heal'] }, () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.message).toContain('2 constants sharing that literal');
  });

  it('given constants holding near-miss literals -> when patchConstant renames one -> then the near misses survive unchanged', { tags: ['@unit', '@heal'] }, () => {
    // gym-card-county must survive a rename of gym-card-name.
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.after).toContain("county: 'gym-card-county'");
    expect(result.after).toContain("searchInput: 'search-input'");
  });

  it('given a literal that appears nowhere in the file -> when patchConstant runs -> then the status is not-found and nothing is rewritten', { tags: ['@unit', '@heal'] }, () => {
    const result = patchConstant(CONSTANTS, { file: FILE, from: 'missing-id', to: 'x' });
    expect(result.status).toBe('not-found');
    expect(result.after).toBeNull();
  });

  it('given a replacement identical to the original literal -> when patchConstant runs -> then the status is unchanged', { tags: ['@unit', '@heal'] }, () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-name',
    });
    expect(result.status).toBe('unchanged');
  });

  it('given a literal bound to two constants -> when patchConstant renames it -> then every recorded change carries its line number', { tags: ['@unit', '@heal'] }, () => {
    const result = patchConstant(CONSTANTS, {
      file: FILE,
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    expect(result.touched.every(t => t.line > 0)).toBe(true);
  });

  it('given a bare exported string constant -> when patchConstant renames it -> then the constant is rewritten and its path recorded', { tags: ['@unit', '@heal'] }, () => {
    const source = `export const SEARCH_INPUT = 'search-input';`;
    const result = patchConstant(source, { file: FILE, from: 'search-input', to: 'search-field' });

    expect(result.status).toBe('applied');
    expect(result.touched[0]?.path).toBe('SEARCH_INPUT');
    expect(result.after).toContain("'search-field'");
  });
});

describe('patchConstant — page objects and specs', () => {
  it('given a spec calling getByTestId inline -> when patchConstant renames the id -> then the inline call is rewritten', { tags: ['@unit', '@heal'] }, () => {
    const source = `await expect(page.getByTestId('gyms-page-header')).toHaveScreenshot('gyms-header.png');\n`;
    const result = patchConstant(source, {
      file: 'tests/features/gyms/gyms.snapshot.acceptance.spec.ts',
      from: 'gyms-page-header',
      to: 'gyms-header',
    });
    expect(result.status).toBe('applied');
    expect(result.after).toContain("getByTestId('gyms-header')");
  });

  it('given a page object naming a role accessible name -> when patchConstant renames it -> then the accessible name is rewritten', { tags: ['@unit', '@heal'] }, () => {
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
  it('given a literal bound to two constants -> when findConstant locates it -> then both binding paths are reported and nothing is changed', { tags: ['@unit', '@heal'] }, () => {
    // The difference between "the selector broke" and "the selector broke,
    // here is the line".
    const found = findConstant(CONSTANTS, FILE, 'gym-card-name');
    expect(found).toHaveLength(2);
    expect(found.map(f => f.path).sort()).toEqual(['GYM_CARD_TEST_IDS.name', 'TEST_IDS.cardName']);
  });

  it('given a value bound to no constant -> when findConstant locates it -> then the result is empty', { tags: ['@unit', '@heal'] }, () => {
    expect(findConstant(CONSTANTS, FILE, 'nope')).toEqual([]);
  });
});

describe('patchConstant — style preservation', () => {
  it('given a single-quoted constants file -> when patchConstant rewrites a literal -> then single quotes are preserved', { tags: ['@unit', '@heal'] }, () => {
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

  it('given a double-quoted constants file -> when patchConstant rewrites a literal -> then double quotes are preserved', { tags: ['@unit', '@heal'] }, () => {
    const source = `export const IDS = { name: "gym-card-name" };`;
    const result = patchConstant(source, { file: FILE, from: 'gym-card-name', to: 'gym-card-title' });
    expect(result.after).toContain('"gym-card-title"');
  });

  it('given a replacement value containing an apostrophe -> when patchConstant rewrites the literal -> then the apostrophe is escaped', { tags: ['@unit', '@heal'] }, () => {
    const source = `export const IDS = { label: 'plain' };`;
    const result = patchConstant(source, { file: FILE, from: 'plain', to: "it's" });
    expect(result.after).toContain("'it\\'s'");
  });
});
