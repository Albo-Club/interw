import { defineConfig, devices } from '@playwright/test'

// The candidate interview end to end, against a real deployment — see
// e2e/interview.spec.ts. Needs the app built (`pnpm build:app`) against that
// deployment, and CONVEX_DEPLOY_KEY in the environment for the seed and the
// database check.
export default defineConfig({
  testDir: 'e2e',
  // Every test seeds a session on a shared deployment: one at a time.
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
