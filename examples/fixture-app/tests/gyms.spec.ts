import { test } from './fixtures.js';

/**
 * Three tests, chosen so the gate has something to prove on each.
 *
 * Unmutated they all pass, which is the point: a reviewer reading a green run
 * cannot tell them apart. The gate can.
 */

test('MEANINGFUL: filtering by county narrows the list to that county', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.verifyIsLoaded();
  await gymsPage.filterByCounty('Dublin');

  // Pinning the count is what dies against `unfiltered`: with the query
  // stripped the server returns all six gyms and this becomes 6, not 2.
  await gymsPage.expectCardCount(2);
  await gymsPage.expectCardVisible('Liffey Grappling Club');
  await gymsPage.expectCardAbsent('011 Grappling');
});

test('MEANINGFUL: a gym can be found by name', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.searchFor('Blackwater');
  await gymsPage.expectCardCount(1);
  await gymsPage.expectCardVisible('Blackwater Valley BJJ');
});

test('VACUOUS: asserts only that the page rendered', async ({ gymsPage }) => {
  // The shape LLM test generation produces by default, and the shape a tired
  // human produces at 5pm: navigate, assert the chrome, call it coverage. It
  // would not notice if filtering stopped working entirely.
  await gymsPage.goTo();
  await gymsPage.filterByCounty('Dublin');
  await gymsPage.verifyIsLoaded();
});
