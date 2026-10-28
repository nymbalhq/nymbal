import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { stack } from '../../scripts/stack'
import { e2eReporters } from './support/reporters'

const isCI = !!process.env.CI
const target = process.env.NYMBAL_E2E_TARGET
const isAdminE2E = process.env.NYMBAL_E2E_ADMIN === 'true' || target === 'admin'
// Every port is the stack slot's of the checkout this file sits in (scripts/stack.ts), wherever Playwright is started:
// slot 0, the main checkout and CI, is 3001, 4321 and the rest; a linked worktree's slot moves them all, so two
// worktrees run the suite at once. The slot is pinned in the environment for the workers, which load this file again.
const block = stack(fileURLToPath(new URL('.', import.meta.url)))
process.env.NYMBAL_STACK_SLOT = String(block.slot)
const local = (port: number): string => `http://localhost:${port}`

// The swap: `astro-custom` and `nextjs-custom` run the journeys tagged @capabilities against the fixture store in
// tests/e2e/fixtures/custom-providers (search and payments `custom`, injected through its `adapters` export), on an API
// of its own (3011 in slot 0) and a storefront of their own, so a custom run never reaches the native store. Each is
// its own invocation (NYMBAL_E2E_TARGET), as gate.ts runs one per target.
const CUSTOM_TARGETS = ['astro-custom', 'nextjs-custom']
// The mail outage journey (@mail-outage) on the custom store's API alone: Chaos applies to the whole Mailpit, so it is
// a target of its own, run after the custom ones, and no other project runs it.
const MAIL_OUTAGE = 'mail-outage'
const isCustom = target !== undefined && [...CUSTOM_TARGETS, MAIL_OUTAGE].includes(target)
const CUSTOM_API = local(block.customApi)
const NATIVE_API = local(block.api)
// The no-search store (tests/e2e/fixtures/no-search, search `custom` with no capability) on an API of its own, with
// storefronts of its own. `astro-nosearch` and `nextjs-nosearch` run only the journeys tagged @nosearch, and every
// other project leaves them out.
const NOSEARCH_TARGETS = ['astro-nosearch', 'nextjs-nosearch']
const isNoSearch = target !== undefined && NOSEARCH_TARGETS.includes(target)
const NOSEARCH_API = local(block.noSearchApi)
// The project-elements fixture (tests/e2e/fixtures/override-elements/elements/index.js, a project entry overriding
// nymbal-mini-cart) in place of each template's own elements entry, named by NYMBAL_ELEMENTS_ENTRY, on an API and
// storefronts of their own (the stack slot's overrideApi, astroOverride and nextjsOverride). `astro-override` and
// `nextjs-override` run only the journeys tagged @override, and every other project leaves them out.
const OVERRIDE_TARGETS = ['astro-override', 'nextjs-override']
const isOverride = target !== undefined && OVERRIDE_TARGETS.includes(target)
const OVERRIDE_API = local(block.overrideApi)
const OVERRIDE_ENTRY = fileURLToPath(
  new URL('./fixtures/override-elements/elements/index.js', import.meta.url),
)
// The journeys read NYMBAL_API_URL (support/csrf.ts and others, falling back to slot 0's 3001), so every run, the
// native one included, points them at its own API whatever the shell says, or their API assertions would read
// another store or another slot's.
process.env.NYMBAL_API_URL = isCustom
  ? CUSTOM_API
  : isNoSearch
    ? NOSEARCH_API
    : isOverride
      ? OVERRIDE_API
      : NATIVE_API

const astroURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.astro)
const nextjsURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.nextjs)
const astroCustomURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.astroCustom)
const nextjsCustomURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.nextjsCustom)
const astroNoSearchURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.astroNoSearch)
const nextjsNoSearchURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.nextjsNoSearch)
const astroOverrideURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.astroOverride)
const nextjsOverrideURL = process.env.NYMBAL_STOREFRONT_URL ?? local(block.nextjsOverride)
// The admin is served by the API (`nymbal dev --api-only`) at /admin/, one origin with /api.
const adminURL = process.env.NYMBAL_ADMIN_URL ?? `${NATIVE_API}/admin/`
/**
 * The origins an API accepts (its nymbal.config.ts reads NYMBAL_CORS_ORIGINS): the two storefronts that call it, one
 * origin when NYMBAL_STOREFRONT_URL names both.
 */
