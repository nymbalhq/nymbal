import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Address, TaxQuote, TaxQuoteLine, TaxQuoteParams } from '@nymbalhq/types'
import { createNativeTaxAdapter } from '../adapters/tax/native-adapter.js'
import { createLogger } from '../logger.js'
import { validQuote } from './tax-quote.js'
import { exclusiveTax, inclusiveTax, matchRate, ppmOf, quoteNative } from './tax-rates.js'

// The native engine's maths, against exact integer oracles: exclusive tax is A × p / 100 rounded half up, inclusive
// tax is what is left of A once the net A × 10⁶ / (10⁶ + r) is rounded half up, a quote taxes each line on its own
// amount at its own rate, and a destination is matched to the store's table by country, then region.

const logger = createLogger({ pretty: false, level: 'error' })
const MILLION = 1_000_000n

type QuoteLine = TaxQuote['lines'][number]

interface RateRow {
  country: string
  region?: string
  percent: number
  codes?: Record<string, number>
}

/** A percent from 0 to 100 with at most four decimals, and its rate in parts per million. */
const arbPercent = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((tenThousandths) => ({ percent: tenThousandths / 10_000, ppm: tenThousandths }))

const arbAmount = fc.integer({ min: 0, max: 2 ** 31 - 1 })

const abs = (n: bigint): bigint => (n < 0n ? -n : n)

function addressIn(country: string, region = ''): Address {
  return {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'Town',
    region,
    postalCode: '00000',
    country,
  }
}

function paramsOf(
  lines: readonly TaxQuoteLine[],
  shipTo: Address,
  pricesIncludeTax = false,
): TaxQuoteParams {
  return {
    currency: 'GBP',
    shipTo,
    customer: { id: null },
    lines,
    shipping: null,
    pricesIncludeTax,
    reference: 'cart-token',
  }
}

describe('AC-1: native exclusive tax', () => {
  // Kills: float maths (Math.round(A * p / 100)) drifting by a unit, rounding down, banker's rounding.
  it('AC-1: property: for 0 ≤ A < 2^31 and a percent with up to four decimals, exclusiveTax is A × p / 100 rounded half up exactly, non-negative and non-decreasing in A; p = 0 or A = 0 gives 0', () => {
    fc.assert(
      fc.property(arbAmount, arbPercent, (amount, { percent, ppm }) => {
        expect(ppmOf(percent), `ppmOf(${percent})`).toBe(ppm)
        const tax = exclusiveTax(amount, ppm)
        const exact = BigInt(amount) * BigInt(ppm)

        expect(Number.isSafeInteger(tax), String(tax)).toBe(true)
        expect(BigInt(tax)).toBe((exact + MILLION / 2n) / MILLION)
        expect(abs(BigInt(tax) * MILLION - exact) * 2n <= MILLION).toBe(true)
        expect(tax).toBeGreaterThanOrEqual(0)
        expect(exclusiveTax(amount + 1, ppm)).toBeGreaterThanOrEqual(tax)
        expect(exclusiveTax(amount, 0)).toBe(0)
        expect(exclusiveTax(0, ppm)).toBe(0)
      }),
      { numRuns: 2000 },
    )
  })

  /** The j-th amount below 2^31 that rate `ppm` puts exactly on a half unit (A × r ≡ 500 000 mod 10⁶); none for some rates. */
  function halfAmount(ppm: number, j: number): number | null {
    // Solve r·A ≡ 500 000 (mod 10⁶) by the extended Euclidean algorithm.
    const r = BigInt(ppm)
    let [oldR, curR, oldS, curS] = [r, MILLION, 1n, 0n]
    while (curR !== 0n) {
      const q = oldR / curR
      ;[oldR, curR] = [curR, oldR - q * curR]
      ;[oldS, curS] = [curS, oldS - q * curS]
    }
    const g = oldR
    if ((MILLION / 2n) % g !== 0n) return null
    const step = MILLION / g
    const first = ((((oldS % step) + step) % step) * (MILLION / 2n / g)) % step
    const amount = first + step * BigInt(j)
    return amount > 0n && amount < 2n ** 31n ? Number(amount) : null
  }

  it('AC-1: property: an amount exactly on a half unit rounds up, never down or to even, from the percent as written to the quoted line', () => {
    fc.assert(
      fc.property(arbPercent, fc.nat({ max: 2_000 }), ({ percent, ppm }, j) => {
        const amount = halfAmount(ppm, j)
        fc.pre(amount !== null)
        const up = (BigInt(amount!) * BigInt(ppm) + MILLION / 2n) / MILLION
        // On a half: the exact value is up − ½.
        expect(BigInt(amount!) * BigInt(ppm) * 2n).toBe((2n * up - 1n) * MILLION)

        expect(exclusiveTax(amount!, ppm), `${amount} at ${percent}%`).toBe(Number(up))
        const quote = quoteNative(
          [{ country: 'GB', percent }],
          paramsOf([{ id: 'l', sku: 'SKU-1', amountMinor: amount!, qty: 1 }], addressIn('GB')),
        )
        expect(quote.lines[0]!.taxMinor, `${amount} at ${percent}% quoted`).toBe(Number(up))
      }),
      { numRuns: 1000 },
    )
  })
})

