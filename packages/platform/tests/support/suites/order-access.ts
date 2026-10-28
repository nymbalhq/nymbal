import { createHash, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// AC-2 on one dialect, over HTTP on a kernel from `src/` with a real checkout: every checkout answer for an order
// (a new order, the cart's pending order answered again, and the 409 that names the order a cart became) carries a
// key that reads that order through `x-nymbal-order-key` and no other. `order_access_keys` holds, for each order, the
// sha256 hex of keys the store served, never a key. The kernel sets no `store.url`, so no email key is minted and
// every row traces to a served key.

const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  orderStatus: string
  orderKey: string
}

interface Refusal {
  code: string
  message: string
  context?: { orderNumber?: string; orderKey?: string }
}

interface KeyRow {
  order_id: string
  key_hash: string
}

type Shop = Awaited<ReturnType<typeof primedShopper>>

interface Shopper {
  shop: Shop
  headers: Record<string, string>
}

/** One generated checkout: a guest or a signed-in shopper, whose order the stub pays inline or leaves pending. */
const arbCheckout = fc.record({
  signedIn: fc.boolean(),
  pending: fc.boolean(),
})

export function orderAccessSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`AC-2: a checkout answers the order’s key, and the key reads that order only (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let seeded: Seeded
    /** Every key a checkout answer or a refusal served in this file, so every row can be traced to one. */
    const servedKeys = new Set<string>()

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      seeded = await seedVariant(k, 500)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    /** A shopper with one unit of the variant in their cart, signed in over HTTP when asked. */
    async function shopperWithLine(signedIn: boolean): Promise<Shopper> {
      const shop = await primedShopper(served.baseUrl)
      const headers: Record<string, string> = {}
      if (signedIn) {
        const registered = await shop.call<{ accessToken: string }>('POST', '/api/auth/register', {
          email: `owner-${randomUUID()}@order-access.test`,
          password: 'order-access-correct-horse',
        })
        expect(registered.status, JSON.stringify(registered.body)).toBe(201)
        headers.authorization = `Bearer ${registered.body.data!.accessToken}`
      }
      expect((await shop.call<Cart>('GET', '/api/cart', undefined, { headers })).status).toBe(200)
      const added = await shop.call<Cart>(
        'POST',
        '/api/cart/items',
        { variantId: seeded.variantId, qty: 1 },
        { headers },
      )
      expect(added.status, JSON.stringify(added.body)).toBe(200)
      return { shop, headers }
    }

    function submit(s: Shopper, pending: boolean) {
      return s.shop.call<CheckoutAnswer>(
        'POST',
        '/api/checkout',
        {
          email: `buyer-${randomUUID()}${pending ? '+stub-pending' : ''}@order-access.test`,
          billingAddress: address,
          shippingAddress: address,
        },
        { headers: s.headers },
      )
    }

    /** `GET /api/orders/:orderNumber` with no session and no cookie, with the key in its header when given. */
    async function read(orderNumber: string, key?: string) {
      const res = await fetch(
        new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, served.baseUrl),
        {
          headers: {
            accept: 'application/json',
            ...(key !== undefined && { [ORDER_KEY_HEADER]: key }),
          },
        },
      )
      const body = (await res.json()) as { data?: { orderNumber: string } }
      return { status: res.status, orderNumber: body.data?.orderNumber }
    }

    async function keyRows(): Promise<KeyRow[]> {
      return raw.rows<KeyRow>('SELECT order_id, key_hash FROM order_access_keys')
    }

    // Kills: no key answered or persisted; a key stored in plaintext; a lookup that ignores order_id; `existing`
    // minting none or replacing the first key; the 409's key minted inside the rolled-back placement, so it opens
    // nothing and leaves no row.
    it(`AC-2: property: over random sets of guest and signed-in checkouts, each answer’s orderKey is 43 base64url characters and reads its own order and no other; a pending cart’s second checkout answers a different key and both read the order; a paid cart’s resubmit is refused 409 checkout.cart_empty naming the order with a committed key that reads it; every order has a key row and every row is the sha256 of a served key, never the key (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(arbCheckout, { minLength: 1, maxLength: 4 }), async (set) => {
          const placed: Array<{ orderId: string; orderNumber: string; keys: string[] }> = []
          for (const [i, c] of set.entries()) {
            const label = `checkout ${i} (${c.signedIn ? 'signed in' : 'guest'}, ${c.pending ? 'pending' : 'paid'})`
            const s = await shopperWithLine(c.signedIn)
            const first = await submit(s, c.pending)
            expect(first.status, `${label}: ${JSON.stringify(first.body)}`).toBe(200)
            const answer = first.body.data!
            expect(answer.orderStatus, label).toBe(c.pending ? 'pending' : 'confirmed')
            expect(answer.orderKey ?? '', `${label}: the answer’s orderKey`).toMatch(ORDER_KEY)
            servedKeys.add(answer.orderKey)
            const keys = [answer.orderKey]

            const again = await submit(s, c.pending)
            if (c.pending) {
              // The cart's pending order, answered again with the same lines.
              expect(again.status, `${label}, again: ${JSON.stringify(again.body)}`).toBe(200)
              const existing = again.body.data!
              expect(existing.orderNumber, `${label}, again: the same order`).toBe(
                answer.orderNumber,
              )
              expect(existing.orderKey ?? '', `${label}, again: its orderKey`).toMatch(ORDER_KEY)
              expect(existing.orderKey, `${label}, again: a fresh key`).not.toBe(answer.orderKey)
              servedKeys.add(existing.orderKey)
              keys.push(existing.orderKey)
            } else {
              // The cart became the order and was emptied: the refusal names it, with a key.
              const refusal = (again.body as { error?: Refusal }).error
              expect(again.status, `${label}, resubmit: ${JSON.stringify(again.body)}`).toBe(409)
              expect(refusal?.code, `${label}, resubmit`).toBe('checkout.cart_empty')
              expect(refusal?.context?.orderNumber, `${label}, resubmit names`).toBe(
                answer.orderNumber,
              )
              const refusedKey = refusal?.context?.orderKey
              expect(refusedKey ?? '', `${label}, resubmit: context.orderKey`).toMatch(ORDER_KEY)
              servedKeys.add(refusedKey!)
              keys.push(refusedKey!)
              // Committed, not rolled back with the placement: a second connection reads its row after the 409.
              expect(
                await raw.count('order_access_keys', 'order_id = ? AND key_hash = ?', [
                  answer.orderId,
                  sha256(refusedKey!),
                ]),
                `${label}, resubmit: the refusal’s key row`,
              ).toBe(1)
            }
            placed.push({ orderId: answer.orderId, orderNumber: answer.orderNumber, keys })
          }
          await k.app.relay.drain()

          // Every key reads its own order, with no session, and no other order of the set.
          for (const owner of placed) {
            for (const key of owner.keys) {
              for (const other of placed) {
                const answer = await read(other.orderNumber, key)
                if (other === owner) {
                  expect(answer, `${owner.orderNumber}’s key reads it`).toEqual({
                    status: 200,
                    orderNumber: owner.orderNumber,
                  })
                } else {
                  expect(
                    answer.status,
                    `${owner.orderNumber}’s key reads ${other.orderNumber}`,
                  ).toBe(404)
                }
              }
            }
          }

          const rows = await keyRows()
          const servedHashes = new Set([...servedKeys].map(sha256))
          for (const o of placed) {
            const own = rows.filter((r) => r.order_id === o.orderId)
            expect(own.length, `${o.orderNumber}: key rows`).toBeGreaterThanOrEqual(o.keys.length)
            for (const key of o.keys)
              expect(
                own.map((r) => r.key_hash),
                `${o.orderNumber}: a row per served key`,
              ).toContain(sha256(key))
          }
          for (const row of rows) {
            expect(
              servedHashes.has(row.key_hash),
              `row ${row.key_hash} traces to a served key`,
            ).toBe(true)
            expect(servedKeys.has(row.key_hash), 'a row holds a key in plaintext').toBe(false)
          }
        }),
        { numRuns: 5 },
      )
    }, 120_000)
  })
}
