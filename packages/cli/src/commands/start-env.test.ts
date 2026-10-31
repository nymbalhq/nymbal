import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { checkStartEnv } from './start.js'

// `nymbal start` checks its environment in one pass before it builds anything, and names every problem by its
// variable, never by its value. In production it also names the config the app would refuse while it is built.

const VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'NYMBAL_SECRETS_KEY',
  'NYMBAL_PUBLIC_URL',
  'NODE_ENV',
  'commerce.payments.provider',
  'security.auth.jwtSecret',
] as const
type Variable = (typeof VARIABLES)[number]

/** Which of VARIABLES a line names, as whole names (REDIS_URL inside NYMBAL_REDIS_URL is not REDIS_URL). */
function named(line: string): Variable[] {
  return VARIABLES.filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_.])${name.replaceAll('.', '\\.')}($|[^A-Za-z0-9_])`).test(line),
  )
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
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    ...c.noise,
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
  if (c.nodeEnv === 'production' && c.jwtSecret === undefined) {
    expected.push('security.auth.jwtSecret')
  }
  const values = [
    ...Object.values(c.noise),
    configRedisUrl,
    c.configRedisPassword,
    ...[databaseUrl, c.database, redisUrl, c.redis, key, publicUrl, c.jwtSecret].filter(
      (v): v is string => v !== undefined,
    ),
  ]
  return { config, env, expected, values }
}

describe('AC-1: checkStartEnv names every problem at once', () => {
  it('AC-1: for any set of problems the lines are one per problem and name exactly that set, and no line holds a value from the environment or the config', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { config, env, expected, values } = made(c)
        const lines: string[] = checkStartEnv(config, env)

        expect(lines).toHaveLength(expected.length)
        expect(lines.map((line) => named(line).length)).toEqual(lines.map(() => 1))
        expect(lines.flatMap(named).sort()).toEqual([...expected].sort())
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
