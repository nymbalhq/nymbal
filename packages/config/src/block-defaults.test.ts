import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JWT_SECRET, nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// AC-6: a config that leaves out a block whose default is `{}` gets that block's field defaults, exactly as if it had
// written the block empty. A default that is returned without being parsed would leave a store with no JWT secret, no
// HSTS and order keys with no lifetime.

const BLOCKS = [
  ['security', 'headers'],
  ['security', 'auth'],
  ['commerce', 'orders'],
  ['commerce', 'orders', 'keyLifetime'],
  ['http', 'cors'],
  ['events'],
] as const

type Path = (typeof BLOCKS)[number]

function baseConfig(): Record<string, unknown> {
  const config: NymbalConfigInput = {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
    commerce: {
      payments: { provider: 'stripe', config: { secretKey: 's', webhookSecret: 'w' } },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'anthropic', config: { apiKey: 'k' } },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  }
  return structuredClone(config) as unknown as Record<string, unknown>
}

function omit(config: Record<string, unknown>, path: Path): void {
  let at: Record<string, unknown> | undefined = config
  for (const key of path.slice(0, -1)) at = at?.[key] as Record<string, unknown> | undefined
  if (at) delete at[path[path.length - 1]!]
}

function setEmpty(config: Record<string, unknown>, path: Path): void {
  let at = config
  for (const key of path.slice(0, -1)) {
    at[key] ??= {}
    at = at[key] as Record<string, unknown>
  }
  at[path[path.length - 1]!] = {}
}

/** The config with each of `paths` left out, and the same config with each written as `{}`. */
function omittedAndEmpty(paths: readonly Path[]) {
  const omitted = baseConfig()
  const empty = baseConfig()
  for (const path of paths) omit(omitted, path)
  for (const path of paths) setEmpty(empty, path)
  return { omitted, empty }
}

describe('AC-6: a block left out of the config takes the same defaults as the block written empty', () => {
  it('AC-6: for any set of the blocks whose default is {}, parsing the config with them omitted equals parsing it with them {}', () => {
    fc.assert(
      fc.property(fc.subarray([...BLOCKS], { minLength: 1 }), (paths) => {
        const { omitted, empty } = omittedAndEmpty(paths)
        expect(nymbalConfigSchema.parse(omitted)).toEqual(nymbalConfigSchema.parse(empty))
      }),
      { numRuns: 64 },
    )
  })

  it("AC-6: with every such block omitted the store keeps today's values: HSTS on, the default JWT secret and TTLs, order numbering and key lifetimes, CORS credentials and 30 days of events", () => {
    const { omitted } = omittedAndEmpty(BLOCKS)

    const parsed = nymbalConfigSchema.parse(omitted)

    expect(parsed.security.headers.hsts).toBe(true)
    expect(parsed.security.auth.jwtSecret).toBe(DEFAULT_JWT_SECRET)
    expect(parsed.security.auth.accessTtl).toBe('15m')
    expect(parsed.security.auth.refreshTtl).toBe('7d')
    expect(parsed.commerce.orders.numberPrefix).toBe('NYM')
    expect(parsed.commerce.orders.numberStart).toBe(1000)
    expect(parsed.commerce.orders.keyLifetime).toEqual({ checkout: '48h', email: '30d' })
    expect(parsed.http.cors.credentials).toBe(true)
    expect(parsed.events.retentionDays).toBe(30)
  })
})
