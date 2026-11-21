// Reads: stryker.config.mjs, stryker.integration.config.mjs
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO } from './scratch-gate'
import { cleanupStrykerScratch, strykerUnder } from './stryker-scratch'

// Stryker's Vitest must run each test file on a process's main thread. On a worker thread, Node unloads native addons
// when the worker exits, and a better-sqlite3 database still alive then has its finalizer called into the unmapped
// library: the whole Stryker child dies, the dry run fails or mutants come back as RuntimeError (macOS; glibc keeps the
// library mapped, so Linux hides it). The scratch test asserts the main thread, which fails on every OS under the
// threads pool, and holds a database open at module scope, as the platform's SQLite tests do.

const SOURCE = 'src/stock.ts'

const MODULE = `export function stockLabel(stock: number): string {
  return stock > 0 ? 'in stock' : 'sold out'
}
`
const TEST = `import { createRequire } from 'node:module'
import { isMainThread } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { stockLabel } from './stock'

const Database = createRequire(${JSON.stringify(join(REPO, 'packages/platform/package.json'))})('better-sqlite3')
const db = new Database(':memory:')
const one = db.prepare('select 1 as n').get()

it('runs on a process main thread with the database open', () => {
  expect(isMainThread).toBe(true)
  expect(one.n).toBe(1)
})

it('labels stock', () => {
  expect(stockLabel(1)).toBe('in stock')
  expect(stockLabel(0)).toBe('sold out')
})
`

afterEach(cleanupStrykerScratch)

describe('Stryker runs tests in processes, not worker threads', () => {
  it.each(['stryker.config.mjs', 'stryker.integration.config.mjs'])(
    '%s: a test holding a native SQLite database runs on a main thread, the run exits 0 and every mutant is killed',
    async (config) => {
      const { code, report, output } = await strykerUnder(config, SOURCE, {
        [SOURCE]: MODULE,
        'src/stock.test.ts': TEST,
      })
      expect(code, output).toBe(0)
      const mutants = Object.values(report?.files ?? {}).flatMap((file) => file.mutants)
      expect(mutants.filter((m) => m.status === 'RuntimeError').length, output).toBe(0)
      const inFunction = report?.files[SOURCE]?.mutants ?? []
      expect(inFunction.length, output).toBeGreaterThan(0)
      expect(
        inFunction.map((m) => [m.mutatorName, m.status]),
        output,
      ).toEqual(inFunction.map((m) => [m.mutatorName, 'Killed']))
    },
    180_000,
  )
})
