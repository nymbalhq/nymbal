import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JWT_SECRET, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { resolveAuthSecret } from './auth-secret.js'

// The effective JWT secret: the config's own when it names one, else NYMBAL_JWT_SECRET, else the schema default. A set
// variable is checked first, whatever the config holds: shorter than 16 characters (empty included) is a ConfigError
// that names the variable and never a value.

const VARIABLE = 'NYMBAL_JWT_SECRET'

function configWith(jwtSecret: string | undefined): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', ...(jwtSecret !== undefined && { auth: { jwtSecret } }) },
    commerce: {
      payments: { provider: 'stripe' },
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
}

/** A value no message holds by chance: at least 6 distinct characters. */
const distinct = (min: number, max: number) =>
  fc
    .stringMatching(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`))
    .filter((s) => new Set(s).size >= Math.min(6, s.length))

const configSecretArb = fc.oneof(
  fc.constant({ kind: 'absent' as const, value: undefined }),
  fc.constant({ kind: 'default' as const, value: DEFAULT_JWT_SECRET }),
  distinct(16, 64).map((value) => ({ kind: 'own' as const, value })),
)

const envSecretArb = fc.oneof(
  fc.constant({ kind: 'unset' as const, value: undefined }),
  fc.constant({ kind: 'empty' as const, value: '' }),
  distinct(1, 15).map((value) => ({ kind: 'short' as const, value })),
  distinct(16, 64).map((value) => ({ kind: 'valid' as const, value })),
)

/** What resolveAuthSecret does for a case: throws, or returns this secret from this source. */
function expected(
  configSecret: { kind: 'absent' | 'default' | 'own'; value: string | undefined },
  envSecret: { kind: 'unset' | 'empty' | 'short' | 'valid'; value: string | undefined },
): Outcome {
  if (envSecret.kind === 'empty' || envSecret.kind === 'short') {
    return {
      refused: {
        code: 'config.jwt_secret_too_short',
        variable: VARIABLE,
        namesVariable: true,
        leaked: [],
      },
    }
  }
  if (configSecret.kind === 'own') return { secret: configSecret.value!, source: 'config' }
  if (envSecret.kind === 'valid') return { secret: envSecret.value!, source: 'env' }
  return { secret: DEFAULT_JWT_SECRET, source: 'default' }
}

/** What a call did, in one comparable shape: the secret and source it returned, or how it refused. */
type Outcome =
  | { secret: string; source: string }
  | {
      refused: { code: string; variable: unknown; namesVariable: boolean; leaked: string[] }
    }
  | { unexpected: string }

function outcomeOf(call: () => { secret: string; source: string }, values: string[]): Outcome {
  try {
    const { secret, source } = call()
    return { secret, source }
  } catch (error) {
    if (!(error instanceof ConfigError)) return { unexpected: String(error) }
    const text = `${error.message} ${JSON.stringify(error.context)}`
    return {
      refused: {
        code: error.code,
        variable: error.context['variable'],
        namesVariable: error.message.includes(VARIABLE),
        leaked: values.filter((v) => text.includes(v)),
      },
    }
  }
}

describe('AC-1: the effective JWT secret', () => {
  it('AC-1: for any config secret and NYMBAL_JWT_SECRET, a set variable under 16 characters throws config.jwt_secret_too_short naming the variable and no value, whatever the config holds; otherwise the config’s own wins, then the variable, then the default', () => {
    fc.assert(
      fc.property(
        configSecretArb,
        envSecretArb,
        fc.dictionary(fc.stringMatching(/^X_[A-Z]{3,8}$/), distinct(12, 24), { maxKeys: 3 }),
        (configSecret, envSecret, noise) => {
          const config = configWith(configSecret.value)
          const env: NodeJS.ProcessEnv = {
            PATH: '/usr/bin:/bin',
            ...noise,
            ...(envSecret.value !== undefined && { [VARIABLE]: envSecret.value }),
          }
          // Only a value long enough to be told apart from the message's own words is searched for.
          const values = [
            envSecret.value,
            configSecret.kind === 'own' ? configSecret.value : '',
          ].filter((v): v is string => v !== undefined && v.length >= 6)

          expect(outcomeOf(() => resolveAuthSecret(config, env), values)).toEqual(
            expected(configSecret, envSecret),
          )
        },
      ),
      { numRuns: 400 },
    )
  })

  it('AC-1: a valid NYMBAL_JWT_SECRET beside the config’s own secret never moves the effective one, and with the config at the default the variable is the secret', () => {
    fc.assert(
      fc.property(distinct(16, 64), distinct(16, 64), (own, fromEnv) => {
        const withOwn = resolveAuthSecret(configWith(own), { [VARIABLE]: fromEnv })
        const alone = resolveAuthSecret(configWith(own), {})
        const onDefault = resolveAuthSecret(configWith(undefined), { [VARIABLE]: fromEnv })

        expect(withOwn.secret).toBe(alone.secret)
        expect(withOwn.source).toBe(alone.source)
        expect(onDefault.secret).toBe(fromEnv)
        expect(onDefault.secret).not.toBe(DEFAULT_JWT_SECRET)
      }),
      { numRuns: 200 },
    )
  })
})
