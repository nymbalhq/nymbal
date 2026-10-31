import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkStock, race, type StockViolation, type TestStore } from '../proof-kit.js'
import { address } from '../kernel.js'
import { stockOf, type RawReader } from '../raw.js'
import { shopper } from '../shopper.js'

// AC-1 (SQLite) and AC-2 (Postgres): fifty buyers race over HTTP for the last three units of one variant, each from
// their own cart, qty 1, five consecutive runs. Exactly three checkouts succeed, the other 47 get an error response,
// checkStock reports nothing, stock ends at 0, three order rows exist and the reservation rows sum to 3.

const CONTENDERS = 50
const UNITS = 3
const RUNS = 5
const FIRST_CHECKOUTS = 8

interface RunSummary {
  run: number
  wins: number
  losses: number
  errorResponses: number
  violations: StockViolation[]
  stock: number
  orderRows: number
  reservedQty: number
}

type Loss = { status: number; body: { error?: { code: string } } }

export function checkoutRaceSuite(
  ac: string,
  start: () => Promise<{ store: TestStore; raw: RawReader; stop(): Promise<void> }>,
): void {
  describe(`${ac}: fifty buyers for three units over HTTP`, () => {
    let store: TestStore
    let raw: RawReader
    let stop: () => Promise<void>

    beforeAll(async () => {
      const started = await start()
      store = started.store
      raw = started.raw
      stop = started.stop
    }, 90_000)

    afterAll(async () => {
      await stop?.()
    })

    it(`${ac}: exactly 3 of 50 checkouts succeed, 47 fail with an error response, checkStock is [], stock 0, 3 order rows, reservation rows sum to 3, in each of ${RUNS} consecutive runs`, async () => {
      const summaries: RunSummary[] = []
      for (let run = 0; run < RUNS; run += 1) {
        const tag = randomUUID()
        const product = await store.app.services.product.create({
          slug: `race-${tag}`,
          name: 'Last Three',
          description: '',
          status: 'active',
          variants: [
            { sku: `RACE-${tag}`, name: 'Default', priceMinor: 1500, stock: UNITS, options: [] },
          ],
        })
        const variantId = product.variants[0]!.id

        // Every contender holds a cart before the race, so only the checkouts race.
        const shoppers = await Promise.all(
          Array.from({ length: CONTENDERS }, async () => {
            const s = shopper(store.baseUrl)
            const cart = await s.call('GET', '/api/cart')
            expect(cart.status, JSON.stringify(cart.body)).toBe(200)
            const item = await s.call('POST', '/api/cart/items', { variantId, qty: 1 })
            expect(item.status, JSON.stringify(item.body)).toBe(200)
            return s
          }),
        )

        const outcome = await race(
          async (i) => {
            const res = await shoppers[i]!.call<{ orderId: string }>('POST', '/api/checkout', {
              // `+stub-pending`: the race is for the reservation; the orders stay pending so their reservation rows
              // are what the run counts.
              email: `buyer-${run}-${i}-${tag}+stub-pending@txn.test`,
              billingAddress: address,
              shippingAddress: address,
            })
            if (res.status !== 200) throw { status: res.status, body: res.body } satisfies Loss
            return res.body.data!
          },
          { contenders: CONTENDERS },
        )
        const losses = outcome.lost as Loss[]
        expect(outcome.won.length + losses.length).toBe(CONTENDERS)
        // The oversell shows here first: today every buyer wins.
        expect(outcome.won.length, `run ${run}: checkouts that succeeded`).toBe(UNITS)

        const stock = await stockOf(raw, variantId)
        const orderRows = await raw.count('orders', 'email LIKE ?', [`%-${tag}+stub-pending@%`])
        const reserved = await raw.rows<{ qty: number }>(
          'SELECT qty FROM inventory_reservations WHERE variant_id = ?',
          [variantId],
        )
        summaries.push({
          run,
          wins: outcome.won.length,
          losses: losses.length,
          errorResponses: losses.filter((l) => l.status >= 400 && l.body?.error !== undefined)
            .length,
          violations: checkStock({
            initial: UNITS,
            final: stock,
            qtyPerWin: 1,
            wins: outcome.won.length,
          }),
          stock,
          orderRows,
          reservedQty: reserved.reduce((sum, r) => sum + Number(r.qty), 0),
        })
      }

      for (const s of summaries) {
        expect(s.stock, `run ${s.run}: stock = initial - wins`).toBe(UNITS - s.wins)
        expect(s.orderRows, `run ${s.run}: one order row per win`).toBe(s.wins)
        expect(s.reservedQty, `run ${s.run}: one reserved unit per win`).toBe(s.wins)
        expect(s.errorResponses, `run ${s.run}: every loss is an error response`).toBe(s.losses)
      }
      expect(summaries.map(({ run: _run, ...rest }) => rest)).toEqual(
        Array.from({ length: RUNS }, () => ({
          wins: UNITS,
          losses: CONTENDERS - UNITS,
          errorResponses: CONTENDERS - UNITS,
          violations: [],
          stock: 0,
          orderRows: UNITS,
          reservedQty: UNITS,
        })),
      )
    }, 90_000)

    // Over HTTP on SQLite the kernel serialises by accident: a request handler's microtask chain runs to completion
    // before the next request's macrotask. The same fifty buyers started in-process interleave at every await, where
    // a read-then-write reservation oversells. The contract is the same; this is the race the services themselves
    // must survive.
    it(`${ac}: the same race in-process (50 concurrent beginCheckout through the services, own carts, qty 1): exactly 3 succeed, 47 reject with CheckoutError, checkStock is [], stock 0, in each of ${RUNS} consecutive runs`, async () => {
      const { services } = store.app
      const summaries: Array<{
        wins: number
        checkoutErrors: number
        violations: StockViolation[]
        stock: number
      }> = []
      for (let run = 0; run < RUNS; run += 1) {
        const tag = randomUUID()
        const product = await services.product.create({
          slug: `race-ip-${tag}`,
          name: 'Last Three',
          description: '',
          status: 'active',
          variants: [
            { sku: `RACEIP-${tag}`, name: 'Default', priceMinor: 1500, stock: UNITS, options: [] },
          ],
        })
        const variant = product.variants[0]!
        const carts = await Promise.all(
          Array.from({ length: CONTENDERS }, async () => {
            const cart = await services.cart.getOrCreate()
            await services.cart.addItem(cart.token, {
              variantId: variant.id,
              productId: product.id,
              productName: product.name,
              variantName: variant.name,
              priceMinor: variant.priceMinor,
              imageUrl: '',
              qty: 1,
            })
            return cart.token
          }),
        )

        const outcome = await race(
          (i) =>
            services.checkout.beginCheckout({
              cartToken: carts[i]!,
              email: `inproc-${run}-${i}-${tag}+stub-pending@txn.test`,
              billingAddress: address,
              shippingAddress: address,
            }),
          { contenders: CONTENDERS },
        )
        expect(outcome.won.length + outcome.lost.length).toBe(CONTENDERS)
        expect(outcome.won.length, `run ${run}: checkouts that succeeded`).toBe(UNITS)

        const stock = await stockOf(raw, variant.id)
        summaries.push({
          wins: outcome.won.length,
          checkoutErrors: outcome.lost.filter(
            (reason) => (reason as { code?: string }).code?.startsWith('checkout.') === true,
          ).length,
          violations: checkStock({
            initial: UNITS,
            final: stock,
            qtyPerWin: 1,
            wins: outcome.won.length,
          }),
          stock,
        })
      }
      for (const s of summaries) expect(s.stock).toBe(UNITS - s.wins)
      expect(summaries).toEqual(
        Array.from({ length: RUNS }, () => ({
          wins: UNITS,
          checkoutErrors: CONTENDERS - UNITS,
          violations: [],
          stock: 0,
        })),
      )
    }, 90_000)
  })

  // With one variant the stock decrement serialises the contenders before the order number is allocated. Shoppers of
  // distinct products reach the allocation together, and on a fresh store the counter row does not exist yet.
  describe(`AC-3: ${FIRST_CHECKOUTS} first checkouts of distinct products on a fresh store`, () => {
    let store: TestStore
    let raw: RawReader
    let stop: () => Promise<void>

    beforeAll(async () => {
      const started = await start()
      store = started.store
      raw = started.raw
      stop = started.stop
    }, 90_000)

    afterAll(async () => {
      await stop?.()
    })

    it(`AC-3: ${FIRST_CHECKOUTS} shoppers, each with their own product in their cart, check out at once as a fresh store's first checkouts: all answer 200, with ${FIRST_CHECKOUTS} distinct order numbers and ${FIRST_CHECKOUTS} order rows`, async () => {
      const tag = randomUUID()
      const shoppers = await Promise.all(
        Array.from({ length: FIRST_CHECKOUTS }, async (_, i) => {
          const product = await store.app.services.product.create({
            slug: `first-${i}-${tag}`,
            name: `First ${i}`,
            description: '',
            status: 'active',
            variants: [
              {
                sku: `FIRST-${i}-${tag}`,
                name: 'Default',
                priceMinor: 1500,
                stock: 5,
                options: [],
              },
            ],
          })
          const s = shopper(store.baseUrl)
          const cart = await s.call('GET', '/api/cart')
          expect(cart.status, JSON.stringify(cart.body)).toBe(200)
          const item = await s.call('POST', '/api/cart/items', {
            variantId: product.variants[0]!.id,
            qty: 1,
          })
          expect(item.status, JSON.stringify(item.body)).toBe(200)
          return s
        }),
      )
      expect(await raw.count('orders'), 'no order placed before the race').toBe(0)

      const outcome = await race(
        async (i) => {
          const res = await shoppers[i]!.call<{ orderNumber: string }>('POST', '/api/checkout', {
            email: `first-${i}-${tag}+stub-pending@txn.test`,
            billingAddress: address,
            shippingAddress: address,
          })
          if (res.status !== 200) throw { status: res.status, body: res.body } satisfies Loss
          return res.body.data!.orderNumber
        },
        { contenders: FIRST_CHECKOUTS },
      )

      expect(outcome.lost, 'checkouts that did not answer 200').toEqual([])
      expect(new Set(outcome.won).size).toBe(FIRST_CHECKOUTS)
      const rows = await raw.rows<{ order_number: string }>(
        'SELECT order_number FROM orders WHERE email LIKE ?',
        [`%-${tag}+stub-pending@%`],
      )
      expect(rows.map((r) => r.order_number).sort()).toEqual([...outcome.won].sort())
    }, 90_000)
  })
}
