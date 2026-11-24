import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateUcp } from '../../../../tests/fixtures/ucp/validate.js'
import { seedPool, type PoolVariant } from '../support/acp.js'
import { agentCaller, serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel } from '../support/kernel.js'
import {
  putCode,
  readCart,
  seedPromotion,
  uniqueCode,
  type PricedCart,
} from '../support/promotions.js'
import { primedShopper } from '../support/security.js'

// A UCP checkout's totals on a cart that holds a code, served as `nymbal dev` serves it (SQLite, the native engine).
// UCP takes no code itself: the cart gets one from the handed-over buyer's browser, here its cookie route.

interface UcpTotal {
  type: string
  amount: number
  display_text?: string
}

interface UcpCheckout {
  id: string
  totals?: UcpTotal[]
}

let store: AgentStore
let pool: PoolVariant[]

beforeAll(async () => {
  store = await serveWithAgents(await createKernel({ dialect: 'sqlite' }))
  pool = await seedPool(store, [
    { priceMinor: 1_999, stock: 10_000 },
    { priceMinor: 4_250, stock: 10_000 },
  ])
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

const caller = agentCaller('ucp-discount-bot')

async function call(name: string, args: unknown): Promise<UcpCheckout> {
  const result = await store.ucp.call(name, args, caller)
  expect(result.isError ?? false, `${name}: ${JSON.stringify(result.structuredContent)}`).toBe(
    false,
  )
  return result.structuredContent as unknown as UcpCheckout
}

const amounts = (checkout: UcpCheckout, type: string): number[] =>
  (checkout.totals ?? []).filter((t) => t.type === type).map((t) => t.amount)

describe('AC-12: a UCP checkout totals a cart’s discount', () => {
  // Kills: the agent told the undiscounted total of a cart whose code moves money, or a positive discount that breaks
  // UCP's schema (discount amounts are below zero).
  it('AC-12: property: create_checkout on a fresh cart answers subtotal and total equal and no discount entry; once the buyer’s browser adds an accepted percent code, get_checkout totals subtotal = subtotalMinor, one discount of −discountTotalMinor and total = GET /api/cart’s totals.totalMinor; each answer validates against shopping/checkout.json', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 5_000 }),
        fc.integer({ min: 0, max: 1 }),
        fc.integer({ min: 1, max: 4 }),
        async (bps, index, quantity) => {
          const code = uniqueCode('UCP').toUpperCase()
          await seedPromotion(store.kernel, { code, kind: 'percent', percentBps: bps })
          const created = await call('create_checkout', {
            checkout: { line_items: [{ item: { id: pool[index]!.variantId }, quantity }] },
          })

          expect(validateUcp('shopping/checkout.json', created)).toEqual([])
          expect(amounts(created, 'discount')).toEqual([])
          expect(amounts(created, 'total')).toEqual(amounts(created, 'subtotal'))

          const browser = await primedShopper(store.baseUrl, new Map([['nymbal.cart', created.id]]))
          const put = await putCode(browser, code.toLowerCase())
          expect(put.status, JSON.stringify(put.body)).toBe(200)
          const cart: PricedCart = (await readCart(browser)).body.data!
          expect(cart.promotions.codes.map((c) => c.status)).toEqual(['accepted'])
          expect(cart.totals.discountTotalMinor).toBeGreaterThan(0)

          const read = await call('get_checkout', { id: created.id })
          expect(validateUcp('shopping/checkout.json', read)).toEqual([])
          expect({
            subtotal: amounts(read, 'subtotal'),
            discount: amounts(read, 'discount'),
            total: amounts(read, 'total'),
          }).toEqual({
            subtotal: [cart.subtotalMinor],
            discount: [-cart.totals.discountTotalMinor],
            total: [cart.totals.totalMinor],
          })
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)
})
