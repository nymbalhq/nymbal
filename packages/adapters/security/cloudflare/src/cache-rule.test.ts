import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter, desiredRules } from './index.js'
import {
  PLANS,
  PLAN_LIMITS,
  startFakeCloudflare,
  type CfRule,
  type FakeCloudflare,
  type Phase,
  type Plan,
} from './tests/fake-cloudflare.js'
import {
  TOKEN,
  adapterContext,
  authored,
  isEmptyPlan,
  isNymbal,
  rulesPartArb,
  securityConfig,
  WINDOWS,
  type SpecPlan,
  type SpecSecurityConfig,
} from './tests/support.js'

// AC-8: whatever the config, `desiredRules` puts one cache rule in `http_request_cache_settings`, the phase `plan`,
// `apply`, `drift` and `inspect` read and write beside the three WAF phases; `validate` counts it against the plan's
// cache-rule limit with the zone's own cache rules; and `apply` keeps the owner's cache rules. Run against the fake,
// which refuses a cache phase over the plan's limit.

const CACHE: Phase = 'http_request_cache_settings'
const WAF: Phase[] = [
  'http_ratelimit',
  'http_request_firewall_custom',
  'http_request_firewall_managed',
]
const REF = 'nymbal:cache:fragments'

/** The Interface's rule, as written. */
const FRAGMENT_RULE: CfRule = {
  ref: REF,
  description: 'nymbal: cache the fragment routes',
  expression: 'starts_with(http.request.uri.path, "/fragments/")',
  action: 'set_cache_settings',
  action_parameters: {
    cache: true,
    edge_ttl: { mode: 'respect_origin' },
    browser_ttl: { mode: 'respect_origin' },
  },
  enabled: true,
}

/** A cache rule of the zone owner's (no `nymbal:` ref). */
const ownerCacheRule = (n: number): CfRule => ({
  description: `owner: cache images ${n}`,
  expression: `(http.request.uri.path wildcard "/img-${n}/*")`,
  action: 'set_cache_settings',
  action_parameters: { cache: true },
})

let fake: FakeCloudflare

beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
})

interface Adapter {
  plan(config: SpecSecurityConfig): Promise<SpecPlan>
  apply(config: SpecSecurityConfig): Promise<SpecPlan>
  drift(config: SpecSecurityConfig): Promise<{
    drift: boolean
    differences: Array<{ path: string; configured: unknown; actual: unknown }>
  }>
  inspect(): Promise<{ rulesApplied: string[] }>
  validate(
    config: SpecSecurityConfig,
  ): Promise<{ valid: boolean; errors: Array<{ code: string; path?: string; message: string }> }>
}

function zone(plan: Plan, phases: Partial<Record<Phase, CfRule[]>> = {}) {
  const zoneId = fake.addZone({ plan, token: TOKEN, phases })
  const cloudflare = { zoneId, apiToken: TOKEN, apiBase: fake.url }
  return {
    zoneId,
    adapter: createAdapter(adapterContext(cloudflare)) as Adapter,
    config: (over: Parameters<typeof securityConfig>[1] = {}) => securityConfig(cloudflare, over),
  }
}

type Phases = Partial<Record<string, CfRule[]>>
const rulesOf = (config: unknown): Phases => desiredRules(config as SpecSecurityConfig) as Phases

const CF = { zoneId: 'zone-fragments', apiToken: 'unused', apiBase: 'http://127.0.0.1:9/client/v4' }

