import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger, RequestContext } from '@nymbalhq/types'
import { rateLimitAddress } from './rate-limit.js'
import { createSecurityGuard } from './security-middleware.js'

// A per-address rate limit counts an IPv6 client by its /64, the block one host is given, so a host cannot spread its
// failures over the addresses of its own network. However the address is spelled (compressed with `::`, upper or lower
// case, leading zeros), one /64 is one key, and two /64s are two. An IPv4-mapped address keys on its IPv4 address and
// is never folded, since its /64 would hold all of IPv4. An IPv4 address, or a value that is no address, is its own
// key. The request keeps its full address for the logs.

const LOGIN = '/api/auth/login'

const hextet = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 0xffff }))
const groups = (n: number) => fc.array(hextet, { minLength: n, maxLength: n })

/** The longest run of two or more zero groups replaced by `::`, or the plain form when there is none. */
function compressed(h: number[]): string {
  let best = { at: -1, length: 0 }
  for (let i = 0; i < h.length; ) {
    if (h[i] !== 0) {
      i += 1
      continue
    }
    let j = i
    while (j < h.length && h[j] === 0) j += 1
    if (j - i > best.length) best = { at: i, length: j - i }
    i = j
  }
  const text = (part: number[]) => part.map((x) => x.toString(16)).join(':')
  if (best.length < 2) return text(h)
  return `${text(h.slice(0, best.at))}::${text(h.slice(best.at + best.length))}`
}

/** Four spellings of one address: minimal lower case, upper case, zero-padded, and `::`-compressed. */
function spellings(h: number[]): string[] {
  const lower = h.map((x) => x.toString(16)).join(':')
  return [
    lower,
    lower.toUpperCase(),
    h.map((x) => x.toString(16).padStart(4, '0')).join(':'),
    compressed(h),
  ]
}

/** Not an IPv4-mapped address (`::ffff:0:0/96`), which keys on its IPv4 address instead. */
const unmapped = (h: number[]): boolean => !(h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)

describe('AC-29: rateLimitAddress keys an IPv6 client by its /64', () => {
  it('AC-29: property: every spelling of every address in one /64 gives one key', () => {
    fc.assert(
      fc.property(groups(4), groups(4), groups(4), (prefix, a, b) => {
        fc.pre(unmapped([...prefix, ...a]) && unmapped([...prefix, ...b]))
        const keys = [...spellings([...prefix, ...a]), ...spellings([...prefix, ...b])].map(
          rateLimitAddress,
        )

        expect(new Set(keys).size, keys.join(' ')).toBe(1)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-29: property: addresses in two different /64s give two keys, whatever their spelling', () => {
    fc.assert(
      fc.property(
        groups(4),
        groups(4),
        groups(4),
        groups(4),
        fc.nat(3),
        fc.nat(3),
        (p, q, a, b, i, j) => {
          fc.pre(p.join(':') !== q.join(':'))
          fc.pre(unmapped([...p, ...a]) && unmapped([...q, ...b]))
          const first = rateLimitAddress(spellings([...p, ...a])[i]!)
          const second = rateLimitAddress(spellings([...q, ...b])[j]!)

          expect(first).not.toBe(second)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-29: property: ::ffff:a.b.c.d keys as a.b.c.d, so distinct IPv4 addresses keep distinct keys; an IPv4 address and a value that is no address come back as given', () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.ipV4(), (v4, other) => {
        fc.pre(v4 !== other)

        expect(rateLimitAddress(`::ffff:${v4}`)).toBe(v4)
        expect(rateLimitAddress(`::ffff:${v4}`)).not.toBe(rateLimitAddress(`::ffff:${other}`))
        expect(rateLimitAddress(v4)).toBe(v4)
      }),
      { numRuns: 200 },
    )
    expect(['unknown', '', 'not-an-address'].map(rateLimitAddress)).toEqual([
      'unknown',
      '',
      'not-an-address',
    ])
  })
})

function silentLogger(): Logger {
  const noop = () => undefined
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as Logger
  return logger
}

function loginContext(ip: string, email: string): RequestContext {
  return {
    method: 'POST',
    path: LOGIN,
    url: LOGIN,
    params: {},
    query: {},
    body: { email, password: 'wrong-password' },
    headers: {},
    cookies: {},
    requestId: 'req',
    correlationId: 'corr',
    logger: silentLogger(),
    ip,
  }
}

/** Eleven failed logins, each at an email of its own from the given address: each status, and each request's ip after. */
function elevenFailures(addresses: string[]): { statuses: number[]; ips: string[] } {
  const guard = createSecurityGuard(securitySchema.parse({ adapter: 'middleware', csrf: false }))
  const statuses: number[] = []
  const ips: string[] = []
  addresses.forEach((ip, i) => {
    const ctx = loginContext(ip, `spread-${i}-${addresses.length}@address.test`)
    const refused = guard.admit(ctx)
    statuses.push(refused ? refused.status : guard.finish(ctx, { status: 401, body: {} }).status)
    ips.push(ctx.ip)
  })
  return { statuses, ips }
}

describe('AC-29: the guard counts an IPv6 client’s logins by its /64', () => {
  it('AC-29: 11 failed logins at 11 emails from 11 addresses of one /64 answer 429 on the eleventh; from 11 distinct /64s none does; each request keeps its full address', () => {
    const oneNetwork = Array.from(
      { length: 11 },
      (_, i) => `2001:db8:aa:bb::${(i + 1).toString(16)}`,
    )
    const elevenNetworks = Array.from(
      { length: 11 },
      (_, i) => `2001:db8:${(i + 1).toString(16)}::1`,
    )

    const shared = elevenFailures(oneNetwork)
    const spread = elevenFailures(elevenNetworks)

    expect(shared.statuses).toEqual([...Array.from({ length: 10 }, () => 401), 429])
    expect(spread.statuses).toEqual(Array.from({ length: 11 }, () => 401))
    expect([shared.ips, spread.ips]).toEqual([oneNetwork, elevenNetworks])
  })
})
