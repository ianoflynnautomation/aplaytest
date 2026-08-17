import { defineConfig } from '@playwright/test';

import { FIXTURE_PORT } from './global-setup.js';

/**
 * Runs against the bundled fixture app — no minikube, no Docker, no network.
 * This is the config CI uses to prove the falsifiability gate actually kills
 * tests, which `examples/smoke` cannot do because it has no API to mutate.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 20_000,
  expect: { timeout: 4_000 },
  reporter: [['list'], ['@atest/runner-playwright/reporter', { runId: 'fixture-run' }]],
  use: {
    baseURL: `http://127.0.0.1:${FIXTURE_PORT}`,
    headless: true,
    testIdAttribute: 'data-testid',
  },
});
