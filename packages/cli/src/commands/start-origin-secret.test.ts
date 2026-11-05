import { randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveOriginLock } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { checkStartEnv } from './start.js'

// `nymbal start` names, before it builds anything, every problem the app would refuse at boot. A malformed
// NYMBAL_ORIGIN_SECRET fails the boot, so start lists its refusal exactly when the app's own resolveOriginLock throws,
// with the same message, and never the secret's text.

const VAR = 'NYMBAL_ORIGIN_SECRET'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.~-'

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

/** An environment start passes with, the origin secret aside. */
const base: NodeJS.ProcessEnv = {
  NYMBAL_SECRETS_KEY: randomBytes(32).toString('base64'),
  NYMBAL_PUBLIC_URL: 'https://shop.example',
  NYMBAL_JWT_SECRET: 'start-origin-jwt-secret-0123456789abcdef',
}

const distinct = (min: number) => (s: string) => new Set(s).size >= min
const unit = fc.constantFrom(...ALPHABET)
const entryArb = fc.oneof(
  fc.string({ unit, minLength: 32, maxLength: 80 }).filter(distinct(8)),
  fc.string({ unit, minLength: 12, maxLength: 31 }).filter(distinct(6)),
  fc
    .tuple(
      fc.string({ unit, minLength: 16, maxLength: 40 }).filter(distinct(6)),
      fc.constantFrom(' ', 'é', '"', '!', '@'),
      fc.string({ unit, minLength: 16, maxLength: 40 }).filter(distinct(6)),
    )
    .map(([a, junk, b]) => `${a}${junk}${b}`),
)
const valueArb = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom('', '  ', ' , '),
  fc.array(entryArb, { minLength: 1, maxLength: 3 }).map((entries) => entries.join(',')),
)

function refusalOf(env: NodeJS.ProcessEnv): string | null {
  try {
    resolveOriginLock(config, env)
    return null
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return error.message
  }
}

describe('AC-6: start and the app agree on the origin secret', () => {
  it('AC-6: property: over generated NYMBAL_ORIGIN_SECRET values (unset, blank, valid and invalid entries), checkStartEnv lists exactly one more line than without it, resolveOriginLock’s message, exactly when that throws, and no line holds an entry’s text', () => {
    const seen = { refused: 0, resolved: 0 }
    fc.assert(
      fc.property(valueArb, (value) => {
        const env = value === undefined ? base : { ...base, [VAR]: value }
        const lines: string[] = checkStartEnv(config, env)
        const without: string[] = checkStartEnv(config, base)
        const appRefusal = refusalOf(env)
        seen[appRefusal === null ? 'resolved' : 'refused'] += 1

        expect([...lines].sort()).toEqual(
          (appRefusal === null ? without : [...without, appRefusal]).sort(),
        )
        const entries = (value ?? '')
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e.length >= 12)
        expect(entries.filter((e) => lines.some((line) => line.includes(e)))).toEqual([])
      }),
      { numRuns: 300 },
    )
    expect(Math.min(seen.refused, seen.resolved)).toBeGreaterThanOrEqual(20)
  })
})
