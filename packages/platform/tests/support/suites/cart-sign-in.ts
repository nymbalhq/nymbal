import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart, CartItem } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'
import type { ShopResponse } from '../shopper.js'

// The cart under concurrency and at sign-in, over HTTP on one dialect: concurrent adds against the line ceiling, a
// variant that is not for sale refused before stock, concurrent sign-ins with one guest cookie, and a sign-in racing
// an add on the guest cart.

const CART_COOKIE = 'nymbal.cart'
const MAX_LINE_QTY = 99
const PASSWORD = 'cart-race-correct-horse'

type Shop = Awaited<ReturnType<typeof primedShopper>>

export interface CartSignInSuiteOptions {
  /** fast-check runs for the concurrent-add property. */
  propertyRuns: number
  /** Rounds of the sign-in-during-an-add race. */
  raceRounds: number
}

/** The `nymbal.cart` value a response sets, if it sets one. */
function cartCookieOf(res: ShopResponse<unknown>): string | undefined {
  const header = res.setCookies.find((c) => c.startsWith(`${CART_COOKIE}=`))
  return header?.split(';')[0]!.slice(CART_COOKIE.length + 1)
}

export function cartSignInSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: CartSignInSuiteOptions,
): void {
  describe(`the cart under concurrency and at sign-in (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function add(shop: Shop, seeded: Seeded, qty: number) {
      return shop.call<Cart>('POST', '/api/cart/items', { variantId: seeded.variantId, qty })
    }

    async function cartOf(shop: Shop): Promise<Cart> {
      const res = await shop.call<Cart>('GET', '/api/cart')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    /** A second shopper on the same device: the same cookies, its own jar from here on. */
    async function sameDevice(shop: Shop): Promise<Shop> {
      return primedShopper(served.baseUrl, new Map(shop.jar))
    }

    async function registered(): Promise<{ id: string; email: string }> {
      const email = `race-${randomUUID()}@cart.test`
      const { customer } = await k.services.auth.register({ email, password: PASSWORD })
      return { id: customer.id, email }
    }

    async function customerCart(customerId: string, lines: Array<[Seeded, number]>) {
      const cart = await k.services.cart.getOrCreate(undefined, customerId)
      for (const [seeded, qty] of lines) {
        await k.services.cart.addItem(cart.token, {
          variantId: seeded.variantId,
          productId: seeded.productId,
          productName: 'Transactional Widget',
          variantName: 'Default',
          priceMinor: seeded.priceMinor,
          imageUrl: '',
          qty,
        })
      }
      return cart.token
    }

    /** The customer's carts as a second connection sees them: token and lines. */
    async function cartsOfCustomer(customerId: string): Promise<Array<{ token: string; items: CartItem[] }>> {
      const rows = await raw.rows<{ token: string; items: string | CartItem[] }>(
        'SELECT token, items FROM carts WHERE customer_id = ?',
        [customerId],
      )
      return rows.map((r) => ({
        token: r.token,
        items: typeof r.items === 'string' ? (JSON.parse(r.items) as CartItem[]) : r.items,
      }))
    }

    const qtyIn = (items: CartItem[], seeded: Seeded): number =>
      items.find((i) => i.variantId === seeded.variantId)?.qty ?? 0

    // Kills: the ceiling checked outside the cart's row lock (two adds both read 90 and both write), or not at all.
    it(`AC-2: property: k concurrent POST /api/cart/items of qty q on a line holding n end at n + q × (2xx answers), at most 99, with every other answer 400 cart.qty_limit (${dialect})`, async () => {
      const X = await seedVariant(k, 100_000)
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 98 }),
          fc.integer({ min: 1, max: 30 }),
          fc.integer({ min: 2, max: 12 }),
          async (n, q, contenders) => {
            const shop = await primedShopper(served.baseUrl)
            const first = await add(shop, X, n)
            expect(first.status, JSON.stringify(first.body)).toBe(200)

            const answers = await Promise.all(
              Array.from({ length: contenders }, () => add(shop, X, q)),
            )

            const won = answers.filter((a) => a.status >= 200 && a.status < 300).length
            const final = qtyIn((await cartOf(shop)).items, X)
            const label = `n=${n} q=${q} k=${contenders}`
            expect(final, label).toBe(n + q * won)
            expect(final, label).toBeLessThanOrEqual(MAX_LINE_QTY)
            expect(won, label).toBe(Math.min(contenders, Math.floor((MAX_LINE_QTY - n) / q)))
            expect(
              answers
                .filter((a) => a.status < 200 || a.status >= 300)
                .map((a) => [a.status, a.body.error?.code]),
              label,
            ).toEqual(Array.from({ length: contenders - won }, () => [400, 'cart.qty_limit']))
          },
        ),
        { numRuns: opts.propertyRuns },
      )
    })

    // Kills: the route checking stock only, so a draft or archived product, or an inactive variant, goes on the cart.
    it(`AC-5: a variant of a draft product, of an archived product, and an inactive variant at stock 0 each answer 404 cart.variant_missing (as an unknown id does) and leave the cart unchanged (${dialect})`, async () => {
      const tag = randomUUID().slice(0, 8)
      const productOf = async (
        label: string,
        status: 'draft' | 'archived' | 'active',
        variant: { stock: number; status: 'active' | 'inactive' },
      ) => {
        const product = await k.services.product.create({
          slug: `unsellable-${label}-${tag}`,
          name: `Unsellable ${label}`,
          description: '',
          status,
          variants: [
            {
              sku: `UNSELL-${label}-${tag}`,
              name: 'Default',
              priceMinor: 1000,
              options: [],
              ...variant,
            },
          ],
        })
        return product.variants[0]!.id
      }
      const unsellable = {
        'draft product': await productOf('draft', 'draft', { stock: 10, status: 'active' }),
        'archived product': await productOf('archived', 'archived', { stock: 10, status: 'active' }),
        'inactive variant at stock 0': await productOf('inactive', 'active', {
          stock: 0,
          status: 'inactive',
        }),
      }
      const X = await seedVariant(k, 50)
      const shop = await primedShopper(served.baseUrl)
      expect((await add(shop, X, 1)).status).toBe(200)
      const before = await cartOf(shop)
      const unknown = await shop.call('POST', '/api/cart/items', { variantId: `none-${tag}`, qty: 1 })

      for (const [label, variantId] of Object.entries(unsellable)) {
        const res = await shop.call('POST', '/api/cart/items', { variantId, qty: 1 })
        expect([res.status, res.body.error?.code], `${label}: ${JSON.stringify(res.body)}`).toEqual([
          unknown.status,
          unknown.body.error?.code,
        ])
        expect([res.status, res.body.error?.code], label).toEqual([404, 'cart.variant_missing'])
      }
      expect((await cartOf(shop)).items).toEqual(before.items)
    })

    // Kills: the guest cart read outside its lock, or not removed in the merge's transaction, so a retried sign-in
    // adds the guest lines twice.
    it(`AC-9: k concurrent logins with one guest cookie for a customer with a cart all answer 200, leave the customer one cart at min(99, guest + customer) per variant, and every nymbal.cart they set names it (${dialect})`, async () => {
      const X = await seedVariant(k, 500)
      const Y = await seedVariant(k, 500)
      const Z = await seedVariant(k, 500)
      const customer = await registered()
      const guestQty = new Map([
        [X.variantId, 60],
        [Y.variantId, 2],
      ])
      const customerQty = new Map([
        [X.variantId, 50],
        [Z.variantId, 3],
      ])
      await customerCart(customer.id, [
        [X, customerQty.get(X.variantId)!],
        [Z, customerQty.get(Z.variantId)!],
      ])
      const guest = await primedShopper(served.baseUrl)
      expect((await add(guest, X, guestQty.get(X.variantId)!)).status).toBe(200)
      expect((await add(guest, Y, guestQty.get(Y.variantId)!)).status).toBe(200)
      const devices = await Promise.all(Array.from({ length: 8 }, () => sameDevice(guest)))

      const answers = await Promise.all(
        devices.map((d) =>
          d.call('POST', '/api/auth/login', { email: customer.email, password: PASSWORD }),
        ),
      )

      expect(
        answers.map((a) => a.status),
        JSON.stringify(answers.map((a) => a.body)),
      ).toEqual(answers.map(() => 200))
      const carts = await cartsOfCustomer(customer.id)
      expect(carts.length, JSON.stringify(carts)).toBe(1)
      const [held] = carts
      for (const seeded of [X, Y, Z]) {
        expect(qtyIn(held!.items, seeded), seeded.variantId).toBe(
          Math.min(
            MAX_LINE_QTY,
            (guestQty.get(seeded.variantId) ?? 0) + (customerQty.get(seeded.variantId) ?? 0),
          ),
        )
      }
      expect(answers.map(cartCookieOf)).toEqual(answers.map(() => held!.token))
    })

    // Kills: the merge reading the guest cart without holding its row, so an add committed between that read and
    // the delete is lost.
    it(`AC-10: a POST /api/cart/items on the guest cookie raced with a login: an add that answered 2xx is in the customer's cart once both settle, and one that did not answered 4xx (${dialect})`, async () => {
      const X = await seedVariant(k, 10_000)
      const W = await seedVariant(k, 10_000)
      for (let round = 0; round < opts.raceRounds; round += 1) {
        const customer = await registered()
        await customerCart(customer.id, [[X, 1]])
        const guest = await primedShopper(served.baseUrl)
        expect((await add(guest, X, 1)).status).toBe(200)
        const adding = await sameDevice(guest)
        const signing = await sameDevice(guest)

        const [added, login] = await Promise.all([
          add(adding, W, 1),
          signing.call('POST', '/api/auth/login', { email: customer.email, password: PASSWORD }),
        ])

        const label = `round ${round}: add ${added.status} ${JSON.stringify(added.body.error)}`
        expect(login.status, label).toBe(200)
        const carts = await cartsOfCustomer(customer.id)
        expect(carts.length, `${label}: ${JSON.stringify(carts)}`).toBe(1)
        if (added.status >= 200 && added.status < 300) {
          expect(qtyIn(carts[0]!.items, W), label).toBe(1)
        } else {
          expect(added.status, label).toBeGreaterThanOrEqual(400)
          expect(added.status, label).toBeLessThan(500)
        }
      }
    })
  })
}
