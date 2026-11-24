import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Address, TaxAdapter, TaxQuote, TaxQuoteLine, TaxQuoteParams } from '@nymbalhq/types'
import {
  CASE_MS,
  healthAndDowntime,
  settle,
  using,
  type Build,
  type ContractOptions,
} from './common.js'

// What the kernel takes from a tax provider without question: a quote it can put on an order line by line. One line
// per request line under the request's own ids, every amount a whole non-negative number of minor units, a total that
// is the sum, and the same answer for the same request; an inclusive quote keeps each line's tax within the line. A
// provider that files documents answers the same document for a repeated order and accepts a repeated refund, because
// the kernel retries both. A quote names the adapter's own provider, because the kernel files an order only with the
// provider that quoted it. Any other answer is refused at checkout as an outage, so the suite refuses it first.
// Shipping is asked about as the kernel asks: no shipping tax when none was sent, a valid one when it was, and a shipping
// tax above 0 for the request the runner names as one its provider taxes.

export interface TaxContractOptions extends ContractOptions<TaxAdapter> {
  /** A destination the adapter taxes: the native engine taxes only where its table has a row. A GB address when absent. */
  shipTo?: Address
  /**
   * A shipping amount the adapter charges tax on at `shipTo`, so the suite can check that delivery is taxed. Absent, the
   * adapter is not asked to tax shipping (a provider that never does); every other shipping case still runs.
   */
  taxedShipping?: { amountMinor: number }
}

const GB: Address = {
  firstName: 'Contract',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

type QuoteLine = TaxQuote['lines'][number]

const IDS = ['line-1', 'line-2', 'line-3'] as const

function request(
  shipTo: Address,
  amounts: readonly number[],
  pricesIncludeTax = false,
  shipping: TaxQuoteParams['shipping'] = null,
): TaxQuoteParams {
  return {
    currency: 'GBP',
    shipTo,
    customer: { id: null },
    lines: amounts.map((amountMinor, i) => ({
      id: IDS[i]!,
      sku: `SKU-${i + 1}`,
      amountMinor,
      qty: i + 1,
    })),
    shipping,
    pricesIncludeTax,
    reference: 'contract-cart',
  }
}

/** Two or three lines of 1p to £10,000 each. */
const arbAmounts = fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 3 })

/** No shipping, or a shipping amount of up to £1,000. */
const arbShipping = fc.option(fc.record({ amountMinor: fc.integer({ min: 0, max: 100_000 }) }), {
  nil: null,
})

const RUNS = { numRuns: 3 }

const isWhole = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

const declares = (adapter: TaxAdapter, word: string): boolean =>
  (adapter.capabilities() as readonly string[]).includes(word)

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

