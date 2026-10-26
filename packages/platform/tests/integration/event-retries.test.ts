import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { eventRetriesSuite } from '../support/suites/event-retries.js'

// Event delivery retries on SQLite: retry then dead-letter (AC-4), the backoff and a restart (AC-5), and every
// handler unchanged in effect under retries (AC-6).

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fresh(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'event-retries-'))
  dirs.push(dir)
  return join(dir, 'store.sqlite')
}

eventRetriesSuite('sqlite', {
  open: async ({ target, ...opts }) =>
    createKernel({ dialect: 'sqlite', sqlitePath: target ?? (await fresh()), ...opts }),
  fresh,
  propertyRuns: 12,
  sequenceRuns: 4,
})
