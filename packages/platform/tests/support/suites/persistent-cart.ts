import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { race } from '../proof-kit.js'
import { lineFor } from '../replica.js'
import { shopper, type CookieJar } from '../shopper.js'

// AC-1, AC-2 and AC-3 on one dialect: a cart is a command-store row, so it survives a restart, is the same cart on
// every replica over one database, and concurrent adds from two replicas lose nothing. The store is a kernel from
// `src/` served over HTTP (tests/support/http.ts), restarted on, or doubled over, one database.

const CART_COOKIE = 'nymbal.cart'

/** `Set-Cookie` headers that set the cart cookie. */
function cartCookiesSet(setCookies: string[]): string[] {
  return setCookies.filter((c) => c.trim().startsWith(`${CART_COOKIE}=`))
}

/** `{ variantId: qty }` over a cart's lines; a variant on two lines is itself a defect, so it fails here. */
function qtyByVariant(cart: Pick<Cart, 'items'>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of cart.items) {
    expect(out, `variant ${item.variantId} appears on more than one line`).not.toHaveProperty(
      item.variantId,
    )
    out[item.variantId] = item.qty
  }
  return out
}

function subtotalOf(cart: Pick<Cart, 'items'>): number {
  return cart.items.reduce((sum, item) => sum + item.priceMinor * item.qty, 0)
}

