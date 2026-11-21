import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { OrderSource, OrderStatus } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, type Kernel } from '../kernel.js'
import { adminAccount, customerAccount, type Account } from '../mcp.js'
import { unaudited } from '../write-audit.js'

// AC-6 on one dialect: the dashboard's agent figures over generated orders. Each run writes 0 to 260 orders with any
// source, status and consistent money, created over the last 45 days (none within a minute of the 30-day boundary),
// and holds GET /api/admin/dashboard's `agents` against a reference computed from what was written: the count and the
// money kept (Σ captured − refunded) of the `agent:` orders in the window, and the top five agent sources.

const DAY = 86_400_000
const WINDOW = 30 * DAY
const SOURCES = [
  'storefront',
  'import',
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s): OrderSource => `agent:${s}`),
] as const
const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]

interface Generated {
  source: (typeof SOURCES)[number]
  status: OrderStatus
  /** How long before the run's start it was created. */
  ageMs: number
  totalMinor: number
  capturedMinor: number
  refundedMinor: number
}

/** Money with 0 ≤ refunded ≤ captured ≤ total, biased to the edges so revenue and count ties occur. */
const money = fc
  .integer({ min: 0, max: 50_000 })
  .chain((total) =>
    fc
      .oneof(fc.constant(0), fc.constant(total), fc.integer({ min: 0, max: total }))
      .chain((captured) =>
        fc
          .oneof(fc.constant(0), fc.constant(captured), fc.integer({ min: 0, max: captured }))
          .map((refunded) => ({
            totalMinor: total,
            capturedMinor: captured,
            refundedMinor: refunded,
          })),
      ),
  )

const awayFromBoundary = (age: number) => Math.abs(age - WINDOW) > 60_000

function order(ages: fc.Arbitrary<number>): fc.Arbitrary<Generated> {
  return fc
    .record({
      source: fc.constantFrom(...SOURCES),
      status: fc.constantFrom(...STATUSES),
      ageMs: ages,
    })
    .chain((o) => money.map((m) => ({ ...o, ...m })))
}

const anyAge = fc.integer({ min: 0, max: 45 * DAY }).filter(awayFromBoundary)
const inWindowAge = fc.integer({ min: 0, max: WINDOW - 2 * 60_000 })

interface SourceRow {
  source: string
  count: number
  revenueMinor: number
}

interface AgentsAnswer {
  since: string
  currency: string
  surfaces: Array<{ name: string; capabilities: unknown }>
  mcp: { enabled: boolean; writes: string }
  profilePath: string | null
  orders: { count: number; revenueMinor: number }
  bySource: SourceRow[]
}

interface DashboardAnswer {
  today: unknown
  recentOrders: unknown
  lowStock: unknown
  agents: AgentsAnswer
}

/** The reference: the `agent:` orders in the window, totalled and grouped, every group ordered as the tile orders. */
function reference(orders: Generated[]) {
  const inWindow = orders.filter((o) => o.source.startsWith('agent:') && o.ageMs < WINDOW)
  const kept = (o: Generated) => o.capturedMinor - o.refundedMinor
  const groups = new Map<string, SourceRow>()
  for (const o of inWindow) {
    const row = groups.get(o.source) ?? { source: o.source, count: 0, revenueMinor: 0 }
    row.count += 1
    row.revenueMinor += kept(o)
    groups.set(o.source, row)
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      b.revenueMinor - a.revenueMinor ||
      b.count - a.count ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
  )
  return {
    count: inWindow.length,
    revenueMinor: inWindow.reduce((sum, o) => sum + kept(o), 0),
    groups: ordered,
  }
}

const sum = (rows: SourceRow[]) => rows.reduce((s, r) => s + r.revenueMinor, 0)

export interface DashboardAgentsSuiteOptions {
  /** fast-check runs of the money property, beyond its two examples. */
  runs: number
}

