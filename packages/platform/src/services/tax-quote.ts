import {
  CheckoutError,
  type Address,
  type CheckoutTotals,
  type Logger,
  type TaxAdapter,
  type TaxQuote,
  type TaxQuoteParams,
} from '@nymbalhq/types'
import { settleTotals, type SettleInput } from './totals.js'

/** How long a tax engine other than the native table may take before it counts as down. */
export const TAX_BOUND_MS = 3000

const isWhole = (amount: number): boolean => Number.isSafeInteger(amount) && amount >= 0

/**
 * The quote is one the kernel can put on an order: one line per request line under the request's ids, every amount a
 * whole non-negative number, the total the lines' tax plus the shipping tax, the request's inclusive flag, and an
 * inclusive line's tax within its amount, no shipping tax when no shipping was sent, and an inclusive shipping tax within
 * the shipping amount.
 */
export function validQuote(params: TaxQuoteParams, quote: TaxQuote): boolean {
  if (quote.inclusive !== params.pricesIncludeTax) return false
  if (quote.lines.length !== params.lines.length) return false
  const asked = new Map(params.lines.map((line) => [line.id, line.amountMinor]))
  const answered = new Set<string>()
  let lineTax = 0
  for (const line of quote.lines) {
    const amount = asked.get(line.id)
    if (amount === undefined || answered.has(line.id)) return false
    answered.add(line.id)
    if (!isWhole(line.taxableMinor) || !isWhole(line.taxMinor)) return false
    if (params.pricesIncludeTax && line.taxMinor > amount) return false
    lineTax += line.taxMinor
  }
  if (params.shipping === null && quote.shippingTaxMinor !== 0) return false
  if (
    params.pricesIncludeTax &&
    params.shipping !== null &&
    quote.shippingTaxMinor > params.shipping.amountMinor
  ) {
    return false
  }
  return (
    isWhole(quote.shippingTaxMinor) &&
    isWhole(quote.totalTaxMinor) &&
    quote.totalTaxMinor === lineTax + quote.shippingTaxMinor
  )
}

/** The totals function's settlement again, with the quote's tax line by line, under the store's flag in `input`. */
export function taxedTotals(input: SettleInput, quote: TaxQuote): CheckoutTotals {
  return settleTotals({
    ...input,
    tax: {
      lines: quote.lines.map((line) => ({ id: line.id, taxMinor: line.taxMinor })),
      shippingTaxMinor: quote.shippingTaxMinor,
    },
  })
}

/** What place asks an engine for; the store's flag and ship-from address are the quoter's to add. */
export type TaxRequest = Omit<TaxQuoteParams, 'pricesIncludeTax' | 'shipFrom'>

export interface TaxAnswer {
  quote: TaxQuote
  /** The engine was down and the native table answered, as the store chose. */
  fallback: boolean
}

export interface TaxQuoter {
  quote(request: TaxRequest): Promise<TaxAnswer>
}

/**
 * The engine's answer, abandoned at the bound as an outage. The call starts inside the chain, so a provider that throws
 * before returning a promise is a rejection the race sees and the timer is still cleared.
 */
function bounded(adapter: TaxAdapter, params: TaxQuoteParams, boundMs: number): Promise<TaxQuote> {
  let timer: NodeJS.Timeout
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tax engine past the ${boundMs} ms bound`)), boundMs)
  })
  const answer = Promise.resolve().then(() => adapter.quote(params))
  return Promise.race([answer, bound]).finally(() => clearTimeout(timer))
}

/**
 * The tax engine as place uses it. A throw, an answer past the bound or an invalid quote is an outage: `refuse` throws
 * `checkout.tax_unavailable`, `native` answers the native table's quote marked as a fallback. The native table is
 * never raced against the bound: it is in-process arithmetic, and the one place a fallback comes from.
 */
export function createTaxQuoter(deps: {
  adapter: TaxAdapter
  fallback: TaxAdapter
  onUnavailable: 'refuse' | 'native'
  pricesIncludeTax: boolean
  shipFrom?: Address
  boundMs: number
  logger: Logger
}): TaxQuoter {
  const { adapter, fallback, onUnavailable, pricesIncludeTax, shipFrom, boundMs, logger } = deps
  return {
    async quote(request) {
      const params: TaxQuoteParams = {
        ...request,
        ...(shipFrom !== undefined && { shipFrom }),
        pricesIncludeTax,
      }
      let failure: unknown
      try {
        const quote =
          adapter.providerName === 'native'
            ? await adapter.quote(params)
            : await bounded(adapter, params, boundMs)
        if (validQuote(params, quote)) return { quote, fallback: false }
        failure = new Error('the tax engine answered a quote the port refuses')
      } catch (err) {
        failure = err
      }
      logger.warn(
        { err: failure, provider: adapter.providerName, reference: params.reference },
        'tax engine unavailable at checkout',
      )
      if (onUnavailable === 'native') {
        return { quote: await fallback.quote(params), fallback: true }
      }
      throw new CheckoutError('tax_unavailable', 'The tax engine could not be reached', {
        cause: failure,
      })
    },
  }
}
