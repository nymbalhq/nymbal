import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { checkStartEnv } from './start.js'

// `nymbal start` checks its environment in one pass before it builds anything, and names every problem by its
// variable, never by its value. In production it also names the config the app would refuse while it is built: the
// default JWT secret only when NYMBAL_JWT_SECRET does not replace it. A malformed NYMBAL_JWT_SECRET or
// NYMBAL_TRUST_PROXY_HOPS fails the app's boot whatever NODE_ENV is, so start names it whatever NODE_ENV is.

const VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'NYMBAL_SECRETS_KEY',
  'NYMBAL_PUBLIC_URL',
  'NODE_ENV',
  'commerce.payments.provider',
  'security.auth.jwtSecret',
  'NYMBAL_JWT_SECRET',
  'NYMBAL_TRUST_PROXY_HOPS',
] as const
type Variable = (typeof VARIABLES)[number]

/** Which of VARIABLES a line names, as whole names (REDIS_URL inside NYMBAL_REDIS_URL is not REDIS_URL). */
function named(line: string): Variable[] {
  return VARIABLES.filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_.])${name.replaceAll('.', '\\.')}($|[^A-Za-z0-9_])`).test(line),
  )
}

/**
 * The problems a line reports. The default-secret line is known by its refusal code, and may say how to fix it
 * (NYMBAL_JWT_SECRET); a malformed-variable line is known by the variable it names, and may name the config path.
 */
function kinds(line: string): Variable[] {
  if (line.includes('config.production_default_jwt_secret')) return ['security.auth.jwtSecret']
  const names = named(line)
  for (const variable of ['NYMBAL_JWT_SECRET', 'NYMBAL_TRUST_PROXY_HOPS'] as const) {
    if (names.includes(variable)) return [variable]
  }
  return names
}

/** A value no message has a reason to hold by chance: 12-32 characters, at least 6 distinct. */
const token = fc.stringMatching(/^[A-Za-z0-9]{12,32}$/).filter((s) => new Set(s).size >= 6)
const host = fc.stringMatching(/^[a-z][a-z0-9]{5,14}$/)

const caseArb = fc
  .record({
    commandStore: fc.constantFrom('sqlite', 'postgres'),
    documentStore: fc.constantFrom('in-memory', 'redis', 'postgres-jsonb'),
    eventBus: fc.constantFrom('in-process', 'redis-streams'),
    redisInConfig: fc.boolean(),
    database: fc.option(token, { nil: undefined }),
    redis: fc.option(token, { nil: undefined }),
    configRedisPassword: token,
    key: fc.constantFrom('valid', 'missing', 'malformed'),
    keyBytes: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    malformedKey: fc.stringMatching(/^[A-Za-z0-9+/]{12,40}$/).filter((s) => new Set(s).size >= 6),
    publicUrl: fc.constantFrom('valid', 'missing', 'path', 'scheme'),
    host,
    nodeEnv: fc.constantFrom('unset', 'production', 'development'),
    payments: fc.constantFrom('native', 'stripe'),
    jwtSecret: fc.option(
      fc.stringMatching(/^[A-Za-z0-9]{16,40}$/).filter((s) => new Set(s).size >= 6),
      { nil: undefined },
    ),
    envJwt: fc.constantFrom('unset', 'empty', 'short', 'valid'),
    envJwtValid: fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/).filter((s) => new Set(s).size >= 6),
    envJwtShort: fc.stringMatching(/^[A-Za-z0-9_-]{8,15}$/).filter((s) => new Set(s).size >= 6),
    hops: fc.constantFrom('unset', 'valid', 'bad'),
    hopsValid: fc.integer({ min: 0, max: 4 }),
    hopsBad: fc.oneof(
      fc.constantFrom('1.5', '-1', 'x', '2.0e1x', 'one'),
      fc.stringMatching(/^[a-z]{8,14}$/).filter((s) => new Set(s).size >= 6),
    ),
    noise: fc.dictionary(fc.stringMatching(/^X_[A-Z]{3,8}$/), token, { maxKeys: 4 }),
  })
  .map((c) => ({
    ...c,
    // The schema refuses these pairs; replace them with the nearest pair it accepts.
    documentStore:
      c.documentStore === 'postgres-jsonb' && c.commandStore === 'sqlite'
        ? 'redis'
        : c.documentStore,
  }))
  .map((c) => ({
    ...c,
    eventBus:
      c.eventBus === 'redis-streams' && c.documentStore === 'in-memory' ? 'in-process' : c.eventBus,
  }))

type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never

function made(c: Case): {
  config: NymbalConfig
  env: NodeJS.ProcessEnv
  expected: Variable[]
  /** Problems a line may report or not: the default secret beside a malformed NYMBAL_JWT_SECRET. */
  optional: Variable[]
  values: string[]
} {
  const configRedisUrl = `redis://:${c.configRedisPassword}@cfg-${c.host}.internal:6379/0`
  const config = nymbalConfigSchema.parse({
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: c.commandStore,
      documentStore: { provider: c.documentStore },
      eventBus: { provider: c.eventBus },
      ...(c.redisInConfig && { redis: { url: configRedisUrl } }),
    },
    security: {
      adapter: 'middleware',
      ...(c.jwtSecret !== undefined && { auth: { jwtSecret: c.jwtSecret } }),
    },
    commerce: {
      payments: { provider: c.payments },
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
  const databaseUrl =
    c.database === undefined
      ? undefined
      : `postgres://shop:${c.database}@db-${c.host}.internal:5432/shop`
  const redisUrl =
    c.redis === undefined ? undefined : `redis://:${c.redis}@cache-${c.host}.internal:6379/0`
  const key =
    c.key === 'valid'
      ? Buffer.from(c.keyBytes).toString('base64')
      : c.key === 'malformed'
        ? c.malformedKey
        : undefined
  const publicUrl =
    c.publicUrl === 'valid'
      ? `https://${c.host}.example`
      : c.publicUrl === 'path'
        ? `https://${c.host}.example/shop`
        : c.publicUrl === 'scheme'
          ? `ftp://${c.host}.example`
          : undefined
  const envJwt =
    c.envJwt === 'valid'
      ? c.envJwtValid
      : c.envJwt === 'short'
        ? c.envJwtShort
        : c.envJwt === 'empty'
          ? ''
          : undefined
  const hops = c.hops === 'valid' ? String(c.hopsValid) : c.hops === 'bad' ? c.hopsBad : undefined
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    ...c.noise,
    ...(envJwt !== undefined && { NYMBAL_JWT_SECRET: envJwt }),
    ...(hops !== undefined && { NYMBAL_TRUST_PROXY_HOPS: hops }),
    ...(databaseUrl !== undefined && { DATABASE_URL: databaseUrl }),
    ...(redisUrl !== undefined && { REDIS_URL: redisUrl }),
    ...(key !== undefined && { NYMBAL_SECRETS_KEY: key }),
    ...(publicUrl !== undefined && { NYMBAL_PUBLIC_URL: publicUrl }),
    ...(c.nodeEnv !== 'unset' && { NODE_ENV: c.nodeEnv }),
  }
  const usesRedis = c.documentStore === 'redis' || c.eventBus === 'redis-streams'
  const expected: Variable[] = []
  if (c.commandStore === 'postgres' && databaseUrl === undefined) expected.push('DATABASE_URL')
  if (usesRedis && redisUrl === undefined && !c.redisInConfig) expected.push('REDIS_URL')
  if (c.key !== 'valid') expected.push('NYMBAL_SECRETS_KEY')
  if (c.publicUrl !== 'valid') expected.push('NYMBAL_PUBLIC_URL')
  if (c.nodeEnv === 'development') expected.push('NODE_ENV')
  if (c.nodeEnv === 'production' && c.payments === 'native') {
    expected.push('commerce.payments.provider')
  }
  const malformedJwt = c.envJwt === 'empty' || c.envJwt === 'short'
  const optional: Variable[] = []
  if (c.nodeEnv === 'production' && c.jwtSecret === undefined) {
    if (c.envJwt === 'unset') expected.push('security.auth.jwtSecret')
    else if (malformedJwt) optional.push('security.auth.jwtSecret')
  }
  if (malformedJwt) expected.push('NYMBAL_JWT_SECRET')
  if (c.hops === 'bad') expected.push('NYMBAL_TRUST_PROXY_HOPS')
  const values = [
    ...Object.values(c.noise),
    configRedisUrl,
    c.configRedisPassword,
    ...[databaseUrl, c.database, redisUrl, c.redis, key, publicUrl, c.jwtSecret].filter(
      (v): v is string => v !== undefined,
    ),
    ...(c.envJwt === 'valid' || c.envJwt === 'short' ? [envJwt!] : []),
    // A bad count of the generated, word-like kind; '1.5' or 'x' may sit in a line's own words.
    ...(c.hops === 'bad' && c.hopsBad.length >= 8 ? [c.hopsBad] : []),
  ]
  return { config, env, expected, optional, values }
}

