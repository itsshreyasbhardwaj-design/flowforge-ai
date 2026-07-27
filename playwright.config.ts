import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against a real dev server with the default offline configuration —
 * no API keys, no external services. A test that needs a key does not belong here.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    colorScheme: 'dark',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Tests run against a production build, not `next dev`. Dev-mode compiles each
  // route on first request, which made timings depend on which worker got there
  // first — and it is the built artifact users actually run.
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { FLOWFORGE_DATA_FILE: '.flowforge/e2e-store.json' },
  },
});