describe('AC-2: native inclusive tax', () => {
  // Kills: the exclusive formula applied to the gross; a rounding that lets the tax exceed the line.
  it('AC-2: property: 0 ≤ inclusiveTax ≤ A, it is within ½ of A × r / (10⁶ + r), and the exclusive tax on the net A − tax is within one unit of it', () => {
    fc.assert(
      fc.property(arbAmount, arbPercent, (amount, { ppm }) => {
        const tax = inclusiveTax(amount, ppm)
        const r = BigInt(ppm)

        expect(Number.isSafeInteger(tax), String(tax)).toBe(true)
        expect(tax).toBeGreaterThanOrEqual(0)
        expect(tax).toBeLessThanOrEqual(amount)
        // |tax − A·r/(10⁶ + r)| ≤ ½, multiplied through by 2(10⁶ + r).
        expect(abs(2n * BigInt(tax) * (MILLION + r) - 2n * BigInt(amount) * r) <= MILLION + r).toBe(
          true,
        )
        expect(Math.abs(exclusiveTax(amount - tax, ppm) - tax)).toBeLessThanOrEqual(1)
        expect(inclusiveTax(amount, 0)).toBe(0)
        expect(inclusiveTax(0, ppm)).toBe(0)
      }),
      { numRuns: 2000 },
    )
  })
})

const CODES = ['food', 'books', 'zero', 'unknown-code'] as const

const arbRow: fc.Arbitrary<RateRow> = fc.record(
  {
    country: fc.constantFrom('GB', 'US', 'FR', 'DE', 'CA'),
    region: fc.constantFrom('CA', 'NY', 'QC', 'Bayern'),
    percent: arbPercent.map((p) => p.percent),
    codes: fc.dictionary(
      fc.constantFrom('food', 'books', 'zero'),
      arbPercent.map((p) => p.percent),
    ),
  },
  { requiredKeys: ['country', 'percent'] },
)

/** A table with no two rows for the same country and region, as the config schema holds it. */
const arbTable = fc.uniqueArray(arbRow, {
  maxLength: 6,
  selector: (row) => `${row.country}/${row.region ?? ''}`,
})

const arbLines = fc.uniqueArray(
  fc.record(
    {
      id: fc.uuid(),
      sku: fc.stringMatching(/^SKU-[A-Z0-9]{1,6}$/),
      taxCode: fc.constantFrom(...CODES),
      amountMinor: fc.integer({ min: 0, max: 10_000_000 }),
      qty: fc.integer({ min: 1, max: 10 }),
    },
    { requiredKeys: ['id', 'sku', 'amountMinor', 'qty'] },
  ),
  { minLength: 1, maxLength: 6, selector: (line) => line.id },
)

const arbShipTo = fc
  .tuple(
    fc.constantFrom('GB', 'US', 'FR', 'DE', 'CA', 'JP'),
    fc.constantFrom('', 'CA', 'NY', 'QC', 'Bayern', 'TX'),
  )
  .map(([country, region]) => addressIn(country, region))

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

