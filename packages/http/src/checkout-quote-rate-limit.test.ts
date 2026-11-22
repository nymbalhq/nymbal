import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger, RequestContext } from '@nymbalhq/types'
import { createSecurityGuard } from './security-middleware.js'

// Each checkout quote may call the tax, promotions and shipping engines, so the quote route has a built-in limit
// counted as the checkout's: 30 a minute per (address, cart) and ten times that per address, in buckets of its own, so
// a shopper who changes option a few times can still place. A rule the config sets for the path replaces it.

const REQUESTS = 30
const QUOTE = '/api/checkout/quote'
const CHECKOUT = '/api/checkout'
const CART_COOKIE = 'nymbal.cart'

const quiet = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return quiet
  },
} as unknown as Logger

function post(path: string, ip: string, cart: string | undefined): RequestContext {
  return {
    method: 'POST',
    path,
    url: path,
    params: {},
    query: {},
    body: {},
    headers: {},
    cookies: cart === undefined ? {} : { [CART_COOKIE]: cart },
    requestId: 'req',
    correlationId: 'corr',
    logger: quiet,
    ip,
  }
}

function guardWith(rateLimit: Record<string, unknown> = {}) {
  return createSecurityGuard(
    securitySchema.parse({ adapter: 'middleware', csrf: false, rateLimit }),
  )
}

/** The status the guard answers a request with: its refusal's, or 200 for one it lets through. */
const statusOf = (guard: ReturnType<typeof guardWith>, ctx: RequestContext): number =>
  guard.admit(ctx)?.status ?? 200

/**
 * Which of a sequence of quotes from one address the rule refuses at `requests` a minute: the address is counted
 * first, at ten times the rule, and a request past it opens no cart count; otherwise the cart's count decides.
 */
function refusedBy(sequence: readonly string[], requests: number): boolean[] {
  let address = 0
  const perCart = new Map<string, number>()
  return sequence.map((cart) => {
    address += 1
    if (address > 10 * requests) return true
    const count = (perCart.get(cart) ?? 0) + 1
    perCart.set(cart, count)
    return count > requests
  })
}

describe('AC-13: the built-in quote limit', () => {
  // Kills: one client driving the tax, promotions and carrier engines without bound through the quote route.
  it('AC-13: from one address, a cart’s 31st quote in a minute answers 429 with a Retry-After of at most 60 s, while another cart from that address is still let through', () => {
    const guard = guardWith()
    const ip = '203.0.113.40'

    const first = Array.from({ length: REQUESTS }, () => statusOf(guard, post(QUOTE, ip, 'cart-a')))
    const refused = guard.admit(post(QUOTE, ip, 'cart-a'))
    const other = statusOf(guard, post(QUOTE, ip, 'cart-b'))

    expect(first).toEqual(first.map(() => 200))
    expect(refused?.status).toBe(429)
    const retryAfter = Number(refused?.headers?.['retry-after'] ?? 0)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(other).toBe(200)
  })

  // Kills: shoppers behind one proxy refusing each other's quotes (an address-only key), or a client minting carts
  // to quote without bound (no address ceiling).
  it('AC-13: property: over 2 to 12 carts quoting 31 times each, interleaved, from one address, exactly the quotes past a cart’s 30 or past the address’s 300 are refused', () => {
    let client = 0
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (cartCount) => {
        const guard = guardWith()
        client += 1
        const ip = `198.18.0.${client}`
        const carts = Array.from({ length: cartCount }, (_, i) => `cart-${client}-${i}`)
        const sequence: string[] = []
        for (let round = 0; round <= REQUESTS; round += 1) sequence.push(...carts)

        const refused = sequence.map((cart) => statusOf(guard, post(QUOTE, ip, cart)) === 429)

        expect(refused).toEqual(refusedBy(sequence, REQUESTS))
      }),
      { numRuns: 12, examples: [[2], [10], [11], [12]] },
    )
  })

  // Kills: quotes and checkouts sharing a bucket, so a shopper who changed option a few times cannot place.
  it('AC-13: thirty quotes of a cart leave POST /api/checkout’s thirty for that cart untouched, and its 31st checkout is refused as before', () => {
    const guard = guardWith()
    const ip = '203.0.113.41'

    const quotes = Array.from({ length: REQUESTS }, () =>
      statusOf(guard, post(QUOTE, ip, 'cart-c')),
    )
    const checkouts = Array.from({ length: REQUESTS + 1 }, () =>
      statusOf(guard, post(CHECKOUT, ip, 'cart-c')),
    )

    expect(quotes).toEqual(quotes.map(() => 200))
    expect(checkouts.slice(0, REQUESTS)).toEqual(checkouts.slice(0, REQUESTS).map(() => 200))
    expect(checkouts[REQUESTS]).toBe(429)
    expect(statusOf(guard, post(QUOTE, ip, 'cart-c'))).toBe(429)
  })

  // Kills: a merchant's own quote rule ignored, or applied by address alone so one proxy's shoppers refuse each other.
  it('AC-13: a configured /api/checkout/quote rule replaces the built-in one and is counted the same way: per cart at its count, per address at ten times it', () => {
    const guard = guardWith({ [QUOTE]: { requests: 5, window: '1m', action: 'block' } })
    const ip = '203.0.113.42'
    const sequence = Array.from({ length: 12 }, (_, i) => `cart-${i}`).flatMap((cart) =>
      Array.from({ length: 6 }, () => cart),
    )

    const refused = sequence.map((cart) => statusOf(guard, post(QUOTE, ip, cart)) === 429)

    expect(refused).toEqual(refusedBy(sequence, 5))
  })
})
