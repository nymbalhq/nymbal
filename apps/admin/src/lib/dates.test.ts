import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { addStoreDays, formatStoreDay } from './dates'

// A store day (`YYYY-MM-DD`, the night an insight is from) names that day in every browser zone: Honolulu is ten hours
// behind UTC and Kiritimati fourteen ahead, so a day read as UTC midnight and shown in the local zone moves in both.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ZONES = ['Pacific/Honolulu', 'Pacific/Kiritimati']
const original = process.env.TZ

afterEach(() => {
  if (original === undefined) delete process.env.TZ
  else process.env.TZ = original
})

const two = (n: number) => String(n).padStart(2, '0')

const storeDay = fc
  .date({
    min: new Date(Date.UTC(2000, 0, 1)),
    max: new Date(Date.UTC(2099, 11, 31)),
    noInvalidDate: true,
  })
  .map((d) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    text: `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`,
  }))

/** The day, month and year a formatted store day names. */
function named(formatted: string): { day: number; month: number; year: number } | null {
  const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(formatted)
  if (match === null) return null
  return { day: Number(match[1]), month: MONTHS.indexOf(match[2]!) + 1, year: Number(match[3]) }
}

describe('AC-10: a store day reads as itself in every zone', () => {
  it('AC-10: property: formatStoreDay names the day, month and year of any YYYY-MM-DD from 2000 to 2099, in Honolulu and in Kiritimati', () => {
    for (const zone of ZONES) {
      process.env.TZ = zone
      fc.assert(
        fc.property(storeDay, ({ year, month, day, text }) => {
          expect(named(formatStoreDay(text)), `${text} in ${zone}`).toEqual({ day, month, year })
        }),
        { numRuns: 300 },
      )
    }
  })

  it("AC-10: '2026-11-21' reads 21 Nov 2026 in both zones", () => {
    const read = ZONES.map((zone) => {
      process.env.TZ = zone
      return formatStoreDay('2026-11-21')
    })
    expect(read).toEqual(['21 Nov 2026', '21 Nov 2026'])
  })
})

// The report's zones: west of UTC with a clock change on 1 Nov, UTC, a half-hour offset east, and far east with its own
// clock changes. The oracle moves a day on UTC epoch milliseconds, where every day is 86,400,000 ms long.
const REPORT_ZONES = ['America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Pacific/Auckland']
const DAY_MS = 86_400_000

function oracle(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) + n * DAY_MS).toISOString().slice(0, 10)
}

/** The days from `from` to `to`, stepped one store day at a time as the page lists them; bounded so a step that never
 * reaches `to` stops. */
function stepped(from: string, to: string, bound: number): string[] {
  const days = [from]
  while (days[days.length - 1] !== to && days.length <= bound) {
    days.push(addStoreDays(days[days.length - 1]!, 1))
  }
  return days
}

describe('AC-1: store days are named and moved on their own parts in every zone', () => {
  it('AC-1: property: in Los Angeles, UTC, Kolkata and Auckland, formatStoreDay names the day, addStoreDays(day, -n) equals the UTC-epoch oracle, and the days from addStoreDays(T, -n) to T are n + 1, each one day after the last', () => {
    for (const zone of REPORT_ZONES) {
      process.env.TZ = zone
      fc.assert(
        fc.property(storeDay, fc.integer({ min: 0, max: 60 }), ({ year, month, day, text }, n) => {
          expect(named(formatStoreDay(text)), `${text} in ${zone}`).toEqual({ day, month, year })

          const from = addStoreDays(text, -n)
          expect(from, `${text} less ${n} in ${zone}`).toBe(oracle(text, -n))

          const days = stepped(from, text, n + 1)
          expect(days.length, `days from ${from} to ${text} in ${zone}`).toBe(n + 1)
          days
            .slice(1)
            .forEach((d, i) => expect(d, `the day after ${days[i]}`).toBe(oracle(days[i]!, 1)))
        }),
        { numRuns: 300 },
      )
    }
  })

  it('AC-1: in Los Angeles, 30 days before 20 Nov 2026 (across the 1 Nov clock change) is 21 Oct 2026, and 1 Nov steps to 2 Nov', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect([addStoreDays('2026-11-20', -30), addStoreDays('2026-11-01', 1)]).toEqual([
      oracle('2026-11-20', -30),
      '2026-11-02',
    ])
    expect(addStoreDays('2026-11-20', -30)).toBe('2026-10-21')
  })
})
