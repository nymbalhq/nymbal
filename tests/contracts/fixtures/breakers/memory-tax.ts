import type {
  TaxAdapter,
  TaxDocument,
  TaxQuote,
  TaxQuoteLine,
  TaxQuoteParams,
} from '@nymbalhq/types'

// An in-memory tax provider that files documents, and its defective twins. While whole it taxes each line, and the
// shipping when the request has some, 10% on top, or extracts 10% from a price that includes it, rounding half up in
// whole units; files one document per order however often it is asked; and accepts a refund however often it is
// filed. Each twin breaks one rule of the quote, and only where a line has money in it, so the cases about lines of no
// amount stay on topic.

export interface TaxFlaws {
  /** The first line answered twice, the second line lost. */
  repeatedLineId?: boolean
  /** Half a unit moved onto a line's tax (and so onto the total). */
  fractionalAmount?: boolean
  /** A total one more than the lines add up to. */
  totalNotSum?: boolean
  /** No tax on shipping, whatever the request's shipping. */
  ignoresShipping?: boolean
  /** A shipping tax on a request that sent no shipping, as if a standard delivery had been sent. */
  shippingWhenNull?: boolean
}

/** The runner's options for every memory-tax run: it taxes shipping, so the suite checks that it does. */
export const TAXED_SHIPPING = { taxedShipping: { amountMinor: 499 } }

/** What a request with no shipping is taxed for by the twin that taxes it anyway. */
const ASSUMED_SHIPPING_MINOR = 499

const RATE_PPM = 100_000n
const MILLION = 1_000_000n

function taxOf(amountMinor: number, inclusive: boolean): number {
  const a = BigInt(amountMinor)
  if (!inclusive) return Number((a * RATE_PPM + MILLION / 2n) / MILLION)
  const net = (2n * a * MILLION + (MILLION + RATE_PPM)) / (2n * (MILLION + RATE_PPM))
  return amountMinor - Number(net)
}

export function memoryTax(flaws: TaxFlaws = {}): TaxAdapter {
  const documents = new Map<string, TaxDocument>()
  const refunds = new Set<string>()
  return {
    kind: 'tax',
    providerName: 'memory-tax',
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    capabilities: () => ['quote', 'inclusive', 'commit', 'refund'],
    async quote(params: TaxQuoteParams): Promise<TaxQuote> {
      const lines: Array<{ id: string; taxableMinor: number; taxMinor: number }> = params.lines.map(
        (line: TaxQuoteLine) => ({
          id: line.id,
          taxableMinor: line.amountMinor,
          taxMinor: taxOf(line.amountMinor, params.pricesIncludeTax),
        }),
      )
      const taxed = lines.some((l) => l.taxableMinor > 0)
      if (flaws.repeatedLineId === true && taxed && lines.length > 1) lines[1] = { ...lines[0]! }
      if (flaws.fractionalAmount === true && taxed) {
        const line = lines.find((l) => l.taxableMinor > 0)!
        line.taxMinor = Math.max(0, line.taxMinor - 1) + 0.5
      }
      const shippingTaxMinor =
        flaws.ignoresShipping === true
          ? 0
          : params.shipping !== null
            ? taxOf(params.shipping.amountMinor, params.pricesIncludeTax)
            : flaws.shippingWhenNull === true && taxed
              ? taxOf(ASSUMED_SHIPPING_MINOR, params.pricesIncludeTax)
              : 0
      const total = lines.reduce((s, l) => s + l.taxMinor, 0) + shippingTaxMinor
      return {
        provider: 'memory-tax',
        inclusive: params.pricesIncludeTax,
        lines,
        shippingTaxMinor,
        totalTaxMinor: flaws.totalNotSum === true && taxed ? total + 1 : total,
      }
    },
    async commit(
      _quote: TaxQuote,
      ref: { orderId: string; orderNumber: string; currency: string },
    ): Promise<TaxDocument> {
      const existing = documents.get(ref.orderId)
      if (existing !== undefined) return existing
      const doc = { provider: 'memory-tax', documentId: `doc-${documents.size + 1}-${ref.orderId}` }
      documents.set(ref.orderId, doc)
      return doc
    },
    async refund(
      _doc: TaxDocument,
      refund: { refundId: string; amountMinor: number; currency: string },
    ): Promise<void> {
      refunds.add(refund.refundId)
    },
  }
}
