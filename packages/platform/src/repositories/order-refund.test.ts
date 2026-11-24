import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import pg from 'pg'
import { v7 as uuidv7 } from 'uuid'
import type { OrderRefundStatus, OrderSource } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import { createOrderRefundRepository, type OrderRefundInsert } from './order-refund.js'

// Each refund is a row, settled once from `pending`, found by its request key per order (a double click sends one
// key), listed oldest first.

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
  return { store, repo: repos.orderRefund, repos }
}
type Env = Awaited<ReturnType<typeof setup>>

let sequence = 0
async function order(env: Env, source?: OrderSource): Promise<string> {
  const id = uuidv7()
  const now = new Date()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repos.order.insert(tx, {
      id,
      orderNumber: `OR-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId: null,
      status: 'confirmed',
      email: 'o@example.com',
      billingAddress: {} as never,
      shippingAddress: {} as never,
      lineItems: [],
      subtotalMinor: 9000,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 9000,
      currency: 'GBP',
      notes: '',
      metadata: {},
      paymentIntentId: null,
      ...(source === undefined ? {} : { source }),
      createdAt: now,
      updatedAt: now,
    }),
  )
  return id
}

function row(orderId: string, over: Partial<OrderRefundInsert> = {}): OrderRefundInsert {
  return {
    id: uuidv7(),
    orderId,
    amountMinor: 1200,
    currency: 'GBP',
    providerRefundId: null,
    status: 'pending',
    reason: null,
    actor: 'admin:1',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    ...over,
  }
}

const insert = (env: Env, r: OrderRefundInsert) =>
  env.store.transaction((tx) => env.repo.insert(tx, r))
const listOf = (env: Env, orderId: string) =>
  env.store.read((tx) => env.repo.listByOrder(tx, orderId))

describe('OrderRefundRepository', () => {
  // Defect: settle drops the pending condition (a late answer overwrites a settled row, so a failed refund turns
  // succeeded after the fact) or reports success when nothing was written.
  it('settle writes a pending row once and answers false for a settled or unknown row', async () => {
    const env = await setup()
    const orderId = await order(env)
    const r = row(orderId)
    await insert(env, r)

    const settle = (id: string, status: OrderRefundStatus, providerRefundId: string | null) =>
      env.store.transaction((tx) => env.repo.settle(tx, id, { status, providerRefundId }))

    expect(await settle(r.id, 'failed', 're_first')).toBe(true)
    expect(await settle(r.id, 'succeeded', 're_second')).toBe(false)
    expect(await settle(uuidv7(), 'succeeded', 're_none')).toBe(false)
    const [stored] = await listOf(env, orderId)
    expect(stored).toMatchObject({ id: r.id, status: 'failed', providerRefundId: 're_first' })
    await env.store.close()
  })

  // Defect: the request key is matched across orders (one order's double click answers another's refund), or a row
  // without a key matches.
  it('findByRequestId finds the refund its request made on that order only', async () => {
    const env = await setup()
    const [a, b] = [await order(env), await order(env)]
    const requestId = uuidv7()
    const onA = row(a, { requestId, amountMinor: 500 })
    const onB = row(b, { requestId, amountMinor: 700 })
    await insert(env, onA)
    await insert(env, onB)
    await insert(env, row(a))

    const find = (orderId: string, key: string) =>
      env.store.read((tx) => env.repo.findByRequestId(tx, orderId, key))
    expect((await find(a, requestId))?.id).toBe(onA.id)
    expect((await find(b, requestId))?.id).toBe(onB.id)
    expect((await find(a, requestId))?.amountMinor).not.toBe(
      (await find(b, requestId))?.amountMinor,
    )
    expect(await find(a, uuidv7())).toBeNull()
    expect(await find(await order(env), requestId)).toBeNull()
    await env.store.close()
  })

  // Defect: a column is dropped or mangled on the way back (the reason, the provider id, the timestamp, the line), so
  // the admin shows a refund other than the one written; or a row written with no line reads back with one.
  it('AC-1: a row reads back as written, its line included, and a row written without a line reads back with none', async () => {
    const env = await setup()
    const orderId = await order(env)
    const written = row(orderId, {
      amountMinor: 4321,
      currency: 'EUR',
      providerRefundId: 're_abc',
      status: 'succeeded',
      reason: 'damaged',
      actor: 'admin:7',
      variantId: 'variant-7',
      productId: 'product-7',
    })
    const unlabelled = row(orderId, { createdAt: new Date('2026-10-01T10:00:01.000Z') })
    await insert(env, written)
    await insert(env, unlabelled)
    const [read, readUnlabelled] = await listOf(env, orderId)
    expect(read).toEqual({
      id: written.id,
      orderId,
      amountMinor: written.amountMinor,
      currency: written.currency,
      providerRefundId: written.providerRefundId,
      status: written.status,
      reason: written.reason,
      actor: written.actor,
      createdAt: written.createdAt.toISOString(),
      variantId: written.variantId,
      productId: written.productId,
    })
    expect(readUnlabelled?.id).toBe(unlabelled.id)
    expect([readUnlabelled?.variantId, readUnlabelled?.productId]).toEqual([null, null])
    await env.store.close()
  })

  // Defect: the order is lost (newest first, or by id alone), an order's list leaks another order's rows, or
  // listByOrders disagrees with listByOrder (the admin list and detail show different refunds).
  it('listByOrder is oldest first and per order, and listByOrders groups exactly the same rows', async () => {
    const env = await setup()
    const orders = [await order(env), await order(env), await order(env)]
    const silent = await order(env)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ which: fc.integer({ min: 0, max: 2 }), at: fc.integer({ min: 0, max: 5 }) }),
          { minLength: 1, maxLength: 10 },
        ),
        async (specs) => {
          for (const s of specs) {
            await insert(
              env,
              row(orders[s.which]!, {
                createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, s.at)),
              }),
            )
          }
          const grouped = await env.store.read((tx) =>
            env.repo.listByOrders(tx, [...orders, silent]),
          )
          expect(grouped.has(silent)).toBe(false)
          let total = 0
          for (const id of orders) {
            const list = await listOf(env, id)
            total += list.length
            expect(list.every((r) => r.orderId === id)).toBe(true)
            for (let i = 1; i < list.length; i += 1) {
              const [prev, cur] = [list[i - 1]!, list[i]!]
              const key = (r: typeof cur) => `${r.createdAt}|${r.id}`
              expect(key(prev) < key(cur)).toBe(true)
            }
            expect(grouped.get(id) ?? []).toEqual(list)
          }
          const all = [...grouped.values()].reduce((n, l) => n + l.length, 0)
          expect(all).toBe(total)
        },
      ),
      { numRuns: 15 },
    )
    expect(await env.store.read((tx) => env.repo.listByOrders(tx, []))).toEqual(new Map())
    expect(await listOf(env, silent)).toEqual([])
    await env.store.close()
  })

  // Defect: the empty-page guard is dropped, so an admin orders page with no orders still queries refunds. A handle
  // whose read has settled refuses any query, so only a call that queries nothing answers on it.
  it('listByOrders of no orders answers an empty map without querying', async () => {
    const env = await setup()
    const orderId = await order(env)
    await insert(env, row(orderId))
    const settled = await env.store.read(async (tx) => tx)

    await expect(env.repo.listByOrders(settled, [orderId])).rejects.toThrow(/after its read/)
    await expect(env.repo.listByOrders(settled, [])).resolves.toEqual(new Map())
    await env.store.close()
  })

  // Defect: the delete loses its order condition (rolling one imported order back takes every order's refunds with
  // it) or deletes nothing (the removed order leaves refunds behind).
  it('deleteByOrder removes the refunds of that order and leaves those of every other order as they were', async () => {
    const env = await setup()
    const [gone, kept] = [await order(env), await order(env)]
    for (const at of [0, 1, 2]) {
      await insert(env, row(gone, { createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, at)) }))
    }
    for (const at of [0, 3]) {
      await insert(env, row(kept, { createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, at)) }))
    }
    const keptBefore = await listOf(env, kept)

    await env.store.transaction((tx) => env.repo.deleteByOrder(tx, gone))

    expect(await listOf(env, gone)).toEqual([])
    expect(await listOf(env, kept)).toEqual(keptBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (a refund made the instant the import ran, or one made before it, is
  // counted the wrong way), the filter is dropped, or ids are collapsed so an order refunded twice counts once.
  it('orderIdsSince answers the order of each refund made at or after the time, none before', async () => {
    const env = await setup()
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ which: fc.integer({ min: 0, max: 2 }), at: fc.integer({ min: -3, max: 3 }) }),
          { maxLength: 6 },
        ),
        fc.integer({ min: -3, max: 3 }),
        async (specs, sinceAt) => {
          // Fresh orders each run, so earlier runs' rows are told apart and a counterexample replays alone.
          const orders = [await order(env), await order(env), await order(env)]
          for (const s of specs) {
            await insert(env, row(orders[s.which]!, { createdAt: new Date(base + s.at * 1000) }))
          }
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.orderIdsSince(tx, since))
          const expected = specs.filter((s) => s.at >= sinceAt).map((s) => orders[s.which]!)
          expect(got.filter((id) => orders.includes(id)).sort()).toEqual(expected.sort())
        },
      ),
      { numRuns: 20 },
    )
    await env.store.close()
  })

  // Defect: the sweep asks about settled refunds, or about one still inside its own request (the bound is inclusive),
  // or an order with two pending rows is asked about twice, so the tick's limit goes on duplicates.
  it('pendingOrderIds answers each order holding a pending refund made before the time, once, and no other', async () => {
    const env = await setup()
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s))
    const before = at(5)
    const [once, twice, settled, atBound, after] = [
      await order(env),
      await order(env),
      await order(env),
      await order(env),
      await order(env),
    ]
    await insert(env, row(once, { createdAt: at(2) }))
    await insert(env, row(twice, { createdAt: at(3) }))
    await insert(env, row(twice, { createdAt: at(4) }))
    await insert(env, row(settled, { status: 'succeeded', createdAt: at(0) }))
    await insert(env, row(settled, { status: 'failed', createdAt: at(0) }))
    await insert(env, row(atBound, { createdAt: at(5) }))
    await insert(env, row(after, { createdAt: at(6) }))

    const got = await env.store.read((tx) => env.repo.pendingOrderIds(tx, before, 10))

    expect(got).toEqual([once, twice])
    expect(new Set(got).size).toBe(got.length)
    await env.store.close()
  })

  // Defect: the order is by id or by a later row of the order, so the longest wait goes last and a limit starves it.
  it('pendingOrderIds is by the oldest pending refund of each order, then by order id, and limit keeps the head', async () => {
    const env = await setup()
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s))
    const [newestFirst, longestWait, tiedA, tiedB] = [
      await order(env),
      await order(env),
      await order(env),
      await order(env),
    ]
    await insert(env, row(newestFirst, { createdAt: at(4) }))
    await insert(env, row(longestWait, { createdAt: at(1) }))
    // A later row of the same order: the order waits since its oldest one, not this.
    await insert(env, row(longestWait, { createdAt: at(9) }))
    await insert(env, row(tiedB, { createdAt: at(2) }))
    await insert(env, row(tiedA, { createdAt: at(2) }))
    const tied = [tiedA, tiedB].sort()

    const pending = (limit: number) =>
      env.store.read((tx) => env.repo.pendingOrderIds(tx, at(30), limit))
    const all = await pending(10)

    expect(all).toEqual([longestWait, ...tied, newestFirst])
    expect(await pending(2)).toEqual(all.slice(0, 2))
    expect(await pending(1)).toEqual([longestWait])
    await env.store.close()
  })

  // Defect: the Postgres half of the query drops the pending filter or answers rows instead of ids. The sweep runs on
  // SQLite in every suite, so drizzle's real Postgres driver stands here against a connection that records and answers.
  it('pendingOrderIds on Postgres asks only for pending refunds before the time, and answers the order ids returned', async () => {
    const sent: unknown[][] = []
    const connection = {
      query: async (_statement: unknown, values: unknown[]) => {
        sent.push(values)
        return { rows: [['order-a'], ['order-b']] }
      },
      release: () => undefined,
    }
    const connect = vi
      .spyOn(pg.Pool.prototype, 'connect')
      .mockImplementation(async () => connection as never)
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
      { postgresUrl: 'postgres://unused/none' },
    )
    const before = new Date('2026-10-01T10:00:05.000Z')
    try {
      const got = await store.read((tx) =>
        createOrderRefundRepository(store).pendingOrderIds(tx, before, 7),
      )

      expect(got).toEqual(['order-a', 'order-b'])
      expect(sent).toEqual([['pending', before.toISOString(), 7]])
    } finally {
      connect.mockRestore()
      await store.close()
    }
  })
  // Defect: the refund-rate figure counts what says nothing about shoppers (a pending or failed refund, a capture
  // checkout returned on a cancelled order, a synthetic or imported order's refund), the bound is strict or reversed,
  // the times come back unordered or as strings, or a refund's product is dropped or given to another refund.
  it('AC-1: countedRefunds answers each succeeded shopper refund at or after the time with the product it names, oldest first', async () => {
    const env = await setup()
    const sources: OrderSource[] = ['storefront', 'agent:shop-bot', 'synthetic', 'import']
    const statuses: OrderRefundStatus[] = ['succeeded', 'pending', 'failed']
    const actors = ['admin:1', 'system:checkout', 'system:webhook']
    const products = [null, 'product-a', 'product-b']
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            source: fc.integer({ min: 0, max: sources.length - 1 }),
            status: fc.integer({ min: 0, max: statuses.length - 1 }),
            actor: fc.integer({ min: 0, max: actors.length - 1 }),
            product: fc.integer({ min: 0, max: products.length - 1 }),
            at: fc.integer({ min: -3, max: 3 }),
          }),
          { maxLength: 8 },
        ),
        fc.integer({ min: -3, max: 3 }),
        async (specs, sinceAt) => {
          // Each run an hour after the last, so earlier runs' rows all fall before this run's time.
          run += 1
          const base = Date.UTC(2026, 9, 1, run, 0, 0)
          for (const s of specs) {
            const orderId = await order(env, sources[s.source])
            const productId = products[s.product]!
            await insert(
              env,
              row(orderId, {
                status: statuses[s.status]!,
                actor: actors[s.actor]!,
                createdAt: new Date(base + s.at * 1000),
                variantId: productId === null ? null : `variant-of-${productId}`,
                productId,
              }),
            )
          }
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.countedRefunds(tx, since))
          const expected = specs
            .filter(
              (s) =>
                s.at >= sinceAt &&
                statuses[s.status] === 'succeeded' &&
                actors[s.actor] !== 'system:checkout' &&
                (s.source === 0 || s.source === 1),
            )
            .map((s) => `${base + s.at * 1000}|${products[s.product]}`)
          const times = got.map((r) => r.at.getTime())
          for (let i = 1; i < times.length; i += 1) {
            expect(times[i - 1]!).toBeLessThanOrEqual(times[i]!)
          }
          expect(got.map((r) => `${r.at.getTime()}|${r.productId}`).sort()).toEqual(
            expected.sort(),
          )
        },
      ),
      { numRuns: 25 },
    )
    await env.store.close()
  })

  // Defect: the time is taken from any refund rather than one that names a product, the earliest is lost (max, or
  // the first row inserted), or a store with no named refund answers a time, which would open the by-product rule on a
  // store that has never labelled a refund.
  it('AC-1: namedSince answers when the earliest refund naming a product was made, null when none does, and an earlier unnamed refund does not move it', async () => {
    const env = await setup()
    const named = () => env.store.read((tx) => env.repo.namedSince(tx))
    expect(await named()).toBeNull()

    const orderId = await order(env)
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s))
    await insert(env, row(orderId, { status: 'succeeded', createdAt: at(1) }))
    expect(await named()).toBeNull()

    await insert(
      env,
      row(orderId, {
        status: 'succeeded',
        createdAt: at(9),
        variantId: 'variant-late',
        productId: 'product-late',
      }),
    )
    await insert(
      env,
      row(orderId, {
        status: 'succeeded',
        createdAt: at(5),
        variantId: 'variant-early',
        productId: 'product-early',
      }),
    )
    await insert(env, row(orderId, { status: 'succeeded', createdAt: at(0) }))

    expect((await named())?.getTime()).toBe(at(5).getTime())
    await env.store.close()
  })

  // Defect: as above, over any mix: the answer is not the minimum time of the named rows.
  it('AC-1: property: namedSince is the minimum time of the refunds that name a product, whatever unnamed refunds lie around them', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ named: fc.boolean(), at: fc.integer({ min: 0, max: 50 }) }), {
          maxLength: 8,
        }),
        async (specs) => {
          const env = await setup()
          try {
            const orderId = await order(env)
            for (const s of specs) {
              await insert(
                env,
                row(orderId, {
                  status: 'succeeded',
                  createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, s.at)),
                  ...(s.named ? { variantId: `v-${s.at}`, productId: `p-${s.at}` } : {}),
                }),
              )
            }
            const namedTimes = specs
              .filter((s) => s.named)
              .map((s) => Date.UTC(2026, 9, 1, 10, 0, s.at))
            const got = await env.store.read((tx) => env.repo.namedSince(tx))
            expect(got === null ? null : got.getTime()).toBe(
              namedTimes.length === 0 ? null : Math.min(...namedTimes),
            )
          } finally {
            await env.store.close()
          }
        },
      ),
      { numRuns: 15 },
    )
  })

  // Defect: the Postgres half drops a filter (the status, the checkout actor, the uncounted sources), answers rows
  // instead of times, or loses each refund's product; drizzle's real Postgres driver stands here against a connection
  // that records and answers, each row in the order the statement selects its columns.
  it('AC-1: countedRefunds on Postgres sends every filter and answers the time and product of each row returned', async () => {
    const sent: unknown[][] = []
    const returned = [
      { at: '2026-10-01T10:00:01.000Z', productId: 'product-a' },
      { at: '2026-10-01T10:00:04.000Z', productId: null },
    ]
    const connection = {
      query: async (statement: { text?: string } | string, values: unknown[]) => {
        sent.push(values)
        const text = typeof statement === 'string' ? statement : (statement.text ?? '')
        const selected = (/^select (.*?) from /is.exec(text)?.[1] ?? '').split(/,\s*/)
        const column = (name: string) => selected.findIndex((c) => c.includes(`"${name}"`))
        const [at, product] = [column('created_at'), column('product_id')]
        return {
          rows: returned.map((r) => {
            const cells: unknown[] = selected.map(() => null)
            cells[at] = r.at
            cells[product] = r.productId
            return cells
          }),
        }
      },
      release: () => undefined,
    }
    const connect = vi
      .spyOn(pg.Pool.prototype, 'connect')
      .mockImplementation(async () => connection as never)
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
      { postgresUrl: 'postgres://unused/none' },
    )
    const since = new Date('2026-10-01T10:00:00.000Z')
    try {
      const got = await store.read((tx) =>
        createOrderRefundRepository(store).countedRefunds(tx, since),
      )

      expect(got.map((r) => [r.at.toISOString(), r.productId])).toEqual(
        returned.map((r) => [r.at, r.productId]),
      )
      expect(sent.map((values) => [...values].map(String).sort())).toEqual([
        ['succeeded', since.toISOString(), 'system:checkout', 'synthetic', 'import'].sort(),
      ])
    } finally {
      connect.mockRestore()
      await store.close()
    }
  })
})
