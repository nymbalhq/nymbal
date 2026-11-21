import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { localDayOf, localHourStartOf } from './reports/time.js'

// A store day and hour are the shopper's, in the store's zone: never the server's, never UTC, and an hour is an
// instant, so the repeated hour of a clock change stays two buckets.

const HOUR_MS = 60 * 60 * 1000

const dayIn = (zone: string, at: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

const minuteIn = (zone: string, at: Date) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, minute: '2-digit' }).format(at).trim(),
  )

describe('AC-1: localDayOf and localHourStartOf', () => {
  it('AC-1: the repeated hour of the UK clock change (25 Oct 2026) is two buckets, and the fall-back day has 25 of them', () => {
    const firstOneThirty = new Date('2026-10-25T00:30:00.000Z')
    const secondOneThirty = new Date('2026-10-25T01:30:00.000Z')

    expect(localHourStartOf(firstOneThirty, 'Europe/London').toISOString()).toBe(
      '2026-10-25T00:00:00.000Z',
    )
    expect(localHourStartOf(secondOneThirty, 'Europe/London').toISOString()).toBe(
      '2026-10-25T01:00:00.000Z',
    )

    const buckets = new Set<string>()
    for (let ms = Date.parse('2026-10-24T23:00:00.000Z'); ms < Date.parse('2026-10-26T00:00:00.000Z'); ms += HOUR_MS / 2) {
      const at = new Date(ms)
      expect(localDayOf(at, 'Europe/London')).toBe('2026-10-25')
      buckets.add(localHourStartOf(at, 'Europe/London').toISOString())
    }
    expect(buckets.size).toBe(25)
  })

  it('AC-1: Asia/Kolkata (UTC+5:30): the day turns at 18:30 UTC and the hour starts on the local hour, which is not a UTC hour', () => {
    expect(localDayOf(new Date('2026-03-01T18:29:59.000Z'), 'Asia/Kolkata')).toBe('2026-03-01')
    expect(localDayOf(new Date('2026-03-01T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-03-02')
    expect(localHourStartOf(new Date('2026-03-01T10:45:00.000Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-01T10:30:00.000Z',
    )
  })

  it('AC-1: property: in every zone whose clock changes by whole hours, the day is the zone’s and the hour start is at most an hour before the instant, on the zone’s whole hour', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01T00:00:00.000Z'), max: new Date('2028-12-31T00:00:00.000Z'), noInvalidDate: true }),
        // Not Australia/Lord_Howe: its clock moves 30 minutes, so an hour around a change holds no whole local hour start.
        fc.constantFrom('Europe/London', 'Asia/Kolkata', 'America/New_York', 'UTC'),
        (at, zone) => {
          expect(localDayOf(at, zone)).toBe(dayIn(zone, at))
          const start = localHourStartOf(at, zone)
          const gap = at.getTime() - start.getTime()
          expect(gap).toBeGreaterThanOrEqual(0)
          expect(gap).toBeLessThan(HOUR_MS)
          expect(minuteIn(zone, start)).toBe(0)
        },
      ),
      { numRuns: 300 },
    )
  })
})