export function persistentCartSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database for this suite: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
  opts: { propertyRuns: number },
): void {
  describe(`persistent carts (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }

    beforeAll(async () => {
      db = await fresh()
    })

    afterAll(async () => {
      await db?.drop()
    })

    /** Another process on the same database. */
    function openKernel(): Promise<Kernel> {
      return createKernel(
        dialect === 'sqlite'
          ? { dialect, sqlitePath: db.target }
          : { dialect, postgresUrl: db.target },
      )
    }

    it('AC-1: a cart added to over HTTP reads back after a restart on the same database with the same token, lines, subtotal and no new cart cookie', async () => {
      const jar: CookieJar = new Map()
      const qty = 2
      let before: Cart
      let seeded: Seeded

      const first = await serveKernel(await openKernel())
      try {
        seeded = await seedVariant(first.kernel, 10, { priceMinor: 1250 })
        const shop = shopper(first.baseUrl, jar)
        const created = await shop.call<Cart>('GET', '/api/cart')
        expect(created.status).toBe(200)
        const added = await shop.call<Cart>('POST', '/api/cart/items', {
          variantId: seeded.variantId,
          qty,
        })
        expect(added.status, JSON.stringify(added.body)).toBe(200)
        before = added.body.data!
        expect(qtyByVariant(before)).toEqual({ [seeded.variantId]: qty })
      } finally {
        await first.stop()
      }

      const second = await serveKernel(await openKernel())
      try {
        const shop = shopper(second.baseUrl, jar)
        const read = await shop.call<Cart>('GET', '/api/cart')
        expect(read.status).toBe(200)
        const after = read.body.data!
        expect(cartCookiesSet(read.setCookies), 'a new cart cookie means a new cart').toEqual([])
        expect(after.token).toBe(before.token)
        expect(qtyByVariant(after)).toEqual(qtyByVariant(before))
        expect(after.items.map((i) => i.priceMinor)).toEqual(before.items.map((i) => i.priceMinor))
        expect(after.subtotalMinor).toBe(before.subtotalMinor)
        expect(after.subtotalMinor).toBe(seeded.priceMinor * qty)
      } finally {
        await second.stop()
      }
    }, 60_000)

    it('AC-2: two replicas on one database serve one cart: B sees the line A added, A sees the line B added, and the subtotal is the sum of price times qty over both', async () => {
      const jar: CookieJar = new Map()
      let a: ServedKernel | undefined
      let b: ServedKernel | undefined
      try {
        a = await serveKernel(await openKernel())
        b = await serveKernel(await openKernel())
        const x = await seedVariant(a.kernel, 10, { priceMinor: 700 })
        const y = await seedVariant(a.kernel, 10, { priceMinor: 1100 })
        const qtyX = 2
        const qtyY = 3
        const shopA = shopper(a.baseUrl, jar)
        const shopB = shopper(b.baseUrl, jar)

        const created = await shopA.call<Cart>('GET', '/api/cart')
        const token = created.body.data!.token
        const addedX = await shopA.call<Cart>('POST', '/api/cart/items', {
          variantId: x.variantId,
          qty: qtyX,
        })
        expect(addedX.status, JSON.stringify(addedX.body)).toBe(200)

        const onB = await shopB.call<Cart>('GET', '/api/cart')
        expect(onB.status).toBe(200)
        expect(onB.body.data!.token).toBe(token)
        expect(qtyByVariant(onB.body.data!)).toEqual({ [x.variantId]: qtyX })

        const addedY = await shopB.call<Cart>('POST', '/api/cart/items', {
          variantId: y.variantId,
          qty: qtyY,
        })
        expect(addedY.status, JSON.stringify(addedY.body)).toBe(200)

        const onA = await shopA.call<Cart>('GET', '/api/cart')
        const cart = onA.body.data!
        expect(cart.token).toBe(token)
        expect(qtyByVariant(cart)).toEqual({ [x.variantId]: qtyX, [y.variantId]: qtyY })
        expect(cart.subtotalMinor).toBe(x.priceMinor * qtyX + y.priceMinor * qtyY)
        expect(cart.subtotalMinor).toBe(subtotalOf(cart))
      } finally {
        await b?.stop()
        await a?.stop()
      }
    }, 60_000)

    it(`AC-3: property: adds to one cart, run concurrently and split across two command stores, end with each variant at the sum of its adds and subtotal = sum of price times qty (${opts.propertyRuns} runs)`, async () => {
      let a: Kernel | undefined
      let b: Kernel | undefined
      try {
        a = await openKernel()
        b = await openKernel()
        const pool = [
          await seedVariant(a, 1000, { priceMinor: 300 }),
          await seedVariant(a, 1000, { priceMinor: 450 }),
          await seedVariant(a, 1000, { priceMinor: 1999 }),
        ]
        const replicas = [a, b]

        await fc.assert(
          fc.asyncProperty(
            fc.array(
              fc.record({
                variant: fc.integer({ min: 0, max: pool.length - 1 }),
                qty: fc.integer({ min: 1, max: 4 }),
              }),
              { minLength: 2, maxLength: 6 },
            ),
            async (adds) => {
              const cart = await a!.services.cart.getOrCreate()
              const outcome = await race(
                (i) => {
                  const add = adds[i]!
                  const seeded = pool[add.variant]!
                  return replicas[i % replicas.length]!.services.cart.addItem(
                    cart.token,
                    lineFor(seeded, add.qty),
                  )
                },
                { contenders: adds.length },
              )
              expect(outcome.lost, 'an add was rejected').toEqual([])

              const expected: Record<string, number> = {}
              for (const add of adds) {
                const id = pool[add.variant]!.variantId
                expected[id] = (expected[id] ?? 0) + add.qty
              }
              const expectedSubtotal = adds.reduce(
                (sum, add) => sum + pool[add.variant]!.priceMinor * add.qty,
                0,
              )
              for (const replica of replicas) {
                const final = await replica.services.cart.get(cart.token)
                expect(final, 'the cart is missing on a replica').not.toBeNull()
                expect(qtyByVariant(final!)).toEqual(expected)
                expect(final!.subtotalMinor).toBe(expectedSubtotal)
                expect(final!.subtotalMinor).toBe(subtotalOf(final!))
              }
            },
          ),
          { numRuns: opts.propertyRuns },
        )
      } finally {
        await b?.close()
        await a?.close()
      }
    }, 120_000)
  })
}
