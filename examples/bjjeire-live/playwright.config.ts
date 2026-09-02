import { defineConfig } from '@playwright/test';

/**
 * Runs against a locally provisioned BjjEire environment (minikube, port 8080).
 * Unlike examples/smoke, this exercises the capture fixtures against a real
 * single-page app — real ARIA tree, real test ids, real network.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  expect: { timeout: 4_000 },
  reporter: [
    ['list'],
    ['@aplaytest/runner-playwright/reporter', { runId: 'live-run' }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    headless: true,
    testIdAttribute: 'data-testid',
  },
});
