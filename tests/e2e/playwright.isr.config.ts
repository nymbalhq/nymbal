import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { stack } from '../../scripts/stack'

// The journey in ./isr builds Next itself, with no API, into its own dist directory, then runs its own API and its own
// `next start` and stops and starts that API. So this config starts no web server: the test owns every process, and
// the build's exit status is the test's to read. It must not share the prod suite's servers or `.next`, so it has its
// own ports: the slot's API and Next ports plus 50, which no other field of the slot uses (scripts/stack.ts: slot 0
// spans 3000-3041 and 4321-4361 within each hundred). In a linked worktree on slot 1 the API is 3151 and Next 3150.
//
// Run: pnpm --filter @nymbalhq/e2e exec playwright test -c playwright.isr.config.ts

const block = stack(fileURLToPath(new URL('.', import.meta.url)))
process.env.NYMBAL_STACK_SLOT = String(block.slot)
const ISR_OFFSET = 50
const apiPort = block.api + ISR_OFFSET
const nextPort = block.nextjs + ISR_OFFSET
process.env.NYMBAL_ISR_API_PORT = String(apiPort)
process.env.NYMBAL_ISR_NEXT_PORT = String(nextPort)
// The support helpers read the API from NYMBAL_API_URL.
process.env.NYMBAL_API_URL = `http://localhost:${apiPort}`
process.env.NYMBAL_ISR_SQLITE_PATH ??= join(
  tmpdir(),
  `nymbal-e2e-isr-${Date.now()}-${process.pid}.db`,
)

export default defineConfig({
  testDir: './isr',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  // A Next build, two server starts and the window passing.
  timeout: 600_000,
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'nextjs-isr',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${nextPort}` },
    },
  ],
})
