import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { resolveTrustProxy } from './server.js'

// Trusting every X-Forwarded-For hop lets any client choose its own address, so a production store refuses to boot
// with it and names the hop count to set instead. Everywhere else the resolved value does not depend on NODE_ENV.

const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'

function configWith(trustProxy: boolean | number | undefined): NymbalConfig {
  return nymbalConfigSchema.parse({
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
    http: trustProxy === undefined ? { adapter: 'fastify' } : { adapter: 'fastify', trustProxy },
    deployment: { strategy: 'standard' },
  })
}

type Outcome = { value: boolean | number } | { code: string; message: string } | { other: unknown }

function outcome(config: NymbalConfig, env: NodeJS.ProcessEnv): Outcome {
  try {
    return { value: resolveTrustProxy(config, env) }
  } catch (error) {
    if (error instanceof ConfigError) return { code: error.code, message: error.message }
    return { other: error }
  }
}

describe('AC-4: trustProxy true is refused in production', () => {
  it('AC-4: http.trustProxy true under NODE_ENV production throws ConfigError config.trust_proxy_true_production naming NYMBAL_TRUST_PROXY_HOPS and http.trustProxy; unset or development returns true', () => {
    const config = configWith(true)
    const production = outcome(config, { NODE_ENV: 'production' })

    expect(production).toMatchObject({ code: 'config.trust_proxy_true_production' })
    const message = 'message' in production ? production.message : ''
    expect(message).toContain(VARIABLE)
    expect(message).toContain('http.trustProxy')
    expect(outcome(config, {})).toEqual({ value: true })
    expect(outcome(config, { NODE_ENV: 'development' })).toEqual({ value: true })
  })

  it('AC-4: under production a hop count is returned as the number: http.trustProxy 2, and NYMBAL_TRUST_PROXY_HOPS=1 over the default', () => {
    expect(outcome(configWith(2), { NODE_ENV: 'production' })).toEqual({ value: 2 })
    expect(outcome(configWith(undefined), { NODE_ENV: 'production', [VARIABLE]: '1' })).toEqual({
      value: 1,
    })
  })

  it('AC-4: over generated configs, variables and NODE_ENV values, the outcome is the one with NODE_ENV unset, except that a resolved true under production throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.boolean(), fc.integer({ min: 0, max: 6 })),
        fc.oneof(
          fc.constant(undefined),
          fc.integer({ min: 0, max: 6 }).map(String),
          fc.constantFrom('x', '1.5', '-1'),
        ),
        fc.constantFrom('production', 'development', 'test', 'staging'),
        (trustProxy, hops, nodeEnv) => {
          const config = configWith(trustProxy)
          const base: NodeJS.ProcessEnv = hops === undefined ? {} : { [VARIABLE]: hops }
          const unset = outcome(config, base)
          const withEnv = outcome(config, { ...base, NODE_ENV: nodeEnv })

          const resolvedTrue = 'value' in unset && unset.value === true
          const refused = 'code' in withEnv && withEnv.code === 'config.trust_proxy_true_production'
          expect(refused ? 'refused' : withEnv).toEqual(
            nodeEnv === 'production' && resolvedTrue ? 'refused' : unset,
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})
