import { test as base } from '@playwright/test';
import { atestFixtures, bindPage, type BoundPageObject } from '@aplaytest/runner-playwright';

import * as GymsPageMod from '../pages/gyms.page.js';

export const test = base.extend<{ gymsPage: BoundPageObject<typeof GymsPageMod> }>({
  ...atestFixtures,
  gymsPage: async ({ page }, use) => {
    await use(bindPage(GymsPageMod, page, 'gymsPage'));
  },
});

export { expect } from '@playwright/test';
