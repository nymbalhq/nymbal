import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { desiredRules } from './index.js'
import { MANAGED_RULESET_IDS, type CfRule } from './tests/fake-cloudflare.js'
import {
  WINDOWS,
  WINDOW_PERIODS,
  allRules,
  pathKeyArb,
  refsOf,
  rulesPartArb,
  securityConfig,
  type RateLimitAction,
  type SpecRateLimit,
  type SpecSecurityConfig,
} from './tests/support.js'

// Acceptance tests for P2-04 AC-3 (spec P2-04-cloudflare-waf, Decisions 3 and 5): `desiredRules(config)` is pure and
// gives Nymbal-owned rules (every ref `nymbal:`-prefixed, unique, the same under any key order), bodies Cloudflare
// accepts (`cf.colo.id` in characteristics, `mitigation_timeout` by action), paths matched as the in-process limiter
// matches them (`eq` without `*`, `wildcard` with `*` or `**`, `**` written as `*`), and nothing for a key that does not
// start with `/`. Kills: refs that collide or follow object order (so every apply rewrites), an edge that limits paths
// the origin does not (`starts_with`), and a rule body Cloudflare refuses.

const CF = { zoneId: 'zone-p2-04', apiToken: 'unused', apiBase: 'http://127.0.0.1:9/client/v4' }

type Phases = Partial<Record<string, CfRule[]>>
const rulesOf = (config: SpecSecurityConfig): Phases => desiredRules(config) as Phases
const rateLimits = (config: SpecSecurityConfig): CfRule[] => rulesOf(config)['http_ratelimit'] ?? []

/** The one rate limiting rule a single-entry config gives. */
function onlyRateLimit(key: string, rule: SpecRateLimit): CfRule[] {
  return rateLimits(securityConfig(CF, { rateLimit: { [key]: rule } }))
}

/** Each phase's rules keyed by ref: what an apply compares, whatever order the rules come in. */
function byRef(phases: Phases): Record<string, Record<string, CfRule>> {
  return Object.fromEntries(
    Object.entries(phases).map(([phase, rules]) => [
      phase,
      Object.fromEntries((rules ?? []).map((r) => [String(r.ref), r])),
    ]),
  )
}

const anyPart = rulesPartArb({
  windows: WINDOWS,
  actions: ['block', 'challenge', 'throttle'],
  maxRateLimits: 6,
  maxCustomRules: 6,
  managed: ['cloudflare', 'owasp'],
  keys: fc.oneof(pathKeyArb, fc.constantFrom('api', 'api/v1', 'login')),
})

