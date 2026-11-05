import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as cloudflare from './index.js'
import { startFakeCloudflare, type CfRule, type FakeCloudflare } from './tests/fake-cloudflare.js'
import {
  ORIGIN_LOCK_REF,
  TOKEN,
  TRANSFORM,
  adapterContext,
  authored,
  maskOf,
  originLockRule,
  originSecretArb,
  securityConfig,
  validPartArb,
  type SpecPlan,
  type SpecSecurityConfig,
} from './tests/support.js'

// The origin lock's edge half. With NYMBAL_ORIGIN_SECRET in the adapter's environment, the zone gets one Transform
// Rule in http_request_late_transform that sets the lock header to the variable's first entry on every request; plan,
// apply, drift and inspect treat it as every other Nymbal rule, after the owner's own transform rules, and nothing the
// adapter returns holds a secret, the zone's own value included. `originLockRule` says whether the zone sends an entry
// of a lock, so doctor and apply's guard can tell a held lock from a lockout.

const HEADER = 'X-Nymbal-Origin'
const VAR = 'NYMBAL_ORIGIN_SECRET'

type Phases = Record<string, CfRule[] | undefined>
interface Difference {
  path: string
  configured: unknown
  actual: unknown
}
type LockRule = { state: 'missing' } | { state: 'present'; header: string; entry: number | null }
interface Adapter {
  plan(config: SpecSecurityConfig): Promise<SpecPlan>
  apply(config: SpecSecurityConfig): Promise<SpecPlan>
  drift(config: SpecSecurityConfig): Promise<{ drift: boolean; differences: Difference[] }>
  inspect(): Promise<{ rulesApplied: string[] }>
  originLockRule(lock: { header: string; secrets: readonly string[] }): Promise<LockRule>
}

const desiredRules = cloudflare.desiredRules as unknown as (
  config: unknown,
  originSecret?: string,
) => Phases
const PHASES = cloudflare.PHASES as readonly string[]

let fake: FakeCloudflare
beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
})

/** An owner's own transform rule: it sets a header of theirs. */
const OWNER_TRANSFORM: CfRule = {
  description: 'owner: tag requests',
  expression: 'true',
  action: 'rewrite',
  action_parameters: { headers: { 'X-Owner-Tag': { operation: 'set', value: 'owner' } } },
}

function zone(phases: Partial<Record<string, CfRule[]>> = {}, env: NodeJS.ProcessEnv = {}) {
  const zoneId = fake.addZone({ plan: 'pro', token: TOKEN, phases })
  const block = { zoneId, apiToken: TOKEN, apiBase: fake.url }
  return {
    zoneId,
    adapter: cloudflare.createAdapter(adapterContext(block, env)) as unknown as Adapter,
    config: securityConfig(block),
  }
}

/** The value the zone's origin-lock rule sends under `header`, or undefined. */
function sent(zoneId: string, header = HEADER): string | undefined {
  const rule = (fake.rules(zoneId, TRANSFORM) ?? []).find((r) => r.ref === ORIGIN_LOCK_REF)
  const headers = rule?.action_parameters?.['headers'] as
    | Record<string, { value?: string }>
    | undefined
  return headers?.[header]?.value
}

/** The value a returned rule shows under `header`. */
function shown(rule: unknown, header = HEADER): unknown {
  const headers = (
    rule as { action_parameters?: { headers?: Record<string, { value?: unknown }> } }
  )?.action_parameters?.headers
  return headers?.[header]?.value
}

/** The lock header's value in a drift side: a whole rule (an added or removed one) or its action_parameters. */
function valueIn(side: unknown): unknown {
  if (side === undefined || side === null) return undefined
  const params = (side as { action_parameters?: unknown }).action_parameters ?? side
  return (params as { headers?: Record<string, { value?: unknown }> }).headers?.[HEADER]?.value
}

const transformOf = (plan: SpecPlan) => plan.phases.find((p) => p.phase === TRANSFORM)

const headerArb = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom('X-Nymbal-Origin', 'X-Edge-Proof', 'X-Shop-Lock'),
  fc.stringMatching(/^X-[A-Za-z][A-Za-z0-9-]{2,20}$/),
)

