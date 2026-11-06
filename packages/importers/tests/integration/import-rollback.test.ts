import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadState,
  rollbackImport,
  RollbackRefusedError,
  runWooCommerceImport,
  type ImportEntity,
} from '@nymbalhq/importers'
import type { NymbalApp } from '@nymbalhq/platform'
import {
  ALL_ENTITIES,
  importDeps,
  importOptions,
  importStore,
  openStoreApp,
  placeOrder,
  seedStore,
  type StoreApp,
  type TableSnapshot,
} from './support/store-app.js'
import {
  arbStore,
  fixtureStore,
  wooStoreFetch,
  type Rec,
  type WooStore,
} from './support/woo-store.js'

// `rollbackImport` against whole stores built from the platform's dist through createApp, on a SQLite file: a store
// that already holds its own records (seeded to collide with the generated sources' slug, SKU, email and order-number
// pools), an import, and then the rollback, compared row for row with the store as it was. Needs `pnpm build`.

afterEach(() => {
  vi.unstubAllGlobals()
})

const confirm = async () => true

async function rollback(env: StoreApp, services: NymbalApp['services'] = env.app.services) {
  return rollbackImport({ statePath: env.statePath, confirm }, { services, repos: env.app.repos })
}

/** Every covered table's rows now against `before`, one table at a time. */
function expectTablesAsBefore(before: TableSnapshot, after: TableSnapshot): void {
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table])
}

const sum = (counts: Record<ImportEntity, number>) =>
  ALL_ENTITIES.reduce((n, e) => n + counts[e], 0)

async function heldIds(env: StoreApp): Promise<string[]> {
  const state = await loadState(env.statePath)
  return state === null ? [] : ALL_ENTITIES.flatMap((e) => state.importedIds[e])
}

const smallStores = arbStore({
  products: fc.integer({ min: 1, max: 5 }),
  categories: 4,
  customers: 4,
  orders: 4,
  reviews: 4,
})

/** A call wrapper that lets `limit` calls through and holds every later one forever, as a process stopped there. */
function stopAfter(limit: number) {
  let started = 0
  let settled = 0
  let reached!: () => void
  const stopped = new Promise<void>((resolve) => {
    reached = resolve
  })
  function gate<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> => {
      started += 1
      if (started > limit) {
        reached()
        return new Promise<R>(() => undefined)
      }
      return fn(...args).finally(() => {
        settled += 1
      })
    }
  }
  return { gate, stopped, settled: () => settled }
}

type Gate = ReturnType<typeof stopAfter>['gate']

/** `target` with each of `methods` passed through `gate`; read when called, so a missing service stays missing. */
function gated<T extends object>(target: T, methods: readonly string[], gate: Gate): T {
  return new Proxy(target, {
    get(t, p, receiver) {
      const value = Reflect.get(t, p, receiver) as unknown
      if (typeof value !== 'function') return value
      const bound = (value as (...a: unknown[]) => Promise<unknown>).bind(t)
      return typeof p === 'string' && methods.includes(p) ? gate(bound) : bound
    },
  })
}

/** The services with every create the importer makes held after `gate`'s limit. */
function createsGated(app: NymbalApp, gate: Gate) {
  const s = app.services
  return {
    services: {
      ...s,
      category: gated(s.category, ['create'], gate),
      product: gated(s.product, ['create'], gate),
      auth: gated(s.auth, ['importCustomer'], gate),
      order: gated(s.order, ['importOrder'], gate),
    } as NymbalApp['services'],
    reviews: gated(app.adapters.reviews, ['submitReview'], gate),
  }
}

/** The services with every removal a rollback makes held after `gate`'s limit. */
function removalsGated(app: NymbalApp, gate: Gate): NymbalApp['services'] {
  const s = app.services
  return new Proxy(s, {
    get(t, p, receiver) {
      const value = Reflect.get(t, p, receiver) as unknown
      if (p === 'product') return gated(s.product, ['delete'], gate)
      if (p === 'category') return gated(s.category, ['delete'], gate)
      if (p === 'importRemoval' && typeof value === 'object' && value !== null) {
        return gated(value, ['removeOrder', 'removeCustomer', 'removeReview'], gate)
      }
      return value
    },
  })
}