describe('AC-1: checkStartEnv names every problem at once', () => {
  it('AC-1: for any set of problems the lines are one per problem and name exactly that set, and no line holds a value from the environment or the config', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { config, env, expected, optional, values } = made(c)
        const lines: string[] = checkStartEnv(config, env)
        const reported = lines.flatMap(kinds)

        expect(lines.map((line) => kinds(line).length)).toEqual(lines.map(() => 1))
        expect(reported.filter((k) => !optional.includes(k)).sort()).toEqual([...expected].sort())
        expect(reported.filter((k) => optional.includes(k)).length).toBeLessThanOrEqual(1)
        const leaked = values.filter((value) => lines.some((line) => line.includes(value)))
        expect(leaked).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: a malformed NYMBAL_SECRETS_KEY gets a line of its own kind, not the missing-key line', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { config, env } = made({ ...c, key: 'malformed' })
        const keyLine = (lines: string[]) =>
          lines.find((l) => named(l).includes('NYMBAL_SECRETS_KEY'))
        const malformed = keyLine(checkStartEnv(config, env) as string[])
        const missing = keyLine(
          checkStartEnv(config, { ...env, NYMBAL_SECRETS_KEY: undefined }) as string[],
        )

        expect(malformed).not.toBe(missing)
        expect([malformed, missing].map((line) => (line === undefined ? 0 : 1))).toEqual([1, 1])
      }),
      { numRuns: 50 },
    )
  })
})

