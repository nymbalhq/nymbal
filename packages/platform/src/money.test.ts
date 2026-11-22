import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CURRENCY_MINOR_UNITS, currencyExponent } from '@nymbalhq/types'
import { formatMoney } from './money.js'

// The kernel's emails, timeline notes and assistant read an amount with ISO 4217's digits for its currency (the
// table in @nymbalhq/types), as a provider that takes minor units has it: 1999 HUF is HUF 19.99, never HUF 1,999.
// Every Intl literal below has U+00A0 between a code and the amount.

/** What Intl shows `minor` as with exactly `digits` fraction digits. */
const isoRule = (minor: number, currency: string, digits: number): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits)

/** The rule 1.9.0's admin read every currency with: two decimals, the amount over 100. */
const twoDecimalRule = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2 }).format(
    minor / 100,
  )

/** The digits after a formatted amount's decimal point; none when it has no point. */
const fractionDigits = (formatted: string): number =>
  /\d[\d,]*(?:\.(\d+))?\D*$/.exec(formatted)?.[1]?.length ?? 0

describe('formatMoney', () => {
  it('AC-2: property: for every listed currency and amount, the string has exactly ISO 4217’s fraction digits and is Intl’s with those digits', () => {
    const codes = Object.keys(CURRENCY_MINOR_UNITS)
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        (currency, minor) => {
          const digits = currencyExponent(currency)
          const shown = formatMoney(minor, currency)
          expect(shown, `${minor} ${currency}`).toBe(isoRule(minor, currency, digits))
          expect(fractionDigits(shown), shown).toBe(digits)
        },
      ),
      {
        numRuns: 1000,
        examples: [
          ['HUF', 1999],
          ['IQD', 1999],
          ['IDR', 1_000_000_000_000],
          ['CLF', 0],
        ],
      },
    )
  })

  it('AC-2: 1999 reads £19.99, JP¥1,999, KWD 1.999, HUF 19.99 and CLF 0.1999, and every GBP, USD and EUR amount reads as the two-decimal rule read it', () => {
    expect(['GBP', 'JPY', 'KWD', 'HUF', 'CLF'].map((c) => formatMoney(1999, c))).toEqual([
      '£19.99',
      'JP¥1,999',
      'KWD 1.999',
      'HUF 19.99',
      'CLF 0.1999',
    ])
    fc.assert(
      fc.property(
        fc.constantFrom('GBP', 'USD', 'EUR'),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        (currency, minor) => {
          expect(formatMoney(minor, currency), `${minor} ${currency}`).toBe(
            twoDecimalRule(minor, currency),
          )
        },
      ),
      {
        numRuns: 500,
        examples: [
          ['GBP', 0],
          ['USD', 5],
          ['EUR', 123_456_789],
        ],
      },
    )
  })
})
