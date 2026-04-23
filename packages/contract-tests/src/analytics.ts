import { describe, it, expect } from 'vitest'
import type { AnalyticsAdapter } from '@nymbal/types'

export function runAnalyticsContract(build: () => AnalyticsAdapter): void {
  describe('AnalyticsAdapter contract', () => {
    it('track resolves without throwing', async () => {
      const adapter = build()
      await expect(adapter.track('product_viewed', {
        productId: 'prod-1',
        source: 'test',
      })).resolves.not.toThrow()
    })

    it('identify resolves without throwing', async () => {
      const adapter = build()
      await expect(adapter.identify('user-1', {
        email: 'test@example.com',
        plan: 'free',
      })).resolves.not.toThrow()
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
