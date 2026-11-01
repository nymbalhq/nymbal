import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, cartWith, seedVariant, type Kernel } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { openRaw, type RawReader } from '../raw.js'

// A customer page's stats on one dialect, over HTTP on a kernel from `src/`: counted over every order the customer
// has, past the 50 orders one page of their order list holds, against the orders table read through a second
// connection.

interface CustomerStats {
  stats: {
    orderCount: number
    lifetimeRevenueMinor: number
    avgOrderValueMinor: number
    firstOrderAt: string | null
  }
}

export function customerStatsSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`AC-3: a customer's stats over all their orders (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminClient(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    // Kills: stats read from `listByCustomer`, which stops at 50 orders, newest first: the oldest order drops out
    // of orderCount, firstOrderAt and Lifetime Value.
    it('AC-3: a customer with 51 orders, one past the 50-order page, gets orderCount 51, firstOrderAt = the first order’s createdAt, and Lifetime Value over all 51', async () => {
      const { customer } = await k.services.auth.register({
        email: `regular-${randomUUID()}@money.test`,
        password: 'correct-horse-battery',
      })
      const seeded = await seedVariant(k, 60, { priceMinor: 1_357 })
      const orderNumbers: string[] = []
      for (let i = 0; i < 51; i += 1) {
        const started = await k.services.checkout.beginCheckout({
          cartToken: await cartWith(k, seeded, 1),
          customerId: customer.id,
          email: `regular-${randomUUID()}@money.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        orderNumbers.push(started.orderNumber)
      }
      const first = await admin.call<{ createdAt: string }>(
        'GET',
        `/api/admin/orders/${orderNumbers[0]}`,
      )
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const [stored] = await raw.rows<{ n: number | string; net: number | string }>(
        'SELECT COUNT(*) AS n, SUM(captured_minor - refunded_minor) AS net FROM orders WHERE customer_id = ?',
        [customer.id],
      )
      expect(Number(stored!.n), 'orders stored').toBe(51)

      const res = await admin.call<CustomerStats>('GET', `/api/admin/customers/${customer.id}`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const { stats } = res.body.data!
      expect(stats.orderCount, 'orderCount').toBe(Number(stored!.n))
      expect(stats.firstOrderAt, 'firstOrderAt').toBe(first.body.data!.createdAt)
      expect(stats.lifetimeRevenueMinor, 'Lifetime Value').toBe(Number(stored!.net))
      expect(stats.avgOrderValueMinor, 'Avg Order').toBe(Math.round(Number(stored!.net) / 51))
    }, 120_000)
  })
}
