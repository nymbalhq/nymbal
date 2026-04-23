import { describe, it, expect } from 'vitest'
import type { TaxAdapter } from '@nymbal/types'

export function runTaxContract(build: () => TaxAdapter): void {
  describe('TaxAdapter contract', () => {
    it('calculate returns totalTaxMinor >= 0', async () => {
      const adapter = build()
      const result = await adapter.calculate({
        currency: 'GBP',
        shippingCountry: 'GB',
        shippingRegion: 'England',
        lines: [{ amountMinor: 1000, qty: 2 }],
      })
      expect(typeof result.totalTaxMinor).toBe('number')
      expect(result.totalTaxMinor).toBeGreaterThanOrEqual(0)
      expect(result.ratePerLine).toHaveLength(1)
      expect(typeof result.ratePerLine[0]!.taxMinor).toBe('number')
    })

    it('calculate with zero amount returns zero tax', async () => {
      const adapter = build()
      const result = await adapter.calculate({
        currency: 'GBP',
        shippingCountry: 'GB',
        shippingRegion: 'England',
        lines: [{ amountMinor: 0, qty: 1 }],
      })
      expect(result.totalTaxMinor).toBe(0)
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
