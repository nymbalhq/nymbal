import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ReviewsAdapter } from '@nymbalhq/types'
import { runReviewsContract } from '../../../contract-tests/src/index.js'
import { createNativeReviewsAdapter } from '../../src/adapters/reviews/native-adapter.js'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories } from '../../src/repositories/index.js'
import { seedReviews, walkReviews } from '../../../../tests/support/reviews-pages'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'

// AC-3, Postgres half: the published reviews suite, pagination case included, on the native reviews adapter over a
// database of this file's own, and the same keyset property the SQLite runner holds
// (tests/contracts/reviews-contract.test.ts): the cursor query is per dialect (created time, then id).

const serverUrl = postgresServerUrl()
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))
const logger = createLogger({ pretty: false, level: 'error' })

let db: TestDatabase | undefined
let store: CommandStore | undefined

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'reviews_contract')
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: db.url },
  )
  await runMigrations(store, { migrationsRoot: MIGRATIONS })
}, 60_000)

afterAll(async () => {
  await store?.close()
  await db?.drop()
}, 60_000)

function build(): ReviewsAdapter {
  if (store === undefined) throw new Error('the Postgres command store was not opened')
  return createNativeReviewsAdapter({
    repos: buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })),
    logger,
  })
}

runReviewsContract('native-postgres', build)

describe('AC-3: native reviews page by cursor (Postgres)', () => {
  it('AC-3: over generated page sizes and seeds larger than one page, the cursor walk yields each seeded review once, the union is the seed, no page exceeds limit, and nextCursor is null exactly on the last page', async () => {
    const native = build()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 20 }),
        async (limit, extra) => {
          const seeded = await seedReviews(native, limit + extra)
          const pages = await walkReviews(
            native,
            seeded.productId,
            limit,
            Math.ceil(seeded.ids.length / limit) + 2,
          )
          const walked = pages.flatMap((p) => p.items.map((r) => r.id))

          expect(new Set(walked).size, 'a review came back on two pages').toBe(walked.length)
          expect([...walked].sort()).toEqual([...seeded.ids].sort())
          expect(Math.max(...pages.map((p) => p.items.length))).toBeLessThanOrEqual(limit)
          expect(pages.map((p) => p.nextCursor === null)).toEqual(
            pages.map((_, i) => i === pages.length - 1),
          )
        },
      ),
      { numRuns: 20 },
    )
  })
})
