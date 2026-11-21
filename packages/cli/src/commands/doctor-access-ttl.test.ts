import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { accessTtlCheck } from './doctor-access-ttl.js'

// An access token outlives a sign-out and a changed password until it expires, so `nymbal doctor` warns when a real
// deployment (one whose cookies are Secure: an https public origin) lets one live longer than the default 15 minutes.
// A store on http, a developer's, is not warned. The line is `access token lifetime`.

const NAME = 'access token lifetime'
const DEFAULT_MS = 15 * 60_000
const HTTPS = 'https://shop.example'
const HTTP = 'http://localhost:4321'

function configOf(storeUrl: string, accessTtl: string): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: {
      name: 'Doctor Store',
      currency: 'GBP',
      locale: 'en-GB',
      timezone: 'Europe/London',
      url: storeUrl,
    },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', auth: { accessTtl, refreshTtl: '7d' } },
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
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  })
}

/** An accessTtl the schema accepts, in minutes: 1 to 60. */
const minutes = fc.integer({ min: 1, max: 60 })

describe('AC-6: doctor warns when an https store’s access tokens outlive 15 minutes', () => {
  it('AC-6: property: the access token lifetime line is degraded exactly when accessTtl exceeds 15 minutes on a store whose cookies are Secure, and ok otherwise', () => {
    fc.assert(
      fc.property(minutes, fc.boolean(), (m, https) => {
        const check = accessTtlCheck(configOf(https ? HTTPS : HTTP, `${m}m`), {})

        expect(check.name).toBe(NAME)
        expect(check.status, `${m}m on ${https ? 'https' : 'http'}`).toBe(
          https && m * 60_000 > DEFAULT_MS ? 'degraded' : 'ok',
        )
      }),
      {
        numRuns: 120,
        examples: [
          [16, true],
          [15, true],
          [16, false],
        ],
      },
    )
  })
})
