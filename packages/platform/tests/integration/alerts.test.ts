import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { alertsSuite } from '../support/suites/alerts.js'

// Back-in-stock alerts on SQLite: subscribe, confirm, unsubscribe and the tokens (AC-2), no account revealed (AC-4),
// one row per address (AC-5), and one alert per activation, row by row (AC-6).

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

alertsSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  fresh: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-fresh-'))
    dirs.push(dir)
    return join(dir, 'store.sqlite')
  },
  propertyRuns: 12,
})
