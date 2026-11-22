import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CURRENCY_MINOR_UNITS, currencyExponent } from '../index.js'

// A currency's minor-unit digits are ISO 4217's (list one), read from one data table, never from the runtime's Intl:
// ICU reads HUF, IDR, COP, PKR and IQD with 0 digits, and Chromium reads RSD with 0 where Node reads 2.

const ZERO = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]
const THREE = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']
const FOUR = ['CLF', 'UYW']
/** List one's codes whose minor unit is `N.A.`: metals, fund codes, the testing and the no-currency code. */
const NOT_APPLICABLE = [
  'XAU',
  'XAG',
  'XPD',
  'XPT',
  'XBA',
  'XBB',
  'XBC',
  'XBD',
  'XDR',
  'XSU',
  'XUA',
  'XTS',
  'XXX',
]

const keysValued = (digits: number): string[] =>
  Object.entries(CURRENCY_MINOR_UNITS)
    .filter(([, d]) => d === digits)
    .map(([code]) => code)
    .sort()

describe('currencyExponent', () => {
  it("AC-1: a currency's exponent is ISO 4217's digits, the code read in any case, and 2 for a code the table does not list", () => {
    const expected: Array<[string, number]> = [
      ['RSD', 2],
      ['HUF', 2],
      ['IDR', 2],
      ['COP', 2],
      ['PKR', 2],
      ['GBP', 2],
      ['USD', 2],
      ['EUR', 2],
      ['JPY', 0],
      ['KRW', 0],
      ['ISK', 0],
      ['VND', 0],
      ['KWD', 3],
      ['BHD', 3],
      ['TND', 3],
      ['IQD', 3],
      ['CLF', 4],
      ['UYW', 4],
      ['jpy', 0],
      ['ZZZ', 2],
      ['XXX', 2],
      ['XAU', 2],
      ['', 2],
    ]

    expect(expected.map(([code]) => [code, currencyExponent(code)])).toEqual(expected)
  })

  it('AC-1: property: every listed code, in upper or lower case, reads its table entry; every unlisted three-letter code reads 2', () => {
    const listed = Object.keys(CURRENCY_MINOR_UNITS)
    fc.assert(
      fc.property(fc.constantFrom(...listed), (code) => {
        expect(currencyExponent(code), code).toBe(CURRENCY_MINOR_UNITS[code])
        expect(currencyExponent(code.toLowerCase()), code.toLowerCase()).toBe(
          CURRENCY_MINOR_UNITS[code],
        )
      }),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z]{3}$/).filter((code) => !listed.includes(code)),
        (code) => {
          expect(currencyExponent(code), code).toBe(2)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('CURRENCY_MINOR_UNITS', () => {
  it('AC-1: the table is ISO 4217 list one whole: 165 codes, the 0-, 3- and 4-digit sets exactly, every other code 2, no N.A. code', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)

    expect(codes.length).toBe(165)
    expect(codes.filter((code) => !/^[A-Z]{3}$/.test(code))).toEqual([])
    expect(keysValued(0)).toEqual([...ZERO].sort())
    expect(keysValued(3)).toEqual([...THREE].sort())
    expect(keysValued(4)).toEqual([...FOUR].sort())
    expect(keysValued(2).length).toBe(codes.length - ZERO.length - THREE.length - FOUR.length)
    expect(NOT_APPLICABLE.filter((code) => code in CURRENCY_MINOR_UNITS)).toEqual([])
  })

  it('AC-1: the table is frozen: a write throws and leaves the entry as it was', () => {
    const before = CURRENCY_MINOR_UNITS['GBP']
    const table = CURRENCY_MINOR_UNITS as Record<string, number>

    expect(Object.isFrozen(CURRENCY_MINOR_UNITS)).toBe(true)
    expect(() => {
      table['GBP'] = 5
    }).toThrow(TypeError)
    expect(() => {
      table['ZZZ'] = 0
    }).toThrow(TypeError)
    expect([CURRENCY_MINOR_UNITS['GBP'], 'ZZZ' in CURRENCY_MINOR_UNITS]).toEqual([before, false])
    expect(before).toBe(2)
  })
})
