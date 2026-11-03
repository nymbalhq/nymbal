import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JWT_SECRET, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { devListenHost } from './dev.js'

// `nymbal dev` with the published default secret binds 127.0.0.1 in place of the schema's wildcard host, so a fresh
// clone and the E2E API keep starting while no other machine can reach a store whose tokens anyone can sign. A secret
// of the store's own (the config's or NYMBAL_JWT_SECRET), or a host the config names, is used as given.

const VARIABLE = 'NYMBAL_JWT_SECRET'
const OWN_SECRET = 'an-own-secret-of-thirty-two-chars'

function configWith(opts: { host?: string; jwtSecret?: string }): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: {
      adapter: 'middleware',
      ...(opts.jwtSecret !== undefined && { auth: { jwtSecret: opts.jwtSecret } }),
    },
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
    http: { adapter: 'fastify', ...(opts.host !== undefined && { host: opts.host }) },
    deployment: { strategy: 'standard' },
  })
}

describe('AC-10: devListenHost', () => {
  it('AC-10: the default secret on the schema host 0.0.0.0 binds 127.0.0.1; NYMBAL_JWT_SECRET set keeps 0.0.0.0; an explicit non-loopback host with the default secret is kept', () => {
    const schemaHost = configWith({})
    expect(schemaHost.http.host).toBe('0.0.0.0')
    expect(schemaHost.security.auth.jwtSecret).toBe(DEFAULT_JWT_SECRET)

    expect(devListenHost(schemaHost, {})).toBe('127.0.0.1')
    expect(devListenHost(schemaHost, { [VARIABLE]: OWN_SECRET })).toBe(schemaHost.http.host)
    expect(devListenHost(configWith({ host: '192.168.1.20' }), {})).toBe('192.168.1.20')
  })

  it('AC-10: over secret sources and hosts, only the default secret on 0.0.0.0 is moved to 127.0.0.1; every other pair keeps its host', () => {
    const source = fc.constantFrom('default', 'env', 'config')
    const host = fc.oneof(
      fc.constant('0.0.0.0'),
      fc.ipV4(),
      fc.domain(),
      fc.constantFrom('127.0.0.1', 'localhost', '::1', '::'),
    )
    fc.assert(
      fc.property(source, host, (src, h) => {
        const config = configWith({ host: h, ...(src === 'config' && { jwtSecret: OWN_SECRET }) })
        const env = src === 'env' ? { [VARIABLE]: OWN_SECRET } : {}
        const expected = src === 'default' && h === '0.0.0.0' ? '127.0.0.1' : h
        expect(devListenHost(config, env), `${src} on ${h}`).toBe(expected)
      }),
      { numRuns: 200 },
    )
  })
})