export function dashboardAgentsSuite(
  dialect: Kernel['dialect'],
  /** A kernel on a database of its own, its config reshaped by `configure`. */
  start: (configure?: (config: NymbalConfig) => NymbalConfig) => Promise<Kernel>,
  opts: DashboardAgentsSuiteOptions,
): void {
  describe(`AC-6: the dashboard's agent figures (${dialect})`, () => {
    let served: ServedKernel
    let k: Kernel
    let admin: Account
    let sequence = 5_000_000

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminAccount(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    async function dashboard(at: ServedKernel, token: string) {
      const res = await fetch(new URL('/api/admin/dashboard', at.baseUrl), {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      })
      return { status: res.status, body: (await res.json()) as { data?: DashboardAnswer } }
    }

    /** Writes the orders as rows (no events: nothing here reads a projection) and answers their ids. */
    async function write(orders: Generated[], startedAt: number): Promise<string[]> {
      const ids: string[] = []
      await unaudited(() =>
        k.store.transaction(async (tx) => {
          for (const o of orders) {
            sequence += 1
            const id = randomUUID()
            const createdAt = new Date(startedAt - o.ageMs)
            await k.repos.order.insert(tx, {
              id,
              orderNumber: `AGT-${sequence}`,
              sequence,
              customerId: null,
              status: o.status,
              email: `tile-${sequence}@dashboard.test`,
              billingAddress: address,
              shippingAddress: address,
              lineItems: [],
              subtotalMinor: o.totalMinor,
              taxTotalMinor: 0,
              shippingTotalMinor: 0,
              discountTotalMinor: 0,
              totalMinor: o.totalMinor,
              currency: 'GBP',
              source: o.source,
              ...(o.capturedMinor > 0 && {
                capture: {
                  amountMinor: o.capturedMinor,
                  method: 'provider' as const,
                  at: createdAt,
                  refundedMinor: o.refundedMinor,
                },
              }),
              createdAt,
              updatedAt: createdAt,
            })
            ids.push(id)
          }
        }),
      )
      return ids
    }

    async function remove(ids: string[]): Promise<void> {
      await unaudited(() =>
        k.store.transaction(async (tx) => {
          for (const id of ids) await k.repos.order.delete(tx, id)
        }),
      )
    }

    // Kills: the tile computed from the newest-200 list, storefront or imported orders counted, totalMinor summed in
    // place of the money kept, a sixth source leaked, a window off by a day, ties ordered another way.
    it(`AC-6: property: agents.orders is the count and Σ(captured − refunded) of the agent: orders created since now − 30 days, bySource is the reference's top five by revenue, count, then source, and since is now − 30 days within 2 s (${dialect})`, async () => {
      const big = fc.sample(order(inWindowAge), { numRuns: 230, seed: 6 })
      await fc.assert(
        fc.asyncProperty(fc.array(order(anyAge), { maxLength: 260 }), async (orders) => {
          const startedAt = Date.now()
          const ids = await write(orders, startedAt)
          try {
            const before = Date.now()
            const res = await dashboard(served, admin.token)
            const after = Date.now()
            const agents = res.body.data?.agents
            const ref = reference(orders)

            expect(res.status).toBe(200)
            expect({ orders: agents?.orders, bySource: agents?.bySource }).toEqual({
              orders: { count: ref.count, revenueMinor: ref.revenueMinor },
              bySource: ref.groups.slice(0, 5),
            })
            // Σ over every agent source is the total; the five shown sum to no more, and to it when there are ≤ 5.
            expect(sum(ref.groups)).toBe(agents?.orders.revenueMinor)
            expect(sum(agents?.bySource ?? [])).toBeLessThanOrEqual(
              agents?.orders.revenueMinor ?? -1,
            )
            const since = Date.parse(agents?.since ?? '')
            expect(since).toBeGreaterThanOrEqual(before - WINDOW - 2000)
            expect(since).toBeLessThanOrEqual(after - WINDOW + 2000)
            expect(agents?.currency).toBe(k.config.store.currency)
          } finally {
            await remove(ids)
          }
        }),
        { numRuns: opts.runs, examples: [[[]], [big]] },
      )
    }, 300_000)

    it(`AC-6: surfaces, profilePath and mcp follow the config: with ucp on, the ucp surface with search, lookup and checkout handoff at /.well-known/ucp; with ucp off, none and a null profilePath; mcp as configured; currency the store's (${dialect})`, async () => {
      const other = await start((config) => ({
        ...config,
        store: { ...config.store, currency: 'EUR' },
        agents: {
          ...config.agents,
          ucp: { ...config.agents.ucp, enabled: false },
          mcp: { ...config.agents.mcp, enabled: false, writes: 'apply' },
        },
      }))
      const otherServed = await serveKernel(other)
      try {
        const otherAdmin = await adminAccount(other, otherServed.baseUrl)
        const on = (await dashboard(served, admin.token)).body.data?.agents
        const off = (await dashboard(otherServed, otherAdmin.token)).body.data?.agents
        const shape = (a: AgentsAnswer | undefined) => ({
          surfaces: a?.surfaces,
          profilePath: a?.profilePath,
          mcp: a?.mcp,
          currency: a?.currency,
        })

        expect([shape(on), shape(off)]).toEqual([
          {
            surfaces: [
              { name: 'ucp', capabilities: { search: true, lookup: true, checkout: 'handoff' } },
            ],
            profilePath: '/.well-known/ucp',
            mcp: { enabled: k.config.agents.mcp.enabled, writes: k.config.agents.mcp.writes },
            currency: k.config.store.currency,
          },
          {
            surfaces: [],
            profilePath: null,
            mcp: {
              enabled: other.config.agents.mcp.enabled,
              writes: other.config.agents.mcp.writes,
            },
            currency: other.config.store.currency,
          },
        ])
        expect(other.config.store.currency).not.toBe(k.config.store.currency)
      } finally {
        await otherServed.stop()
      }
    }, 60_000)

    it(`AC-6: the answer keeps today, recentOrders and lowStock beside agents, and a customer token gets 403 as before (${dialect})`, async () => {
      const shopper = await customerAccount(k, served.baseUrl)
      const asAdmin = await dashboard(served, admin.token)
      const asCustomer = await dashboard(served, shopper.token)

      expect(Object.keys(asAdmin.body.data ?? {}).sort()).toEqual([
        'agents',
        'lowStock',
        'recentOrders',
        'today',
      ])
      expect([asAdmin.status, asCustomer.status]).toEqual([200, 403])
    })
  })
}
