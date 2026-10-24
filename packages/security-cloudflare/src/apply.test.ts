import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter, desiredRules } from './index.js'
import {
  startFakeCloudflare,
  type CfRule,
  type FakeCloudflare,
  type Phase,
  type Plan,
} from './tests/fake-cloudflare.js'
import {
  OWNER_CUSTOM_RULES,
  TOKEN,
  adapterContext,
  allRules,
  authored,
  isEmptyPlan,
  isNymbal,
  refsOf,
  securityConfig,
  validPartArb,
  type SpecPlan,
  type SpecSecurityConfig,
} from './tests/support.js'

// AC-5: on a zone whose custom phase starts with two rules of the owner's, `apply` keeps them unchanged and first and
// puts Nymbal's rules after them; it is idempotent (after any apply, `plan` is empty and a second `apply` writes
// nothing, also after moving from one config to another); `inspect` lists exactly the refs `desiredRules` gives;
// removing one rate limit removes exactly that rule; and a phase never written (404) is an empty phase.

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
  inspect(): Promise<{ rulesApplied: string[]; lastValidatedAt: string }>
  validate(config: SpecSecurityConfig): Promise<{ valid: boolean; errors: Array<{ code: string }> }>
}

const OWNER = { rateLimits: 0, customRules: OWNER_CUSTOM_RULES.length }
const PLAN: Plan = 'pro'

function ownerZone(
  phases: Partial<Record<Phase, CfRule[]>> = {
    http_request_firewall_custom: [...OWNER_CUSTOM_RULES],
  },
) {
  const zoneId = fake.addZone({ plan: PLAN, token: TOKEN, phases })
  const cloudflare = { zoneId, apiToken: TOKEN, apiBase: fake.url }
  return {
    zoneId,
    adapter: createAdapter(adapterContext(cloudflare)) as Adapter,
    config: (over: Parameters<typeof securityConfig>[1] = {}) => securityConfig(cloudflare, over),
  }
}

type Phases = Partial<Record<string, CfRule[]>>
const desired = (config: SpecSecurityConfig): Phases => desiredRules(config) as Phases

/** Every live `nymbal:` ref in the zone, over every phase. */
function liveNymbalRefs(zoneId: string): string[] {
  const phases: Phase[] = [
    'http_ratelimit',
    'http_request_firewall_custom',
    'http_request_firewall_managed',
    // The fragment cache rule's phase.
    'http_request_cache_settings',
  ]
  return refsOf(phases.flatMap((p) => (fake.rules(zoneId, p) ?? []).filter(isNymbal)))
}

const FULL = {
  rateLimit: {
    '/api/auth/login': { requests: 10, window: '1m', action: 'block' as const },
    '/api/*': { requests: 300, window: '10s', action: 'challenge' as const },
  },
  customRules: [
    {
      name: 'no-trace',
      expression: '(http.request.method eq "TRACE")',
      action: 'block' as const,
    },
  ],
  geo: { block: ['RU', 'KP'] },
  managedRulesets: ['cloudflare' as const],
}

