import { defineConfig, devices } from '@playwright/test'

const astroURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321'
const nextjsURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3000'
const adminURL = process.env.NYMBAL_ADMIN_URL ?? 'http://localhost:5174'
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
      testIgnore: ['**/journeys/admin/**'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroURL,
      },
    },
    {
      name: 'nextjs',
      testIgnore: ['**/journeys/admin/**'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsURL,
      },
    },
    {
      name: 'astro-mobile',
      testIgnore: ['**/journeys/admin/**'],
      use: {
        ...devices['iPhone 14'],
        baseURL: astroURL,
      },
      grep: /@visual/,
    },
    {
      name: 'nextjs-mobile',
      testIgnore: ['**/journeys/admin/**'],
      use: {
        ...devices['iPhone 14'],
        baseURL: nextjsURL,
      },
      grep: /@visual/,
    },
    {
      name: 'admin',
      testMatch: ['**/journeys/admin/**/*.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: adminURL,
      },
    },
    {
      name: 'admin-mobile',
      testMatch: ['**/journeys/admin/**/*.spec.ts'],
      use: {
        ...devices['iPhone 14'],
        baseURL: adminURL,
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
      env: {
        NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
        PUBLIC_NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
      },
    },
    {
      command: 'pnpm --filter @nymbal/template-nextjs dev',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
        NEXT_PUBLIC_NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
      },
    },
    {
      command: 'pnpm --filter @nymbal/admin preview --port 5174',
      url: 'http://localhost:5174',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ] : undefined,
})
