import type { Logger, TaxAdapter } from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

export function createNativeTaxAdapter(logger: Logger, defaultRate = 0): TaxAdapter {
  return {
    kind: 'tax',
    providerName: 'native',
    capabilities: ['flat-rate'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
    async calculate(params) {
      const ratePerLine = params.lines.map((l) => ({
        taxMinor: Math.round(l.amountMinor * l.qty * defaultRate),
      }))
      const totalTaxMinor = ratePerLine.reduce((s, l) => s + l.taxMinor, 0)
      logger.debug({ defaultRate, totalTaxMinor }, 'tax.calculate')
      return { totalTaxMinor, ratePerLine }
    },
  }
}
