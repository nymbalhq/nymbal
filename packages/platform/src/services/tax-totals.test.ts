import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Address,
  CheckoutTotalsLine,
  PromotionEffect,
  TaxQuote,
  TaxQuoteParams,
  TotalsLine,
} from '@nymbalhq/types'
import { taxedTotals } from './tax-quote.js'
import { quoteNative } from './tax-rates.js'
import { settleQuote, type SettleInput } from './totals.js'

// The roadmap's proof, extended to tax: place composes the promotions settlement (with its free-order rule), the
// native quote on each line's discounted amount and the production `taxedTotals`. Over arbitrary lines, hostile effect
// lists, rate tables and both flags the totals still add up, the tax is the quote's line by line, and settling the
// result's own applied effects with the same tax changes nothing.

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

const arbLines: fc.Arbitrary<TotalsLine[]> = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    unitMinor: fc.integer({ min: 0, max: 100_000 }),
    qty: fc.integer({ min: 1, max: 50 }),
  }),
  { minLength: 1, maxLength: 6, selector: (line) => line.id },
)

/** An amount an engine has no business returning, and one it might. */
const arbAmount = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 200_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -200_000, max: -1 }) },
  { weight: 1, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 1e15),
  },
)

function arbEffects(lines: readonly TotalsLine[]): fc.Arbitrary<PromotionEffect[]> {
  const lineId = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...lines.map((l) => l.id)) },
    { weight: 1, arbitrary: fc.constant('no-such-line') },
  )
  const effect: fc.Arbitrary<PromotionEffect> = fc.oneof(
    fc.record({
      kind: fc.constant('line' as const),
      lineId,
      amountMinor: arbAmount,
      label: fc.constant('line'),
    }),
    fc.record({
      kind: fc.constant('order' as const),
      amountMinor: arbAmount,
      label: fc.constant('order'),
    }),
    fc.record({
      kind: fc.constant('shipping' as const),
      amountMinor: arbAmount,
      label: fc.constant('shipping'),
    }),
    fc.record({ kind: fc.constant('code_accepted' as const), code: fc.constant('C') }),
  )
  return fc
    .tuple(fc.array(effect, { maxLength: 10 }), fc.nat({ max: 3 }))
    .map(([effects, repeated]) => [...effects, ...effects.slice(0, repeated)])
}

const arbPercent = fc.integer({ min: 0, max: 1_000_000 }).map((t) => t / 10_000)

const arbRates = fc.uniqueArray(
  fc.record(
    {
      country: fc.constantFrom('GB', 'US', 'DE'),
      region: fc.constantFrom('CA', 'NY'),
      percent: arbPercent,
      codes: fc.dictionary(fc.constantFrom('food', 'books'), arbPercent),
    },
    { requiredKeys: ['country', 'percent'] },
  ),
  { maxLength: 4, selector: (row) => `${row.country}/${row.region ?? ''}` },
)

const arbShipTo: fc.Arbitrary<Address> = fc
  .tuple(fc.constantFrom('GB', 'US', 'DE', 'JP'), fc.constantFrom('', 'CA', 'NY'))
  .map(([country, region]) => ({
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'Town',
    region,
    postalCode: '00000',
    country,
  }))

const arbCase = arbLines.chain((lines) =>
  fc.record({
    input: fc.record({
      currency: fc.constant('GBP'),
      lines: fc.constant(lines),
      shipping: fc.option(fc.record({ amountMinor: fc.integer({ min: 0, max: 50_000 }) }), {
        nil: null,
      }),
      effects: arbEffects(lines),
      tax: fc.constant(null),
      pricesIncludeTax: fc.boolean(),
    }),
    rates: arbRates,
    shipTo: arbShipTo,
    codes: fc.array(fc.option(fc.constantFrom('food', 'books', 'other'), { nil: undefined }), {
      minLength: lines.length,
      maxLength: lines.length,
    }),
  }),
)

const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

