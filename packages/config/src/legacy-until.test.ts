import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BASE_CONFIG } from './fixtures/middleware-security.js'
import { nymbalConfigSchema } from './schema.js'

// `security.auth.legacy` sets when imported WordPress password hashes stop being honoured: a calendar date at most 366
// days after the config is loaded (a past date is the sunset having passed), and the costliest WordPress bcrypt the
// store accepts, 10 unless the merchant opts into 11 or 12. The clock is faked; the bound is measured from it.

const UNTIL = 'security.auth.legacy.until'
const MAX_COST = 'security.auth.legacy.maxCost'
const DAY_MS = 24 * 60 * 60_000
const LOADED = Date.parse('2026-11-19T00:00:00.000Z')

const parse = (legacy?: Record<string, unknown>) =>
  nymbalConfigSchema.safeParse({
    ...structuredClone(BASE_CONFIG),
    security: { adapter: 'middleware', ...(legacy !== undefined && { auth: { legacy } }) },
  })

/** Whether a failed parse names `field`, by its issue's path or in its message. */
function names(result: ReturnType<typeof parse>, field: string): boolean {
  return (
    !result.success &&
    result.error.issues.some((i) => i.path.join('.') === field || i.message.includes(field))
  )
}

const messages = (result: ReturnType<typeof parse>): string =>
  result.success ? '' : result.error.issues.map((i) => i.message).join(' | ')

/** The calendar date `days` after the day `at` falls on, in UTC. */
const dateAfter = (at: number, days: number): string =>
  new Date(
    Date.UTC(
      new Date(at).getUTCFullYear(),
      new Date(at).getUTCMonth(),
      new Date(at).getUTCDate() + days,
    ),
  )
    .toISOString()
    .slice(0, 10)

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-14: security.auth.legacy.until is a date at most 366 days after the load', () => {
  it('AC-14: property: at any time of the loading day, a date 0 to 366 days ahead or any day in the past is accepted as written, and 367 days or more is refused naming the key and the 366-day bound', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DAY_MS - 1 }),
        fc.oneof(
          fc.integer({ min: -3_000, max: 366 }),
          fc.integer({ min: 367, max: 2_000 }),
          fc.constantFrom(366, 367),
        ),
        (timeOfDay, days) => {
          const now = LOADED + timeOfDay
          vi.setSystemTime(now)
          const until = dateAfter(now, days)
          const result = parse({ until })
          const label = `${until}, loaded ${new Date(now).toISOString()}`
          const got = {
            legacy: result.success && result.data.security.auth.legacy,
            namesKey: names(result, UNTIL),
            namesBound: /366/.test(messages(result)),
          }
          expect(got, label).toEqual(
            days <= 366
              ? { legacy: { until, maxCost: 10 }, namesKey: false, namesBound: false }
              : { legacy: false, namesKey: true, namesBound: true },
          )
        },
      ),
      { numRuns: 400 },
    )
  })

  it('AC-14: the bound moves with the clock: the date refused at one load is accepted a day later', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LOADED)
    const until = dateAfter(LOADED, 367)
    const refused = parse({ until })
    vi.setSystemTime(LOADED + DAY_MS)
    const accepted = parse({ until })
    expect([refused.success, accepted.success]).toEqual([false, true])
  })

  it('AC-14: a date-time, an impossible calendar date and a non-date are refused, each naming the key', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LOADED)
    const refused = [
      '2027-01-01T00:00:00.000Z',
      '2027-01-01 00:00',
      '2027-02-30',
      '2027-13-01',
      '2027-1-1',
      '20270101',
      'soon',
      '',
      20270101,
    ]
    expect(
      refused.map((until) => [until, parse({ until }).success, names(parse({ until }), UNTIL)]),
    ).toEqual(refused.map((until) => [until, false, true]))
  })
})

describe('AC-14: security.auth.legacy.maxCost', () => {
  it('AC-14: maxCost defaults to 10, accepts 10, 11 and 12, and refuses 9, 13 and 14 naming the key; with no legacy block, security.auth.legacy is undefined', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LOADED)
    const until = dateAfter(LOADED, 90)
    const accepted = [10, 11, 12].map((maxCost) => {
      const result = parse({ until, maxCost })
      return result.success ? result.data.security.auth.legacy : messages(result)
    })
    const refused = [9, 13, 14, '12'].map((maxCost) => {
      const result = parse({ until, maxCost })
      return [maxCost, result.success, names(result, MAX_COST)]
    })
    const absent = parse()
    const defaulted = parse({ until })

    expect(accepted).toEqual([10, 11, 12].map((maxCost) => ({ until, maxCost })))
    expect(refused).toEqual([9, 13, 14, '12'].map((maxCost) => [maxCost, false, true]))
    expect(defaulted.success && defaulted.data.security.auth.legacy).toEqual({ until, maxCost: 10 })
    expect(absent.success && absent.data.security.auth.legacy).toBe(undefined)
  })

  it('AC-14: a legacy block with no until is refused naming the key', () => {
    const result = parse({ maxCost: 12 })
    expect([result.success, names(result, UNTIL)]).toEqual([false, true])
  })
})
