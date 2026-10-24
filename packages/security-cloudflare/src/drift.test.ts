import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter, desiredRules } from './index.js'
import {
  startFakeCloudflare,
  type CfRule,
  type FakeCloudflare,
  type Phase,
} from './tests/fake-cloudflare.js'
import {
  OWNER_CUSTOM_RULES,
  TOKEN,
  adapterContext,
  isNymbal,
  securityConfig,
  type SpecSecurityConfig,
} from './tests/support.js'

// AC-6: after `apply`, a dashboard edit of a Nymbal rule (`fake.edit`) is one difference at `<phase>/<ref>/<field>`
// carrying the configured and the live value; a deleted Nymbal rule is a difference whose `actual` is undefined; an
// extra `nymbal:` rule is a difference; a rule of the owner's never counts.

let fake: FakeCloudflare

beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
})

interface DriftReport {
  drift: boolean
  differences: Array<{ path: string; configured: unknown; actual: unknown }>
}
interface Adapter {
  apply(config: SpecSecurityConfig): Promise<unknown>
  drift(config: SpecSecurityConfig): Promise<DriftReport>
}

const CUSTOM: Phase = 'http_request_firewall_custom'
const GEO = 'nymbal:geo:block'

async function applied() {
  const zoneId = fake.addZone({
    plan: 'pro',
    token: TOKEN,
    phases: { [CUSTOM]: [...OWNER_CUSTOM_RULES] },
  })
  const cloudflare = { zoneId, apiToken: TOKEN, apiBase: fake.url }
  const adapter = createAdapter(adapterContext(cloudflare)) as Adapter
  const config = securityConfig(cloudflare, {
    rateLimit: { '/api/auth/login': { requests: 10, window: '1m', action: 'block' } },
    customRules: [
      { name: 'no-trace', expression: '(http.request.method eq "TRACE")', action: 'block' },
    ],
    geo: { block: ['RU', 'KP'] },
    managedRulesets: ['cloudflare'],
  })
  await adapter.apply(config)
  expect(await adapter.drift(config)).toEqual({ drift: false, differences: [] })
  return { zoneId, adapter, config }
}

const desiredGeo = (config: SpecSecurityConfig): CfRule =>
  ((desiredRules(config) as Partial<Record<string, CfRule[]>>)[CUSTOM] ?? []).find(
    (r) => r.ref === GEO,
  )!

describe('AC-6: drift', () => {
  it("AC-6 (a): a dashboard edit of the geo rule's expression is drift with one difference at http_request_firewall_custom/nymbal:geo:block/expression, configured and actual the two expressions", async () => {
    const { zoneId, adapter, config } = await applied()
    const edited = '(ip.src.country in {"FR"})'
    fake.edit(zoneId, CUSTOM, GEO, { expression: edited })

    const report = await adapter.drift(config)
    expect(report.drift).toBe(true)
    expect(report.differences).toEqual([
      {
        path: `${CUSTOM}/${GEO}/expression`,
        configured: desiredGeo(config).expression,
        actual: edited,
      },
    ])
  })

  it('AC-6 (a): over every live Nymbal rule, an edited expression is exactly one difference at that rule; editing it back is no drift', async () => {
    const { zoneId, adapter, config } = await applied()
    // The fragment cache rule's phase is among them.
    const phases: Phase[] = [
      'http_ratelimit',
      CUSTOM,
      'http_request_firewall_managed',
      'http_request_cache_settings',
    ]
    const live = phases.flatMap((phase) =>
      (fake.rules(zoneId, phase) ?? []).filter(isNymbal).map((rule) => ({ phase, rule })),
    )
    expect(live.length).toBeGreaterThanOrEqual(4)

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...live), async ({ phase, rule }) => {
        const ref = String(rule.ref)
        fake.edit(zoneId, phase, ref, { expression: '(http.host eq "cf.example")' })
        const report = await adapter.drift(config)
        expect(report.differences.map((d) => d.path)).toEqual([`${phase}/${ref}/expression`])
        expect(report.differences[0]!.actual).not.toEqual(report.differences[0]!.configured)

        fake.edit(zoneId, phase, ref, { expression: rule.expression })
        expect((await adapter.drift(config)).drift).toBe(false)
      }),
      { numRuns: 12 },
    )
  })

  it('AC-6 (b): a Nymbal rule deleted on the dashboard is one difference for that rule, with actual undefined', async () => {
    const { zoneId, adapter, config } = await applied()
    fake.remove(zoneId, CUSTOM, GEO)

    const report = await adapter.drift(config)
    expect(report.drift).toBe(true)
    expect(report.differences).toHaveLength(1)
    expect(report.differences[0]!.path.startsWith(`${CUSTOM}/${GEO}`)).toBe(true)
    expect(report.differences[0]!.actual).toBeUndefined()
    expect(report.differences[0]!.configured).not.toBeUndefined()
  })

  it('AC-6 (b): an extra nymbal: rule on the zone is one difference for that rule', async () => {
    const { zoneId, adapter, config } = await applied()
    fake.add(zoneId, CUSTOM, {
      ref: 'nymbal:custom:cf-stale',
      description: 'nymbal: stale',
      expression: '(http.request.uri.path eq "/stale")',
      action: 'block',
    })

    const report = await adapter.drift(config)
    expect(report.drift).toBe(true)
    expect(
      report.differences.map((d) => d.path.startsWith(`${CUSTOM}/nymbal:custom:cf-stale`)),
    ).toEqual([true])
  })

  it("AC-6 (c): a rule the owner adds is not drift, and neither is an edit to the owner's own rule", async () => {
    const { zoneId, adapter, config } = await applied()
    const own = fake.add(zoneId, CUSTOM, {
      description: 'owner: block a scraper',
      expression: '(http.user_agent contains "scrapy")',
      action: 'block',
    })
    fake.edit(zoneId, CUSTOM, String(own.ref), { action: 'managed_challenge' })
    const ownerFirst = fake.rules(zoneId, CUSTOM)![0]!
    fake.edit(zoneId, CUSTOM, String(ownerFirst.ref), {
      expression: '(http.request.uri.path eq "/x")',
    })

    expect(await adapter.drift(config)).toEqual({ drift: false, differences: [] })
  })
})