const corsOrigins = (...urls: string[]): string =>
  [...new Set(urls.map((url) => new URL(url).origin))].join(',')

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
const noSearchSqlitePath = (process.env.NYMBAL_E2E_NOSEARCH_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-nosearch-${Date.now()}-${process.pid}.db`,
))
const overrideSqlitePath = (process.env.NYMBAL_E2E_OVERRIDE_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-override-${Date.now()}-${process.pid}.db`,
))

// Where scripts/e2e-server.mjs records the store variables it starts the native API with (the database and the key
// prefix it makes for the run), so the rebuild journey runs `nymbal replay` against that same store.
const storeEnvFile = (process.env.NYMBAL_E2E_STORE_ENV_FILE ??= join(
  tmpdir(),
  `nymbal-e2e-store-env-${Date.now()}-${process.pid}.json`,
))

// Servers are dev servers started in place: the packages they import come from the build, which this file never runs.
const apiServer = {
  command: `node scripts/e2e-server.mjs -- node packages/cli/bin/nymbal.mjs dev --api-only --port ${block.api}`,
  url: `${NATIVE_API}/health`,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: sqlitePath,
    NYMBAL_CORS_ORIGINS: corsOrigins(astroURL, nextjsURL),
    NYMBAL_E2E_STORE_ENV_FILE: storeEnvFile,
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

/**
 * The Mailpit the fixture store sends its mail to: CI's service, which NYMBAL_TEST_MAILPIT_SMTP (`host:port`) names,
 * else the stack slot's compose Mailpit, so a worktree's store never mails slot 0's.
 */
const mailpitSmtpPort = process.env.NYMBAL_TEST_MAILPIT_SMTP
  ? new URL(`smtp://${process.env.NYMBAL_TEST_MAILPIT_SMTP}`).port
  : String(block.mailpitSmtp)

/** The fixture store: `nymbal dev --api-only` from the fixture directory, so its nymbal.config.ts is the one loaded. */
const customApiServer = {
  command: `node ../../../../scripts/e2e-server.mjs -- node ../../../../packages/cli/bin/nymbal.mjs dev --api-only --port ${block.customApi}`,
  url: `${CUSTOM_API}/health`,
  cwd: './fixtures/custom-providers',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: customSqlitePath,
    NYMBAL_CORS_ORIGINS: corsOrigins(astroCustomURL, nextjsCustomURL),
    NYMBAL_E2E_SMTP_PORT: mailpitSmtpPort,
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

/** The no-search store: `nymbal dev --api-only` from its fixture directory, as the custom store runs from its own. */
const noSearchApiServer = {
  command: `node ../../../../scripts/e2e-server.mjs -- node ../../../../packages/cli/bin/nymbal.mjs dev --api-only --port ${block.noSearchApi}`,
  url: `${NOSEARCH_API}/health`,
  cwd: './fixtures/no-search',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: noSearchSqlitePath,
    NYMBAL_CORS_ORIGINS: corsOrigins(astroNoSearchURL, nextjsNoSearchURL),
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

/** The native store's config on an API of its own, for the override storefronts. */
const overrideApiServer = {
  command: `node scripts/e2e-server.mjs -- node packages/cli/bin/nymbal.mjs dev --api-only --port ${block.overrideApi}`,
  url: `${OVERRIDE_API}/health`,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 90000,
  env: {
    NYMBAL_SQLITE_PATH: overrideSqlitePath,
    NYMBAL_CORS_ORIGINS: corsOrigins(astroOverrideURL, nextjsOverrideURL),
  },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10000 },
}

/** What a storefront takes beyond its API: the project elements entry it uses in place of its own. */
const overrideEnv = { NYMBAL_ELEMENTS_ENTRY: OVERRIDE_ENTRY }

// --ignore-lock: Astro 7 backgrounds `astro dev` under an AI agent, and Playwright would see the exit.
function astroServer(url: string, api: string, extraEnv: Record<string, string> = {}) {
  return {
    command: `pnpm --filter @nymbalhq/template-astro dev --ignore-lock --port ${new URL(url).port}`,
    url,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NYMBAL_API_URL: api,
      PUBLIC_NYMBAL_API_URL: api,
      ...extraEnv,
    },
  }
}

function nextjsServer(url: string, api: string, extraEnv: Record<string, string> = {}) {
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
      ...extraEnv,
    },
  }
}