describe('AC-5: apply, plan and inspect', () => {
  it("AC-5 (a): after apply, the owner's two custom rules are unchanged and first, and the Nymbal rules follow them", async () => {
    const z = ownerZone()
    const before = fake.rules(z.zoneId, 'http_request_firewall_custom')!
    const config = z.config(FULL)

    await z.adapter.apply(config)

    const after = fake.rules(z.zoneId, 'http_request_firewall_custom')!
    expect(after.slice(0, before.length).map(authored)).toEqual(before.map(authored))
    const following = after.slice(before.length)
    expect(following.every(isNymbal)).toBe(true)
    expect(refsOf(following)).toEqual(refsOf(desired(config)['http_request_firewall_custom'] ?? []))
  })

  it('AC-5 (b): over generated pairs of valid configs on a pro zone with two owner rules, after applying one then the other, plan is empty, a second apply makes zero writes, and the owner rules are unchanged and first', async () => {
    await fc.assert(
      fc.asyncProperty(
        validPartArb(PLAN, OWNER),
        validPartArb(PLAN, OWNER),
        async (first, second) => {
          const z = ownerZone()
          const owner = fake.rules(z.zoneId, 'http_request_firewall_custom')!.map(authored)
          const a = z.config(first)
          const b = z.config(second)
          expect((await z.adapter.validate(a)).valid).toBe(true)
          expect((await z.adapter.validate(b)).valid).toBe(true)

          await z.adapter.apply(a)
          await z.adapter.apply(b)
          expect(isEmptyPlan(await z.adapter.plan(b))).toBe(true)

          const writesBefore = fake.writes(z.zoneId).length
          const again = await z.adapter.apply(b)
          expect(fake.writes(z.zoneId).length).toBe(writesBefore)
          expect(isEmptyPlan(again)).toBe(true)

          const custom = fake.rules(z.zoneId, 'http_request_firewall_custom')!
          expect(custom.slice(0, owner.length).map(authored)).toEqual(owner)
          expect(liveNymbalRefs(z.zoneId)).toEqual(refsOf(allRules(desired(b))))
        },
      ),
      { numRuns: 25 },
    )
  })

  it('AC-5 (c): inspect().rulesApplied equals the refs desiredRules gives', async () => {
    const z = ownerZone()
    const config = z.config(FULL)
    await z.adapter.apply(config)

    const { rulesApplied } = await z.adapter.inspect()
    expect([...rulesApplied].sort()).toEqual(refsOf(allRules(desired(config))))
  })

  it('AC-5 (d): removing one rateLimit entry and applying again removes exactly that rule and writes only the rate limiting phase', async () => {
    const z = ownerZone()
    const full = z.config(FULL)
    await z.adapter.apply(full)
    const before = fake.rules(z.zoneId, 'http_ratelimit')!

    const { ['/api/*']: _dropped, ...kept } = FULL.rateLimit
    const less = z.config({ ...FULL, rateLimit: kept })
    const gone = refsOf(desired(full)['http_ratelimit'] ?? []).filter(
      (ref) => !refsOf(desired(less)['http_ratelimit'] ?? []).includes(ref),
    )
    expect(gone).toHaveLength(1)

    const writesBefore = fake.writes(z.zoneId).length
    await z.adapter.apply(less)
    const after = fake.rules(z.zoneId, 'http_ratelimit')!

    expect(refsOf(after)).toEqual(refsOf(before).filter((ref) => ref !== gone[0]))
    expect(after.map(authored)).toEqual(before.filter((r) => r.ref !== gone[0]).map(authored))
    const newWrites = fake.writes(z.zoneId).slice(writesBefore)
    expect(newWrites.length).toBeGreaterThan(0)
    expect(
      newWrites.filter((w) => !w.path.includes('http_ratelimit') && w.method === 'PUT'),
    ).toEqual([])
  })

  it('AC-5 (e): on a zone whose http_ratelimit phase was never written (404), inspect lists no rate limit ref without an error, plan adds every rate limit, and apply creates the phase', async () => {
    const z = ownerZone()
    const config = z.config(FULL)
    const wanted = refsOf(desired(config)['http_ratelimit'] ?? [])
    expect(wanted).toHaveLength(Object.keys(FULL.rateLimit).length)
    expect(fake.rules(z.zoneId, 'http_ratelimit')).toBeUndefined()

    const inspected = await z.adapter.inspect()
    expect(inspected.rulesApplied.filter((ref) => wanted.includes(ref))).toEqual([])

    const plan = await z.adapter.plan(config)
    const rate = plan.phases.find((p) => p.phase === 'http_ratelimit')
    expect(refsOf(rate?.add ?? [])).toEqual(wanted)
    const notFound = fake.requests.filter(
      (r) =>
        r.path === `/zones/${z.zoneId}/rulesets/phases/http_ratelimit/entrypoint` &&
        r.status === 404,
    )
    expect(notFound.length).toBeGreaterThan(0)

    await z.adapter.apply(config)
    expect(refsOf(fake.rules(z.zoneId, 'http_ratelimit') ?? [])).toEqual(wanted)
  })
})
