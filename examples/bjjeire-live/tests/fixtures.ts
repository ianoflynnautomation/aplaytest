import { test as base } from '@playwright/test';
import { atestFixtures, bindPage, type BoundPageObject } from '@aplaytest/runner-playwright';

import * as GymsPageMod from '../pages/gyms.page.js';

export const test = base.extend<{ gymsPage: BoundPageObject<typeof GymsPageMod> }>({
  // `auto: true` inside atestFixtures means no spec ever mentions capture.
  ...atestFixtures,
  gymsPage: async ({ page }, use) => {
    // The third argument is the name that appears in step titles, and should
    // match the fixture name so the report speaks the same vocabulary as the test.
    await use(bindPage(GymsPageMod, page, 'gymsPage'));
  },
});

export { expect } from '@playwright/test';
