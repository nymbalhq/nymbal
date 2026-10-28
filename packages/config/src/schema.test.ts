import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

function baseConfig(): NymbalConfigInput {
  return {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro' as const,
    // cloud and compute are gone; the cast keeps this compiling until the schema drops them.
    infrastructure: {
      commandStore: 'sqlite' as const,
      documentStore: 'in-memory' as const,
      eventBus: 'in-process' as const,
    } as NymbalConfigInput['infrastructure'],
    security: { adapter: 'middleware' as const, rateLimit: {}, csrf: true },
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
    http: { adapter: 'fastify' as const, port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' as const },
  }
}

describe('nymbalConfigSchema', () => {
  it('accepts a valid local config', () => {
    const parsed = nymbalConfigSchema.parse(baseConfig())
    expect(parsed.template).toBe('astro')
    expect(parsed.infrastructure.commandStore).toBe('sqlite')
    expect(parsed.features.staging).toBe(false)
  })

  it('round-trips: explicit values survive parsing, and re-parsing a parsed config changes nothing', () => {
    const input = baseConfig()
    const parsed = nymbalConfigSchema.parse(input)
    expect(parsed.store).toEqual(nymbalConfigSchema.parse(input).store)
    expect(parsed.http.port).toBe(input.http!.port)
    // Defaults apply once: the parsed config is a fixed point of the schema.
    expect(parsed).toEqual(nymbalConfigSchema.parse(structuredClone(parsed)))
  })

  it('rejects invalid template', () => {
    const cfg = baseConfig() as unknown as Record<string, unknown>
    cfg.template = 'svelte'
    const result = nymbalConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues.some((i) => i.path.includes('template'))).toBe(true)
  })

  it('rejects malformed rate-limit key', () => {
    const cfg = baseConfig()
    cfg.security.rateLimit = { bad_key: { requests: 10, window: '60s', action: 'block' } }
    const result = nymbalConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })

  it('applies header defaults', () => {
    const cfg = nymbalConfigSchema.parse(baseConfig())
    expect(cfg.security.headers.hsts).toBe(true)
    expect(cfg.security.headers.xFrameOptions).toBe('deny')
  })

  it('applies CORS defaults for local dev — localhost origins, credentials true', () => {
    const cfg = nymbalConfigSchema.parse(baseConfig())
    expect(cfg.http.cors.credentials).toBe(true)
    expect(cfg.http.cors.allowedOrigins).toContain('http://localhost:3000')
    expect(cfg.http.cors.allowedOrigins).toContain('http://localhost:4321')
  })

  it('accepts explicit CORS origins override', () => {
    const input = baseConfig() as unknown as Record<string, unknown>
    input.http = {
      ...(input.http as object),
      cors: { allowedOrigins: ['https://shop.example.com'], credentials: false },
    }
    const cfg = nymbalConfigSchema.parse(input)
    expect(cfg.http.cors.allowedOrigins).toEqual(['https://shop.example.com'])
    expect(cfg.http.cors.credentials).toBe(false)
  })
})

// AC-5: the storefront's public URL, which the order-placed email links from. Optional, so every existing config still
// parses; a URL, kept without a trailing slash so a path joined to it never doubles one.
describe('AC-5: store.url', () => {
  const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/)
  const storeUrl = fc
    .record({
      scheme: fc.constantFrom('http', 'https'),
      host: fc
        .array(label, { minLength: 1, maxLength: 3 })
        .map((parts) => [...parts, 'test'].join('.')),
      port: fc.option(fc.integer({ min: 1024, max: 65_535 }), { nil: undefined }),
      path: fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { maxLength: 2 }),
    })
    .map(
      ({ scheme, host, port, path }) =>
        `${scheme}://${host}${port === undefined ? '' : `:${port}`}${path.map((p) => `/${p}`).join('')}`,
    )

  const withStore = (store: Record<string, unknown>): NymbalConfigInput => {
    const cfg = baseConfig()
    return { ...cfg, store: { ...cfg.store, ...store } } as NymbalConfigInput
  }

  it('AC-5: property: a config with no store.url parses with none; one with a URL parses to that URL whether or not it ends in /, and with no trailing /', () => {
    expect(nymbalConfigSchema.parse(baseConfig()).store.url).toBeUndefined()
    fc.assert(
      fc.property(storeUrl, fc.boolean(), (url, slash) => {
        const parsed = nymbalConfigSchema.parse(withStore({ url: slash ? `${url}/` : url }))
        expect(parsed.store.url).toBe(url)
        expect(parsed.store.url?.endsWith('/')).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it("AC-5: store.url 'shop' is refused, naming store.url", () => {
    const result = nymbalConfigSchema.safeParse(withStore({ url: 'shop' }))
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
    expect([result.success, paths]).toEqual([false, ['store.url']])
  })
})
