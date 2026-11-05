import Fastify from 'fastify'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'

// proxy-addr compiles the trusted list when Fastify is constructed and throws a bare TypeError for an entry it
// refuses (a /0 prefix among them). Whatever the resolver lets through must build a server: the store learns of a bad
// entry as a ConfigError naming it, never as an uncaught TypeError at boot.

const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'

const config = nymbalConfigSchema.parse({
  store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  security: { adapter: 'middleware' },
  commerce: {
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  },
  http: { adapter: 'fastify' },
  deployment: { strategy: 'standard' },
})

const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16))
const ipv6 = fc.array(hextet, { minLength: 8, maxLength: 8 }).map((h) => h.join(':'))
const entry = fc.oneof(
  fc.constantFrom('loopback', 'linklocal', 'uniquelocal', 'loopbak', 'localhost', ''),
  fc.constantFrom('0.0.0.0/0', '::/0'),
  fc.ipV4(),
  ipv6,
  fc.tuple(fc.ipV4(), fc.integer({ min: 0, max: 40 })).map(([a, p]) => `${a}/${p}`),
  fc.tuple(ipv6, fc.integer({ min: 0, max: 140 })).map(([a, p]) => `${a}/${p}`),
)

describe('AC-3: every list the resolver accepts builds a Fastify instance', () => {
  it('AC-3: property: over generated lists, valid and not, the resolver either throws a ConfigError or returns a list Fastify({ trustProxy: list }) is constructed with, and it refuses the lists Fastify would throw on', () => {
    let accepted = 0
    let refused = 0
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 4 }), (list) => {
        let resolved: string[] | ConfigError
        try {
          resolved = resolveTrustedProxies(config, { [LIST_VAR]: list.join(',') }).trustedProxies
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error
          resolved = error
        }
        let built: 'built' | string
        try {
          Fastify({ trustProxy: Array.isArray(resolved) ? resolved : list })
          built = 'built'
        } catch (error) {
          built = (error as Error).message
        }
        const verdict = Array.isArray(resolved)
          ? `accepted, Fastify ${built}`
          : /^config\.trusted_proxies_(invalid|everyone)$/.test(resolved.code)
            ? 'refused'
            : `refused as ${resolved.code}`
        if (Array.isArray(resolved)) accepted += 1
        else refused += 1
        expect(['accepted, Fastify built', 'refused']).toContain(verdict)
      }),
      { numRuns: 400 },
    )
    // Both halves ran: the generator reaches lists of each kind.
    expect(Math.min(accepted, refused)).toBeGreaterThanOrEqual(20)
  })
})
