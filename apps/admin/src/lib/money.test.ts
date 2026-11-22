import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CURRENCY_MINOR_UNITS, currencyExponent } from '@nymbalhq/types'
import { formatMoney, formatMoneyCompact, parseMoney, toMoneyInput } from './money'

// The admin reads and writes every amount in its currency's ISO 4217 minor units, from the table in
// @nymbalhq/types, never from the browser's Intl digits: 1999 JPY is JP¥1,999, 1999 KWD is KWD 1.999, and what a money
// input shows parses back to the minor units it came from. Every Intl literal below has U+00A0 between a code and the
// amount.

/** Exponents 0, 2, 3 and 4, and the codes where runtimes or ICU disagree with ISO 4217. */
const C = [
  'GBP',
  'USD',
  'EUR',
  'JPY',
  'KRW',
  'ISK',
  'KWD',
  'BHD',
  'TND',
  'CLF',
  'HUF',
  'RSD',
  'IQD',
] as const

/** What the kernel shows: Intl with exactly the currency's ISO digits. */
const kernelRule = (minor: number, currency: string): string => {
  const digits = currencyExponent(currency)
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits)
}

/** The digits after a formatted amount's decimal point; none when it has no point. */
const fractionDigits = (formatted: string): number =>
  /\d[\d,]*(?:\.(\d+))?\D*$/.exec(formatted)?.[1]?.length ?? 0

/** A currency in C with an amount whose major part is in [lowMajor, highMajor). */
const inMajorRange = (lowMajor: number, highMajor: number) =>
  fc.constantFrom(...C).chain((currency) => {
    const scale = 10 ** currencyExponent(currency)
    return fc.tuple(
      fc.constant(currency),
      fc.integer({ min: lowMajor * scale, max: highMajor * scale - 1 }),
    )
  })

