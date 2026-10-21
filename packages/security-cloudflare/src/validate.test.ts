import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter } from './index.js'
import {
  PLANS,
  startFakeCloudflare,
  type FakeCloudflare,
  type Phase,
  type Plan,
} from './tests/fake-cloudflare.js'
import {
  OWNER_RATE_LIMIT,
  TOKEN,
  WINDOWS,
  adapterContext,
  codes,
  rulesPartArb,
  securityConfig,
  type SpecSecurityConfig,
} from './tests/support.js'

// Acceptance tests for P2-04 AC-4 (spec P2-04-cloudflare-waf, Interface `validate` error codes, Context plan table):
// `validate` reads the zone's plan and live rules from the API (the fake) and refuses at plan time what Cloudflare
// would refuse at apply time, counting every rule in a phase, the owner's included. Property: whatever `validate`
// accepts on a plan, the fake (which enforces the plan table on every write) accepts from `apply`. Kills: a `validate`
// that always passes (as `middleware`'s does), one that counts only Nymbal's rules, and a plan whose limits it ignores,
// each of which leaves `apply` to fail at Cloudflare.

let fake: FakeCloudflare

beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
})

interface Adapter {
  validate(
    config: SpecSecurityConfig,
  ): Promise<{ valid: boolean; errors: Array<{ code: string; message: string }> }>
  apply(config: SpecSecurityConfig): Promise<unknown>
}

function zone(plan: Plan, phases: Partial<Record<Phase, (typeof OWNER_RATE_LIMIT)[]>> = {}) {
  const zoneId = fake.addZone({ plan, token: TOKEN, phases })
  const cloudflare = { zoneId, apiToken: TOKEN, apiBase: fake.url }
  const adapter = createAdapter(adapterContext(cloudflare)) as Adapter
  return {
    zoneId,
    adapter,
    config: (over: Parameters<typeof securityConfig>[1] = {}) => securityConfig(cloudflare, over),
  }
}

const limit = (window: string, action: 'block' | 'challenge' | 'throttle' = 'block') => ({
  requests: 50,
  window,
  action,
})

const TWO_LIMITS = { '/api/auth/login': limit('10s'), '/api/auth/register': limit('10s') }

