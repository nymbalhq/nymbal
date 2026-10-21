import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { stack } from '../../scripts/stack'

// P2-08 AC-3 and AC-5: the journeys in ./prod run against production builds of the templates (Astro `build` then
// `preview`, Next `build` then `start`), not the dev servers of playwright.config.ts: a dev server loads modules one by
// one, so what a page ships is only seen in a build. Ports are the stack slot's (scripts/stack.ts), as in
// playwright.config.ts: in a linked worktree on slot 6 the API is 3601, Astro 4921 and Next 3600.
//
//   NYMBAL_E2E_TARGET=astro|nextjs  one template (both when unset)
//   NYMBAL_E2E_PREBUILT=1           serve the build already on disk (CI's build-job artefacts, built for slot 0's API)
//
// Run: pnpm --filter @nymbalhq/e2e exec playwright test -c playwright.prod.config.ts

const target = process.env.NYMBAL_E2E_TARGET
if (target !== undefined && target !== 'astro' && target !== 'nextjs') {
  throw new Error(
    `NYMBAL_E2E_TARGET must be astro or nextjs for the production run; got "${target}"`,
  )
}
const block = stack(fileURLToPath(new URL('.', import.meta.url)))
process.env.NYMBAL_STACK_SLOT = String(block.slot)
const local = (port: number): string => `http://localhost:${port}`
const API = local(block.api)
process.env.NYMBAL_API_URL = API
const astroURL = local(block.astro)
const nextjsURL = local(block.nextjs)
const prebuilt = process.env.NYMBAL_E2E_PREBUILT === '1'

const sqlitePath = (process.env.NYMBAL_E2E_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-prod-${Date.now()}-${process.pid}.db`,
))

const apiServer = {
  command: `node scripts/e2e-server.mjs -- node packages/cli/bin/nymbal.mjs dev --api-only --port ${block.api}`,
  url: `${API}/health`,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 90_000,
  env: { NYMBAL_SQLITE_PATH: sqlitePath, NYMBAL_CORS_ORIGINS: `${astroURL},${nextjsURL}` },
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
}

/**
 * The API URL is read at build time by both templates' client code, so the build is made for this slot's API.
 * --ignore-lock: Astro 7 backgrounds `astro preview` under an AI agent, as it does `astro dev`, and Playwright would see
 * the exit.
 */
const astroServer = {
  command: [
    ...(prebuilt ? [] : ['pnpm --filter @nymbalhq/template-astro build']),
    `pnpm --filter @nymbalhq/template-astro preview --ignore-lock --port ${block.astro}`,
  ].join(' && '),
  url: astroURL,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 300_000,
  env: { NYMBAL_API_URL: API, PUBLIC_NYMBAL_API_URL: API },
}

const nextjsServer = {
  command: [
    ...(prebuilt ? [] : ['pnpm --filter @nymbalhq/template-nextjs build']),
    `pnpm --filter @nymbalhq/template-nextjs exec next start -p ${block.nextjs}`,
  ].join(' && '),
  url: nextjsURL,
  cwd: '../..',
  reuseExistingServer: false,
  timeout: 300_000,
  env: { NYMBAL_API_URL: API, NEXT_PUBLIC_NYMBAL_API_URL: API },
}

const projects = [
  {
    name: 'astro-prod',
    grepInvert: /@nextjs/,
    use: { ...devices['Desktop Chrome'], baseURL: astroURL },
  },
  { name: 'nextjs-prod', use: { ...devices['Desktop Chrome'], baseURL: nextjsURL } },
].filter((p) => target === undefined || p.name === `${target}-prod`)

export default defineConfig({
  testDir: './prod',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects,
  webServer: [
    apiServer,
    ...(target !== 'nextjs' ? [astroServer] : []),
    ...(target !== 'astro' ? [nextjsServer] : []),
  ],
})