export function runTaxContract(
  name: string,
  build: Build<TaxAdapter>,
  options: TaxContractOptions = {},
): void {
  const shipTo = options.shipTo ?? GB

  describe(`TaxAdapter contract: ${name}`, () => {
    // Kills: a quote the kernel cannot put on the order's lines (one dropped, doubled, or under another id).
    it(
      'lines: property: a quote has exactly one line per request line, under the request’s ids',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, async (amounts) => {
              const params = request(shipTo, amounts)
              const quote = await adapter.quote(params)
              expect(
                quote.lines.map((l: QuoteLine) => l.id).sort(),
                JSON.stringify(quote.lines),
              ).toEqual(params.lines.map((l: TaxQuoteLine) => l.id).sort())
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: money in fractions of a unit or below zero, which an order column cannot hold.
    it(
      'amounts: property: every line’s taxable and tax amount, the shipping tax and the total are whole non-negative minor units',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, fc.boolean(), async (amounts, inclusive) => {
              const params = request(shipTo, amounts, inclusive && declares(adapter, 'inclusive'))
              const quote = await adapter.quote(params)
              const money = [
                ...quote.lines.flatMap((l: QuoteLine) => [l.taxableMinor, l.taxMinor]),
                quote.shippingTaxMinor,
                quote.totalTaxMinor,
              ]
              expect(
                money.filter((n) => !isWhole(n)),
                JSON.stringify(quote),
              ).toEqual([])
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: a total the order's lines do not add up to, with or without shipping in the request.
    it(
      'total: property: totalTaxMinor is the sum of the lines’ tax and the shipping tax, with and without shipping',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, arbShipping, async (amounts, shipping) => {
              const quote = await adapter.quote(request(shipTo, amounts, false, shipping))
              expect(quote.totalTaxMinor, JSON.stringify(quote)).toBe(
                sum(quote.lines.map((l: QuoteLine) => l.taxMinor)) + quote.shippingTaxMinor,
              )
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: a provider charging tax on a delivery the kernel never sent, which checkout would put on the order.
    it(
      'shipping-null: property: with no shipping in the request, the shipping tax is 0',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, fc.boolean(), async (amounts, inclusive) => {
              const quote = await adapter.quote(
                request(shipTo, amounts, inclusive && declares(adapter, 'inclusive')),
              )
              expect(quote.shippingTaxMinor, JSON.stringify(quote)).toBe(0)
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: a shipping tax the kernel refuses as an outage (a fraction, or more than the delivery it is inside), or
    // shipping folded into a line's tax.
    it(
      'shipping-valid: property: with a shipping amount, the shipping tax is whole and, when prices include tax, within the amount, and every line’s tax is as without shipping',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(
              arbAmounts,
              fc.integer({ min: 0, max: 100_000 }),
              fc.boolean(),
              async (amounts, amountMinor, wantInclusive) => {
                const inclusive = wantInclusive && declares(adapter, 'inclusive')
                const shipped = await adapter.quote(
                  request(shipTo, amounts, inclusive, { amountMinor }),
                )
                const unshipped = await adapter.quote(request(shipTo, amounts, inclusive))
                expect(isWhole(shipped.shippingTaxMinor), JSON.stringify(shipped)).toBe(true)
                if (inclusive) {
                  expect(shipped.shippingTaxMinor, JSON.stringify(shipped)).toBeLessThanOrEqual(
                    amountMinor,
                  )
                }
                const taxes = (q: TaxQuote) =>
                  q.lines.map((l: QuoteLine) => [l.id, l.taxMinor]).sort()
                expect(taxes(shipped)).toEqual(taxes(unshipped))
              },
            ),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: a provider package that passes the suite while never charging tax on delivery.
    it(
      'shipping-taxed: the shipping its runner names as taxed is answered a shipping tax above 0, and twice that shipping no less',
      (ctx) =>
        using(build, async (adapter) => {
          const taxed = options.taxedShipping
          if (taxed === undefined) return ctx.skip()
          const once = await adapter.quote(request(shipTo, [2_500, 1_000], false, taxed))
          const twice = await adapter.quote(
            request(shipTo, [2_500, 1_000], false, { amountMinor: taxed.amountMinor * 2 }),
          )
          expect(once.shippingTaxMinor, JSON.stringify(once)).toBeGreaterThan(0)
          expect(twice.shippingTaxMinor, JSON.stringify(twice)).toBeGreaterThanOrEqual(
            once.shippingTaxMinor,
          )
        }),
      CASE_MS,
    )

    it(
      'zero: lines of no amount are taxed nothing',
      () =>
        using(build, async (adapter) => {
          const quote = await adapter.quote(request(shipTo, [0, 0]))
          expect(quote.lines.map((l: QuoteLine) => l.taxMinor)).toEqual(quote.lines.map(() => 0))
        }),
      CASE_MS,
    )

    // Kills: a provider whose answer drifts between the dry quote and the reserving one, so a checkout is refused.
    it(
      'repeat: the same request twice gives the same amounts',
      () =>
        using(build, async (adapter) => {
          const params = request(shipTo, [12_345, 678, 99_999])
          const amountsOf = (q: TaxQuote) => ({
            lines: q.lines.map((l: QuoteLine) => [l.id, l.taxableMinor, l.taxMinor]),
            shippingTaxMinor: q.shippingTaxMinor,
            totalTaxMinor: q.totalTaxMinor,
          })
          const first = await adapter.quote(params)
          const second = await adapter.quote(params)
          expect(amountsOf(second)).toEqual(amountsOf(first))
        }),
      CASE_MS,
    )

    // Kills: an inclusive store's line taxed more than it costs, or tax added on top of a price that holds it.
    it(
      'inclusive: property: an adapter declaring inclusive answers an inclusive request with an inclusive quote whose every line’s tax is within its amount',
      (ctx) =>
        using(build, async (adapter) => {
          if (!declares(adapter, 'inclusive')) return ctx.skip()
          await fc.assert(
            fc.asyncProperty(arbAmounts, async (amounts) => {
              const params = request(shipTo, amounts, true)
              const quote = await adapter.quote(params)
              const asked = new Map(params.lines.map((l: TaxQuoteLine) => [l.id, l.amountMinor]))
              expect(quote.inclusive).toBe(true)
              expect(
                quote.lines.filter((l: QuoteLine) => !(l.taxMinor <= (asked.get(l.id) ?? -1))),
                JSON.stringify(quote),
              ).toEqual([])
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: quotes that name another provider, so the kernel, which files an order only with the provider its quote
    // names, never files an order this provider quoted.
    it(
      'provider: property: a quote names the adapter’s providerName',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, fc.boolean(), async (amounts, inclusive) => {
              const quote = await adapter.quote(
                request(shipTo, amounts, inclusive && declares(adapter, 'inclusive')),
              )
              expect(quote.provider).toBe(adapter.providerName)
            }),
            RUNS,
          )
        }),
      CASE_MS,
    )

    // Kills: a retried filing (its first answer lost) filing the order twice with the tax authority.
    it(
      'commit: an adapter declaring commit answers the same documentId for a repeated orderId, and another for another order',
      (ctx) =>
        using(build, async (adapter) => {
          if (!declares(adapter, 'commit')) return ctx.skip()
          expect(typeof adapter.commit, 'commit declared without the method').toBe('function')
          const quote = await adapter.quote(request(shipTo, [2_500, 1_000]))
          const ref = (orderId: string) => ({
            orderId,
            orderNumber: `NYM-${orderId}`,
            currency: 'GBP',
          })
          const orderId = `contract-${Date.now()}`

          const first = await adapter.commit!(quote, ref(orderId))
          const again = await adapter.commit!(quote, ref(orderId))
          const other = await adapter.commit!(quote, ref(`${orderId}-other`))

          expect(again.documentId).toBe(first.documentId)
          expect(other.documentId).not.toBe(first.documentId)
        }),
      CASE_MS,
    )

    // Kills: a retried refund filing rejected, which the kernel's relay would retry until the event dies.
    it(
      'refund: an adapter declaring refund accepts a repeated refundId',
      (ctx) =>
        using(build, async (adapter) => {
          if (!declares(adapter, 'refund') || !declares(adapter, 'commit')) return ctx.skip()
          expect(typeof adapter.refund, 'refund declared without the method').toBe('function')
          const quote = await adapter.quote(request(shipTo, [2_500]))
          const orderId = `contract-refund-${Date.now()}`
          const doc = await adapter.commit!(quote, {
            orderId,
            orderNumber: `NYM-${orderId}`,
            currency: 'GBP',
          })
          const refund = { refundId: `${orderId}-r1`, amountMinor: 500, currency: 'GBP' }

          const outcomes = [
            await settle(() => adapter.refund!(doc, refund)),
            await settle(() => adapter.refund!(doc, refund)),
          ]

          expect(outcomes.map((o) => o.state)).toEqual(['resolved', 'resolved'])
        }),
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'quote()', (adapter) =>
      adapter.quote(request(shipTo, [1_000])),
    )
  })
}
