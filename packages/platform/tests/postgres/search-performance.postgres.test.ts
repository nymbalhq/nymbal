import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchAdapter } from '@nymbalhq/types'
import { createNativeSearchAdapter } from '../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { MIGRATIONS_ROOT, kernelConfig } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import {
  indexOneByOne,
  percentile,
  searchCatalogue,
  timeQueries,
} from '../support/search-catalogue.js'

// AC-7 on Postgres: the SQLite run's catalogue, queries and budgets
// (packages/platform/tests/integration/search-performance.test.ts) on a database of this file's own, every total
// checked against an in-memory oracle.

// Three times the quiet-machine bound: measured 11.7 s and 16.6 s beside another worktree's gate:full (2026-10-22),
// where a 10 s bound was red then green with no code change.
const BUILD_BUDGET_MS = 30_000
const P95_BUDGET_MS = 50

const serverUrl = postgresServerUrl()
const catalogue = searchCatalogue(10_000)
const logger = createLogger({ pretty: false, level: 'error' })

let db: TestDatabase | undefined
let store: CommandStore | undefined
let adapter: SearchAdapter
let buildMs = Number.NaN

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'search_bench')
  store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  adapter = createNativeSearchAdapter({ sql: rawClients(store), logger })
  buildMs = await indexOneByOne(adapter, catalogue.documents)
}, 120_000)

afterAll(async () => {
  await store?.close()
  await db?.drop()
}, 60_000)

describe('AC-7: 10k products on Postgres', () => {
  it('AC-7 (a): indexing the 10k catalogue through the adapter, one product per call, takes under 30 s', () => {
    expect(buildMs).toBeLessThan(BUILD_BUDGET_MS)
  })

  it('AC-7 (b): 50 warm queries, each search({limit: 20}) plus its category facet, answer at p95 under 50 ms, every total the oracle’s', async () => {
    const timings = await timeQueries(adapter, catalogue)
    const p95 = percentile(timings, 95)
    const p50 = percentile(timings, 50)
    // eslint-disable-next-line no-console -- AC-7: the test prints the p95, the p50 and the build time
    console.log(
      `[search performance postgres] 10k build ${buildMs.toFixed(0)} ms; search+facet p95 ${p95.toFixed(2)} ms, p50 ${p50.toFixed(2)} ms over ${timings.length} queries`,
    )
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
