import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cartPageCart } from '@/lib/api'

// The cart the cart page renders from. With no `nymbal.cart` cookie the cart is empty by construction, so the page
// can say so without asking the API. With the cookie, the API's answer decides: a failed read is an unknown cart,
// never a false empty one.

interface Sent {
  url: string
  cookie: string | null
}

const sent: Sent[] = []
let answer: () => Response = () => {
  throw new Error('no answer set')
}

beforeEach(() => {
  sent.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ url, cookie: new Headers(init?.headers).get('cookie') })
    return answer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const EMPTY = { items: [], subtotalMinor: 0, currency: '', itemCount: 0 }

const aName = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,12}$/)
  .filter((name) => name !== 'nymbal.cart')
const aValue = fc.stringMatching(/^[A-Za-z0-9_-]{0,16}$/)
/** A cookie pair that is not `nymbal.cart`: another name, a name that only contains it, or a value that names it. */
const otherPair = fc.oneof(
  fc.tuple(aName, aValue).map(([name, value]) => `${name}=${value}`),
  fc
    .tuple(fc.stringMatching(/^[a-z_.-]{0,4}$/), fc.stringMatching(/^[a-z0-9_.-]{0,4}$/), aValue)
    .filter(([before, after]) => before !== '' || after !== '')
    .map(([before, after, value]) => `${before}nymbal.cart${after}=${value}`),
  aValue.map((value) => `other=nymbal.cart=${value}`),
)
const aSeparator = fc.constantFrom(';', '; ', ' ;  ')
/** A Cookie header with no `nymbal.cart` pair, or none at all. */
const noCartCookie: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc
    .tuple(fc.array(otherPair, { minLength: 1, maxLength: 4 }), aSeparator)
    .map(([pairs, sep]) => pairs.join(sep)),
)

let tokens = 0
/** A Cookie header carrying a `nymbal.cart` pair among others; every token is new, so no read answers from another. */
const cartCookie = fc
  .tuple(
    fc.array(otherPair, { maxLength: 3 }),
    fc.stringMatching(/^[A-Za-z0-9_-]{8,24}$/),
    fc.nat(3),
    aSeparator,
  )
  .map(([others, base, at, sep]) => {
    tokens += 1
    const token = `${base}-${tokens}`
    const pairs = [...others]
    pairs.splice(Math.min(at, pairs.length), 0, `nymbal.cart=${token}`)
    return { header: pairs.join(sep), token }
  })

const aFailure = fc.oneof(fc.constant<'network'>('network'), fc.integer({ min: 400, max: 599 }))

const aLine = fc.record({
  variantId: fc.stringMatching(/^var_[a-z0-9]{4,8}$/),
  productName: fc.string({ minLength: 1, maxLength: 12 }),
  variantName: fc.string({ minLength: 1, maxLength: 8 }),
  qty: fc.integer({ min: 1, max: 99 }),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
})

describe('the cart the cart page renders from', () => {
  it('AC-7: for every Cookie header with no nymbal.cart pair (none, empty, other names, a name that only contains it), cartPageCart resolves the empty cart and makes no request', async () => {
    await fc.assert(
      fc.asyncProperty(noCartCookie, async (cookie) => {
        answer = () => {
          throw new Error('cartPageCart asked the API with no cart cookie')
        }
        const before = sent.length
        await expect(cartPageCart(cookie), `cookie ${JSON.stringify(cookie)}`).resolves.toEqual(
          EMPTY,
        )
        expect(sent.length - before, `requests for cookie ${JSON.stringify(cookie)}`).toBe(0)
      }),
      { numRuns: 120 },
    )
  })

  it('AC-7: with a nymbal.cart pair and a failed read (the fetch rejects, or any status of 400 or more), cartPageCart resolves null, never the empty cart', async () => {
    await fc.assert(
      fc.asyncProperty(cartCookie, aFailure, async ({ header }, failure) => {
        answer =
          failure === 'network'
            ? () => {
                throw new TypeError('fetch failed')
              }
            : () =>
                new Response(JSON.stringify({ error: { message: 'refused' } }), {
                  status: failure,
                  headers: { 'content-type': 'application/json' },
                })
        await expect(cartPageCart(header), `${failure} for ${header}`).resolves.toBeNull()
      }),
      { numRuns: 80 },
    )
  })

  it('AC-7: with a nymbal.cart pair and a 200, over generated carts, cartPageCart resolves the API’s lines and sums with itemCount the sum of quantities, asking GET /api/cart with that token alone', async () => {
    await fc.assert(
      fc.asyncProperty(
        cartCookie,
        fc.array(aLine, { maxLength: 6 }),
        fc.constantFrom('GBP', 'USD', 'EUR'),
        async ({ header, token }, items, currency) => {
          const subtotalMinor = items.reduce((sum, line) => sum + line.qty * line.priceMinor, 0)
          answer = () =>
            new Response(
              JSON.stringify({
                data: { token, customerId: null, items, subtotalMinor, currency },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          const before = sent.length
          const cart = await cartPageCart(header)
          const made = sent.slice(before)
          expect(made.map((s) => new URL(s.url).pathname)).toEqual(['/api/cart'])
          expect(made[0]?.cookie).toBe(`nymbal.cart=${token}`)
          expect(cart).toEqual({
            items,
            subtotalMinor,
            currency,
            itemCount: items.reduce((sum, line) => sum + line.qty, 0),
          })
        },
      ),
      { numRuns: 60 },
    )
  })
})
