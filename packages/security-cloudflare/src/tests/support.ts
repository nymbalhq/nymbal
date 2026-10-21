import fc from 'fast-check'
import { PLAN_LIMITS, type CfRule, type Plan } from './fake-cloudflare.js'

// P2-04 acceptance support (spec P2-04-cloudflare-waf): the `security` block the adapter is given, the context its
// `createAdapter` is called with, and generators of configs. The shapes are the spec's (Decision 4, Interface), written
// here so the tests depend on the spec and not on the implementation's types.

export type RateLimitAction = 'block' | 'challenge' | 'throttle'
export type CustomRuleAction = 'block' | 'managed_challenge' | 'js_challenge' | 'log'
export type ManagedRuleset = 'cloudflare' | 'owasp'

export type SpecRateLimit = { requests: number; window: string; action: RateLimitAction }
export type SpecCustomRule = { name: string; expression: string; action: CustomRuleAction }
export type SpecCloudflareBlock = { zoneId?: string; apiToken?: string; apiBase?: string }

/** The parsed `security` block of a `cloudflare` store (Decision 4). A type alias, so it has an implicit index signature. */
export type SpecSecurityConfig = {
  adapter: 'cloudflare'
  rateLimit: Record<string, SpecRateLimit>
  botProtection: { mode: 'off' | 'managed' | 'strict'; allowList: string[] }
  headers: {
    hsts: boolean
    contentSecurityPolicy: string
    referrerPolicy: string
    xFrameOptions: 'deny' | 'sameorigin'
  }
  csrf: boolean
  auth: { jwtSecret: string; accessTtl: string; refreshTtl: string }
  cloudflare: SpecCloudflareBlock
  geo: { block: string[] }
  customRules: SpecCustomRule[]
  managedRulesets: ManagedRuleset[]
}

/** Interface: `SecurityPlan`. */
export type SpecPlan = {
  phases: Array<{
    phase: string
    add: CfRule[]
    change: Array<{ ref: string; from: CfRule; to: CfRule }>
    remove: CfRule[]
  }>
}

/** Decision 5: each window and the period it becomes, in seconds. */
export const WINDOW_PERIODS: Readonly<Record<string, number>> = {
  '10s': 10,
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '10m': 600,
  '1h': 3600,
}
export const WINDOWS = Object.keys(WINDOW_PERIODS)

export const TOKEN = 'cf-p2-04-token-never-printed-7Qm2Xv'

export function securityConfig(
  cloudflare: SpecCloudflareBlock,
  over: Partial<Omit<SpecSecurityConfig, 'adapter' | 'cloudflare'>> = {},
): SpecSecurityConfig {
  return {
    adapter: 'cloudflare',
    rateLimit: {},
    botProtection: { mode: 'off', allowList: [] },
    headers: {
      hsts: true,
      contentSecurityPolicy: 'strict',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'deny',
    },
    csrf: true,
    auth: { jwtSecret: 'p2-04-jwt-secret-long-enough', accessTtl: '15m', refreshTtl: '7d' },
    geo: { block: [] },
    customRules: [],
    managedRulesets: [],
    ...over,
    cloudflare,
  }
}

const noop = (): void => {}
export interface SilentLogger {
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  child(bindings: Record<string, unknown>): SilentLogger
}
export const silentLogger: SilentLogger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLogger,
}

/** Decision 4: for the `security` slot, `ctx.config` is the `security.cloudflare` block. */
export function adapterContext(cloudflare: SpecCloudflareBlock) {
  return {
    slot: 'security' as const,
    config: cloudflare,
    logger: silentLogger,
    env: {} as NodeJS.ProcessEnv,
  }
}

/** Every rule of a `desiredRules` result, phase by phase (a phase the result leaves out has none). */
export function allRules(byPhase: Partial<Record<string, CfRule[]>>): CfRule[] {
  return Object.values(byPhase).flatMap((rules) => rules ?? [])
}

export function refsOf(rules: readonly CfRule[]): string[] {
  return rules.map((r) => String(r.ref)).sort()
}

export const isNymbal = (rule: CfRule): boolean =>
  typeof rule.ref === 'string' && rule.ref.startsWith('nymbal:')

export function isEmptyPlan(plan: SpecPlan): boolean {
  return plan.phases.every((p) => p.add.length + p.change.length + p.remove.length === 0)
}

export function codes(result: { errors: Array<{ code: string }> }): string[] {
  return result.errors.map((e) => e.code)
}

