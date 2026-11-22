import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopperCart } from '@nymbalhq/types'
import { createNymbalClient } from '../index.js'

// The API adapter's code calls: what each sends on the wire, and that each resolves the cart the API answered with
// its totals and the engine's word on each code.

const BASE = 'https://api.cart-codes.test'

interface Sent {
  method: string
  path: string
  body: unknown
}

/** A fake API: answers the CSRF read, records every other request, and answers each with `answer`. */
function recordingApi(answer: () => ShopperCart): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-token' } }), { status: 200 })
    }
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify({ data: answer() }), { status: 200 })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A code a shopper might type, slashes, percent signs, spaces and non-ASCII letters included. */
const typedCode = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.constantFrom('SAVE 10%', 'a/b', '../x', '%2F', 'Ünïcode', 'x?y#z', '50%off'),
  )
  .filter((code) => code.trim() !== '.' && code.trim() !== '..' && code.trim() !== '')

const money = fc.integer({ min: 0, max: 500_000 })

const shopperCart: fc.Arbitrary<ShopperCart> = fc
  .record({
    subtotalMinor: money,
    discountShare: fc.integer({ min: 0, max: 100 }),
    code: fc.stringMatching(/^[A-Z0-9-]{1,12}$/),
    status: fc.constantFrom('accepted', 'rejected', 'pending'),
  })
  .map(({ subtotalMinor, discountShare, code, status }) => {
    const discountTotalMinor = Math.floor((subtotalMinor * discountShare) / 100)
    return {
      token: 'cart-token',
      customerId: null,
      items: [],
      subtotalMinor,
      currency: 'GBP',
      source: 'storefront',
      expiresAt: '2026-12-21T00:00:00.000Z',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
      totals: {
        currency: 'GBP',
        subtotalMinor,
        discountTotalMinor,
        shippingTotalMinor: 0,
        shippingDiscountMinor: 0,
        taxTotalMinor: 0,
        totalMinor: subtotalMinor - discountTotalMinor,
        pricesIncludeTax: false,
        lines: [],
        applied: [],
      },
      promotions: {
        codes: [
          status === 'rejected'
            ? { code, status, reason: 'expired' }
            : { code, status: status as 'accepted' | 'pending' },
        ],
        unavailable: status === 'pending',
      },
    } as ShopperCart
  })

describe('AC-1: the adapter’s code calls', () => {
  // Kills: a missing code call, the wrong body, a path built from the raw code (a `/`, `%` or space naming another
  // route or another code), or an answer reduced to the stored cart without its totals and code statuses.
  it('AC-1: property: addCode(code) posts { code } to /api/cart/codes and removeCode(code) deletes /api/cart/codes/<encodeURIComponent(code)>, whose one last segment decodes to the code; each resolves the API’s cart answer, totals and promotions included', async () => {
    await fc.assert(
      fc.asyncProperty(typedCode, shopperCart, shopperCart, async (code, onAdd, onRemove) => {
        const answers = [onAdd, onRemove]
        const sent = recordingApi(() => answers.shift()!)
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          const added = await client.adapter.cart.addCode(code)
          const removed = await client.adapter.cart.removeCode(code)

          expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
            ['POST', '/api/cart/codes', { code }],
            ['DELETE', `/api/cart/codes/${encodeURIComponent(code)}`, undefined],
          ])
          const segments = sent[1]!.path.split('/')
          expect(segments.slice(0, 4)).toEqual(['', 'api', 'cart', 'codes'])
          expect(segments).toHaveLength(5)
          expect(decodeURIComponent(segments[4]!)).toBe(code)
          expect([added, removed]).toEqual([onAdd, onRemove])
          expect(added.totals.totalMinor).toBe(
            onAdd.totals.subtotalMinor - onAdd.totals.discountTotalMinor,
          )
        } finally {
          client.destroy()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 100 },
    )
  })
})
