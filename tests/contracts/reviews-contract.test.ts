import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runReviewsContract } from '@nymbalhq/contract-tests'
import type { ReviewsAdapter } from '@nymbalhq/types'
import {
  buildRepositories,
  createCommandStore,
  createLogger,
  createNativeReviewsAdapter,
  InMemoryDocumentStore,
  runMigrations,
  type CommandStore,
} from '@nymbalhq/platform'
import { seedReviews, walkReviews } from '../support/reviews-pages'

// AC-3, SQLite half: the published reviews suite, pagination case included, runs on the native reviews adapter over a
// migrated SQLite command store; Postgres runs the same in integration-postgres
// (packages/platform/tests/postgres/reviews-contract.postgres.test.ts). The property below holds the native adapter to
// keyset pagination directly: seeds number more than `limit`, the walk from page 1 yields each seeded review once, the
// union is the seed, no page exceeds `limit` and `nextCursor` is null exactly on the last page.

const logger = createLogger({ pretty: false, level: 'error' })
let store: CommandStore | undefined
let adapter: ReviewsAdapter | undefined

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../packages/platform/migrations', import.meta.url).pathname,
  })
  adapter = build()
})

afterAll(async () => {
  await store?.close()
})

function build(): ReviewsAdapter {
  if (store === undefined) throw new Error('the SQLite command store was not opened')
  return createNativeReviewsAdapter({
    repos: buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })),
    logger,
  })
}

runReviewsContract('native-sqlite', build)

describe('AC-3: native reviews page by cursor (SQLite)', () => {
  it('AC-3: over generated page sizes and seeds larger than one page, the cursor walk yields each seeded review once, the union is the seed, no page exceeds limit, and nextCursor is null exactly on the last page', async () => {
    const native = adapter!
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
