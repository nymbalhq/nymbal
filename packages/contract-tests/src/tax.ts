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
// the kernel retries both. Any other answer is refused at checkout as an outage, so the suite refuses it first.

export interface TaxContractOptions extends ContractOptions<TaxAdapter> {
  /** A destination the adapter taxes: the native engine taxes only where its table has a row. A GB address when absent. */
  shipTo?: Address
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
    shipping: null,
    pricesIncludeTax,
    reference: 'contract-cart',
  }
}

/** Two or three lines of 1p to £10,000 each. */
const arbAmounts = fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 3 })

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

    // Kills: a total the order's lines do not add up to.
    it(
      'total: property: totalTaxMinor is the sum of the lines’ tax and the shipping tax',
      () =>
        using(build, async (adapter) => {
          await fc.assert(
            fc.asyncProperty(arbAmounts, async (amounts) => {
              const quote = await adapter.quote(request(shipTo, amounts))
              expect(quote.totalTaxMinor, JSON.stringify(quote)).toBe(
                sum(quote.lines.map((l: QuoteLine) => l.taxMinor)) + quote.shippingTaxMinor,
              )
            }),
            RUNS,
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
