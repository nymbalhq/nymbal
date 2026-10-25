import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_ORDER_PLACED, type OrderLineItem } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, type Kernel } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// AC-3 on one dialect: a kernel migrated to the head holds orders with no key, the way orders placed before keys
// existed and imported orders do. Two are written through the order repository with their order.placed published (so
// the read side projects them), two through importOrder; one of each is a guest's, one a customer's. A guest order
// with no key is not found for anyone on the shopper route, whatever key is sent; a customer's is read by that
// customer's session alone.

const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const orderKey = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)

interface Customer {
  id: string
  bearer: string
}

interface Keyless {
  label: string
  id: string
  orderNumber: string
  owner: Customer | null
}

const line: OrderLineItem = {
  variantId: 'keyless-variant',
  productId: 'keyless-product',
  productName: 'Keyless Widget',
  variantName: 'Default',
  sku: 'KEYLESS-1',
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 0,
  lineTotalMinor: 2500,
  imageUrl: '',
}

const money = {
  lineItems: [line],
  subtotalMinor: 2500,
  taxTotalMinor: 0,
  shippingTotalMinor: 0,
  discountTotalMinor: 0,
  totalMinor: 2500,
  currency: 'GBP',
}

export function keylessOrdersSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`AC-3: orders with no key (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let owner: Customer
    let stranger: Customer
    const orders: Keyless[] = []

    async function customer(): Promise<Customer> {
      const shop = await primedShopper(served.baseUrl)
      const registered = await shop.call<{ accessToken: string; customer: { id: string } }>(
        'POST',
        '/api/auth/register',
        { email: `keyless-${randomUUID()}@orders.test`, password: 'keyless-correct-horse' },
      )
      expect(registered.status, JSON.stringify(registered.body)).toBe(201)
      return { id: registered.body.data!.customer.id, bearer: registered.body.data!.accessToken }
    }

    /** An order as one placed before keys existed: the row and its order.placed, and no key. */
    async function written(label: string, by: Customer | null): Promise<Keyless> {
      const id = uuidv7()
      const orderNumber = `OLD-${randomUUID().slice(0, 8)}`
      const now = new Date()
      await k.store.transaction(async (tx) => {
        const sequence = await k.repos.orderSequence.nextSequence(tx)
        await k.repos.order.insert(tx, {
          id,
          orderNumber,
          sequence,
          customerId: by?.id ?? null,
          status: 'confirmed',
          email: `${label.replace(/\W+/g, '-')}@orders.test`,
          billingAddress: address,
          shippingAddress: address,
          ...money,
          notes: '',
          metadata: {},
          paymentIntentId: null,
          createdAt: now,
          updatedAt: now,
        })
        const order = await k.repos.order.findById(tx, id)
        await k.publisher.publish(EVT_ORDER_PLACED, { order: order! })
      })
      return { label, id, orderNumber, owner: by }
    }

    /** An order as the WooCommerce importer brings it. */
    async function imported(label: string, by: Customer | null): Promise<Keyless> {
      const order = await k.services.order.importOrder({
        orderId: uuidv7(),
        orderNumber: `WC-${Math.floor(Math.random() * 1e9)}`,
        status: 'confirmed',
        createdAt: new Date('2025-01-02T10:00:00Z'),
        customerId: by?.id ?? null,
        email: `${label.replace(/\W+/g, '-')}@orders.test`,
        billingAddress: address,
        shippingAddress: address,
        ...money,
        metadata: {},
      })
      return { label, id: order.id, orderNumber: order.orderNumber, owner: by }
    }

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      owner = await customer()
      stranger = await customer()
      orders.push(
        await written('an old guest order', null),
        await written('an old customer order', owner),
        await imported('an imported guest order', null),
        await imported('an imported customer order', owner),
      )
      await k.app.relay.drain()
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function read(orderNumber: string, headers: Record<string, string> = {}) {
      const res = await fetch(
        new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, served.baseUrl),
        { headers: { accept: 'application/json', ...headers } },
      )
      return { status: res.status, body: (await res.json()) as unknown }
    }

    /** What a number no order has gets, with `orderNumber` in its place. */
    async function notFoundBodyFor(orderNumber: string): Promise<unknown> {
      const unknown = `NONE-${randomUUID().slice(0, 8)}`
      const res = await fetch(new URL(`/api/orders/${unknown}`, served.baseUrl), {
        headers: { accept: 'application/json' },
      })
      expect(res.status, `${unknown}: a number no order has`).toBe(404)
      return JSON.parse((await res.text()).replaceAll(unknown, orderNumber)) as unknown
    }

    const bearer = (c: Customer) => ({ authorization: `Bearer ${c.bearer}` })

    it(`AC-3: the head migration leaves order_access_keys in place, and the keyless orders have no row in it (${dialect})`, async () => {
      const tables =
        dialect === 'sqlite'
          ? await raw.rows<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_access_keys'",
            )
          : await raw.rows<{ name: string }>(
              "SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'order_access_keys'",
            )
      expect(tables.map((t) => t.name)).toEqual(['order_access_keys'])
      for (const o of orders) {
        expect(
          await raw.count('order_access_keys', 'order_id = ?', [o.id]),
          `${o.label}: key rows`,
        ).toBe(0)
      }
    })

    // Kills: an order with no key rows treated as open, and an imported guest order served.
    it(`AC-3: property: each keyless guest order, old or imported, answers 404 with the body of a number no order has to a read with no key and with any 43-character key (${dialect})`, async () => {
      const guests = orders.filter((o) => o.owner === null)
      const expected = new Map(
        await Promise.all(
          guests.map(async (o) => [o.orderNumber, await notFoundBodyFor(o.orderNumber)] as const),
        ),
      )
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...guests),
          fc.option(orderKey, { nil: undefined }),
          async (o, key) => {
            const answer = await read(
              o.orderNumber,
              key === undefined ? {} : { [ORDER_KEY_HEADER]: key },
            )
            const label = `${o.label} read with ${key === undefined ? 'no key' : `the key ${key}`}`
            expect(answer.status, label).toBe(404)
            expect(answer.body, label).toEqual(expected.get(o.orderNumber))
          },
        ),
        { numRuns: 40 },
      )
    })

    // Kills: a keyless customer order served to no session, or answered 403 to another customer, which says it exists.
    it(`AC-3: each keyless customer order, old or imported, answers 200 to its customer’s bearer, and 404 with the body of a number no order has to another customer’s bearer and to no session (${dialect})`, async () => {
      for (const o of orders.filter((x) => x.owner !== null)) {
        const theirs = await read(o.orderNumber, bearer(o.owner!))
        expect(theirs.status, `${o.label}: its customer`).toBe(200)
        expect((theirs.body as { data: { id: string } }).data.id, `${o.label}: its customer`).toBe(
          o.id,
        )

        const notFound = await notFoundBodyFor(o.orderNumber)
        for (const [who, headers] of [
          ['another customer', bearer(stranger)],
          ['no session', {}],
        ] as const) {
          const answer = await read(o.orderNumber, headers)
          expect(answer.status, `${o.label}: ${who}`).toBe(404)
          expect(answer.body, `${o.label}: ${who}`).toEqual(notFound)
        }
      }
    })
  })
}
