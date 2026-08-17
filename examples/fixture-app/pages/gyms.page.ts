import { expect, type Page } from '@playwright/test';

/** Mirrors the function-module shape used in bjjeire-tests. */
export const TEST_IDS = {
  header: 'gyms-page-header',
  search: 'gyms-page-search',
  searchInput: 'search-input',
  countyFilter: 'county-filter',
  listItem: 'gyms-list-item',
  cardName: 'gym-card-name',
  emptyState: 'gyms-empty-state',
  errorState: 'gyms-error-state',
} as const;

export async function goTo(page: Page): Promise<void> {
  await page.goto('/gyms');
}

export async function verifyIsLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.header)).toBeVisible();
}

export async function searchFor(page: Page, term: string): Promise<void> {
  await page.getByTestId(TEST_IDS.search).getByTestId(TEST_IDS.searchInput).fill(term);
}

export async function filterByCounty(page: Page, county: string): Promise<void> {
  await page.getByTestId(TEST_IDS.countyFilter).selectOption(county);
}

export async function expectCardVisible(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.cardName).filter({ hasText: name })).toBeVisible();
}

export async function expectCardAbsent(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.cardName).filter({ hasText: name })).toHaveCount(0);
}

/** The assertion that makes `unfiltered` bite: it pins the RESULT SET size. */
export async function expectCardCount(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.listItem)).toHaveCount(count);
}

export async function expectEmptyState(page: Page): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.emptyState)).toBeVisible();
}
