import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BASE_CONFIG } from './fixtures/middleware-security.js'
import { nymbalConfigSchema } from './schema.js'

// A store's access token lives between one minute and one hour, and its refresh token outlives it: an access token is
// what a signed-out or re-passworded session keeps until it expires, and a refresh token that dies first would end
// every session at each access token's expiry. The bounds are on the duration, whatever unit it is written in, and a
// refusal names the field. The defaults stay 15m and 7d.

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
type Unit = keyof typeof UNIT_MS
const MIN_ACCESS_MS = 60_000
const MAX_ACCESS_MS = 3_600_000
const ACCESS = 'security.auth.accessTtl'
const REFRESH = 'security.auth.refreshTtl'

interface Duration {
  text: string
  ms: number
}

const durationOf = (text: string): Duration => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (match === null) throw new Error(`not a duration: ${text}`)
  return { text, ms: Number(match[1]) * UNIT_MS[match[2] as Unit] }
}

/** The largest count drawn for each unit: every unit spans both access bounds, and a refresh TTL's usual range. */
const MAX_COUNT: Record<Unit, number> = { ms: 7_200_000, s: 7_200, m: 180, h: 72, d: 60 }

const anyDuration: fc.Arbitrary<Duration> = fc.oneof(
  fc
    .constantFrom(...(Object.keys(UNIT_MS) as Unit[]))
    .chain((unit) =>
      fc.integer({ min: 0, max: MAX_COUNT[unit] }).map((n) => durationOf(`${n}${unit}`)),
    ),
  // The bounds as each unit writes them, and a step either side.
  fc
    .constantFrom(
      '59999ms',
      '60000ms',
      '59s',
      '60s',
      '1m',
      '3600000ms',
      '3600001ms',
      '3600s',
      '3601s',
      '60m',
      '61m',
      '1h',
      '2h',
      '1d',
    )
    .map(durationOf),
)

const accessInBounds = anyDuration.filter((d) => d.ms >= MIN_ACCESS_MS && d.ms <= MAX_ACCESS_MS)

const parse = (auth?: Record<string, unknown>) =>
  nymbalConfigSchema.safeParse({
    ...structuredClone(BASE_CONFIG),
    security: { adapter: 'middleware', ...(auth !== undefined && { auth }) },
  })

/** Whether a failed parse names `field`, by its issue's path or in its message. */
function names(result: ReturnType<typeof parse>, field: string): boolean {
  return (
    !result.success &&
    result.error.issues.some((i) => i.path.join('.') === field || i.message.includes(field))
  )
}

describe('AC-5: accessTtl is bounded and refreshTtl outlives it', () => {
  it('AC-5: property: accessTtl is accepted exactly when 1 minute <= its duration <= 1 hour, whatever the unit, and a refusal names security.auth.accessTtl; the defaults parse to 15m and 7d', () => {
    const defaults = parse()
    expect(defaults.success && defaults.data.security.auth).toMatchObject({
      accessTtl: '15m',
      refreshTtl: '7d',
    })
    fc.assert(
      fc.property(anyDuration, (access) => {
        const result = parse({ accessTtl: access.text, refreshTtl: '60d' })
        const inBounds = access.ms >= MIN_ACCESS_MS && access.ms <= MAX_ACCESS_MS

        expect(result.success, access.text).toBe(inBounds)
        expect(names(result, ACCESS), access.text).toBe(!inBounds)
      }),
      {
        numRuns: 400,
        examples: ['60s', '1m', '3600000ms', '1h', '59s', '61m', '2h'].map((text): [Duration] => [
          durationOf(text),
        ]),
      },
    )
  })

  it('AC-5: property: with accessTtl in bounds, refreshTtl is accepted exactly when its duration exceeds accessTtl’s, an equal one refused, and a refusal names security.auth.refreshTtl', () => {
    fc.assert(
      fc.property(accessInBounds, anyDuration, (access, refresh) => {
        const result = parse({ accessTtl: access.text, refreshTtl: refresh.text })
        const outlives = refresh.ms > access.ms

        expect(result.success, `${access.text} / ${refresh.text}`).toBe(outlives)
        expect(names(result, REFRESH), `${access.text} / ${refresh.text}`).toBe(!outlives)
      }),
      {
        numRuns: 400,
        examples: [
          [durationOf('15m'), durationOf('900s')],
          [durationOf('1h'), durationOf('60m')],
          [durationOf('1m'), durationOf('61s')],
          [durationOf('1h'), durationOf('59m')],
        ],
      },
    )
  })
})