describe('P2-04 AC-4: validate against the plan', () => {
  it('AC-4 (a): on free, two rate limits give cloudflare.plan-limit naming the count 2, the limit 1 and the plan; on pro they are valid', async () => {
    const free = zone('free')
    const result = await free.adapter.validate(free.config({ rateLimit: TWO_LIMITS }))
    expect(result.valid).toBe(false)
    const planLimit = result.errors.filter((e) => e.code === 'cloudflare.plan-limit')
    expect(planLimit).toHaveLength(1)
    expect(planLimit[0]!.message).toMatch(/\b2\b/)
    expect(planLimit[0]!.message).toMatch(/\b1\b/)
    expect(planLimit[0]!.message).toMatch(/\bfree\b/)

    const pro = zone('pro')
    expect(await pro.adapter.validate(pro.config({ rateLimit: TWO_LIMITS }))).toEqual({
      valid: true,
      errors: [],
    })
  })

  it('AC-4 (b): on free, one rate limit on a zone whose owner already has one gives cloudflare.plan-limit; the same config on an empty free zone is valid', async () => {
    const owned = zone('free', { http_ratelimit: [OWNER_RATE_LIMIT] })
    const one = { rateLimit: { '/api/auth/login': limit('10s') } }
    const result = await owned.adapter.validate(owned.config(one))
    expect(codes(result)).toContain('cloudflare.plan-limit')

    const empty = zone('free')
    expect((await empty.adapter.validate(empty.config(one))).valid).toBe(true)
  })

  it('AC-4 (c): a 1m window gives cloudflare.period on free and is valid on pro; 5m gives cloudflare.period on pro and is valid on business; 1h is valid on enterprise', async () => {
    const cases: Array<[Plan, string, boolean]> = [
      ['free', '1m', false],
      ['pro', '1m', true],
      ['pro', '5m', false],
      ['business', '5m', true],
      ['enterprise', '1h', true],
    ]
    const outcomes = await Promise.all(
      cases.map(async ([plan, window]) => {
        const z = zone(plan)
        const result = await z.adapter.validate(
          z.config({ rateLimit: { '/api/auth/login': limit(window) } }),
        )
        return [plan, window, result.valid, codes(result).includes('cloudflare.period')] as const
      }),
    )
    expect(outcomes).toEqual(
      cases.map(([plan, window, valid]) => [plan, window, valid, !valid] as const),
    )
  })

  it('AC-4 (d): throttle gives cloudflare.action on free, and is valid on enterprise', async () => {
    const config = { rateLimit: { '/api/auth/login': limit('10s', 'throttle') } }
    const free = zone('free')
    expect(codes(await free.adapter.validate(free.config(config)))).toContain('cloudflare.action')
    const enterprise = zone('enterprise')
    expect((await enterprise.adapter.validate(enterprise.config(config))).valid).toBe(true)
  })

  it("AC-4 (e): managedRulesets ['owasp'] gives cloudflare.plan-limit on free, and is valid on pro", async () => {
    const free = zone('free')
    expect(
      codes(await free.adapter.validate(free.config({ managedRulesets: ['owasp'] }))),
    ).toContain('cloudflare.plan-limit')
    const pro = zone('pro')
    expect((await pro.adapter.validate(pro.config({ managedRulesets: ['owasp'] }))).valid).toBe(
      true,
    )
  })

  it("AC-4 (f): on free, {'/api/*': 50 per 10s, challenge} is valid, and the fake accepts apply's write of it", async () => {
    const free = zone('free')
    const config = free.config({ rateLimit: { '/api/*': limit('10s', 'challenge') } })
    expect(await free.adapter.validate(config)).toEqual({ valid: true, errors: [] })

    await free.adapter.apply(config)
    const writes = fake.writes(free.zoneId)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.filter((w) => w.status !== 200)).toEqual([])
    expect(fake.rules(free.zoneId, 'http_ratelimit')).toHaveLength(1)
  })

  it('AC-4: a 401 from the API gives cloudflare.credentials, and so does a missing zone or token, without a rejection', async () => {
    const zoneId = fake.addZone({ plan: 'pro', token: TOKEN })
    const results = await Promise.all(
      [
        { zoneId, apiToken: 'cf-p2-04-wrong-token', apiBase: fake.url },
        { apiToken: TOKEN, apiBase: fake.url },
        { zoneId, apiBase: fake.url },
      ].map((cloudflare) =>
        (createAdapter(adapterContext(cloudflare)) as Adapter).validate(
          securityConfig(cloudflare, { rateLimit: { '/api/auth/login': limit('10s') } }),
        ),
      ),
    )
    expect(results.map((r) => [r.valid, codes(r).includes('cloudflare.credentials')])).toEqual(
      results.map(() => [false, true]),
    )
  })

  it('AC-4: over generated configs, plans and an owner rate limit or none, whatever validate accepts the fake accepts from apply', async () => {
    let accepted = 0
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PLANS),
        fc.boolean(),
        rulesPartArb({
          windows: WINDOWS,
          actions: ['block', 'challenge', 'throttle'],
          maxRateLimits: 3,
          maxCustomRules: 4,
          managed: ['cloudflare', 'owasp'],
        }),
        async (plan, ownerHasOne, part) => {
          const z = zone(plan, ownerHasOne ? { http_ratelimit: [OWNER_RATE_LIMIT] } : {})
          const config = z.config(part)
          const result = await z.adapter.validate(config)
          if (!result.valid) return
          accepted += 1
          await z.adapter.apply(config)
          expect(fake.writes(z.zoneId).filter((w) => w.status !== 200)).toEqual([])
        },
      ),
      { numRuns: 60 },
    )
    // A property over nothing proves nothing: some generated configs were valid and applied.
    expect(accepted).toBeGreaterThan(5)
  })
})
