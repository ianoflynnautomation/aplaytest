import { expect, test } from './fixtures.js';

test('the gyms page loads', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.verifyIsLoaded();
});

test('a gym can be found by name', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.searchFor('011 Grappling');
  await gymsPage.expectCardData({ name: '011 Grappling' });
});

test('FAILS ON PURPOSE: a stale test id, as if the app renamed it', async ({ gymsPage }) => {
  await gymsPage.goTo();
  await gymsPage.searchFor('011 Grappling');
  await gymsPage.expectCardDataStale({ name: '011 Grappling' });
});