describe('AC-8: the origin-lock rule on the zone', () => {
  it('AC-8: PHASES ends with http_request_late_transform; over generated configs, headers and secrets, desiredRules(config, S) puts exactly the origin-lock rule in that phase, desiredRules(config) puts none, and every other phase is the same either way', () => {
    expect(PHASES[PHASES.length - 1]).toBe(TRANSFORM)
    fc.assert(
      fc.property(
        validPartArb('business', { rateLimits: 0, customRules: 0 }),
        headerArb,
        originSecretArb,
        (part, header, secret) => {
          const config = {
            ...securityConfig({}, part),
            ...(header !== undefined && { originLock: { header } }),
          }
          const locked = desiredRules(config, secret)
          const open = desiredRules(config)

          expect(locked[TRANSFORM]).toEqual([originLockRule(header ?? HEADER, secret)])
          expect(open[TRANSFORM] ?? []).toEqual([])
          for (const phase of PHASES.filter((p) => p !== TRANSFORM)) {
            expect(locked[phase], phase).toEqual(open[phase])
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it("AC-8: applied with NYMBAL_ORIGIN_SECRET S to a zone holding two transform rules of the owner's, the phase holds them first and then the rule sending S; a second apply makes zero writes; inspect lists nymbal:origin-lock", async () => {
    const secret = 'S'.repeat(8) + 'origin-lock-apply-Qm4Xv8Lp2Rt6Zw0'
    const owner = [OWNER_TRANSFORM, { ...OWNER_TRANSFORM, description: 'owner: second' }]
    const z = zone({ [TRANSFORM]: owner }, { [VAR]: secret })
    const before = fake.rules(z.zoneId, TRANSFORM)!.map(authored)

    await z.adapter.apply(z.config)
    const after = fake.rules(z.zoneId, TRANSFORM)!
    const writes = fake.writes(z.zoneId).length
    const again = await z.adapter.apply(z.config)

    expect(after.slice(0, before.length).map(authored)).toEqual(before)
    expect(after.slice(before.length).map(authored)).toEqual([originLockRule(HEADER, secret)])
    expect(fake.writes(z.zoneId).length).toBe(writes)
    expect(again.phases.every((p) => p.add.length + p.change.length + p.remove.length === 0)).toBe(
      true,
    )
    expect((await z.adapter.inspect()).rulesApplied).toContain(ORIGIN_LOCK_REF)
  })

  it('AC-8: after apply, a dashboard delete of the rule gives exactly one drift difference, at http_request_late_transform/nymbal:origin-lock; a dashboard edit of its value gives exactly one, at http_request_late_transform/nymbal:origin-lock/action_parameters', async () => {
    const secret = 'drift-origin-secret-Hq7Zt2Lw9Kd8Mx3Pb5'
    const deleted = zone({}, { [VAR]: secret })
    const edited = zone({}, { [VAR]: secret })
    await deleted.adapter.apply(deleted.config)
    await edited.adapter.apply(edited.config)
    expect([sent(deleted.zoneId), sent(edited.zoneId)]).toEqual([secret, secret])

    fake.remove(deleted.zoneId, TRANSFORM, ORIGIN_LOCK_REF)
    fake.edit(edited.zoneId, TRANSFORM, ORIGIN_LOCK_REF, {
      action_parameters: {
        headers: { [HEADER]: { operation: 'set', value: 'edited-in-the-dashboard-Vr4Ns8Gk1Jc' } },
      },
    })
    const paths = async (z: ReturnType<typeof zone>) =>
      (await z.adapter.drift(z.config)).differences.map((d) => d.path)

    expect(await paths(deleted)).toEqual([`${TRANSFORM}/${ORIGIN_LOCK_REF}`])
    expect(await paths(edited)).toEqual([`${TRANSFORM}/${ORIGIN_LOCK_REF}/action_parameters`])
  })

  it('AC-8: with NYMBAL_ORIGIN_SECRET "N,S" over a zone whose rule sends S, apply writes N, the first entry', async () => {
    const [next, current] = [
      'next-origin-secret-Wm4Ps7Nx2Lb9Rc5Ty',
      'current-origin-secret-Ka6Jd0Fg3Hs',
    ]
    const holding = zone({}, { [VAR]: current })
    await holding.adapter.apply(holding.config)
    const rotating = cloudflare.createAdapter(
      adapterContext(
        { zoneId: holding.zoneId, apiToken: TOKEN, apiBase: fake.url },
        { [VAR]: `${next},${current}` },
      ),
    ) as unknown as Adapter
    const before = sent(holding.zoneId)

    await rotating.apply(holding.config)

    expect([before, sent(holding.zoneId)]).toEqual([current, next])
  })

  it('AC-8: property: over generated secrets S and zone values V (none, equal to S, or another), the JSON of plan, apply and drift holds neither S nor V and shows each as [secret <first 8 hex of its SHA-256>], equal for equal values; apply leaves the zone sending S', async () => {
    await fc.assert(
      fc.asyncProperty(
        originSecretArb,
        fc.oneof(
          fc.constant({ kind: 'none' as const }),
          fc.constant({ kind: 'same' as const }),
          originSecretArb.map((value) => ({ kind: 'other' as const, value })),
        ),
        async (secret, zoneValue) => {
          const value =
            zoneValue.kind === 'none'
              ? undefined
              : zoneValue.kind === 'same'
                ? secret
                : zoneValue.value
          const z = zone(
            value === undefined ? {} : { [TRANSFORM]: [originLockRule(HEADER, value)] },
            { [VAR]: secret },
          )

          const plan = await z.adapter.plan(z.config)
          const drift = await z.adapter.drift(z.config)
          const applied = await z.adapter.apply(z.config)
          const texts = [plan, drift, applied].map((r) => JSON.stringify(r))
          const leaks = texts.filter(
            (text) => text.includes(secret) || (value !== undefined && text.includes(value)),
          )

          expect(leaks).toEqual([])
          expect(sent(z.zoneId)).toBe(secret)
          const wanted =
            value === undefined
              ? { add: [maskOf(secret)], change: [] }
              : value === secret
                ? { add: [], change: [] }
                : { add: [], change: [[maskOf(value), maskOf(secret)]] }
          for (const result of [plan, applied]) {
            const transform = transformOf(result)
            expect({
              add: (transform?.add ?? []).map((r) => shown(r)),
              change: (transform?.change ?? []).map((c) => [shown(c.from), shown(c.to)]),
            }).toEqual(wanted)
          }
          const lockDifferences = drift.differences.filter((d) => d.path.startsWith(TRANSFORM))
          expect(lockDifferences.map((d) => [valueIn(d.actual), valueIn(d.configured)])).toEqual(
            value === secret
              ? []
              : [[value === undefined ? undefined : maskOf(value), maskOf(secret)]],
          )
        },
      ),
      // Each run makes about fifteen round trips to the fake.
      { numRuns: 15 },
    )
  }, 30_000)
})

describe('AC-9: originLockRule tells a held lock from a lockout', () => {
  it('AC-9: no transform phase, a phase without the rule, and the rule disabled are each missing', async () => {
    const lock = { header: HEADER, secrets: ['held-origin-secret-Tz8Qw3Ln6Vb1Xc4Md'] }
    const noPhase = zone()
    const noRule = zone({ [TRANSFORM]: [OWNER_TRANSFORM] })
    const disabled = zone({
      [TRANSFORM]: [{ ...originLockRule(HEADER, lock.secrets[0]!), enabled: false }],
    })
    const held = zone({ [TRANSFORM]: [originLockRule(HEADER, lock.secrets[0]!)] })

    const answers = await Promise.all(
      [noPhase, noRule, disabled, held].map((z) => z.adapter.originLockRule(lock)),
    )

    expect(answers).toEqual([
      { state: 'missing' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'present', header: HEADER, entry: 0 },
    ])
  })

  it('AC-9: property: over secret lists and what the zone sends (entry i of the list, another value, or an entry under another header), the answer is present with entry i, with entry null, or with the header as the zone has it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(originSecretArb, { minLength: 1, maxLength: 3 }),
        fc.nat(),
        fc.constantFrom('entry', 'other', 'header'),
        originSecretArb,
        fc
          .stringMatching(/^X-[A-Za-z][A-Za-z0-9]{2,12}$/)
          .filter((h) => h.toLowerCase() !== HEADER.toLowerCase()),
        async (secrets, pick, kind, other, otherHeader) => {
          const i = pick % secrets.length
          const value = kind === 'other' && !secrets.includes(other) ? other : secrets[i]!
          const header = kind === 'header' ? otherHeader : HEADER
          const z = zone({ [TRANSFORM]: [OWNER_TRANSFORM, originLockRule(header, value)] })

          const answer = await z.adapter.originLockRule({ header: HEADER, secrets })

          const observed =
            kind === 'header' ? (answer.state === 'present' ? answer.header : answer.state) : answer
          expect(observed).toEqual(
            kind === 'header'
              ? header
              : {
                  state: 'present',
                  header: HEADER,
                  entry: secrets.indexOf(value) < 0 ? null : secrets.indexOf(value),
                },
          )
        },
      ),
      { numRuns: 25 },
    )
  })
})
