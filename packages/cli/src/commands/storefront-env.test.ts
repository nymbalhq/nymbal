import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { KNOWN_PROVIDERS, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { storefrontEnv } from './dev.js'

// P2-05 decision 3 (replacing P1-07 AC-6's payments branch): the storefront learns how to take a payment from GET
// /api/capabilities, so the environment `nymbal dev` starts it with says nothing about the payments provider. Over
// every payments provider the config accepts (custom included), the storefront environment is the same, carries the
// API URL and the port, and holds no `*_PAYMENTS_PROVIDER` or `*_STRIPE_*` variable the base environment did not.
// Kills: the vendor branch surviving in the CLI (a template told `native-stub` keeps its stub branch).

const API_URL = 'http://localhost:3001'
const VENDOR_VARIABLE = /(_PAYMENTS_PROVIDER$|_STRIPE_)/

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

const PROVIDERS = [...new Set([...KNOWN_PROVIDERS.payments, 'custom'])]

describe('nymbal dev storefront environment', () => {
  it('AC-2: over every payments provider and port, the storefront environment is the same for all providers and sets no payments-provider or Stripe variable', () => {
    expect(PROVIDERS).toEqual(expect.arrayContaining(['native', 'stripe', 'custom']))
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        fc.constantFrom(...PROVIDERS),
        fc.integer({ min: 1024, max: 65535 }),
        (a, b, port) => {
          const envA = storefrontEnv(configWith(a), API_URL, port, {})
          const envB = storefrontEnv(configWith(b), API_URL, port, {})

          expect(envA).toEqual(envB)
          expect(Object.keys(envA).filter((name) => VENDOR_VARIABLE.test(name))).toEqual([])
          expect(envA['PUBLIC_NYMBAL_API_URL']).toBe(API_URL)
          expect(envA['NEXT_PUBLIC_NYMBAL_API_URL']).toBe(API_URL)
          expect(envA['NYMBAL_STOREFRONT_PORT']).toBe(String(port))
        },
      ),
    )
  })
})