/** The fields a rule carries that Cloudflare does not add itself. */
export function authored(rule: CfRule): Omit<CfRule, 'id' | 'version' | 'last_updated'> {
  const { id: _id, version: _version, last_updated: _updated, ...rest } = rule
  return rest
}

/** The owner's own rules: a ref Cloudflare gave them (their id), never `nymbal:`. */
export const OWNER_CUSTOM_RULES: readonly CfRule[] = [
  {
    description: 'owner: block wp-login probes',
    expression: '(http.request.uri.path eq "/wp-login.php")',
    action: 'block',
  },
  {
    description: 'owner: challenge one address',
    expression: '(ip.src eq 203.0.113.7)',
    action: 'managed_challenge',
  },
]

/** A rate limiting rule of the owner's that every plan accepts. */
export const OWNER_RATE_LIMIT: CfRule = {
  description: 'owner: limit the contact form',
  expression: '(http.request.uri.path eq "/contact")',
  action: 'block',
  ratelimit: {
    characteristics: ['cf.colo.id', 'ip.src'],
    period: 10,
    requests_per_period: 20,
    mitigation_timeout: 10,
  },
}

const PATH_KEYS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/*',
  '/api/**',
  '/api/products/:id',
  '/api/cart/*/items',
  '/checkout',
  '/api/search',
]

const EXPRESSIONS = [
  '(http.request.uri.path eq "/xmlrpc.php")',
  '(http.user_agent contains "sqlmap")',
  '(http.request.method eq "TRACE")',
  '(ip.src in {192.0.2.0/24})',
  '(http.request.uri.query contains "union select")',
]

export const COUNTRIES = ['RU', 'KP', 'IR', 'BY', 'SY', 'CU', 'VE']

export const pathKeyArb = fc.oneof(
  fc.constantFrom(...PATH_KEYS),
  fc.stringMatching(/^\/[a-z]{1,8}(\/[a-z]{1,8}){0,2}$/),
)

export const customRuleArb = (
  actions: readonly CustomRuleAction[] = ['block', 'managed_challenge', 'js_challenge', 'log'],
) =>
  fc.record(
    {
      name: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
      expression: fc.constantFrom(...EXPRESSIONS),
      action: fc.constantFrom(...actions),
    },
    { noNullPrototype: true },
  )

export interface ConfigShape {
  windows: readonly string[]
  actions: readonly RateLimitAction[]
  maxRateLimits: number
  maxCustomRules: number
  managed: readonly ManagedRuleset[]
  /** Keys a store may hold that the edge cannot express (the contract's `api`). */
  keys?: fc.Arbitrary<string>
}

/** The parts of a security block `desiredRules` reads, shaped by `shape`. */
export function rulesPartArb(shape: ConfigShape) {
  return fc.record(
    {
      rateLimit: fc.dictionary(
        shape.keys ?? pathKeyArb,
        fc.record(
          {
            requests: fc.integer({ min: 1, max: 10_000 }),
            window: fc.constantFrom(...shape.windows),
            action: fc.constantFrom(...shape.actions),
          },
          { noNullPrototype: true },
        ),
        { maxKeys: shape.maxRateLimits, noNullPrototype: true },
      ),
      customRules: fc.uniqueArray(customRuleArb(), {
        maxLength: shape.maxCustomRules,
        selector: (r) => r.name,
      }),
      geo: fc.record(
        { block: fc.uniqueArray(fc.constantFrom(...COUNTRIES), { maxLength: 3 }) },
        { noNullPrototype: true },
      ),
      managedRulesets: fc.subarray([...shape.managed]),
    },
    { noNullPrototype: true },
  )
}

/** Configs every rule of which `plan` accepts, leaving `ownerRules` of the owner's room in each phase. */
export function validPartArb(plan: Plan, owner: { rateLimits: number; customRules: number }) {
  const limits = PLAN_LIMITS[plan]
  const windows = WINDOWS.filter((w) => limits.periods.includes(WINDOW_PERIODS[w]!))
  return rulesPartArb({
    windows,
    actions: plan === 'enterprise' ? ['block', 'challenge', 'throttle'] : ['block', 'challenge'],
    maxRateLimits: Math.max(0, limits.rateLimitRules - owner.rateLimits),
    // One custom rule is the geo block's.
    maxCustomRules: Math.min(6, limits.customRules - owner.customRules - 1),
    managed: limits.managedRulesets ? ['cloudflare', 'owasp'] : [],
  })
}
