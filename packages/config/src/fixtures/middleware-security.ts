import fc from 'fast-check'

// `security` blocks of `middleware` stores, as a project may write them at d872ee8: any rate limit the key pattern
// allows, every optional block present or absent. `middleware-security-d872ee8.json` holds RECORD_RUNS of them, drawn
// with RECORD_SEED, beside what the d872ee8 schema parsed each one to (the config beside it is BASE_CONFIG). The
// recording ran once, at d872ee8, before the schema changed; it is not re-run.

export const RECORD_SEED = 2404
export const RECORD_RUNS = 60

/** Every top-level block but `security`, as schema.test.ts's base config has it. */
export const BASE_CONFIG = {
  store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
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
  http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
  deployment: { strategy: 'standard' },
} as const

const keyArb = fc.stringMatching(/^\/[a-z0-9_\-/*:]{0,24}$/)

const ruleArb = fc.record(
  {
    requests: fc.integer({ min: 1, max: 100_000 }),
    window: fc
      .tuple(fc.integer({ min: 1, max: 999 }), fc.constantFrom('ms', 's', 'm', 'h'))
      .map(([n, unit]) => `${n}${unit}`),
    action: fc.constantFrom('block', 'challenge', 'throttle'),
  },
  { noNullPrototype: true },
)

export const middlewareSecurityArb = fc.record(
  {
    adapter: fc.constant('middleware'),
    rateLimit: fc.dictionary(keyArb, ruleArb, { maxKeys: 4, noNullPrototype: true }),
    botProtection: fc.record(
      {
        mode: fc.constantFrom('off', 'managed', 'strict'),
        allowList: fc.array(fc.ipV4(), { maxLength: 3 }),
      },
      { requiredKeys: [], noNullPrototype: true },
    ),
    headers: fc.record(
      {
        hsts: fc.boolean(),
        contentSecurityPolicy: fc.constantFrom('strict', 'relaxed', 'off', "default-src 'self'"),
        referrerPolicy: fc.constantFrom('no-referrer', 'strict-origin-when-cross-origin'),
        xFrameOptions: fc.constantFrom('deny', 'sameorigin'),
      },
      { requiredKeys: [], noNullPrototype: true },
    ),
    csrf: fc.boolean(),
    auth: fc.record(
      {
        jwtSecret: fc.stringMatching(/^[A-Za-z0-9]{16,40}$/),
        accessTtl: fc.constantFrom('15m', '1h', '30s'),
        refreshTtl: fc.constantFrom('7d', '30d', '12h'),
      },
      { requiredKeys: [], noNullPrototype: true },
    ),
  },
  { requiredKeys: ['adapter'], noNullPrototype: true },
)

export interface RecordedCase {
  input: unknown
  /** `security` as the d872ee8 schema parsed `{ ...BASE_CONFIG, security: input }`. */
  output: unknown
}

export interface Recording {
  recordedAt: string
  seed: number
  runs: number
  cases: RecordedCase[]
}
