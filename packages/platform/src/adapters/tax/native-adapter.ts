import type { Logger, TaxAdapter } from '@nymbalhq/types'
import { quoteNative, type TaxRate } from '../../services/tax-rates.js'
import { noopInitialize, okHealth } from '../base.js'

/** The kernel's own engine: the store's rate table (`commerce.tax.rates`). It files nothing, so has no commit or refund. */
export function createNativeTaxAdapter(opts: {
  logger: Logger
  rates: readonly TaxRate[]
}): TaxAdapter {
  const { logger, rates } = opts
  return {
    kind: 'tax',
    providerName: 'native',
    capabilities: () => ['quote', 'codes', 'inclusive'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
    async quote(params) {
      const quote = quoteNative(rates, params)
      logger.debug({ reference: params.reference, totalTaxMinor: quote.totalTaxMinor }, 'tax.quote')
      return quote
    },
  }
}