/**
 * The API and what the run needs: NYMBAL_E2E_TARGET names one target, otherwise both templates on the native store.
 * The admin needs the API alone, which serves the built admin (`pnpm --filter @nymbalhq/admin build` first).
 */
function servers() {
  const targets = [
    'astro',
    'nextjs',
    'admin',
    ...CUSTOM_TARGETS,
    MAIL_OUTAGE,
    ...NOSEARCH_TARGETS,
    ...OVERRIDE_TARGETS,
  ]
  if (target !== undefined && !targets.includes(target)) {
    throw new Error(`NYMBAL_E2E_TARGET must be one of ${targets.join(', ')}; got "${target}"`)
  }
  if (target === 'astro') return [apiServer, astroServer(astroURL, NATIVE_API)]
  if (target === 'nextjs') return [apiServer, nextjsServer(nextjsURL, NATIVE_API)]
  if (target === 'astro-custom') return [customApiServer, astroServer(astroCustomURL, CUSTOM_API)]
  if (target === 'nextjs-custom') {
    return [customApiServer, nextjsServer(nextjsCustomURL, CUSTOM_API)]
  }
  if (target === MAIL_OUTAGE) return [customApiServer]
  if (target === 'astro-nosearch') {
    return [noSearchApiServer, astroServer(astroNoSearchURL, NOSEARCH_API)]
  }
  if (target === 'nextjs-nosearch') {
    return [noSearchApiServer, nextjsServer(nextjsNoSearchURL, NOSEARCH_API)]
  }
  if (target === 'astro-override') {
    return [overrideApiServer, astroServer(astroOverrideURL, OVERRIDE_API, overrideEnv)]
  }
  if (target === 'nextjs-override') {
    return [overrideApiServer, nextjsServer(nextjsOverrideURL, OVERRIDE_API, overrideEnv)]
  }
  if (isAdminE2E) return [apiServer]
  return [apiServer, astroServer(astroURL, NATIVE_API), nextjsServer(nextjsURL, NATIVE_API)]
}

// A whole run is bounded: each target is its own invocation, and one that hangs (the admin project once ran 389 s
// against a 9.5 s median) is red at the bound instead of holding everything behind it. GitHub's runners get twice
// the local bound; NYMBAL_E2E_GLOBAL_TIMEOUT_MS overrides either. Unbounded when run by hand without CI.
const globalTimeout = process.env.NYMBAL_E2E_GLOBAL_TIMEOUT_MS
  ? Number(process.env.NYMBAL_E2E_GLOBAL_TIMEOUT_MS)
  : isCI
    ? process.env.GITHUB_ACTIONS
      ? 10 * 60_000
      : 5 * 60_000
    : 0

export default defineConfig({
  testDir: './journeys',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // With retries a test that passes only on a retry leaves the exit status green; the JSON report per target is
  // where it shows (support/reporters.ts).
  reporter: e2eReporters(isCI, target),
  globalTimeout,
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
      grepInvert: /@nosearch|@override|@mail-outage/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroURL,
      },
    },
    {
      name: 'nextjs',
      testIgnore: ['**/journeys/admin/**'],
      grepInvert: /@nosearch|@override|@mail-outage/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsURL,
      },
    },
    // The fixture store with custom providers: only the journeys tagged @capabilities, whose assertions branch on
    // what GET /api/capabilities reports, which is what the providers change. Every other journey runs on the native
    // store alone.
    {
      name: 'astro-custom',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@capabilities/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroCustomURL,
      },
    },
    {
      name: 'nextjs-custom',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@capabilities/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsCustomURL,
      },
    },
    // The custom store's API, with no storefront: its origin is one the API accepts, as a browser on it would send.
    {
      name: MAIL_OUTAGE,
      testMatch: ['**/journeys/mail-outage.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroCustomURL,
      },
    },
    // The no-search store: only the journeys tagged @nosearch, which no other project runs.
    {
      name: 'astro-nosearch',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@nosearch/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroNoSearchURL,
      },
    },
    {
      name: 'nextjs-nosearch',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@nosearch/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsNoSearchURL,
      },
    },
    // The project-elements fixture: only the journeys tagged @override, which no other project runs.
    {
      name: 'astro-override',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@override/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: astroOverrideURL,
      },
    },
    {
      name: 'nextjs-override',
      testIgnore: ['**/journeys/admin/**'],
      grep: /@override/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: nextjsOverrideURL,
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
