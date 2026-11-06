import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'

// A product's categories and a category's products are two reads of one set of links: attaching twice links once,
// detaching a pair leaves every other link, and detaching a product's links leaves every other product's.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return { store, repo: repos.productCategory }
}

const PRODUCTS = ['p1', 'p2', 'p3']
const CATEGORIES = ['c1', 'c2', 'c3']

type Op =
  | { kind: 'attach' | 'detach'; product: string; category: string }
  | { kind: 'detachAll'; product: string }

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constantFrom('attach' as const, 'detach' as const),
    product: fc.constantFrom(...PRODUCTS),
    category: fc.constantFrom(...CATEGORIES),
  }),
  fc.record({ kind: fc.constant('detachAll' as const), product: fc.constantFrom(...PRODUCTS) }),
)

describe('product category links', () => {
  it('property: after any attaches and detaches, each side reads exactly the links a set model holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 25 }), async (ops) => {
        const { store, repo } = await setup()
        const model = new Set<string>()
        for (const o of ops) {
          await store.transaction(async (tx) => {
            if (o.kind === 'attach') await repo.attach(tx, o.product, o.category)
            else if (o.kind === 'detach') await repo.detach(tx, o.product, o.category)
            else await repo.detachAllForProduct(tx, o.product)
          })
          if (o.kind === 'attach') model.add(`${o.product}/${o.category}`)
          else if (o.kind === 'detach') model.delete(`${o.product}/${o.category}`)
          else for (const c of CATEGORIES) model.delete(`${o.product}/${c}`)
        }
        await store.transaction(async (tx) => {
          for (const p of PRODUCTS) {
            const read = (await repo.listCategoriesForProduct(tx, p)).sort()
            expect(read).toEqual(CATEGORIES.filter((c) => model.has(`${p}/${c}`)))
          }
          for (const c of CATEGORIES) {
            const read = (await repo.listProductsForCategory(tx, c)).sort()
            expect(read).toEqual(PRODUCTS.filter((p) => model.has(`${p}/${c}`)))
          }
        })
        await store.close()
      }),
      { numRuns: 30 },
    )
  })
})