describe('toMoneyInput and parseMoney', () => {
  it('AC-6: property: for every listed currency and amount, the input text has exactly the currency’s digits, reads as the amount, and parses back to it', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.integer({ min: 0, max: 10_000_000_000_000 }),
        (currency, minor) => {
          const digits = currencyExponent(currency)
          const text = toMoneyInput(minor, currency)
          const shape = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${digits}}$`)
          expect(text, `${minor} ${currency}`).toMatch(shape)
          expect(Number(text.replace('.', '')), text).toBe(minor)
          expect(parseMoney(text, currency), `${text} ${currency}`).toBe(minor)
        },
      ),
      {
        numRuns: 1000,
        examples: [
          ['GBP', 29],
          ['GBP', 113],
          ['KWD', 1005],
          ['HUF', 1999],
          ['JPY', 10_000_000_000_000],
          ['CLF', 0],
        ],
      },
    )
  })

  it('AC-6: 1999 is 19.99 in GBP, 1999 in JPY and 1.999 in KWD; 0 GBP is 0.00', () => {
    expect([
      toMoneyInput(1999, 'GBP'),
      toMoneyInput(1999, 'JPY'),
      toMoneyInput(1999, 'KWD'),
      toMoneyInput(0, 'GBP'),
    ]).toEqual(['19.99', '1999', '1.999', '0.00'])
  })

  it('AC-8: parseMoney refuses more decimals than the currency has and anything not a non-negative decimal, and reads the rest in minor units', () => {
    const cases: Array<[string, string, number | null]> = [
      ['19.5', 'JPY', null],
      ['1.', 'JPY', null],
      ['.5', 'GBP', null],
      ['12.345', 'GBP', null],
      ['1.2345', 'KWD', null],
      ['1,250.00', 'GBP', null],
      ['', 'GBP', null],
      ['-1', 'GBP', null],
      ['1e3', 'GBP', null],
      ['abc', 'GBP', null],
      [' 12.3 ', 'GBP', 1230],
      ['1.5', 'KWD', 1500],
      ['19.99', 'HUF', 1999],
    ]

    expect(
      cases.map(([input, currency]) => [input, currency, parseMoney(input, currency)]),
    ).toEqual(cases)
  })

  it('AC-8: property: a decimal with 1 to d fraction digits is whole × 10^d plus the fraction padded to d; one with d + 1 digits is refused', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.integer({ min: 0, max: 999_999_999 }),
        fc.stringMatching(/^\d{1,5}$/),
        (currency, whole, fraction) => {
          const digits = currencyExponent(currency)
          const text = `${whole}.${fraction}`
          const expected =
            fraction.length > digits
              ? null
              : whole * 10 ** digits + Number(fraction.padEnd(digits, '0'))
          expect(parseMoney(text, currency), `${text} ${currency}`).toBe(expected)
          expect(parseMoney(String(whole), currency), `${whole} ${currency}`).toBe(
            whole * 10 ** digits,
          )
        },
      ),
      {
        numRuns: 1000,
        examples: [
          ['JPY', 19, '5'],
          ['KWD', 1, '5'],
          ['HUF', 19, '99'],
        ],
      },
    )
  })
})

describe('formatMoney', () => {
  it('AC-7: property: for the currencies of every exponent and every disagreement, the admin shows what the kernel shows, with exactly the currency’s fraction digits', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...C),
        fc.integer({ min: 0, max: 10_000_000_000_000 }),
        (currency, minor) => {
          const shown = formatMoney(minor, currency)
          expect(shown, `${minor} ${currency}`).toBe(kernelRule(minor, currency))
          expect(fractionDigits(shown), shown).toBe(currencyExponent(currency))
        },
      ),
      {
        numRuns: 1000,
        examples: [
          ['RSD', 1999],
          ['JPY', 1999],
          ['KWD', 1999],
          ['CLF', 1999],
        ],
      },
    )
  })

  it('AC-7: 1999 reads £19.99, JP¥1,999, KWD 1.999, ISK 1,999, BHD 1.999, TND 1.999, CLF 0.1999, HUF 19.99 and RSD 19.99', () => {
    const codes = ['GBP', 'JPY', 'KWD', 'ISK', 'BHD', 'TND', 'CLF', 'HUF', 'RSD']

    expect(codes.map((c) => formatMoney(1999, c))).toEqual([
      '£19.99',
      'JP¥1,999',
      'KWD 1.999',
      'ISK 1,999',
      'BHD 1.999',
      'TND 1.999',
      'CLF 0.1999',
      'HUF 19.99',
      'RSD 19.99',
    ])
  })
})

describe('formatMoneyCompact', () => {
  it('AC-9: thresholds on the major amount: 120000 GBP is £1.2k, 120000 JPY is JP¥120.0k, 999 JPY is formatMoney’s, 1500000 KWD is KWD1.5k', () => {
    expect([
      formatMoneyCompact(120000, 'GBP'),
      formatMoneyCompact(120000, 'JPY'),
      formatMoneyCompact(999, 'JPY'),
      formatMoneyCompact(1_500_000, 'KWD'),
    ]).toEqual(['£1.2k', 'JP¥120.0k', formatMoney(999, 'JPY'), 'KWD1.5k'])
  })

  it('AC-9: property: below 1,000 in major units the tile shows formatMoney’s string; from 1,000 to under a million it shows the major amount in thousands to one decimal, then k', () => {
    fc.assert(
      fc.property(inMajorRange(0, 1000), ([currency, minor]) => {
        expect(formatMoneyCompact(minor, currency), `${minor} ${currency}`).toBe(
          formatMoney(minor, currency),
        )
      }),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(inMajorRange(1000, 1_000_000), ([currency, minor]) => {
        const shown = formatMoneyCompact(minor, currency)
        const major = minor / 10 ** currencyExponent(currency)
        expect(shown, `${minor} ${currency}`).toMatch(/\d\.\dk$/)
        expect(
          shown.endsWith(`${(major / 1000).toFixed(1)}k`),
          `${shown} for ${minor} ${currency}`,
        ).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})
