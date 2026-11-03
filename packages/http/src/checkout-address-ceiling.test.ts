import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger, RequestContext } from '@nymbalhq/types'
import { checkoutKeys, createSecurityGuard } from './security-middleware.js'

// Checkouts count per (address, cart) at the rule's count and per address at ten times it, the address first. A
// request the address ceiling refuses opens no cart bucket, and a cart cookie reaches a limiter key only as a digest of
// fixed length, so neither fresh cookies nor long ones grow the limiter.

const REQUESTS = 30
const CEILING = 10 * REQUESTS
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

function checkoutContext(ip: string, cart: string | undefined): RequestContext {
  return {
    method: 'POST',
    path: CHECKOUT,
    url: CHECKOUT,
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

/** Cookie values as a browser sends them: no separator, quote or whitespace. */
const cookieValue = (maxLength: number) =>
  fc.string({
    unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.%'),
    minLength: 1,
    maxLength,
  })

describe('AC-3: the checkout address ceiling bounds the limiter', () => {
  it('AC-3: past the address ceiling, 100 checkouts with new cart cookies are all refused 429 and the guard holds no more buckets than before them', () => {
    const guard = createSecurityGuard(securitySchema.parse({ adapter: 'middleware', csrf: false }))
    const ip = '203.0.113.30'
    const admitted: boolean[] = []
    for (let i = 0; i < CEILING; i += 1) {
      admitted.push(guard.admit(checkoutContext(ip, `cart-${i % 10}`)) === null)
    }
    const atCeiling = guard.admit(checkoutContext(ip, 'cart-10'))
    const before = guard.bucketCount()
    const refused = Array.from(
      { length: 100 },
      (_, i) => guard.admit(checkoutContext(ip, `fresh-cart-${i}`))?.status ?? 200,
    )
    const after = guard.bucketCount()

    expect(admitted).toEqual(admitted.map(() => true))
    expect(atCeiling?.status).toBe(429)
    expect(refused).toEqual(refused.map(() => 429))
    expect(after).toBe(before)
  })

  it('AC-3: over generated cookies up to 8 KB, the pair key has one length whatever the cookie, never holds the cookie, is equal for equal cookies and differs for different ones; no cookie keys the empty cart; the address key is the address', () => {
    const ip = '198.51.100.23'
    const prefix = `${ip}|cart:`
    const eightKb = 'c'.repeat(8 * 1024)
    fc.assert(
      fc.property(cookieValue(8 * 1024), cookieValue(64), (cookie, other) => {
        fc.pre(cookie !== other)
        const keys = checkoutKeys(checkoutContext(ip, cookie))
        const again = checkoutKeys(checkoutContext(ip, cookie))
        const otherKeys = checkoutKeys(checkoutContext(ip, other))
        const long = checkoutKeys(checkoutContext(ip, eightKb))
        const none = checkoutKeys(checkoutContext(ip, undefined))

        expect(keys.address).toBe(ip)
        expect(none).toEqual({ pair: prefix, address: ip })
        expect(keys.pair.startsWith(prefix)).toBe(true)
        expect(keys.pair.slice(prefix.length)).toMatch(/^[0-9a-f]{32}$/)
        expect(keys.pair.length).toBe(long.pair.length)
        expect(otherKeys.pair.length).toBe(keys.pair.length)
        expect(again.pair).toBe(keys.pair)
        expect(otherKeys.pair).not.toBe(keys.pair)
        expect(long.pair.includes(eightKb.slice(0, 33))).toBe(false)
        expect(cookie.length > 32 && keys.pair.includes(cookie)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })
})