/** The same store with every slug, SKU, email and order number its own, so a whole import of it refuses nothing. */
function withoutClashes(s: WooStore): WooStore {
  return {
    ...s,
    categories: s.categories.map((c) => ({ ...c, slug: `cat-${String(c['id'])}` })),
    products: s.products.map((p) => ({
      ...p,
      slug: `p-${String(p['id'])}`,
      sku: `SKU-${String(p['id'])}`,
    })),
    variations: Object.fromEntries(
      Object.entries(s.variations).map(([id, vs]) => [
        id,
        vs.map((v) => ({ ...v, sku: `V-${String(v['id'])}` })),
      ]),
    ),
    customers: s.customers.map((c) => {
      const email = `c${String(c['id'])}@example.com`
      return { ...c, email, billing: { ...(c['billing'] as Rec), email } }
    }),
    orders: s.orders.map((o) => ({ ...o, number: String(o['id']) })),
  }
}

/** Rows each entity's table holds. */
function entityRows(env: StoreApp): Record<ImportEntity, number> {
  const count = (table: string) =>
    env.rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]!.n
  return {
    categories: count('categories'),
    products: count('products'),
    customers: count('customers'),
    orders: count('orders'),
    reviews: count('reviews'),
  }
}

describe('AC-1: import then rollback leaves the store as it was', () => {
  it('AC-1: for generated sources over a store holding its own colliding records, at gdpr on and off and concurrency 1-4, every covered table is row for row as before the import and no read model differs from a rebuild', async () => {
    await fc.assert(
      fc.asyncProperty(
        smallStores,
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        async (store, gdpr, concurrency) => {
          const env = await openStoreApp()
          try {
            await seedStore(env)
            const before = env.covered()

            await importStore(env, { store, gdpr, concurrency })
            await rollback(env)

            expectTablesAsBefore(before, env.covered())
            expect(await env.readModelDifferences()).toEqual([])
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 20 },
    )
  }, 600_000)
})

describe('AC-3: a customer the import only linked', () => {
  it('AC-3: a store customer with a source customer’s email (gdpr off) carries that customer’s imported orders, is not in importedIds.customers, and after the rollback keeps its row while the orders are gone', async () => {
    const env = await openStoreApp()
    try {
      const { customer } = await env.app.services.auth.register({
        email: 'alice@example.com',
        password: 'a long enough store password 42',
        firstName: 'Alice',
        lastName: 'Store',
      })
      const base = fixtureStore()
      const second = { ...base.orders[0]!, id: 1001, number: '1001' }
      const source = fixtureStore({ orders: [...base.orders, second] })
      const sourceOrdersOfAlice = source.orders.filter((o) => o['customer_id'] === 1).length
      const rowOf = () =>
        env.rows<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', customer.id)
      const before = rowOf()

      await importStore(env, {
        store: source,
        gdpr: false,
        entities: ['categories', 'products', 'customers', 'orders'],
      })

      const ordersOfAlice = () =>
        env.rows<{ id: string }>('SELECT id FROM orders WHERE customer_id = ?', customer.id)
      expect(ordersOfAlice().length).toBe(sourceOrdersOfAlice)
      const state = await loadState(env.statePath)
      expect(state!.importedIds.customers).not.toContain(customer.id)

      await rollback(env)

      expect(rowOf()).toEqual(before)
      expect(ordersOfAlice()).toEqual([])
    } finally {
      await env.close()
    }
  }, 120_000)
})

describe('AC-4: an import stopped before a create', () => {
  it('AC-4: stopped before its (k+1)-th create at concurrency 1, for any k and so any entity, a rollback in a fresh call reading only the files on disk leaves every covered table as before the import', async () => {
    await fc.assert(
      fc.asyncProperty(smallStores, fc.nat(), async (store, n) => {
        const creates =
          store.categories.length +
          store.products.length +
          store.customers.length +
          store.orders.length +
          store.reviews.length
        const k = 1 + (n % creates)
        const env = await openStoreApp()
        try {
          await seedStore(env)
          const before = env.covered()

          const { gate, stopped } = stopAfter(k)
          const { services, reviews } = createsGated(env.app, gate)
          vi.stubGlobal('fetch', wooStoreFetch(store).fetch)
          const run = runWooCommerceImport(
            importOptions(env, { store, concurrency: 1 }),
            importDeps(env, { services, reviews }),
          )
          run.catch(() => undefined)
          await Promise.race([stopped, run])
          vi.unstubAllGlobals()

          await rollback(env)

          expectTablesAsBefore(before, env.covered())
          expect(await env.readModelDifferences()).toEqual([])
        } finally {
          await env.close()
        }
      }),
      { numRuns: 20 },
    )
  }, 600_000)

  it('AC-4: stopped before its (k+1)-th create at concurrency 1, a resumed import ends with the rows and errors of an import never stopped: no record twice and no slug collision', async () => {
    await fc.assert(
      fc.asyncProperty(smallStores, fc.nat(), async (drawn, n) => {
        const store = withoutClashes(drawn)
        const creates =
          store.categories.length +
          store.products.length +
          store.customers.length +
          store.orders.length +
          store.reviews.length
        const k = 1 + (n % creates)

        const whole = await openStoreApp()
        let wholeRows: Record<ImportEntity, number>
        let wholeErrors: number
        try {
          const report = await importStore(whole, { store, concurrency: 1 })
          wholeRows = entityRows(whole)
          wholeErrors = report.errors.length
        } finally {
          await whole.close()
        }

        const env = await openStoreApp()
        try {
          const { gate, stopped } = stopAfter(k)
          const { services, reviews } = createsGated(env.app, gate)
          vi.stubGlobal('fetch', wooStoreFetch(store).fetch)
          const run = runWooCommerceImport(
            importOptions(env, { store, concurrency: 1 }),
            importDeps(env, { services, reviews }),
          )
          run.catch(() => undefined)
          await Promise.race([stopped, run])
          vi.unstubAllGlobals()

          const resumed = await importStore(env, { store, concurrency: 1 })

          expect(entityRows(env)).toEqual(wholeRows)
          expect(
            resumed.errors.length,
            resumed.errors.map((e) => `${e.phase} ${e.id ?? ''}: ${e.error}`).join('\n'),
          ).toBe(wholeErrors)
        } finally {
          await env.close()
        }
      }),
      { numRuns: 15 },
    )
  }, 600_000)
})

describe('AC-5: a rollback stopped and run again', () => {
  it('AC-5: stopped after any k removals and run again, the store is as before the import, each record removed exactly once (k plus the second run’s removed is the set, its absent 0), and a third run is refused as no-state', async () => {
    await fc.assert(
      fc.asyncProperty(smallStores, fc.nat(), async (store, n) => {
        const env = await openStoreApp()
        try {
          await seedStore(env)
          const before = env.covered()
          await importStore(env, { store })
          const set = (await heldIds(env)).length
          fc.pre(set > 0)
          const k = n % set

          const { gate, stopped, settled } = stopAfter(k)
          const first = rollback(env, removalsGated(env.app, gate))
          first.catch(() => undefined)
          await Promise.race([stopped, first])

          const second = await rollback(env)

          expect(settled() + sum(second.removed)).toBe(set)
          expect(sum(second.absent)).toBe(0)
          expectTablesAsBefore(before, env.covered())
          expect(await env.readModelDifferences()).toEqual([])
          await expect(rollback(env)).rejects.toMatchObject({ reason: 'no-state' })
        } finally {
          await env.close()
        }
      }),
      { numRuns: 20 },
    )
  }, 600_000)
})

describe('AC-6: a store with activity of its own refuses the rollback', () => {
  /** The fixture source with a paid order still to ship and two reviews. */
  function liveSource(): WooStore {
    const base = fixtureStore()
    return fixtureStore({
      orders: [{ ...base.orders[0]!, status: 'processing' }],
      reviews: [100, 101].map((productId, i) => ({
        id: i + 1,
        product_id: productId,
        reviewer: `r${i}`,
        reviewer_email: `r${i}@example.com`,
        review: 'imported review',
        rating: 4,
        verified: false,
        date_created: '2024-03-01T09:00:00',
      })),
    })
  }

  async function refusal(env: StoreApp) {
    return rollback(env).then(
      (report) => ({ resolved: report }) as const,
      (error: unknown) => ({ rejected: error }) as const,
    )
  }

  it('AC-6: a native checkout order placed after the import refuses the rollback as live-store with orders 1 and reviews 0, and no table changes', async () => {
    const env = await openStoreApp()
    try {
      const seeded = await seedStore(env)
      await importStore(env, { store: liveSource() })
      await placeOrder(env, seeded.productId, seeded.variantId)
      await env.app.relay.drain()
      const before = env.everyTable()

      const outcome = await refusal(env)

      expect(outcome).toMatchObject({ rejected: { reason: 'live-store', orders: 1, reviews: 0 } })
      expect('rejected' in outcome && outcome.rejected).toBeInstanceOf(RollbackRefusedError)
      expectTablesAsBefore(before, env.everyTable())
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-6: a review submitted through the reviews adapter after the import refuses the rollback as live-store with orders 0 and reviews 1, and no table changes', async () => {
    const env = await openStoreApp()
    try {
      const seeded = await seedStore(env)
      await importStore(env, { store: liveSource() })
      await env.app.adapters.reviews.submitReview({
        productId: seeded.productId,
        customerId: null,
        orderId: null,
        author: null,
        rating: 5,
        title: '',
        body: 'bought after the import',
      })
      const before = env.everyTable()

      const outcome = await refusal(env)

      expect(outcome).toMatchObject({ rejected: { reason: 'live-store', orders: 0, reviews: 1 } })
      expect('rejected' in outcome && outcome.rejected).toBeInstanceOf(RollbackRefusedError)
      expectTablesAsBefore(before, env.everyTable())
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-6: an admin shipping an imported order after the import refuses the rollback as live-store, and no table changes', async () => {
    const env = await openStoreApp()
    try {
      await seedStore(env)
      await importStore(env, { store: liveSource() })
      const [orderId] = (await loadState(env.statePath))!.importedIds.orders
      await env.app.services.order.markShipped(orderId!, 'RM123456789GB', 'Royal Mail', 'admin')
      await env.app.relay.drain()
      const before = env.everyTable()

      const outcome = await refusal(env)

      expect(outcome).toMatchObject({ rejected: { reason: 'live-store' } })
      expect('rejected' in outcome && outcome.rejected).toBeInstanceOf(RollbackRefusedError)
      expectTablesAsBefore(before, env.everyTable())
    } finally {
      await env.close()
    }
  }, 120_000)

  // Defect: the store is checked only before the merchant is asked, so an order placed while the prompt waits is
  // orphaned: its product, category and customer are removed under it.
  it('AC-6: an order placed on an imported product while the rollback waits for confirmation refuses the rollback as live-store with orders 1, and nothing is removed', async () => {
    const env = await openStoreApp()
    try {
      await seedStore(env)
      await importStore(env, { store: liveSource() })
      const held = await heldIds(env)
      const imported = await Promise.all(
        (await loadState(env.statePath))!.importedIds.products.map((id) =>
          env.app.services.product.getById(id),
        ),
      )
      const product = imported.find((p) => p.variants.some((v) => v.stock > 0))
      if (product === undefined) throw new Error('the fixture imports no product in stock')
      const variant = product.variants.find((v) => v.stock > 0)!
      let placed: TableSnapshot | undefined

      const outcome = await rollbackImport(
        {
          statePath: env.statePath,
          confirm: async () => {
            await placeOrder(env, product.id, variant.id)
            await env.app.relay.drain()
            placed = env.everyTable()
            return true
          },
        },
        { services: env.app.services, repos: env.app.repos },
      ).then(
        (report) => ({ resolved: report }) as const,
        (error: unknown) => ({ rejected: error }) as const,
      )

      expect(outcome).toMatchObject({ rejected: { reason: 'live-store', orders: 1, reviews: 0 } })
      expect('rejected' in outcome && outcome.rejected).toBeInstanceOf(RollbackRefusedError)
      expectTablesAsBefore(placed!, env.everyTable())
      expect(await heldIds(env)).toEqual(held)
    } finally {
      await env.close()
    }
  }, 120_000)
})

describe('AC-12: --fresh keeps what an earlier run created', () => {
  /** `s` with every id moved by `by` and every slug, SKU, email and number made its own: no record of `s` again. */
  function another(s: WooStore, by: number): WooStore {
    const id = (r: Rec) => (r['id'] as number) + by
    const tag = (v: unknown) => `${String(v)}-b`
    return {
      categories: s.categories.map((c) => ({
        ...c,
        id: id(c),
        slug: tag(c['slug']),
        name: tag(c['name']),
        parent: (c['parent'] as number) > 0 ? (c['parent'] as number) + by : 0,
      })),
      products: s.products.map((p) => ({
        ...p,
        id: id(p),
        slug: tag(p['slug']),
        sku: tag(p['sku']),
        name: tag(p['name']),
        categories: (p['categories'] as Rec[]).map((c) => ({
          ...c,
          id: id(c),
          slug: tag(c['slug']),
        })),
      })),
      variations: Object.fromEntries(
        Object.entries(s.variations).map(([pid, vs]) => [
          Number(pid) + by,
          vs.map((v) => ({ ...v, id: id(v), sku: tag(v['sku']) })),
        ]),
      ),
      customers: s.customers.map((c) => {
        const email = `b-${String(c['email'])}`
        return { ...c, id: id(c), email, billing: { ...(c['billing'] as Rec), email } }
      }),
      orders: s.orders.map((o) => ({
        ...o,
        id: id(o),
        number: String(Number(o['number']) + by),
        customer_id: (o['customer_id'] as number) > 0 ? (o['customer_id'] as number) + by : 0,
        line_items: (o['line_items'] as Rec[]).map((l) => ({
          ...l,
          product_id: (l['product_id'] as number) + by,
        })),
      })),
      reviews: s.reviews.map((r) => ({
        ...r,
        id: id(r),
        product_id: (r['product_id'] as number) + by,
      })),
    }
  }

  it('AC-12: import source A, a --fresh import of a different source B, then a rollback leaves every covered table as before A', async () => {
    const env = await openStoreApp()
    try {
      await seedStore(env)
      const before = env.covered()
      const a = fixtureStore({
        reviews: [
          {
            id: 1,
            product_id: 100,
            reviewer: 'r',
            reviewer_email: 'r@example.com',
            review: 'from A',
            rating: 5,
            verified: false,
            date_created: '2024-03-01T09:00:00',
          },
        ],
      })

      await importStore(env, { store: a })
      const fromA = await heldIds(env)
      await importStore(env, { store: another(a, 5_000), fresh: true })
      const held = await heldIds(env)

      expect(fromA.filter((id) => !held.includes(id))).toEqual([])
      expect(held.length).toBeGreaterThan(fromA.length)

      await rollback(env)

      expectTablesAsBefore(before, env.covered())
      expect(await env.readModelDifferences()).toEqual([])
    } finally {
      await env.close()
    }
  }, 120_000)
})
