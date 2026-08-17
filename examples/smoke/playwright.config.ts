import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10_000,
  reporter: [
    ['list'],
    ['@atest/runner-playwright/reporter', {
      evidenceDir: '.atest/evidence',
      runsDir: '.atest/runs',
      runId: 'smoke-run',
      traceId: (test: { id: string }, retry: number) => `trace-${test.id}-${retry}`,
    }],
  ],
  use: { headless: true },
});
