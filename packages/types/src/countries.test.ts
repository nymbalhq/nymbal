import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as types from './index.js'

// The country codes an address may carry: the officially assigned ISO 3166-1 alpha-2 codes plus Kosovo's XK, read
// against what the runtime's CLDR names. The codes it names that are not current ISO ones (exceptionally or
// transitionally reserved, withdrawn, user-assigned) are written out here, so a superseded code standing in for a
// current one, a reserved code listed, or a country missing all fail. A Node whose CLDR names a new code fails on
// purpose: the list is then reviewed.

const { COUNTRY_CODES, isCountryCode } = types as unknown as {
  COUNTRY_CODES?: readonly string[]
  isCountryCode?: (code: string) => boolean
}

const NOT_ISO = new Set(
  'AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH QO RH SU TA TP UK UN VD XA XB YD YU ZR ZZ'.split(
    ' ',
  ),
)

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = LETTERS.toLowerCase()

/** Every string of two letters from `alphabet`. */
function pairs(alphabet: string): string[] {
  return [...alphabet].flatMap((a) => [...alphabet].map((b) => a + b))
}

const named = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })

function codes(): readonly string[] {
  expect(COUNTRY_CODES, '@nymbalhq/types exports COUNTRY_CODES').toBeInstanceOf(Array)
  return COUNTRY_CODES!
}

describe('COUNTRY_CODES', () => {
  it('AC-1: as a set it is exactly the codes AA..ZZ the runtime names in English, less the non-ISO ones, XK kept', () => {
    const expected = pairs(LETTERS)
      .filter((code) => named.of(code) !== undefined && !NOT_ISO.has(code))
      .sort()

    expect([...new Set(codes())].sort()).toEqual(expected)
    expect(expected, 'Kosovo stays').toContain('XK')
    expect(expected.length, 'the pinned Node names 250 of them').toBe(250)
  })

  it('AC-1: it lists no code twice, and no two of its codes share an English name', () => {
    const list = codes()
    const names = list.map((code) => named.of(code))

    expect(new Set(list).size).toBe(list.length)
    expect(new Set(names).size).toBe(list.length)
  })

  it('AC-1: isCountryCode is true exactly for its entries, over every two-letter string in either case', () => {
    const list = new Set(codes())
    expect(typeof isCountryCode, '@nymbalhq/types exports isCountryCode').toBe('function')

    for (const code of pairs(LETTERS + LOWER)) {
      expect(isCountryCode!(code), code).toBe(list.has(code))
    }
  })

  it('AC-1: property: isCountryCode is false for any string that is not an entry', () => {
    const list = new Set(codes())
    expect(typeof isCountryCode, '@nymbalhq/types exports isCountryCode').toBe('function')

    fc.assert(
      fc.property(fc.string({ maxLength: 6 }), (text) => {
        expect(isCountryCode!(text)).toBe(list.has(text))
      }),
      { numRuns: 500 },
    )
  })
})
