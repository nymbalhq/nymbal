import { defineConfig, devices } from '@playwright/test'

const astroURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321'
const nextjsURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3000'
// The admin is served by the API (`nymbal dev --api-only`) at /admin/, one origin with /api (P1-08).
const adminURL = process.env.NYMBAL_ADMIN_URL ?? 'http://localhost:3001/admin/'
const isCI = !!process.env.CI
const target = process.env.NYMBAL_E2E_TARGET
const isAdminE2E = process.env.NYMBAL_E2E_ADMIN === 'true' || target === 'admin'

// Servers are dev servers started in place: the packages they import come from the build, which this file never runs.
const apiServer = {
  command: 'node packages/cli/bin/nymbal.mjs dev --api-only',
  url: 'http://localhost:3001/health',
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
  },
}

// --ignore-lock: Astro 7 backgrounds `astro dev` under an AI agent, and Playwright would see the exit.
const astroServer = {
  command: 'pnpm --filter @nymbalhq/template-astro dev --ignore-lock',
  url: 'http://localhost:4321',
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 60000,
  env: {
    NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    PUBLIC_NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    NYMBAL_API_URL: 'http://localhost:3001',
    PUBLIC_NYMBAL_API_URL: 'http://localhost:3001',
  },
}

const nextjsServer = {
  command: 'pnpm --filter @nymbalhq/template-nextjs dev',
  url: 'http://localhost:3000',
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 60000,
  env: {
    NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    NEXT_PUBLIC_NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    NYMBAL_API_URL: 'http://localhost:3001',
    NEXT_PUBLIC_NYMBAL_API_URL: 'http://localhost:3001',
  },
}

/**
 * The API and what the run needs: NYMBAL_E2E_TARGET names one target, otherwise both templates. The admin needs the
 * API alone, which serves the built admin (`pnpm --filter @nymbalhq/admin build` first).
 */
function servers() {
  const targets = ['astro', 'nextjs', 'admin']
  if (target !== undefined && !targets.includes(target)) {
    throw new Error(`NYMBAL_E2E_TARGET must be one of ${targets.join(', ')}; got "${target}"`)
  }
  if (target === 'astro') return [apiServer, astroServer]
  if (target === 'nextjs') return [apiServer, nextjsServer]
  if (isAdminE2E) return [apiServer]
  return [apiServer, astroServer, nextjsServer]
}

export default defineConfig({
  testDir: './journeys',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/{testFileDir}/snapshots/{arg}-{projectName}{ext}',
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
        ...devices['Pixel 7'],
        baseURL: astroURL,
      },
      grep: /@visual/,
    },
    {
      name: 'nextjs-mobile',
      testIgnore: ['**/journeys/admin/**'],
      use: {
        ...devices['Pixel 7'],
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
        ...devices['Pixel 7'],
        baseURL: adminURL,
      },
      grep: /@visual/,
    },
  ],
  ...(isCI ? { webServer: servers() } : {}),
})
