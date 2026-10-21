import { describe, expect, it } from 'vitest'
import type { TaxAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

const REQUEST = {
  currency: 'GBP',
  shippingCountry: 'GB',
  shippingRegion: 'England',
  lines: [{ amountMinor: 1000, qty: 2 }],
}

export function runTaxContract(
  name: string,
  build: Build<TaxAdapter>,
  options: ContractOptions<TaxAdapter> = {},
): void {
  describe(`TaxAdapter contract: ${name}`, () => {
    it(
      'calculate returns totalTaxMinor >= 0',
      async () => {
        const adapter = await build()
        const result = await adapter.calculate(REQUEST)
        expect(typeof result.totalTaxMinor).toBe('number')
        expect(result.totalTaxMinor).toBeGreaterThanOrEqual(0)
        expect(result.ratePerLine).toHaveLength(1)
        expect(typeof result.ratePerLine[0]!.taxMinor).toBe('number')
      },
      CASE_MS,
    )

    it(
      'calculate with zero amount returns zero tax',
      async () => {
        const adapter = await build()
        const result = await adapter.calculate({
          ...REQUEST,
          lines: [{ amountMinor: 0, qty: 1 }],
        })
        expect(result.totalTaxMinor).toBe(0)
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'calculate()', (adapter) =>
      adapter.calculate(REQUEST),
    )
  })
}
