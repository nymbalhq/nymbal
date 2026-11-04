import { readFile } from 'node:fs/promises'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  journalPathFor,
  loadState,
  runWooCommerceImport,
  type ImportEntity,
  type ImportReport,
  type ProgressEvent,
} from '@nymbalhq/importers'
import type { NymbalApp } from '@nymbalhq/platform'
import {
  ALL_ENTITIES,
  importDeps,
  importOptions,
  importStore,
  openStoreApp,
  seedStore,
  type ImportRun,
  type StoreApp,
} from './support/store-app.js'
import {
  arbStore,
  clashFree,
  fixtureStore,
  wooStoreFetch,
  type Rec,
  type WooMock,
  type WooStore,
} from './support/woo-store.js'

// An import stopped and run again, on whole stores built from the platform's dist through createApp (`pnpm build`
// first). A stop is a run whose next call never returns: the first run is left hanging, as a killed process leaves
// its files, and the second run reads only those files. Before the second run starts, every write the first run had
// handed back has its journal line, so the two runs never share the files.

afterEach(() => {
  vi.unstubAllGlobals()
})

const never = <T>() => new Promise<T>(() => undefined)

/** Resolves once `ready()` holds, looking again after each turn of the event loop. */
async function until(ready: () => Promise<boolean>): Promise<void> {
  while (!(await ready())) await new Promise((r) => setImmediate(r))
}

async function journalLines(env: StoreApp, entity?: ImportEntity): Promise<number> {
  const text = await readFile(journalPathFor(env.statePath), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && (entity === undefined || l.includes(`"entity":"${entity}"`)))
    .length
}

/** `target` with `method` replaced by `wrap(the bound method)`; every other member as it was. */
function replacing<T extends object>(target: T, method: string, wrap: (fn: never) => unknown): T {
  return new Proxy(target, {
    get(t, p, receiver) {
      const value = Reflect.get(t, p, receiver) as unknown
      if (typeof value !== 'function') return value
      const bound = (value as (...a: unknown[]) => unknown).bind(t)
      return p === method ? wrap(bound as never) : bound
    },
  })
}

/** A run of the import over `store` that is left to hang wherever it stops, with what it reported on the way. */
function startRun(
  env: StoreApp,
  run: ImportRun,
  services: NymbalApp['services'],
  reviews = env.app.adapters.reviews,
) {
  const events: ProgressEvent[] = []
  const mock: WooMock = wooStoreFetch(run.store)
  vi.stubGlobal('fetch', mock.fetch)
  const done = runWooCommerceImport(importOptions(env, run), {
    ...importDeps(env, { services, reviews }),
    onProgress: (e) => events.push(e),
  })
  done.catch(() => undefined)
  return { events, mock, done }
}

/** A whole run with its progress events and the requests it made. */
async function finishRun(env: StoreApp, run: ImportRun) {
  const { events, mock, done } = startRun(env, run, env.app.services)
  const report: ImportReport = await done
  vi.unstubAllGlobals()
  return { report, events, requests: mock.requests }
}

/**
 * For each entity, what its progress events got wrong: a `done` above its `total`, a `done` below the one before it,
 * and, for a run that finished, a last event whose `done` is not its `total`.
 */
function progressFaults(events: ProgressEvent[], finished: boolean): string[] {
  const faults: string[] = []
  const last = new Map<string, { done: number; total: number }>()
  for (const e of events) {
    if (e.kind !== 'progress') continue
    const before = last.get(e.entity)
    if (e.done > e.total) faults.push(`${e.entity}: ${e.done}/${e.total}`)
    if (before !== undefined && e.done < before.done) {
      faults.push(`${e.entity}: ${before.done} then ${e.done}`)
    }
    last.set(e.entity, { done: e.done, total: e.total })
  }
  if (finished) {
    for (const [entity, e] of last) {
      if (e.done !== e.total) faults.push(`${entity} ends at ${e.done}/${e.total}`)
    }
  }
  return faults
}

function orderRows(env: StoreApp) {
  return env
    .rows<{
      id: string
      order_number: string
      metadata: string
    }>('SELECT id, order_number, metadata FROM orders')
    .map((r) => ({
      id: r.id,
      number: r.order_number,
      wcId: (JSON.parse(r.metadata) as { woocommerce?: { orderId?: number } }).woocommerce?.orderId,
    }))
}

const sorted = (xs: string[]) => [...xs].sort()

