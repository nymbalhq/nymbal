import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { formatStoreDay } from './dates'

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
