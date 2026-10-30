import { createHash, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// AC-5 on one dialect, over HTTP on a kernel from `src/`: every guest checkout answer for an order mints a checkout
// key (the placed answer, the pending cart's order answered again, the 409 naming the order a paid cart became), and
// an order keeps only its 5 newest: a mint past 5 deletes the oldest in the same write. The page's poll of a pending
// order reads by key and mints nothing. The kernel sets no `store.url`, so no email key is minted.

const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const CAP = 5

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface Answer {
  orderId: string
  orderNumber: string
  orderKey?: string
}

interface Refusal {
  code: string
  context?: { orderNumber?: string; orderKey?: string }
}

/** One guest's mint sequence: a pending cart answered again, or a paid cart resubmitted, `again` more times. */
const sequence = fc.record({
  pending: fc.boolean(),
  again: fc.integer({ min: 1, max: 8 }),
})

export function orderKeyCapSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`AC-5: an order keeps at most its ${CAP} newest checkout keys (${dialect})`, () => {
    let served: ServedKernel
    let raw: RawReader
    let seeded: Seeded

    beforeAll(async () => {
      const k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      seeded = await seedVariant(k, 500)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function read(orderNumber: string, key: string): Promise<number> {
      const res = await fetch(
        new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, served.baseUrl),
        {
          headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key },
        },
      )
      await res.arrayBuffer()
      return res.status
    }

    const checkoutRows = (orderId: string) =>
      raw.rows<{ key_hash: string }>(
        "SELECT key_hash FROM order_access_keys WHERE order_id = ? AND purpose = 'checkout'",
        [orderId],
      )

    // Kills: no cap, so a checkout loop grows the table without bound; a cap that deletes the newest keys, or keys of
    // another order; a cap applied outside the mint's write; a poll that mints.
    it(`AC-5: property: over mint sequences of 2 to 9 checkout answers for one guest order (a pending cart answered again, or a paid cart’s resubmit refused 409 naming the order), the order holds min(n, ${CAP}) checkout key rows, they are the sha256 of the ${CAP} newest keys served, those read the order and every older key answers 404; reading the order 10 times by key, as the pending page polls, adds no row (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(sequence, async ({ pending, again }) => {
          const label = `${pending ? 'pending' : 'paid'} cart, ${again} more checkouts`
          const shop = await primedShopper(served.baseUrl)
          expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
          const added = await shop.call<Cart>('POST', '/api/cart/items', {
            variantId: seeded.variantId,
            qty: 1,
          })
          expect(added.status, JSON.stringify(added.body)).toBe(200)
          const email = `cap-${randomUUID()}${pending ? '+stub-pending' : ''}@key-cap.test`
          const submit = () =>
            shop.call<Answer>('POST', '/api/checkout', {
              email,
              billingAddress: address,
              shippingAddress: address,
            })

          const first = await submit()
          expect(first.status, `${label}: ${JSON.stringify(first.body)}`).toBe(200)
          const order = first.body.data!
          const minted: string[] = [order.orderKey!]
          for (let i = 0; i < again; i += 1) {
            const answer = await submit()
            if (pending) {
              expect(
                answer.status,
                `${label}, answer ${i + 2}: ${JSON.stringify(answer.body)}`,
              ).toBe(200)
              expect(answer.body.data!.orderNumber, `${label}, answer ${i + 2}`).toBe(
                order.orderNumber,
              )
              minted.push(answer.body.data!.orderKey!)
            } else {
              const refusal = (answer.body as { error?: Refusal }).error
              expect(
                answer.status,
                `${label}, answer ${i + 2}: ${JSON.stringify(answer.body)}`,
              ).toBe(409)
              expect(refusal?.context?.orderNumber, `${label}, answer ${i + 2}`).toBe(
                order.orderNumber,
              )
              minted.push(refusal!.context!.orderKey!)
            }
          }
          const n = minted.length
          const newest = minted.slice(-CAP)
          const older = minted.slice(0, Math.max(0, n - CAP))

          const rows = await checkoutRows(order.orderId)
          expect(rows.length, `${label}: checkout key rows after ${n} mints`).toBe(Math.min(n, CAP))
          expect(rows.map((r) => r.key_hash).sort(), `${label}: the rows kept`).toEqual(
            newest.map(sha256).sort(),
          )
          for (const key of newest)
            expect(await read(order.orderNumber, key), `${label}: a kept key`).toBe(200)
          for (const key of older)
            expect(await read(order.orderNumber, key), `${label}: a deleted key`).toBe(404)

          // The order page's poll: reads by key, pending or paid, and mints nothing.
          const before = (await checkoutRows(order.orderId)).length
          for (let i = 0; i < 10; i += 1) await read(order.orderNumber, minted.at(-1)!)
          expect((await checkoutRows(order.orderId)).length, `${label}: rows after 10 polls`).toBe(
            before,
          )
        }),
        { numRuns: 6 },
      )
    }, 120_000)
  })
}
