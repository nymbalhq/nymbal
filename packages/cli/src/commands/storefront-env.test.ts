import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { KNOWN_PROVIDERS, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { storefrontEnv } from './dev.js'

// Acceptance test for P1-07 AC-6 (the `nymbal dev` half): the storefront's environment tells both templates to skip
// Stripe whenever the configured payments provider is not `stripe`, and says nothing for `stripe`. Since P2-01 the
// config accepts only the providers it knows, so the property runs over those (`custom` reads an injected adapter
// the storefront environment cannot see, which the spec leaves open).

const STUB = 'native-stub'
const VARS = ['PUBLIC_NYMBAL_PAYMENTS_PROVIDER', 'NEXT_PUBLIC_NYMBAL_PAYMENTS_PROVIDER'] as const
const API_URL = 'http://localhost:3001'

function configWith(provider: string): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  })
}

describe('nymbal dev storefront environment', () => {
  it('AC-6: any provider other than stripe sets both payments-provider variables to native-stub', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...KNOWN_PROVIDERS.payments.filter((p: string) => p !== 'stripe' && p !== 'custom'),
        ),
        fc.integer({ min: 1024, max: 65535 }),
        (provider, port) => {
          fc.pre(provider !== 'stripe')
          const env = storefrontEnv(configWith(provider), API_URL, port, {})
          for (const name of VARS) expect(env[name], `${name} for ${provider}`).toBe(STUB)
          // The same object is the one carrying the API URL to the storefront.
          expect(env['PUBLIC_NYMBAL_API_URL']).toBe(API_URL)
          expect(env['NYMBAL_STOREFRONT_PORT']).toBe(String(port))
        },
      ),
    )
  })

  it('AC-6: stripe leaves both payments-provider variables unset', () => {
    const env = storefrontEnv(configWith('stripe'), API_URL, 4321, {})
    for (const name of VARS) expect(env[name], name).toBeUndefined()
    expect(env['PUBLIC_NYMBAL_API_URL']).toBe(API_URL)
  })
})
