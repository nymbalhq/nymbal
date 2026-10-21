import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchAdapter } from '@nymbalhq/types'
import { createNativeSearchAdapter } from '../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { MIGRATIONS_ROOT, kernelConfig } from '../support/kernel.js'
import {
  indexOneByOne,
  percentile,
  searchCatalogue,
  timeQueries,
  type QueryTiming,
} from '../support/search-catalogue.js'

// P2-07 AC-7 on SQLite (a file database, as a store runs): the 10k-product catalogue (tests/support/search-catalogue.ts),
// built once for the file through the adapter one product per call, as a warm start indexes; then 50 warm queries,
// each search({limit: 20}) and its facet('categoryIds', {query}). The Postgres run is in integration-postgres
// (packages/platform/tests/postgres/search-performance.postgres.test.ts).
// Kills: a search that scans in memory, a missing index that makes a query a table scan, an upsert that is a full
// scan (a warm start O(N²)), and a fast answer that is wrong (each total is checked against decision 3's oracle).

const BUILD_BUDGET_MS = 10_000
const P95_BUDGET_MS = 50

const catalogue = searchCatalogue(10_000)
const logger = createLogger({ pretty: false, level: 'error' })

let dir: string | undefined
let store: CommandStore | undefined
let adapter: SearchAdapter
let buildMs = Number.NaN

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p2-07-bench-'))
  store = createCommandStore(kernelConfig('sqlite'), { sqlitePath: join(dir, 'bench.sqlite') })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  adapter = createNativeSearchAdapter({ sql: rawClients(store), logger })
  buildMs = await indexOneByOne(adapter, catalogue.documents)
}, 120_000)

afterAll(async () => {
  await store?.close()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

function report(dialect: string, timings: QueryTiming[]): { p95: number; p50: number } {
  const p95 = percentile(timings, 95)
  const p50 = percentile(timings, 50)
  // eslint-disable-next-line no-console -- AC-7: the test prints the p95, the p50 and the build time
  console.log(
    `[P2-07 AC-7 ${dialect}] 10k build ${buildMs.toFixed(0)} ms; search+facet p95 ${p95.toFixed(2)} ms, p50 ${p50.toFixed(2)} ms over ${timings.length} queries`,
  )
  return { p95, p50 }
}

describe('P2-07 AC-7: 10k products on SQLite', () => {
  it('AC-7 (a): indexing the 10k catalogue through the adapter, one product per call, takes under 10 s', () => {
    expect(buildMs).toBeLessThan(BUILD_BUDGET_MS)
  })

  it('AC-7 (b): 50 warm queries, each search({limit: 20}) plus its category facet, answer at p95 under 50 ms, every total the oracle’s', async () => {
    const timings = await timeQueries(adapter, catalogue)
    const { p95 } = report('sqlite', timings)
    for (const [i, t] of timings.entries()) {
      expect(t.total, `total for "${t.query}"`).toBe(t.expected)
      expect(t.facetValues > 0, `facet for "${t.query}" is non-empty iff it matches`).toBe(
        t.total > 0,
      )
      expect(
        t.expected > 0,
        `"${t.query}" is a ${catalogue.queries[i]!.hit ? 'hit' : 'miss'}`,
      ).toBe(catalogue.queries[i]!.hit)
    }
    expect(p95).toBeLessThan(P95_BUDGET_MS)
  }, 60_000)
})
