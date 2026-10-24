import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import type { OrderRefundStatus } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { OrderRefundInsert } from './order-refund.js'

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
async function order(env: Env): Promise<string> {
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

  // Defect: a column is dropped or mangled on the way back (the reason, the provider id, the timestamp), so the admin
  // shows a refund other than the one written.
  it('a row reads back as written', async () => {
    const env = await setup()
    const orderId = await order(env)
    const written = row(orderId, {
      amountMinor: 4321,
      currency: 'EUR',
      providerRefundId: 're_abc',
      status: 'succeeded',
      reason: 'damaged',
      actor: 'admin:7',
    })
    await insert(env, written)
    const [read] = await listOf(env, orderId)
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
    })
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
})