describe('AC-3: the native quote’s shape', () => {
  // Kills: the total taxed once on the sum of the lines, so Σ lines ≠ total and the order's lines disagree with its column.
  it('AC-3: property: one line per request line in order with equal ids; each line taxed on its own whole amount at its own rate; total = Σ line tax + shipping tax; a line’s tax does not move when other lines are added or removed; every quote is valid by the port’s rule', () => {
    fc.assert(
      fc.property(
        arbTable,
        arbLines,
        arbShipTo,
        fc.boolean(),
        (rates, lines, shipTo, inclusive) => {
          const params = paramsOf(lines, shipTo, inclusive)
          const quote = quoteNative(rates, params)

          expect(quote.lines.map((l: QuoteLine) => l.id)).toEqual(lines.map((l) => l.id))
          expect(quote.inclusive).toBe(inclusive)
          expect(quote.shippingTaxMinor).toBe(0)
          expect(quote.totalTaxMinor).toBe(
            sum(quote.lines.map((l: QuoteLine) => l.taxMinor)) + quote.shippingTaxMinor,
          )
          quote.lines.forEach((line: QuoteLine, i: number) => {
            const ppm = line.ratePpm ?? 0
            const own = inclusive
              ? inclusiveTax(lines[i]!.amountMinor, ppm)
              : exclusiveTax(lines[i]!.amountMinor, ppm)
            expect(line.taxMinor, `line ${i}`).toBe(own)
          })
          expect(validQuote(params, quote)).toBe(true)

          // Each line alone, and the lines reversed: every line keeps its tax.
          lines.forEach((line, i) => {
            const alone = quoteNative(rates, paramsOf([line], shipTo, inclusive))
            expect(alone.lines[0]!.taxMinor, `line ${i} alone`).toBe(quote.lines[i]!.taxMinor)
          })
          const reversed = quoteNative(rates, paramsOf([...lines].reverse(), shipTo, inclusive))
          expect(reversed.lines.map((l: QuoteLine) => l.taxMinor)).toEqual(
            [...quote.lines].reverse().map((l) => l.taxMinor),
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})

const TABLE: RateRow[] = [
  { country: 'GB', percent: 20 },
  { country: 'US', region: 'CA', percent: 7.25 },
  { country: 'US', region: 'NY', percent: 8.875 },
  { country: 'CA', percent: 5 },
  { country: 'CA', region: 'QC', percent: 14.975 },
]

/** The rate the native quote applies to one line shipped to `shipTo`. */
function ratePpmAt(shipTo: Address, rates: readonly RateRow[] = TABLE): number | undefined {
  const quote = quoteNative(
    rates,
    paramsOf([{ id: 'line', sku: 'SKU-1', amountMinor: 100_000, qty: 1 }], shipTo),
  )
  return quote.lines[0]!.ratePpm
}

describe('AC-4: native matching', () => {
  // Kills: a destination outside the store's nexus taxed at another row's rate; a shopper typing the state's name untaxed.
  it('AC-4: a country-and-region row beats the country’s row, and a region with no row of its own takes the country’s', () => {
    expect(ratePpmAt(addressIn('CA', 'QC'))).toBe(ppmOf(14.975))
    expect(ratePpmAt(addressIn('CA', 'ON'))).toBe(ppmOf(5))
    expect(ratePpmAt(addressIn('CA', ''))).toBe(ppmOf(5))
  })

  it('AC-4: a destination with no row is taxed 0 at ratePpm 0, even when another row shares its country', () => {
    for (const shipTo of [
      addressIn('JP', ''),
      addressIn('US', 'TX'),
      addressIn('US', ''),
      addressIn('FR', 'CA'),
    ]) {
      const what = `${shipTo.country}/${shipTo.region}`
      expect(matchRate(TABLE, shipTo), what).toBeNull()
      const quote = quoteNative(
        TABLE,
        paramsOf([{ id: 'line', sku: 'SKU-1', amountMinor: 99_999, qty: 3 }], shipTo),
      )
      expect(quote.lines[0], what).toMatchObject({ taxMinor: 0, ratePpm: 0 })
      expect(quote.totalTaxMinor, what).toBe(0)
    }
  })

  it('AC-4: a US region matches its state row by code or by name, in any case, with surrounding spaces', () => {
    for (const region of [
      'CA',
      'ca',
      ' Ca ',
      'California',
      'california',
      ' california ',
      'CALIFORNIA',
    ]) {
      expect(ratePpmAt(addressIn('US', region)), JSON.stringify(region)).toBe(ppmOf(7.25))
    }
    for (const region of ['NY', 'ny', 'New York', 'new york', '  NEW YORK ']) {
      expect(ratePpmAt(addressIn('US', region)), JSON.stringify(region)).toBe(ppmOf(8.875))
    }
  })

  // Kills: an address with no region or country throwing in the native engine, which the checkout reads as an outage.
  it('AC-4: an address with no region takes its country’s row, or none; one with no country matches no row and is taxed 0', () => {
    const { region: _region, ...noRegion } = addressIn('GB')
    const { country: _country, ...noCountry } = addressIn('GB', 'CA')
    const at = (shipTo: Record<string, unknown>) => shipTo as unknown as Address

    expect(ratePpmAt(at(noRegion))).toBe(ppmOf(20))
    expect(ratePpmAt(at({ ...noRegion, region: null }))).toBe(ppmOf(20))
    expect(ratePpmAt(at({ ...noRegion, country: 'CA' }))).toBe(ppmOf(5))
    for (const shipTo of [at({ ...noRegion, country: 'US' }), at(noCountry)]) {
      const what = JSON.stringify(shipTo)
      expect(matchRate(TABLE, shipTo), what).toBeNull()
      const quote = quoteNative(
        TABLE,
        paramsOf([{ id: 'line', sku: 'SKU-1', amountMinor: 99_999, qty: 3 }], shipTo),
      )
      expect(quote.lines[0], what).toMatchObject({ taxMinor: 0, ratePpm: 0 })
      expect(quote.totalTaxMinor, what).toBe(0)
    }
  })

  it('AC-4: every country, and another country’s region, compare case-insensitively after trimming', () => {
    expect(ratePpmAt(addressIn(' gb ', ''))).toBe(ppmOf(20))
    expect(ratePpmAt(addressIn('us', 'ca'))).toBe(ppmOf(7.25))
    expect(ratePpmAt(addressIn('ca', ' qc '))).toBe(ppmOf(14.975))
    expect(ratePpmAt(addressIn('Ca', 'Qc'))).toBe(ppmOf(14.975))
  })
})

describe('native matching edges', () => {
  // Kills: a state's name read as its code outside the US, so a foreign region takes a row written for a code.
  it('only a US address has its region read from a state’s name', () => {
    const rates: RateRow[] = [
      { country: 'GB', percent: 20 },
      { country: 'GB', region: 'NY', percent: 1 },
    ]
    expect(ratePpmAt(addressIn('GB', 'New York'), rates)).toBe(ppmOf(20))
    expect(ratePpmAt(addressIn('GB', 'NY'), rates)).toBe(ppmOf(1))
  })

  // Kills: a line with no code looked up as the code "undefined" and taxed at that code's rate.
  it('a line with no tax code takes its row’s percent, whatever the row’s codes are named', () => {
    const rates: RateRow[] = [{ country: 'GB', percent: 20, codes: { undefined: 0 } }]
    const quote = quoteNative(
      rates,
      paramsOf([{ id: 'line', sku: 'SKU-1', amountMinor: 10_000, qty: 1 }], addressIn('GB')),
    )
    expect(quote.lines[0]).toMatchObject({ ratePpm: ppmOf(20), taxMinor: 2_000 })
  })

  // Kills: a native quote not named native, so the checkout keeps a tax record on an order nothing taxed.
  it('names the native provider on a taxed and an untaxed quote', () => {
    for (const shipTo of [addressIn('GB'), addressIn('JP')]) {
      const quote = quoteNative(
        TABLE,
        paramsOf([{ id: 'line', sku: 'SKU-1', amountMinor: 10_000, qty: 1 }], shipTo),
      )
      expect(quote.provider, shipTo.country).toBe('native')
    }
  })
})

describe('AC-5: native tax codes', () => {
  const coded: RateRow[] = [{ country: 'GB', percent: 20, codes: { food: 0, books: 5 } }]
  const line = (id: string, taxCode?: string): TaxQuoteLine => ({
    id,
    sku: `SKU-${id}`,
    ...(taxCode !== undefined && { taxCode }),
    amountMinor: 10_000,
    qty: 1,
  })

  // Kills: a zero-rated code (food, clothing) taxed at the standard rate.
  it('AC-5: property: a line whose code is in the row’s codes takes that rate, 0 included; an unknown code or none takes the row’s percent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.boolean(),
        (amountMinor, inclusive) => {
          const lines = ['food', 'books', 'unknown-code', undefined].map((code, i) => ({
            ...line(`l-${i}`, code),
            amountMinor,
          }))
          const quote = quoteNative(coded, paramsOf(lines, addressIn('GB'), inclusive))
          const taxAt = inclusive ? inclusiveTax : exclusiveTax

          expect(quote.lines.map((l: QuoteLine) => l.ratePpm)).toEqual([
            0,
            ppmOf(5),
            ppmOf(20),
            ppmOf(20),
          ])
          expect(quote.lines.map((l: QuoteLine) => l.taxMinor)).toEqual([
            0,
            taxAt(amountMinor, ppmOf(5)),
            taxAt(amountMinor, ppmOf(20)),
            taxAt(amountMinor, ppmOf(20)),
          ])
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-5: the native adapter declares quote, codes and inclusive, has no commit or refund, and answers the native quote', async () => {
    const adapter = createNativeTaxAdapter({ logger, rates: coded })
    const params = paramsOf([line('a', 'food'), line('b', 'books'), line('c')], addressIn('GB'))

    expect([...adapter.capabilities()].sort()).toEqual(['codes', 'inclusive', 'quote'])
    expect(adapter.commit).toBeUndefined()
    expect(adapter.refund).toBeUndefined()
    expect(await adapter.quote(params)).toEqual(quoteNative(coded, params))
  })
})

const arbShippingRow = arbRow.chain((row) =>
  fc.boolean().map((taxShipping) => ({ ...row, taxShipping })),
)

const arbShippingTable = fc.uniqueArray(arbShippingRow, {
  maxLength: 6,
  selector: (row) => `${row.country}/${row.region ?? ''}`,
})

const arbShipping = fc.option(
  fc.record({ amountMinor: fc.integer({ min: 0, max: 10_000_000 }) }),
  { nil: null },
)

describe('AC-3: native tax on shipping', () => {
  // Kills: shipping never taxed (VAT on delivery not collected), taxed where the row exempts it, taxed at a line's
  // code rate instead of the row's percent, taxed when no shipping was sent, or left out of the total.
  it('AC-3: property: shippingTaxMinor is the row’s percent of the request’s shipping, exclusive or inclusive as lines are, when the row taxes shipping; 0 when it does not, when no row matches, or when shipping is null; the total adds it; the lines do not move; the quote is valid', () => {
    fc.assert(
      fc.property(
        arbShippingTable,
        arbLines,
        arbShipTo,
        fc.boolean(),
        arbShipping,
        (rates, lines, shipTo, inclusive, shipping) => {
          const params: TaxQuoteParams = { ...paramsOf(lines, shipTo, inclusive), shipping }
          const quote = quoteNative(rates, params)
          const row = matchRate(rates, shipTo) as (RateRow & { taxShipping: boolean }) | null
          const taxOf = inclusive ? inclusiveTax : exclusiveTax
          const expected =
            shipping === null || row === null || !row.taxShipping
              ? 0
              : taxOf(shipping.amountMinor, ppmOf(row.percent))

          expect(quote.shippingTaxMinor).toBe(expected)
          expect(quote.totalTaxMinor).toBe(
            sum(quote.lines.map((l: QuoteLine) => l.taxMinor)) + quote.shippingTaxMinor,
          )
          const withoutShipping = quoteNative(rates, paramsOf(lines, shipTo, inclusive))
          expect(quote.lines).toEqual(withoutShipping.lines)
          expect(validQuote(params, quote)).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-3: GB 20% on £4.99 of shipping is 100 on top, 83 included, and 0 on a row with taxShipping false', () => {
    const gb = (taxShipping: boolean) => [{ country: 'GB', percent: 20, codes: { food: 0 }, taxShipping }]
    const line = [{ id: 'v1', sku: 'SKU-1', taxCode: 'food', amountMinor: 1000, qty: 1 }]
    const at = (taxShipping: boolean, inclusive: boolean) =>
      quoteNative(gb(taxShipping), {
        ...paramsOf(line, addressIn('GB'), inclusive),
        shipping: { amountMinor: 499 },
      }).shippingTaxMinor
    expect(at(true, false)).toBe(100)
    expect(at(true, true)).toBe(499 - Math.round(499 / 1.2))
    expect(at(false, false)).toBe(0)
    expect(at(false, true)).toBe(0)
  })
})
