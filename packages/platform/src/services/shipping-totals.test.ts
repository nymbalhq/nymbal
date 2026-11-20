import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Address,
  CheckoutTotalsLine,
  PromotionEffect,
  TaxQuoteParams,
  TotalsLine,
} from '@nymbalhq/types'
import { shippingOptions } from './shipping-quote.js'
import { taxedTotals } from './tax-quote.js'
import { quoteNative } from './tax-rates.js'
import { settleQuote, settleTotals, type SettleInput } from './totals.js'

// The roadmap's proof, extended to shipping: a checkout quote composes the promotions settlement with no shipping
// (its free-order rule included), the native shipping options for the goods after their discount, the totals settled
// with the chosen option's amount, the native tax quote with shipping less its discount, and the production
// `taxedTotals`. For every option offered, over hostile effects and both flags, the totals still add up.

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
    // Shipping effects weigh double: they are what this proof adds.
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('shipping' as const),
        amountMinor: arbAmount,
        label: fc.constant('shipping'),
      }),
    },
    fc.record({ kind: fc.constant('code_accepted' as const), code: fc.constant('C') }),
  )
  return fc
    .tuple(fc.array(effect, { maxLength: 10 }), fc.nat({ max: 3 }))
    .map(([effects, repeated]) => [...effects, ...effects.slice(0, repeated)])
}

const arbPercent = fc.integer({ min: 0, max: 1_000_000 }).map((t) => t / 10_000)

const arbTaxRates = fc.uniqueArray(
  fc.record(
    {
      country: fc.constantFrom('GB', 'US', 'DE'),
      region: fc.constantFrom('CA', 'NY'),
      percent: arbPercent,
      codes: fc.dictionary(fc.constantFrom('food', 'books'), arbPercent),
      taxShipping: fc.boolean(),
    },
    { requiredKeys: ['country', 'percent', 'taxShipping'] },
  ),
  { maxLength: 4, selector: (row) => `${row.country}/${row.region ?? ''}` },
)

const arbShippingTable = fc.uniqueArray(
  fc.record(
    {
      id: fc.stringMatching(/^[a-z0-9_-]{1,10}$/),
      name: fc.constantFrom('Standard', 'Express', 'Next day', 'Collect'),
      countries: fc.uniqueArray(fc.constantFrom('GB', 'US', 'DE'), { minLength: 1, maxLength: 2 }),
      amountMinor: fc.integer({ min: 0, max: 50_000 }),
      freeOverMinor: fc.integer({ min: 1, max: 2_000_000 }),
      estimatedDays: fc.integer({ min: 0, max: 14 }),
    },
    { requiredKeys: ['id', 'name', 'amountMinor'] },
  ),
  { maxLength: 5, selector: (row) => row.id },
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
    lines: fc.constant(lines),
    effects: arbEffects(lines),
    pricesIncludeTax: fc.boolean(),
    taxRates: arbTaxRates,
    table: arbShippingTable,
    shipTo: arbShipTo,
    codes: fc.array(fc.option(fc.constantFrom('food', 'books', 'other'), { nil: undefined }), {
      minLength: lines.length,
      maxLength: lines.length,
    }),
  }),
)

const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

describe('AC-5: the totals invariant with shipping', () => {
  // Kills: shipping tax computed on the gross rate after a shipping discount; a branch adding shipping twice; the
  // free-over threshold read before the discount; an order and its quote disagreeing by the shipping tax.
  it('AC-5: property: for every option offered, the quote’s steps give total = subtotal − discount + shipping + (inclusive ? 0 : tax), discount = Σ line discount + shipping discount within shipping, tax = Σ line tax + shipping tax within the net shipping when inclusive, shipping the option’s amount, the tax asked on shipping less its discount, and re-settling applied changes nothing', () => {
    fc.assert(
      fc.property(
        arbCase,
        ({ lines, effects, pricesIncludeTax, taxRates, table, shipTo, codes }) => {
          const inclusive = pricesIncludeTax
          const base: SettleInput = {
            currency: 'GBP',
            lines,
            shipping: null,
            effects,
            tax: null,
            pricesIncludeTax,
          }
          const promoted = settleQuote(base)
          const goods =
            promoted.totals.subtotalMinor -
            (promoted.totals.discountTotalMinor - promoted.totals.shippingDiscountMinor)
          const options = shippingOptions(table, shipTo, goods)

          for (const option of options) {
            const placed: SettleInput = {
              ...base,
              effects: promoted.effects,
              shipping: { amountMinor: option.amountMinor },
            }
            const settled = settleTotals(placed)
            const taxedShipping =
              table.length === 0
                ? null
                : { amountMinor: option.amountMinor - settled.shippingDiscountMinor }
            const params: TaxQuoteParams = {
              currency: 'GBP',
              shipTo,
              customer: { id: null },
              lines: settled.lines.map((line, i) => ({
                id: line.id,
                sku: `SKU-${i}`,
                ...(codes[i] !== undefined && { taxCode: codes[i] }),
                amountMinor: line.subtotalMinor - line.discountMinor,
                qty: lines[i]!.qty,
              })),
              shipping: taxedShipping,
              pricesIncludeTax: inclusive,
              reference: 'cart-token',
            }
            const taxQuote = quoteNative(taxRates, params)
            const totals = taxedTotals(placed, taxQuote)
            const lineTax = sum(totals.lines.map((l: CheckoutTotalsLine) => l.taxMinor))
            const shippingTax = totals.taxTotalMinor - lineTax
            const where = `option ${option.id}`

            expect(totals.shippingTotalMinor, where).toBe(option.amountMinor)
            expect(totals.totalMinor, where).toBe(
              totals.subtotalMinor -
                totals.discountTotalMinor +
                totals.shippingTotalMinor +
                (inclusive ? 0 : totals.taxTotalMinor),
            )
            expect(
              sum(totals.lines.map((l: CheckoutTotalsLine) => l.discountMinor)) +
                totals.shippingDiscountMinor,
              where,
            ).toBe(totals.discountTotalMinor)
            expect(totals.shippingDiscountMinor, where).toBeGreaterThanOrEqual(0)
            expect(totals.shippingDiscountMinor, where).toBeLessThanOrEqual(
              totals.shippingTotalMinor,
            )
            expect(shippingTax, where).toBe(taxQuote.shippingTaxMinor)
            expect(totals.taxTotalMinor, where).toBe(taxQuote.totalTaxMinor)
            // With no table, no shipping was sent to tax; when prices include tax, it is inside the net shipping.
            expect(table.length === 0 ? shippingTax : 0, where).toBe(0)
            expect(inclusive ? shippingTax : 0, where).toBeLessThanOrEqual(
              totals.shippingTotalMinor - totals.shippingDiscountMinor,
            )
            // The goods' discount is the shipping-less settlement's: shipping does not move it.
            expect(totals.discountTotalMinor - totals.shippingDiscountMinor, where).toBe(
              promoted.totals.discountTotalMinor - promoted.totals.shippingDiscountMinor,
            )
            for (const amount of [
              totals.subtotalMinor,
              totals.discountTotalMinor,
              totals.shippingTotalMinor,
              totals.shippingDiscountMinor,
              totals.taxTotalMinor,
              totals.totalMinor,
            ]) {
              expect(isNonNegativeInteger(amount), `${where}: ${amount}`).toBe(true)
            }

            expect(taxedTotals({ ...placed, effects: totals.applied }, taxQuote), where).toEqual(
              totals,
            )
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})
