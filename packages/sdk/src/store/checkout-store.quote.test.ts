import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from '@nymbalhq/types'
import { createNymbalApiAdapter } from '../adapter/nymbal-api-adapter.js'
import { FetchClient } from '../adapter/fetch-client.js'
import { createCheckoutStore } from './checkout-store.js'

// The checkout store over the real API adapter, against a fake API at the fetch boundary: what each call leaves the
// API holding (the quote and checkout posts and their bodies), and what the store's state says after. The element
// shows the store's quote and places with it, so the total sent is the total shown.

const BASE = 'https://api.checkout-quote.test'

const addr: Address = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test St',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
}

interface Post {
  path: string
  body: Record<string, unknown>
}

interface Reply {
  status: number
  body: unknown
}

/** A quote for option `optionId` whose total is `totalMinor`. */
function quoteOf(optionId: string, totalMinor = 2_499) {
  const shipping = optionId === 'standard' ? 0 : 499
  return {
    currency: 'GBP',
    options: [
      { id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: 3 },
      { id: 'express', name: 'Express', amountMinor: 499, estimatedDays: 1 },
    ],
    shippingOptionId: optionId,
    totals: {
      currency: 'GBP',
      subtotalMinor: totalMinor - shipping,
      discountTotalMinor: 0,
      shippingTotalMinor: shipping,
      shippingDiscountMinor: 0,
      taxTotalMinor: 0,
      totalMinor,
      pricesIncludeTax: true,
      lines: [],
      applied: [],
    },
  }
}

const placedOrder = (totalMinor: number) => ({
  orderId: 'ord-1',
  orderNumber: 'NYM-1001',
  paymentIntent: {
    id: 'pi_1',
    clientSecret: 'pi_1_secret',
    amountMinor: totalMinor,
    currency: 'GBP',
    status: 'succeeded',
  },
  currency: 'GBP',
  totalMinor,
  orderStatus: 'confirmed',
  payment: { status: 'succeeded' },
})

const refusal = (status: number, code: string, context: Record<string, unknown> = {}): Reply => ({
  status,
  body: { error: { code, message: `refused: ${code}`, context } },
})

type Answer = Reply | (() => Promise<Reply>)

/**
 * The API: every POST it receives, in order, and the answers it gives. A quote with nothing staged answers the quote
 * of the option it was asked for; a checkout with nothing staged places the order at the total it acknowledged.
 */
function fakeApi() {
  const posts: Post[] = []
  const staged = { quote: [] as Answer[], checkout: [] as Answer[] }
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-token' } }), { status: 200 })
    }
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    posts.push({ path: url.pathname, body })
    const kind = url.pathname === '/api/checkout/quote' ? 'quote' : 'checkout'
    const next = staged[kind].shift()
    const reply: Reply =
      next === undefined
        ? kind === 'quote'
          ? { status: 200, body: { data: quoteOf(String(body['shippingOptionId'] ?? 'standard')) } }
          : { status: 200, body: { data: placedOrder(Number(body['expectedTotalMinor'] ?? 0)) } }
        : typeof next === 'function'
          ? await next()
          : next
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  })
  return {
    posts,
    quotes: () => posts.filter((p) => p.path === '/api/checkout/quote'),
    checkouts: () => posts.filter((p) => p.path === '/api/checkout'),
    stageQuote: (answer: Answer) => staged.quote.push(answer),
    stageCheckout: (answer: Answer) => staged.checkout.push(answer),
  }
}

/** A reply the test releases when it chooses. */
function gate(reply: Reply) {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { answer: async () => (await opened, reply), release }
}