describe('AC-10: the totals invariant with promotions and tax', () => {
  // Kills: the second settle double-counting a discount; tax computed from one settle applied to another's lines.
  it('AC-10: property: settleQuote, then quoteNative on the discounted lines, then taxedTotals: the totals add up, the discount is the settlement’s, each line’s tax is the quote’s, an inclusive line’s tax is within its amount, and re-settling applied with the same tax changes nothing', () => {
    fc.assert(
      fc.property(arbCase, ({ input, rates, shipTo, codes }) => {
        const settleInput: SettleInput = input
        const inclusive = input.pricesIncludeTax
        const promoted = settleQuote(settleInput)
        const params: TaxQuoteParams = {
          currency: input.currency,
          shipTo,
          customer: { id: null },
          lines: promoted.totals.lines.map((line, i) => ({
            id: line.id,
            sku: `SKU-${i}`,
            ...(codes[i] !== undefined && { taxCode: codes[i] }),
            amountMinor: line.subtotalMinor - line.discountMinor,
            qty: input.lines[i]!.qty,
          })),
          shipping: null,
          pricesIncludeTax: inclusive,
          reference: 'cart-token',
        }
        const taxQuote = quoteNative(rates, params)
        const placed = { ...settleInput, effects: promoted.effects }

        const totals = taxedTotals(placed, taxQuote)

        // The totals function's equations, now with tax.
        expect(totals.subtotalMinor).toBe(sum(input.lines.map((l) => l.unitMinor * l.qty)))
        expect(totals.totalMinor).toBe(
          totals.subtotalMinor -
            totals.discountTotalMinor +
            totals.shippingTotalMinor +
            (inclusive ? 0 : totals.taxTotalMinor),
        )
        expect(totals.pricesIncludeTax).toBe(inclusive)
        expect(sum(totals.lines.map((l: CheckoutTotalsLine) => l.discountMinor))).toBe(
          totals.discountTotalMinor - totals.shippingDiscountMinor,
        )
        // The discount is the promotions settlement's, line by line: tax does not move it.
        expect(totals.discountTotalMinor).toBe(promoted.totals.discountTotalMinor)
        expect(totals.lines.map((l: CheckoutTotalsLine) => [l.id, l.discountMinor])).toEqual(
          promoted.totals.lines.map((l: CheckoutTotalsLine) => [l.id, l.discountMinor]),
        )
        // The tax is the quote's, on the lines it was quoted for.
        expect(totals.taxTotalMinor).toBe(
          sum(totals.lines.map((l: CheckoutTotalsLine) => l.taxMinor)) + taxQuote.shippingTaxMinor,
        )
        expect(totals.taxTotalMinor).toBe(taxQuote.totalTaxMinor)
        for (const line of totals.lines) {
          const quoted = taxQuote.lines.find((q: TaxQuote['lines'][number]) => q.id === line.id)!
          expect(line.taxMinor, line.id).toBe(quoted.taxMinor)
          expect(line.totalMinor, line.id).toBe(
            line.subtotalMinor - line.discountMinor + (inclusive ? 0 : line.taxMinor),
          )
          // Within the line when prices include it; on top, any amount the quote set.
          expect(line.taxMinor, line.id).toBeLessThanOrEqual(
            inclusive ? line.subtotalMinor - line.discountMinor : quoted.taxMinor,
          )
        }
        for (const amount of [
          totals.subtotalMinor,
          totals.discountTotalMinor,
          totals.shippingTotalMinor,
          totals.taxTotalMinor,
          totals.totalMinor,
          ...totals.lines.flatMap((l: CheckoutTotalsLine) => [
            l.subtotalMinor,
            l.discountMinor,
            l.taxMinor,
            l.totalMinor,
          ]),
        ]) {
          expect(isNonNegativeInteger(amount), String(amount)).toBe(true)
        }

        expect(taxedTotals({ ...placed, effects: totals.applied }, taxQuote)).toEqual(totals)
      }),
      { numRuns: 500 },
    )
  })
})
