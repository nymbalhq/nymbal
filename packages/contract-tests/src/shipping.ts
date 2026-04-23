import { describe, it, expect } from 'vitest'
import type { ShippingAdapter } from '@nymbal/types'

export function runShippingContract(build: () => ShippingAdapter): void {
  describe('ShippingAdapter contract', () => {
    it('rate returns an array of shipping options', async () => {
      const adapter = build()
      const rates = await adapter.rate({
        fromPostalCode: 'SW1A 1AA',
        toPostalCode: 'EC1A 1BB',
        toCountry: 'GB',
        weightGrams: 500,
        currency: 'GBP',
      })
      expect(Array.isArray(rates)).toBe(true)
      if (rates.length > 0) {
        const rate = rates[0]!
        expect(typeof rate.amountMinor).toBe('number')
        expect(typeof rate.carrier).toBe('string')
        expect(typeof rate.estimatedDays).toBe('number')
      }
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