function readyStore() {
  const store = createCheckoutStore(createNymbalApiAdapter(new FetchClient({ baseUrl: BASE })))
  store.setEmail('buyer@example.com')
  store.setShippingAddress(addr)
  store.setBillingAddress(addr)
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-13: the checkout store quotes, and places at the quote', () => {
  // Kills: a quote for another address or option than the one stored, or an answer the state does not keep.
  it('AC-13: quote() posts the stored shipping address, selectShippingOption(id) posts that id, a later quote() posts the stored option, and the state holds each answer', async () => {
    const api = fakeApi()
    const store = readyStore()

    const first = await store.quote()
    expect(
      api.quotes().map((p) => [p.body['shippingAddress'], p.body['shippingOptionId']]),
    ).toEqual([[addr, undefined]])
    expect(store.getState().quote).toEqual(quoteOf('standard'))
    expect(first).toEqual(store.getState().quote)

    await store.selectShippingOption('express')
    expect(api.quotes()[1]?.body).toMatchObject({
      shippingAddress: addr,
      shippingOptionId: 'express',
    })
    expect(store.getState().quote).toEqual(quoteOf('express'))

    await store.quote()
    expect(api.quotes()[2]?.body).toMatchObject({
      shippingAddress: addr,
      shippingOptionId: 'express',
    })
    expect(api.checkouts()).toEqual([])
  })

  // Kills: the element sending no total, or a stale one, so every checkout on a store charging shipping is refused.
  it('AC-13: property: submitPayment() posts the quote’s shippingOptionId and expectedTotalMinor equal to quote.totals.totalMinor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('standard', 'express'),
        fc.integer({ min: 500, max: 5_000_000 }),
        async (optionId, totalMinor) => {
          const api = fakeApi()
          const store = readyStore()
          api.stageQuote({ status: 200, body: { data: quoteOf(optionId, totalMinor) } })
          await store.quote()

          const result = await store.submitPayment()

          const quote = store.getState().quote
          expect(
            api.checkouts().map((p) => [p.body['shippingOptionId'], p.body['expectedTotalMinor']]),
          ).toEqual([[quote?.shippingOptionId, quote?.totals.totalMinor]])
          expect(result?.totalMinor).toBe(totalMinor)
          vi.unstubAllGlobals()
        },
      ),
      { numRuns: 30 },
    )
  })

  // Kills: a payment posted at no total, or while a newer total is still on its way.
  it('AC-13: with no quote, or one in flight, submitPayment() posts nothing and resolves null with an error', async () => {
    const api = fakeApi()
    const store = readyStore()

    const unquoted = await store.submitPayment()

    expect(unquoted).toBeNull()
    expect(store.getState().error).not.toBeNull()
    expect(api.checkouts()).toEqual([])

    const held = gate({ status: 200, body: { data: quoteOf('express') } })
    api.stageQuote(held.answer)
    const quoting = store.quote()
    const during = await store.submitPayment()
    held.release()
    await quoting

    expect(during).toBeNull()
    expect(api.checkouts()).toEqual([])
    expect(store.getState().quote?.shippingOptionId).toBe('express')
  })

  // Kills: a shopper who placed an order, went Back and pressed Place Order again left stranded: the refusal naming
  // their order must still reach the server, which answers it with a key.
  it('AC-13: after a quote refused checkout.cart_empty, submitPayment() posts once with no total and keeps the order and key the refusal names', async () => {
    const api = fakeApi()
    const store = readyStore()
    api.stageQuote(refusal(409, 'checkout.cart_empty', { orderNumber: 'NYM-2002' }))
    expect(await store.quote()).toBeNull()
    api.stageCheckout(
      refusal(409, 'checkout.cart_empty', { orderNumber: 'NYM-2002', orderKey: 'k'.repeat(43) }),
    )

    const result = await store.submitPayment()

    expect(result).toBeNull()
    expect(api.checkouts().length).toBe(1)
    expect(api.checkouts()[0]!.body['expectedTotalMinor']).toBeUndefined()
    expect(api.checkouts()[0]!.body['shippingOptionId']).toBeUndefined()
    const state = store.getState()
    expect([state.placedOrderNumber, state.placedOrderKey]).toEqual(['NYM-2002', 'k'.repeat(43)])
  })

  // Kills: the store retrying the payment by itself at a total the shopper has not seen, or keeping the old quote
  // on screen after the server said the total moved.
  it.each(['checkout.total_changed', 'checkout.shipping_option_unavailable'])(
    'AC-13: on 409 %s, the API holds one more quote and no second checkout, and the result is null with that code and the new quote in state',
    async (code) => {
      const api = fakeApi()
      const store = readyStore()
      await store.selectShippingOption('express')
      api.stageCheckout(refusal(409, code, { quoted: 2_499, due: 2_999 }))
      api.stageQuote({ status: 200, body: { data: quoteOf('standard', 2_999) } })
      const quotesBefore = api.quotes().length

      const result = await store.submitPayment()

      expect(result).toBeNull()
      expect(api.quotes().length).toBe(quotesBefore + 1)
      expect(api.checkouts().length).toBe(1)
      expect(store.getState().errorCode).toBe(code)
      expect(store.getState().quote).toEqual(quoteOf('standard', 2_999))
    },
  )
})

describe('AC-14: two quotes in flight', () => {
  // Kills: a late answer for A overwriting B's, so the summary shows A's total beside B's checked option; or a
  // payment posted while the total is still moving.
  it('AC-14: property: with option A then option B in flight, answered in either order, the state’s quote is B’s, quoting stays true until both settle, and a submit while either is in flight posts nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 500, max: 900_000 }),
        async (bFirst, total) => {
          const api = fakeApi()
          const store = readyStore()
          const a = gate({ status: 200, body: { data: quoteOf('standard', total) } })
          const b = gate({ status: 200, body: { data: quoteOf('express', total + 499) } })
          api.stageQuote(a.answer)
          api.stageQuote(b.answer)

          const forA = store.selectShippingOption('standard')
          const forB = store.selectShippingOption('express')
          const [first, firstDone, second, secondDone] = bFirst
          ? ([b, forB, a, forA] as const)
          : ([a, forA, b, forB] as const)

        expect(store.getState().quoting).toBe(true)
          first.release()
          await firstDone
          expect(store.getState().quoting, 'one answer still to come').toBe(true)
          expect(await store.submitPayment()).toBeNull()

          second.release()
          await secondDone
          const state = store.getState()
          expect(state.quoting).toBe(false)
          expect(state.quote?.shippingOptionId).toBe('express')
          expect(state.quote?.totals.totalMinor).toBe(total + 499)
          expect(api.checkouts()).toEqual([])
          vi.unstubAllGlobals()
        },
      ),
      { numRuns: 20 },
    )
  })
})