describe('AC-4: start agrees with the app on the JWT secret and the proxy hop count', () => {
  it("AC-4: under production, start names the default secret exactly when the app's resolveAuthSecret resolves to the default, names NYMBAL_JWT_SECRET exactly when it throws (an own config secret beside it included), and names NYMBAL_TRUST_PROXY_HOPS exactly when the server's resolveTrustProxy throws, with no value in any line", async () => {
    const { resolveAuthSecret } = (await import('@nymbalhq/platform')) as unknown as {
      resolveAuthSecret: (config: NymbalConfig, env: NodeJS.ProcessEnv) => { source: string }
    }
    const { resolveTrustProxy } = (await import('@nymbalhq/http')) as unknown as {
      resolveTrustProxy: (config: NymbalConfig, env: NodeJS.ProcessEnv) => boolean | number
    }
    /** Whether the app refuses: a ConfigError. Anything else is the test's own failure and propagates. */
    const throws = (fn: () => unknown): boolean => {
      try {
        fn()
        return false
      } catch (error) {
        if (error instanceof ConfigError) return true
        throw error
      }
    }

    fc.assert(
      fc.property(caseArb, (c) => {
        const { config, env, values } = made({ ...c, nodeEnv: 'production' })
        const lines: string[] = checkStartEnv(config, env)
        const reported = lines.flatMap(kinds)
        const secretRefused = throws(() => resolveAuthSecret(config, env))
        const hopsRefused = throws(() => resolveTrustProxy(config, env))

        // Beside a refused variable the app's verdict on the default is unknown, so it is not compared.
        const onDefault = secretRefused ? null : resolveAuthSecret(config, env).source === 'default'

        expect(reported.includes('NYMBAL_JWT_SECRET')).toBe(secretRefused)
        expect(secretRefused ? null : reported.includes('security.auth.jwtSecret')).toBe(onDefault)
        expect(reported.includes('NYMBAL_TRUST_PROXY_HOPS')).toBe(hopsRefused)
        expect(values.filter((value) => lines.some((line) => line.includes(value)))).toEqual([])
      }),
      { numRuns: 300 },
    )
  })
})
