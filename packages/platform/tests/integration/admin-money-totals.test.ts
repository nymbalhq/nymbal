import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, cartWith, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, storedMoney, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'

// AC-7 on SQLite: dashboard revenue and a customer's totalSpentMinor are Σ (captured − refunded) over their orders,
// over generated runs of paid, manually paid and unpaid orders with generated partial refunds. AC-3: the customer
// page's stats count the same money (past one page of orders on both dialects: suites/customer-stats.ts).

interface Dashboard {
  today: { orderCount: number; revenueMinor: number; itemsShipped: number }
}

interface CustomerRead {
  customer: { totalSpentMinor: number }
  stats: {
    orderCount: number
    lifetimeRevenueMinor: number
    avgOrderValueMinor: number
  }
}

const orderPlan = fc.record({
  kind: fc.constantFrom('paid', 'manual', 'unpaid'),
  priceMinor: fc.integer({ min: 1, max: 15_000 }),
  qty: fc.integer({ min: 1, max: 3 }),
  refundPercents: fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 3 }),
})

describe('AC-7: totals count money (sqlite)', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let admin: AdminClient

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    admin = await adminClient(k, served.baseUrl)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  async function revenue(): Promise<number> {
    const res = await admin.call<Dashboard>('GET', '/api/admin/dashboard')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!.today.revenueMinor
  }

  async function customerRead(customerId: string): Promise<CustomerRead> {
    const res = await admin.call<CustomerRead>('GET', `/api/admin/customers/${customerId}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!
  }

  // AC-3 kills: stats summing `totalMinor` by status (a partial refund counted at its full total, a full refund at
  // none of what it kept), and an average divided by unpaid orders too.
  it('AC-7, AC-3: over generated paid, manually paid, unpaid, partially refunded and refunded orders, the dashboard revenue grows by exactly Σ (captured − refunded); the customer’s totalSpentMinor and Lifetime Value equal it, Avg Order is it over the orders that captured money, and orderCount counts every order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(orderPlan, { minLength: 1, maxLength: 4 }), async (plans) => {
        const { customer } = await k.services.auth.register({
          email: `spender-${randomUUID()}@money.test`,
          password: 'correct-horse-battery',
        })
        const revenueBefore = await revenue()
        let moved = 0
        let paidOrders = 0

        for (const plan of plans) {
          const seeded = await seedVariant(k, plan.qty + 2, { priceMinor: plan.priceMinor })
          const tag = randomUUID()
          const started = await k.services.checkout.beginCheckout({
            cartToken: await cartWith(k, seeded, plan.qty),
            customerId: customer.id,
            email:
              plan.kind === 'paid'
                ? `buyer-${tag}@money.test`
                : `buyer-${tag}+stub-pending@money.test`,
            billingAddress: address,
            shippingAddress: address,
          })
          if (plan.kind === 'unpaid') continue
          const paid =
            plan.kind === 'manual'
              ? await admin.call('POST', `/api/admin/orders/${started.orderId}/mark-paid`, {})
              : null
          expect(paid?.status ?? 200, JSON.stringify(paid?.body)).toBe(200)
          const captured = plan.priceMinor * plan.qty
          paidOrders += 1
          let refunded = 0
          for (const percent of plan.refundPercents) {
            const amountMinor = Math.min(
              captured - refunded,
              Math.max(1, Math.round((captured * percent) / 100)),
            )
            if (amountMinor <= 0) break
            const res = await admin.call('POST', `/api/admin/orders/${started.orderId}/refund`, {
              amountMinor,
            })
            expect(res.status, JSON.stringify(res.body)).toBe(200)
            refunded += amountMinor
          }
          const stored = await storedMoney(raw, started.orderId)
          expect(stored.capturedMinor - stored.refundedMinor).toBe(captured - refunded)
          moved += captured - refunded
        }

        expect((await revenue()) - revenueBefore).toBe(moved)
        const read = await customerRead(customer.id)
        expect(read.customer.totalSpentMinor, 'totalSpentMinor').toBe(moved)
        expect(read.stats.lifetimeRevenueMinor, 'Lifetime Value').toBe(
          read.customer.totalSpentMinor,
        )
        expect(read.stats.avgOrderValueMinor, `Avg Order over ${paidOrders} paid`).toBe(
          paidOrders === 0 ? 0 : Math.round(moved / paidOrders),
        )
        expect(read.stats.orderCount, 'orderCount').toBe(plans.length)
      }),
      { numRuns: 6 },
    )
  }, 180_000)

  it('AC-7: the dashboard revenue equals Σ (captured_minor − refunded_minor) over every order the store holds from today', async () => {
    // One of each: paid, partially refunded, unpaid; whatever earlier tests left is counted too.
    for (const kind of ['paid', 'partial', 'unpaid'] as const) {
      const seeded = await seedVariant(k, 3, { priceMinor: 1_234 })
      const tag = randomUUID()
      const started = await k.services.checkout.beginCheckout({
        cartToken: await cartWith(k, seeded, 2),
        email:
          kind === 'unpaid' ? `buyer-${tag}+stub-pending@money.test` : `buyer-${tag}@money.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      const res =
        kind === 'partial'
          ? await admin.call('POST', `/api/admin/orders/${started.orderId}/refund`, {
              amountMinor: 1_000,
            })
          : null
      expect(res?.status ?? 200, JSON.stringify(res?.body)).toBe(200)
    }
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    const rows = await raw.rows<{ captured_minor: number; refunded_minor: number }>(
      'SELECT captured_minor, refunded_minor FROM orders WHERE created_at >= ?',
      [startOfToday],
    )
    const net = rows.reduce(
      (sum, r) => sum + Number(r.captured_minor) - Number(r.refunded_minor),
      0,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(await revenue()).toBe(net)
  })
})
