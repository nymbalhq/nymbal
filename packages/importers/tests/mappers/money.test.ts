import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CURRENCY_MINOR_UNITS, currencyExponent } from '@nymbalhq/types'
import { toMinorUnits } from '../../src/woocommerce/mappers/money.js'
import { decimal } from './support/wc.js'

// WooCommerce prices are decimal strings in the store currency; Nymbal holds integers in that currency's minor units,
// whose exponent is ISO 4217's, from the table in @nymbalhq/types (JPY 0, GBP 2, HUF 2, KWD 3, IQD 3).

const CURRENCIES = ['GBP', 'USD', 'JPY', 'KWD'] as const

/** Intl's fraction digits, which agree with ISO 4217's for the four currencies the older properties use. */
const platformDigits = (currency: string): number =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2

describe('toMinorUnits reads ISO 4217 digits', () => {
  it('AC-3: property: for every listed currency, an integer amount written with that currency’s ISO digits comes back as that integer', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (currency, n) => {
          const text = decimal(n, currencyExponent(currency))
          expect(toMinorUnits(text, currency), `${text} ${currency}`).toBe(n)
        },
      ),
      {
        numRuns: 1000,
        examples: [
          ['HUF', 1999],
          ['IQD', 1999],
          ['IDR', 1_000_000_000],
          ['CLF', 1],
        ],
      },
    )
  })

  it('AC-3: "19.99" HUF is 1999, "1.999" IQD is 1999 and "1500" JPY is 1500', () => {
    expect([
      toMinorUnits('19.99', 'HUF'),
      toMinorUnits('1.999', 'IQD'),
      toMinorUnits('1500', 'JPY'),
    ]).toEqual([1999, 1999, 1500])
  })
})

describe('toMinorUnits', () => {
  it('AC-1: property: every integer amount written with its currency’s fraction digits comes back as that integer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (currency, n) => {
          expect(toMinorUnits(decimal(n, platformDigits(currency)), currency)).toBe(n)
        },
      ),
      {
        numRuns: 500,
        examples: [
          ['JPY', 1500],
          ['GBP', 0],
          ['KWD', 1_000_000_000],
        ],
      },
    )
  })

  it('AC-1: property: one fraction digit more than the currency has rounds half up', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 9 }),
        (currency, n, extra) => {
          const digits = platformDigits(currency)
          const text = `${decimal(n, digits)}${digits === 0 ? '.' : ''}${extra}`
          expect(toMinorUnits(text, currency), text).toBe(extra >= 5 ? n + 1 : n)
        },
      ),
      {
        numRuns: 500,
        examples: [
          ['GBP', 100, 5],
          ['GBP', 28, 5],
          ['JPY', 1499, 5],
        ],
      },
    )
  })

  it('AC-1: the float rule’s failures are exact: "1.005" GBP is 101, "0.285" GBP is 29, "1500" JPY is 1500', () => {
    expect(toMinorUnits('1.005', 'GBP')).toBe(101)
    expect(toMinorUnits('0.285', 'GBP')).toBe(29)
    expect(toMinorUnits('1500', 'JPY')).toBe(1500)
    expect(toMinorUnits('1.500', 'KWD')).toBe(1500)
  })

  it('AC-1: a negative amount is the same minor units, negated: "-9.00" GBP is -900', () => {
    expect(toMinorUnits('-9.00', 'GBP')).toBe(-900)
    expect(toMinorUnits('-0.285', 'GBP')).toBe(-29)
  })

  it('AC-1: property: a number is read through its decimal string form, exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (n) => {
        expect(toMinorUnits(n / 100, 'GBP')).toBe(n)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: an empty or unparseable price is null, never 0', () => {
    for (const text of ['', ' ', 'abc', '1.2.3', '£5', 'NaN']) {
      expect(toMinorUnits(text, 'GBP'), JSON.stringify(text)).toBeNull()
    }
  })
})
