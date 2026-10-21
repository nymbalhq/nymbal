import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from './schema.js'
import {
  BASE_CONFIG,
  middlewareSecurityArb,
  type Recording,
} from './fixtures/middleware-security.js'

// Acceptance tests for P2-04 AC-1 (spec P2-04-cloudflare-waf, Decision 4): the `security` block gains `cloudflare`
// (zoneId and apiToken required when the adapter is `cloudflare`), `geo.block` (ISO 3166 alpha-2), `customRules`
// (names unique) and `managedRulesets`, and a `middleware` store parses as it did at d872ee8: on every key the d872ee8
// schema produced, the parse equals the recording made from that schema, and the new keys are absent or at their
// defaults. Kills: no schema fields, and a `middleware` store whose existing keys change.

const recording = JSON.parse(
  readFileSync(new URL('./fixtures/middleware-security-d872ee8.json', import.meta.url), 'utf8'),
) as Recording

const parse = (security: unknown) =>
  nymbalConfigSchema.safeParse({ ...structuredClone(BASE_CONFIG), security })

/** `actual` cut down to the keys `shape` has, at every depth: what the d872ee8 parse produced. */
function onKeysOf(actual: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) {
    return Array.isArray(actual) ? shape.map((s, i) => onKeysOf(actual[i], s)) : actual
  }
  if (typeof shape === 'object' && shape !== null) {
    if (typeof actual !== 'object' || actual === null) return actual
    return Object.fromEntries(
      Object.entries(shape).map(([k, s]) => [
        k,
        onKeysOf((actual as Record<string, unknown>)[k], s),
      ]),
    )
  }
  return actual
}

const CLOUDFLARE = { zoneId: 'zone-p2-04', apiToken: 'token-p2-04' }

function cloudflareSecurity(over: Record<string, unknown> = {}) {
  return { adapter: 'cloudflare', cloudflare: { ...CLOUDFLARE }, ...over }
}

function issueNames(result: ReturnType<typeof parse>, field: string): boolean {
  return (
    !result.success &&
    result.error.issues.some((i) => i.path.includes(field) || i.message.includes(field))
  )
}

describe('P2-04 AC-1: the security block for Cloudflare', () => {
  it('AC-1 (a): adapter cloudflare without cloudflare.zoneId or apiToken fails, naming the missing field; with both it parses and keeps them', () => {
    const outcomes = (['zoneId', 'apiToken'] as const).map((missing) => {
      const cloudflare: Record<string, string> = { ...CLOUDFLARE }
      delete cloudflare[missing]
      const result = parse(cloudflareSecurity({ cloudflare }))
      return [missing, result.success, issueNames(result, missing)]
    })
    expect(outcomes).toEqual([
      ['zoneId', false, true],
      ['apiToken', false, true],
    ])
    expect(parse({ adapter: 'cloudflare' }).success).toBe(false)

    const both = parse(cloudflareSecurity())
    expect(both.success).toBe(true)
    expect((both.data?.security as { cloudflare?: unknown } | undefined)?.cloudflare).toEqual(
      expect.objectContaining(CLOUDFLARE),
    )
  })

  it('AC-1 (b): a geo.block code that is not two capital letters fails; two-letter capital codes parse and are kept', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4 }).filter((s) => !/^[A-Z]{2}$/.test(s)),
        fc.uniqueArray(fc.stringMatching(/^[A-Z]{2}$/), { maxLength: 4 }),
        (bad, good) => {
          expect(parse(cloudflareSecurity({ geo: { block: [...good, bad] } })).success).toBe(false)
          const ok = parse(cloudflareSecurity({ geo: { block: good } }))
          expect(ok.success).toBe(true)
          expect((ok.data?.security as { geo?: { block: string[] } }).geo?.block).toEqual(good)
        },
      ),
    )
  })

  it('AC-1 (c): two customRules with one name fail; distinct names parse and are kept in order', () => {
    const rule = (name: string) => ({
      name,
      expression: '(http.request.method eq "TRACE")',
      action: 'block',
    })
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), { minLength: 1, maxLength: 5 }),
        fc.nat(),
        (names, pick) => {
          const dup = names[pick % names.length]!
          const duplicated = parse(cloudflareSecurity({ customRules: [...names, dup].map(rule) }))
          expect(duplicated.success).toBe(false)

          const distinct = parse(cloudflareSecurity({ customRules: names.map(rule) }))
          expect(distinct.success).toBe(true)
          expect(
            (distinct.data?.security as { customRules?: Array<{ name: string }> }).customRules?.map(
              (r) => r.name,
            ),
          ).toEqual(names)
        },
      ),
    )
  })

  it('AC-1 (d): every recorded middleware config parses, on the keys the d872ee8 parse produced, to what d872ee8 parsed it to; cloudflare is absent, and geo, customRules and managedRulesets are at their defaults', () => {
    expect(recording.recordedAt).toBe('d872ee8')
    expect(recording.cases.length).toBe(recording.runs)
    for (const { input, output } of recording.cases) {
      const result = parse(structuredClone(input))
      expect(result.success).toBe(true)
      const security = result.data!.security as Record<string, unknown>
      expect(onKeysOf(security, output)).toEqual(output)
      expect(security).not.toHaveProperty('cloudflare')
      expect([security['geo'], security['customRules'], security['managedRulesets']]).toEqual([
        { block: [] },
        [],
        [],
      ])
    }
  })

  it('AC-1 (d): over freshly generated middleware configs, cloudflare is absent and the new keys are at their defaults, and parsing is a fixed point', () => {
    fc.assert(
      fc.property(middlewareSecurityArb, (input) => {
        const result = parse(input)
        expect(result.success).toBe(true)
        const security = result.data!.security as Record<string, unknown>
        expect(security).not.toHaveProperty('cloudflare')
        expect(security['geo']).toEqual({ block: [] })
        expect(security['customRules']).toEqual([])
        expect(security['managedRulesets']).toEqual([])
        expect(parse(structuredClone(security)).data?.security).toEqual(security)
      }),
      { numRuns: 200 },
    )
  })
})