describe('AC-6: an order written but not journalled before a stop is held once', () => {
  /**
   * `importOrder` whose k-th call commits and then never returns: a stop between an order's write and its journal
   * line. A call begun after the k-th never starts, and one in flight when it commits never returns either; `settled`
   * counts the writes that started and have ended, so the second run starts after the last of them.
   */
  function stopAfterOrderWrite(k: number) {
    let calls = 0
    let stopped = false
    let settled = 0
    let handedBack = 0
    let reach!: () => void
    const reached = new Promise<void>((resolve) => {
      reach = resolve
    })
    const stop = () => {
      stopped = true
      reach()
    }
    const wrap =
      (importOrder: NymbalApp['services']['order']['importOrder']) =>
      (input: Parameters<typeof importOrder>[0]) => {
        calls += 1
        const n = calls
        if (n > k) return never()
        return importOrder(input).then(
          (order) => {
            settled += 1
            if (n === k) stop()
            if (stopped) return never<typeof order>()
            handedBack += 1
            return order
          },
          (err: unknown) => {
            settled += 1
            if (n === k) stop()
            if (stopped) return never<never>()
            throw err
          },
        )
      }
    return { wrap, reached, settled: () => settled, handedBack: () => handedBack }
  }

  /** The first run, stopped after its k-th order write, settled: every order it handed back is journalled. */
  async function stoppedRun(env: StoreApp, run: ImportRun, k: number) {
    const stop = stopAfterOrderWrite(k)
    const services = {
      ...env.app.services,
      order: replacing(env.app.services.order, 'importOrder', stop.wrap as never),
    } as NymbalApp['services']
    const first = startRun(env, run, services)
    await Promise.race([stop.reached, first.done])
    await until(
      async () => stop.settled() === k && (await journalLines(env, 'orders')) >= stop.handedBack(),
    )
    vi.unstubAllGlobals()
  }

  it('AC-6: for any source and any k at concurrency 1-4, stopped after its k-th order write and run again, each source order whose number no other source or store order holds is in the store once, errors name only those clashes, importedIds.orders holds each imported order once, and a third run adds no order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStore({
          products: fc.integer({ min: 1, max: 4 }),
          categories: 3,
          customers: 4,
          orders: 6,
          reviews: 2,
        }),
        fc.nat(),
        fc.integer({ min: 1, max: 4 }),
        async (store, n, concurrency) => {
          fc.pre(store.orders.length > 0)
          const k = 1 + (n % store.orders.length)
          const env = await openStoreApp()
          try {
            await seedStore(env)
            const storeOrders = orderRows(env)
            const storeNumbers = new Set(storeOrders.map((o) => o.number))
            const numberOf = (o: Rec) => `WC-${String(o['number'])}`
            const holders = (num: string) => store.orders.filter((o) => numberOf(o) === num).length
            const clashes = new Set(
              store.orders
                .filter((o) => storeNumbers.has(numberOf(o)) || holders(numberOf(o)) > 1)
                .map((o) => String(o['id'])),
            )
            const sourceNumber = new Map(store.orders.map((o) => [String(o['id']), numberOf(o)]))

            await stoppedRun(env, { store, concurrency }, k)
            const second = await importStore(env, { store, concurrency })

            const rows = orderRows(env)
            const sole = store.orders.filter((o) => !clashes.has(String(o['id'])))
            expect(
              sole.map((o) => rows.filter((r) => r.number === numberOf(o)).map((r) => r.wcId)),
            ).toEqual(sole.map((o) => [o['id']]))

            const orderErrors = second.errors.filter((e) => e.phase === 'orders')
            expect(
              orderErrors.map((e) => [
                e.id,
                clashes.has(e.id ?? ''),
                e.error.includes(sourceNumber.get(e.id ?? '') ?? 'no such source order'),
              ]),
            ).toEqual(orderErrors.map((e) => [e.id, true, true]))
            expect(new Set(orderErrors.map((e) => e.id)).size).toBe(orderErrors.length)

            const state = (await loadState(env.statePath))!
            const storeIds = new Set(storeOrders.map((o) => o.id))
            expect(sorted(state.importedIds.orders)).toEqual(
              sorted(rows.filter((r) => !storeIds.has(r.id)).map((r) => r.id)),
            )

            const held = rows.length
            await importStore(env, { store, concurrency })
            expect(orderRows(env).length).toBe(held)
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 15 },
    )
  }, 600_000)

  it("AC-6: the store's own WC-1 stays a refused clash for a source order numbered 1, while an order written but not journalled before the stop is taken back", async () => {
    const env = await openStoreApp()
    try {
      const seeded = await seedStore(env)
      const base = fixtureStore()
      const store = fixtureStore({
        orders: [
          { ...base.orders[0]!, id: 60001, number: '1' },
          { ...base.orders[0]!, id: 60002, number: '60002' },
        ],
      })
      const storeOrder = () => env.rows('SELECT * FROM orders WHERE id = ?', seeded.orderId)
      const before = storeOrder()

      await stoppedRun(env, { store }, 2)
      const second = await importStore(env, { store })
      const state = (await loadState(env.statePath))!

      expect({
        orderErrors: second.errors
          .filter((e) => e.phase === 'orders')
          .map((e) => [e.id, e.error.includes(seeded.orderNumber)]),
        taken: orderRows(env)
          .filter((r) => r.number === 'WC-60002')
          .map((r) => [
            r.wcId,
            state.wcToNymbalOrder['60002'] === r.id,
            state.importedIds.orders.includes(r.id),
          ]),
        storeOrder: storeOrder(),
        storeOrderClaimed:
          Object.values(state.wcToNymbalOrder).includes(seeded.orderId) ||
          state.importedIds.orders.includes(seeded.orderId),
      }).toEqual({
        orderErrors: [['60001', true]],
        taken: [[60002, true, true]],
        storeOrder: before,
        storeOrderClaimed: false,
      })
    } finally {
      await env.close()
    }
  }, 120_000)
})

