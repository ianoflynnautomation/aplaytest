import { expect, type Page } from '@playwright/test';

// Mirrors the shape used in bjjeire-tests: function modules taking `page` first,
// with every selector funnelled through a constants object.
export const TEST_IDS = {
  header: 'gyms-page-header',
  headerTitle: 'gyms-page-header-title',
  search: 'gyms-page-search',
  searchInput: 'search-input',
  listItem: 'gyms-list-item',
  cardName: 'gym-card-name',
} as const;

export async function goTo(page: Page): Promise<void> {
  await page.goto('/gyms');
}

export async function verifyIsLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.header)).toBeVisible();
}

export async function searchFor(page: Page, term: string): Promise<void> {
  const input = page.getByTestId(TEST_IDS.search).getByTestId(TEST_IDS.searchInput);
  await input.clear();
  await input.fill(term);
}

export async function expectCardData(page: Page, expected: { name: string }): Promise<void> {
  const card = page
    .getByTestId(TEST_IDS.listItem)
    .filter({ has: page.getByTestId(TEST_IDS.cardName).filter({ hasText: expected.name }) });
  await expect(card).toBeVisible();
}

/**
 * Deliberately references a test id the application does not render, to
 * simulate the most common real-world failure: the app renamed a test id and
 * the suite has not caught up. This is the exact input the healing engine is
 * built to consume.
 */
export async function expectCardDataStale(page: Page, expected: { name: string }): Promise<void> {
  const card = page.getByTestId('gym-card-name-v1').filter({ hasText: expected.name });
  await expect(card).toBeVisible();
}

/**
 * Added because the author agent asked for it.
 *
 * Its plan named `unfiltered` as the mutation that should kill the test, then
 * it found it could not express that with the existing API — asserting a card
 * is visible stays true when the filter is bypassed and the full catalogue
 * comes back. Rather than inline a raw locator to fake the assertion, it set
 * needsNewPageObjectMethod and named this signature.
 */
export async function expectCardCount(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.listItem)).toHaveCount(count);
}
