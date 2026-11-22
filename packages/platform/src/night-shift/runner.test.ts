import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isDue, runDayOf } from './runner.js'

// When the night is due and which day it is for, in the store's zone: the oracle is Intl's own reading of the instant
// in that zone, computed apart from the code under test.

const ZONES = ['Europe/London', 'Asia/Kolkata', 'Pacific/Auckland', 'America/New_York', 'UTC'] as const

const clockIn = (zone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dayIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone })

const at = (iso: string) => new Date(iso)

const instant = fc
  .integer({ min: Date.parse('2026-01-01T00:00:00Z'), max: Date.parse('2027-12-31T23:59:59Z') })
  .map((ms) => new Date(ms))
const hhmm = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)

describe('AC-1: the night is due from `at` in the store’s zone, for the store’s day', () => {
  it('AC-1: Europe/London on the spring clock change: 03:00 BST is 02:00 UTC, so 01:59 UTC is not due and 02:00 UTC is', () => {
    expect([isDue(at('2026-03-29T01:59:00Z'), '03:00', 'Europe/London'), isDue(at('2026-03-29T02:00:00Z'), '03:00', 'Europe/London')]).toEqual([false, true])
  })

  it('AC-1: Europe/London on the autumn clock change: 03:00 GMT is 03:00 UTC, so 02:59 UTC is not due and 03:00 UTC is', () => {
    expect([isDue(at('2026-10-25T02:59:00Z'), '03:00', 'Europe/London'), isDue(at('2026-10-25T03:00:00Z'), '03:00', 'Europe/London')]).toEqual([false, true])
  })

  it('AC-1: Asia/Kolkata (UTC+05:30): 03:00 is 21:30 UTC the day before', () => {
    expect([isDue(at('2026-11-20T21:29:00Z'), '03:00', 'Asia/Kolkata'), isDue(at('2026-11-20T21:30:00Z'), '03:00', 'Asia/Kolkata')]).toEqual([false, true])
  })

  it('AC-1: 23:30 UTC on 2026-11-20 is the night of 2026-11-21 in Pacific/Auckland', () => {
    expect(runDayOf(at('2026-11-20T23:30:00Z'), 'Pacific/Auckland')).toBe('2026-11-21')
  })

  it('AC-1: property: for any instant, zone and `at`, the night is due exactly when the store’s clock reads `at` or later, and its day is the store’s date', () => {
    fc.assert(
      fc.property(instant, fc.constantFrom(...ZONES), hhmm, (now, zone, due) => {
        expect(isDue(now, due, zone)).toBe(clockIn(zone).format(now) >= due)
        expect(runDayOf(now, zone)).toBe(dayIn(zone).format(now))
      }),
      { numRuns: 500 },
    )
  })
})