describe('AC-7: a resumed import holds each record once and counts its progress to n/n', () => {
  /**
   * Every create the importer makes, let through `k` times and held forever from the (k+1)-th, with how many of those
   * let through settled and how many the importer journals (all but a customer it only linked).
   */
  function stopBeforeCreate(k: number) {
    let started = 0
    let settled = 0
    let journalled = 0
    let reach!: () => void
    const reached = new Promise<void>((resolve) => {
      reach = resolve
    })
    function gate<A extends unknown[], R>(
      fn: (...args: A) => Promise<R>,
      journals: (args: A, result: R) => boolean,
    ) {
      return (...args: A): Promise<R> => {
        started += 1
        if (started > k) {
          reach()
          return never()
        }
        return fn(...args).then(
          (result) => {
            settled += 1
            if (journals(args, result)) journalled += 1
            return result
          },
          (err: unknown) => {
            settled += 1
            throw err
          },
        )
      }
    }
    const always = () => true
    const sourceCustomerOf = (meta: Record<string, unknown> | undefined) =>
      (meta?.['woocommerce'] as { customerId?: number } | undefined)?.customerId
    function wrap(app: NymbalApp) {
      const s = app.services
      return {
        services: {
          ...s,
          category: replacing(s.category, 'create', (fn) => gate(fn, always)),
          product: replacing(s.product, 'create', (fn) => gate(fn, always)),
          auth: replacing(s.auth, 'importCustomer', (fn) =>
            gate(
              fn as (input: { metadata?: Record<string, unknown> }) => Promise<{
                metadata: Record<string, unknown>
              }>,
              ([input], customer) =>
                sourceCustomerOf(customer.metadata) === sourceCustomerOf(input.metadata),
            ),
          ),
          order: replacing(s.order, 'importOrder', (fn) => gate(fn, always)),
        } as NymbalApp['services'],
        reviews: replacing(app.adapters.reviews, 'submitReview', (fn) => gate(fn, always)),
      }
    }
    return { wrap, reached, settled: () => settled, journalled: () => journalled }
  }

  /** The first run, stopped before its (k+1)-th create and settled: every create it let through is journalled. */
  async function stoppedRun(env: StoreApp, run: ImportRun, k: number) {
    const stop = stopBeforeCreate(k)
    const { services, reviews } = stop.wrap(env.app)
    const first = startRun(env, run, services, reviews)
    const finished = await Promise.race([
      stop.reached.then(() => false),
      first.done.then(() => true),
    ])
    if (!finished) {
      await until(
        async () => stop.settled() === k && (await journalLines(env)) >= stop.journalled(),
      )
    }
    vi.unstubAllGlobals()
    return first.events
  }

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

  const pageOf = (url: string) => Number(new URL(url).searchParams.get('page') ?? '1')

  it('AC-7: for any source (order ids meeting product and customer ids; clash-free above concurrency 1), stopped before any create k at concurrency 1-4 and run again, the store holds what an uninterrupted import does, progress never passes its total nor goes back, each entity of the finishing run ends at n/n, and the resumed categories phase asks for no page before its cursor', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStore({
          products: fc.integer({ min: 1, max: 5 }),
          categories: 4,
          customers: 4,
          orders: 5,
          reviews: 4,
          idsMeet: true,
        }),
        fc.nat(),
        fc.integer({ min: 1, max: 4 }),
        async (drawn, n, concurrency) => {
          const store = concurrency > 1 ? clashFree(drawn) : drawn
          const creates = ALL_ENTITIES.reduce((sum, e) => sum + store[e].length, 0)
          const k = 1 + (n % creates)

          const whole = await openStoreApp()
          let wholeRows: Record<ImportEntity, number>
          let wholeImported: ImportReport['imported']
          try {
            const run = await finishRun(whole, { store, concurrency })
            wholeRows = entityRows(whole)
            wholeImported = run.report.imported
            expect(progressFaults(run.events, true)).toEqual([])
          } finally {
            await whole.close()
          }

          const env = await openStoreApp()
          try {
            const firstEvents = await stoppedRun(env, { store, concurrency }, k)
            const cursor = (await loadState(env.statePath))?.cursors.categories?.page ?? 1
            const second = await finishRun(env, { store, concurrency })
            const categoryPages = second.requests
              .filter((r) => r.path.endsWith('/products/categories'))
              .map((r) => pageOf(r.url))
            const categoriesFinished = k >= store.categories.length
            const pages = Math.max(1, Math.ceil(store.categories.length / 100))

            expect({
              rows: entityRows(env),
              imported: second.report.imported,
              firstRunFaults: progressFaults(firstEvents, false),
              secondRunFaults: progressFaults(second.events, true),
              categoryPagesBeforeCursor: categoryPages.filter((p) => p < cursor),
              cursorPastFinishedPages: categoriesFinished ? cursor : pages + 1,
            }).toEqual({
              rows: wholeRows,
              imported: wholeImported,
              firstRunFaults: [],
              secondRunFaults: [],
              categoryPagesBeforeCursor: [],
              cursorPastFinishedPages: pages + 1,
            })
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 15 },
    )
  }, 600_000)

  /** A simple product WooCommerce lists, with nothing to fetch beside it. */
  function simpleProduct(id: number): Rec {
    return {
      id,
      name: `product ${id}`,
      slug: `product-${id}`,
      type: 'simple',
      status: 'publish',
      description: '',
      short_description: '',
      sku: `SKU-${id}`,
      regular_price: '10.00',
      sale_price: '',
      categories: [],
      images: [],
      attributes: [],
      variations: [],
      meta_data: [],
      downloadable: false,
      virtual: false,
      weight: '1',
      dimensions: { length: '20', width: '15', height: '5' },
    }
  }

  it('AC-7: a source that lost records before the cursor between the runs never shows progress above its total, and ends at n/n', async () => {
    const products = Array.from({ length: 130 }, (_, i) => simpleProduct(i + 1))
    const empty: WooStore = {
      categories: [],
      products: [],
      variations: {},
      customers: [],
      orders: [],
      reviews: [],
    }
    const env = await openStoreApp()
    try {
      // Page 1 (100 products) finished and its cursor saved; 10 of page 2 created before the stop.
      const firstEvents = await stoppedRun(
        env,
        { store: { ...empty, products }, entities: ['products'] },
        110,
      )
      const shrunk = { ...empty, products: products.filter((p) => (p['id'] as number) > 40) }
      const second = await finishRun(env, { store: shrunk, entities: ['products'] })
      const lastProducts = second.events
        .filter((e) => e.kind === 'progress' && e.entity === 'products')
        .at(-1)

      expect({
        firstRunFaults: progressFaults(firstEvents, false),
        secondRunFaults: progressFaults(second.events, true),
        last: lastProducts,
      }).toEqual({
        firstRunFaults: [],
        secondRunFaults: [],
        last: {
          kind: 'progress',
          entity: 'products',
          done: shrunk.products.length,
          total: shrunk.products.length,
        },
      })
    } finally {
      await env.close()
    }
  }, 120_000)
})
