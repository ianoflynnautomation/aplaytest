import { expect, test } from './fixtures.js';

/**
 * Two candidates for the falsifiability gate, one of each kind.
 *
 * The vacuous one is not a strawman — it is the exact shape LLM test
 * generation produces by default: navigate, assert the page header, call it
 * search coverage. It passes, it reviews cleanly, and it would not notice if
 * search stopped working entirely.
 */

test('MEANINGFUL: search narrows the list to the searched gym', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.searchFor('011 Grappling');
  await gymsPage.expectCardData({ name: '011 Grappling' });
});

test('VACUOUS: asserts only that the page rendered', async ({ gymsPage, page }) => {
  await gymsPage.goTo();
  await gymsPage.searchFor('011 Grappling');
  await expect(page.getByTestId('gyms-page-header')).toBeVisible();
});
