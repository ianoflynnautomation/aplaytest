import { test as base } from '@playwright/test';
import { atestApiFixtures } from '@aplaytest/runner-playwright';

/** An API-project barrel: capture, but never a browser. */
export const test = base.extend({ ...atestApiFixtures });
export { expect } from '@playwright/test';
