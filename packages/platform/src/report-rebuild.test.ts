import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { heldFrom } from './reports/rebuild.js'

// The first day a rebuild may replace is one the log still holds whole: every instant of it is at or after the floor
// (the later of the retention bound plus an hour and the oldest append), and no earlier day qualifies.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const formats = new Map<string, Intl.DateTimeFormat>()

/** The calendar day an instant falls on in `zone`, worked out apart from the code under test. */
function dayIn(zone: string, at: Date): string {
  let format = formats.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formats.set(zone, format)
  }
  return format.format(at)
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The first instant (to the millisecond) whose day in `zone` is `day` or later. */
function startOf(day: string, zone: string): number {
  const midnightUtc = Date.parse(`${day}T00:00:00.000Z`)
  let lo = midnightUtc - 15 * HOUR_MS
  let hi = midnightUtc + 15 * HOUR_MS
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayIn(zone, new Date(mid)) >= day) hi = mid
    else lo = mid
  }
  return hi
}

const floorOf = (now: Date, retentionDays: number, oldest: Date): number =>
  Math.max(now.getTime() - retentionDays * DAY_MS + HOUR_MS, oldest.getTime())

/** Clock changes of 2026: London both ways, New York in, Lord Howe's half hour out; Kolkata has none. */
const CHANGES = [
  '2026-03-29T01:00:00.000Z',
  '2026-10-25T01:00:00.000Z',
  '2026-03-08T07:00:00.000Z',
  '2026-04-04T15:00:00.000Z',
].map(Date.parse)

const ZONES = ['Europe/London', 'Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe'] as const

/** Instants anywhere in a few years, and instants within a day and a half of a clock change. */
const instant = fc.oneof(
  fc.date({
    min: new Date('2024-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T00:00:00.000Z'),
    noInvalidDate: true,
  }),
  fc
    .tuple(fc.constantFrom(...CHANGES), fc.integer({ min: -36 * 60, max: 36 * 60 }))
    .map(([at, minutes]) => new Date(at + minutes * 60_000)),
)

describe('AC-3: heldFrom', () => {
  it('AC-3: an empty log holds no whole day, whatever the clock and the retention', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 1, max: 90 }),
        fc.constantFrom(...ZONES),
        (now, days, zone) => {
          expect(heldFrom(now, days, null, zone)).toBeNull()
        },
      ),
    )
  })

  it('AC-3: property over zones and instants: heldFrom is the day after the floor’s day; every instant from its start is at or after the floor, and the day before it starts at or before the floor', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 1, max: 90 }),
        // The oldest append: before the retention bound (an unswept dead event) or after it (a young store).
        fc.integer({ min: -120 * 24 * 60, max: 120 * 24 * 60 }),
        fc.constantFrom(...ZONES),
        (now, days, oldestOffsetMinutes, zone) => {
          const retentionBound = now.getTime() - days * DAY_MS + HOUR_MS
          const oldest = new Date(retentionBound + oldestOffsetMinutes * 60_000)
          const floor = floorOf(now, days, oldest)

          const held = heldFrom(now, days, oldest, zone)

          expect(held).toBe(addDays(dayIn(zone, new Date(floor)), 1))
          expect(startOf(held!, zone)).toBeGreaterThan(floor)
          expect(startOf(addDays(held!, -1), zone)).toBeLessThanOrEqual(floor)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-3: a store day of 23 or 25 hours: a floor in the repeated or skipped hour of London and New York still leaves the whole next day held', () => {
    const cases: Array<[string, string, string]> = [
      ['Europe/London', '2026-10-25T01:30:00.000Z', '2026-10-26'],
      ['Europe/London', '2026-03-29T00:30:00.000Z', '2026-03-30'],
      ['America/New_York', '2026-03-08T07:30:00.000Z', '2026-03-09'],
      ['Asia/Kolkata', '2026-10-24T18:29:59.999Z', '2026-10-25'],
      ['Asia/Kolkata', '2026-10-24T18:30:00.000Z', '2026-10-26'],
    ]
    for (const [zone, floorAt, expected] of cases) {
      // A young log: its oldest append is the floor, well after the retention bound.
      const oldest = new Date(floorAt)
      const now = new Date(oldest.getTime() + 2 * DAY_MS)
      const held = heldFrom(now, 30, oldest, zone)
      expect(held, `${zone} ${floorAt}`).toBe(expected)
      expect(startOf(held!, zone), `${zone} ${floorAt}`).toBeGreaterThan(oldest.getTime())
    }
  })
})