// A dashboard reorder that moves a Nymbal rule above one of the owner's is drift at that rule's `position`, and apply
// puts the owner's rules first again with one PUT, after which apply writes nothing. A diff by ref alone would see no
// change in a reorder.
describe('drift and apply see a dashboard reorder', () => {
  it("a Nymbal rule moved above an owner rule is one difference at its position; apply restores the owner's rules first with one PUT, and a second apply writes nothing", async () => {
    const { zoneId, adapter, config } = await applied()
    const before = fake.rules(zoneId, CUSTOM)!
    const owner = before.filter((r) => !isNymbal(r))
    const ours = before.filter(isNymbal)
    expect(owner.length).toBe(OWNER_CUSTOM_RULES.length)
    expect(ours.length).toBeGreaterThanOrEqual(2)
    expect(before.slice(owner.length)).toEqual(ours)

    // The dashboard drag of the first Nymbal rule above the last owner rule: [..., N1, owner last, N2, ...].
    const [first, ...rest] = ours
    const lastOwner = owner[owner.length - 1]!
    for (const rule of [lastOwner, ...rest]) fake.remove(zoneId, CUSTOM, String(rule.ref))
    for (const rule of [lastOwner, ...rest]) fake.add(zoneId, CUSTOM, rule)
    const moved = fake.rules(zoneId, CUSTOM)!
    expect(moved.map((r) => r.ref)).toEqual([
      ...owner.slice(0, -1).map((r) => r.ref),
      first!.ref,
      lastOwner.ref,
      ...rest.map((r) => r.ref),
    ])

    expect(await adapter.drift(config)).toEqual({
      drift: true,
      differences: [
        {
          path: `${CUSTOM}/${String(first!.ref)}/position`,
          configured: owner.length,
          actual: owner.length - 1,
        },
      ],
    })

    const writesBefore = fake.writes(zoneId).length
    await adapter.apply(config)
    const writes = fake.writes(zoneId).slice(writesBefore)
    expect(writes.map((w) => [w.method, w.path.endsWith(`/phases/${CUSTOM}/entrypoint`)])).toEqual([
      ['PUT', true],
    ])
    expect(fake.rules(zoneId, CUSTOM)!.map((r) => r.ref)).toEqual(before.map((r) => r.ref))
    expect(await adapter.drift(config)).toEqual({ drift: false, differences: [] })

    const writesAfter = fake.writes(zoneId).length
    await adapter.apply(config)
    expect(fake.writes(zoneId).length).toBe(writesAfter)
  })
})