describe('P2-04 AC-3: desiredRules', () => {
  it('AC-3: over generated configs, every ref is nymbal:-prefixed and unique, every description starts nymbal:, and the rules are the same under any key order of rateLimit and customRules', () => {
    fc.assert(
      fc.property(anyPart, fc.integer({ min: 0, max: 1_000_000 }), (part, seed) => {
        const config = securityConfig(CF, part)
        const rules = allRules(rulesOf(config))
        const refs = rules.map((r) => r.ref)

        expect(refs.every((ref) => typeof ref === 'string' && ref.startsWith('nymbal:'))).toBe(true)
        expect(new Set(refs).size).toBe(refs.length)
        expect(
          rules.every(
            (r) => typeof r.description === 'string' && r.description.startsWith('nymbal:'),
          ),
        ).toBe(true)

        // The same entries in another order (a seeded shuffle).
        const shuffle = <T>(xs: readonly T[]): T[] =>
          xs
            .map((x, i) => ({ x, k: (i * 7919 + seed) % 104_729 }))
            .sort((a, b) => a.k - b.k)
            .map(({ x }) => x)
        const reordered = securityConfig(CF, {
          ...part,
          rateLimit: Object.fromEntries(shuffle(Object.entries(part.rateLimit))),
          customRules: shuffle(part.customRules),
        })
        expect(byRef(rulesOf(reordered))).toEqual(byRef(rulesOf(config)))
      }),
      { numRuns: 200 },
    )
  })

  it('AC-3: over generated configs, one rate limiting rule per key that starts with /, one custom rule per customRules entry plus one for a non-empty geo.block, one execute rule per managed ruleset; a key without / gives no rule and no throw', () => {
    fc.assert(
      fc.property(anyPart, (part) => {
        const config = securityConfig(CF, part)
        const phases = rulesOf(config)
        const slashKeys = Object.keys(part.rateLimit).filter((k) => k.startsWith('/'))

        expect((phases['http_ratelimit'] ?? []).length).toBe(slashKeys.length)
        expect((phases['http_request_firewall_custom'] ?? []).length).toBe(
          part.customRules.length + (part.geo.block.length > 0 ? 1 : 0),
        )
        expect((phases['http_request_firewall_managed'] ?? []).length).toBe(
          part.managedRulesets.length,
        )
        for (const rule of phases['http_request_firewall_managed'] ?? []) {
          expect(rule.action).toBe('execute')
        }
      }),
      { numRuns: 200 },
    )
    const contractKey = () =>
      rateLimits(
        securityConfig(CF, {
          rateLimit: { api: { requests: 100, window: '1m', action: 'block' } },
        }),
      )
    expect(contractKey).not.toThrow()
    expect(contractKey()).toEqual([])
  })

  it('AC-3: every rate limiting rule keys on cf.colo.id and ip.src, limits requests_per_period to the configured requests, and its period is the window in seconds', () => {
    fc.assert(
      fc.property(
        pathKeyArb,
        fc.integer({ min: 1, max: 10_000 }),
        fc.constantFrom(...WINDOWS),
        fc.constantFrom<RateLimitAction>('block', 'challenge', 'throttle'),
        (key, requests, window, action) => {
          const rules = onlyRateLimit(key, { requests, window, action })
          expect(rules).toHaveLength(1)
          const rl = rules[0]!.ratelimit!
          expect([...(rl.characteristics ?? [])].sort()).toEqual(['cf.colo.id', 'ip.src'])
          expect(rl.requests_per_period).toBe(requests)
          expect(rl.period).toBe(WINDOW_PERIODS[window])
        },
      ),
      { numRuns: 150 },
    )
  })

  it('AC-3: block is block with mitigation_timeout equal to the period, challenge is managed_challenge with 0, throttle is block with 0', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WINDOWS), (window) => {
        const at = (action: RateLimitAction): CfRule =>
          onlyRateLimit('/api/auth/login', { requests: 5, window, action })[0]!

        const block = at('block')
        expect(block.action).toBe('block')
        expect(block.ratelimit?.mitigation_timeout).toBe(block.ratelimit?.period)

        const challenge = at('challenge')
        expect(challenge.action).toBe('managed_challenge')
        expect(challenge.ratelimit?.mitigation_timeout).toBe(0)

        const throttle = at('throttle')
        expect(throttle.action).toBe('block')
        expect(throttle.ratelimit?.mitigation_timeout).toBe(0)
      }),
    )
  })

  it('AC-3: a key without * is matched with eq, one with * or ** with wildcard and ** written as *, and : is literal', () => {
    const expressionOf = (key: string): string | undefined =>
      onlyRateLimit(key, { requests: 5, window: '10s', action: 'block' })[0]?.expression

    expect(expressionOf('/api/auth/login')).toBe('http.request.uri.path eq "/api/auth/login"')
    expect(expressionOf('/api/*')).toBe('http.request.uri.path wildcard "/api/*"')
    expect(expressionOf('/api/**')).toBe(expressionOf('/api/*'))
    expect(expressionOf('/api/products/:id')).toBe('http.request.uri.path eq "/api/products/:id"')
    expect(expressionOf('/api/cart/*/items')).toBe(
      'http.request.uri.path wildcard "/api/cart/*/items"',
    )
  })

  it('AC-3: the geo block is one block rule, ref nymbal:geo:block, naming every code; cloudflare is the Cloudflare Managed ruleset', () => {
    const phases = rulesOf(
      securityConfig(CF, { geo: { block: ['RU', 'KP'] }, managedRulesets: ['cloudflare'] }),
    )
    const geo = (phases['http_request_firewall_custom'] ?? []).filter(
      (r) => r.ref === 'nymbal:geo:block',
    )
    expect(geo).toHaveLength(1)
    expect(geo[0]!.action).toBe('block')
    for (const code of ['RU', 'KP']) expect(geo[0]!.expression).toContain(`"${code}"`)

    const managed = phases['http_request_firewall_managed'] ?? []
    expect(managed.map((r) => r.action_parameters?.['id'])).toEqual([
      MANAGED_RULESET_IDS.cloudflare,
    ])
    expect(refsOf(allRules(phases)).length).toBe(2)
  })
})
