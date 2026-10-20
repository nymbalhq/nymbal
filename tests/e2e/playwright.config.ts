import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI
const target = process.env.NYMBAL_E2E_TARGET
const isAdminE2E = process.env.NYMBAL_E2E_ADMIN === 'true' || target === 'admin'

// P2-05: the swap. `astro-custom` and `nextjs-custom` run the same journeys against the fixture store in
// tests/e2e/fixtures/custom-providers (search and payments `custom`, injected through its `adapters` export), on an API
// of its own on 3011 and a storefront of their own, so a custom run never reaches the native store on 3001. Each is
// its own invocation (NYMBAL_E2E_TARGET), as gate.ts runs one per target.
const CUSTOM_TARGETS = ['astro-custom', 'nextjs-custom']
const isCustom = target !== undefined && CUSTOM_TARGETS.includes(target)
const CUSTOM_API = 'http://localhost:3011'
const NATIVE_API = 'http://localhost:3001'
// The journeys read API_URL from here (support/csrf.ts); a custom run must point them at the fixture API, whatever
// the shell says, or its API assertions would read the native store.
if (isCustom) process.env.NYMBAL_API_URL = CUSTOM_API

const astroURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321'
const nextjsURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3000'
const astroCustomURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4331'
const nextjsCustomURL = process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3010'
// The admin is served by the API (`nymbal dev --api-only`) at /admin/, one origin with /api (P1-08).
const adminURL = process.env.NYMBAL_ADMIN_URL ?? 'http://localhost:3001/admin/'

// Every run gets a database of its own, as CI's fresh checkout does: the repo-root nymbal.db keeps what earlier runs
// created (products from `ownProduct`, orders), and a crashed run cleans nothing up. `dev` migrates and seeds an empty
// file. Set here once and inherited by the workers, which load this file again; set it to reuse a database.
const sqlitePath = (process.env.NYMBAL_E2E_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-${Date.now()}-${process.pid}.db`,
))
const customSqlitePath = (process.env.NYMBAL_E2E_CUSTOM_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-custom-${Date.now()}-${process.pid}.db`,
))

// Servers are dev servers started in place: the packages they import come from the build, which this file never runs.
const apiServer = {
  command: 'node scripts/e2e-server.mjs -- node packages/cli/bin/nymbal.mjs dev --api-only',
  url: `${NATIVE_API}/health`,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: sqlitePath,
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

/** The fixture store: `nymbal dev --api-only` from the fixture directory, so its nymbal.config.ts is the one loaded. */
const customApiServer = {
  command:
    'node ../../../../scripts/e2e-server.mjs -- node ../../../../packages/cli/bin/nymbal.mjs dev --api-only',
  url: `${CUSTOM_API}/health`,
  cwd: './fixtures/custom-providers',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: customSqlitePath,
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

// --ignore-lock: Astro 7 backgrounds `astro dev` under an AI agent, and Playwright would see the exit.
function astroServer(url: string, api: string) {
  return {
    command: `pnpm --filter @nymbalhq/template-astro dev --ignore-lock --port ${new URL(url).port}`,
    url,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NYMBAL_API_URL: api,
      PUBLIC_NYMBAL_API_URL: api,
    },
  }
}

function nextjsServer(url: string, api: string) {
  const port = new URL(url).port
  return {
    // The template's `dev` script pins 3000; another port runs the same `next dev` with its own -p.
    command:
      port === '3000'
        ? 'pnpm --filter @nymbalhq/template-nextjs dev'
        : `pnpm --filter @nymbalhq/template-nextjs exec next dev -p ${port}`,
    url,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NYMBAL_API_URL: api,
      NEXT_PUBLIC_NYMBAL_API_URL: api,
    },
  }
}

/**
 * The API and what the run needs: NYMBAL_E2E_TARGET names one target, otherwise both templates on the native store.
 * The admin needs the API alone, which serves the built admin (`pnpm --filter @nymbalhq/admin build` first).
 */
function servers() {
  const targets = ['astro', 'nextjs', 'admin', ...CUSTOM_TARGETS]
  if (target !== undefined && !targets.includes(target)) {
    throw new Error(`NYMBAL_E2E_TARGET must be one of ${targets.join(', ')}; got "${target}"`)
  }
  if (target === 'astro') return [apiServer, astroServer(astroURL, NATIVE_API)]
  if (target === 'nextjs') return [apiServer, nextjsServer(nextjsURL, NATIVE_API)]
  if (target === 'astro-custom') return [customApiServer, astroServer(astroCustomURL, CUSTOM_API)]
  if (target === 'nextjs-custom') {
    return [customApiServer, nextjsServer(nextjsCustomURL, CUSTOM_API)]
  }
  if (isAdminE2E) return [apiServer]
  return [apiServer, astroServer(astroURL, NATIVE_API), nextjsServer(nextjsURL, NATIVE_API)]
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
    // The same journey files on the fixture store. Visual snapshots are keyed by project and shot on the native
    // store, so the custom runs leave them out.
    {
      name: 'astro-custom',
      testIgnore: ['**/journeys/admin/**'],
      grepInvert: /@visual/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroCustomURL,
      },
    },
    {
      name: 'nextjs-custom',
      testIgnore: ['**/journeys/admin/**'],
      grepInvert: /@visual/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsCustomURL,
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
