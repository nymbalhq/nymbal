import { defineConfig, devices } from '@playwright/test'

const astroURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321'
const nextjsURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3000'
const isCI = !!process.env.CI

export default defineConfig({
  testDir: './journeys',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'astro',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroURL,
      },
    },
    {
      name: 'nextjs',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsURL,
      },
    },
    {
      name: 'astro-mobile',
      use: {
        ...devices['iPhone 14'],
        baseURL: astroURL,
      },
      grep: /@visual/,
    },
    {
      name: 'nextjs-mobile',
      use: {
        ...devices['iPhone 14'],
        baseURL: nextjsURL,
      },
      grep: /@visual/,
    },
  ],
  webServer: isCI ? [
    {
      command: 'pnpm --filter @nymbal/template-astro dev',
      url: 'http://localhost:4321',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'pnpm --filter @nymbal/template-nextjs dev',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ] : undefined,
})