describe('AC-8: the fragment cache rule', () => {
  it('AC-8: desiredRules({}) puts exactly the Interface’s rule in http_request_cache_settings, and over generated configs the cache phase is that one rule and the WAF phases never hold it', () => {
    expect(rulesOf({})[CACHE]).toEqual([FRAGMENT_RULE])

    fc.assert(
      fc.property(
        rulesPartArb({
          windows: WINDOWS,
          actions: ['block', 'challenge', 'throttle'],
          maxRateLimits: 4,
          maxCustomRules: 4,
          managed: ['cloudflare', 'owasp'],
        }),
        (part) => {
          const phases = rulesOf(securityConfig(CF, part))
          expect(Object.keys(phases).sort()).toEqual([...WAF, CACHE].sort())
          expect(phases[CACHE]).toEqual([FRAGMENT_RULE])
          for (const phase of WAF) {
            expect((phases[phase] ?? []).filter((r) => r.ref === REF)).toEqual([])
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-8: on an empty free zone, plan adds the cache rule and nothing else for an empty config; apply writes the Interface’s rule; a second plan is empty and a second apply writes nothing', async () => {
    const z = zone('free')
    const config = z.config()

    const plan = await z.adapter.plan(config)
    const cache = plan.phases.find((p) => p.phase === CACHE)
    expect(cache?.add.map((r) => r.ref)).toEqual([REF])
    expect(plan.phases.flatMap((p) => p.add).length).toBe(cache?.add.length)

    await z.adapter.apply(config)
    expect((fake.rules(z.zoneId, CACHE) ?? []).map(authored)).toEqual([FRAGMENT_RULE])
    expect(isEmptyPlan(await z.adapter.plan(config))).toBe(true)

    const writes = fake.writes(z.zoneId).length
    await z.adapter.apply(config)
    expect(fake.writes(z.zoneId).length).toBe(writes)
  })

  it('AC-8: after apply, a dashboard edit of the cache rule’s expression is one drift difference at http_request_cache_settings/nymbal:cache:fragments/expression; inspect lists nymbal:cache:fragments', async () => {
    const z = zone('pro')
    const config = z.config()
    await z.adapter.apply(config)
    expect(await z.adapter.drift(config)).toEqual({ drift: false, differences: [] })
    expect((await z.adapter.inspect()).rulesApplied).toContain(REF)

    const edited = 'starts_with(http.request.uri.path, "/")'
    fake.edit(z.zoneId, CACHE, REF, { expression: edited })
    expect(await z.adapter.drift(config)).toEqual({
      drift: true,
      differences: [
        {
          path: `${CACHE}/${REF}/expression`,
          configured: FRAGMENT_RULE.expression,
          actual: edited,
        },
      ],
    })
  })

  it('AC-8: a free zone holding 10 cache rules of its own makes validate report http_request_cache_settings would hold 11 against the free plan’s 10; over plans and owner counts, validate refuses exactly when owner + 1 exceeds the plan’s cache-rule limit', async () => {
    const full = zone('free', { [CACHE]: Array.from({ length: 10 }, (_, i) => ownerCacheRule(i)) })
    const refused = await full.adapter.validate(full.config())
    expect(refused.valid).toBe(false)
    const limit = refused.errors.filter((e) => e.code === 'cloudflare.plan-limit')
    expect(limit.map((e) => e.message)).toEqual([
      expect.stringMatching(/http_request_cache_settings would hold 11 .*the free plan allows 10/),
    ])

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PLANS),
        fc.integer({ min: 0, max: 2 }),
        async (plan, below) => {
          const max = PLAN_LIMITS[plan].cacheRules
          for (const owned of [max - 1 - below, max - below]) {
            const z = zone(plan, {
              [CACHE]: Array.from({ length: owned }, (_, i) => ownerCacheRule(i)),
            })
            const result = await z.adapter.validate(z.config())
            const over = result.errors.some(
              (e) => e.code === 'cloudflare.plan-limit' && e.message.includes(CACHE),
            )
            expect(over, `${plan}: ${owned} owner cache rules + 1`).toBe(owned + 1 > max)
          }
        },
      ),
      { numRuns: 12 },
    )
  })

  it('AC-8: a cache rule of the zone owner’s survives apply, unchanged and first, with Nymbal’s rule after it', async () => {
    const z = zone('pro', { [CACHE]: [ownerCacheRule(1), ownerCacheRule(2)] })
    const before = fake.rules(z.zoneId, CACHE)!

    await z.adapter.apply(z.config())

    const after = fake.rules(z.zoneId, CACHE)!
    expect(after.slice(0, before.length).map(authored)).toEqual(before.map(authored))
    expect(after.slice(0, before.length).map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(after.slice(before.length).filter(isNymbal).map(authored)).toEqual([FRAGMENT_RULE])
    expect(after.length).toBe(before.length + 1)
  })
})
