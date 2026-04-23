import { describe, it, expect } from 'vitest'
import type { EmailAdapter } from '@nymbal/types'

export function runEmailContract(build: () => EmailAdapter): void {
  describe('EmailAdapter contract', () => {
    it('sendTransactional resolves with accepted or messageId', async () => {
      const adapter = build()
      const result = await adapter.sendTransactional({
        template: 'order-confirmation',
        to: 'test@example.com',
        vars: { orderNumber: 'ORD-001' },
      })
      expect(typeof result.accepted).toBe('boolean')
    })

    it('syncCustomerToList resolves without throwing', async () => {
      const adapter = build()
      await expect(adapter.syncCustomerToList({
        customerId: 'cust-1',
        orderCount: 0,
        totalSpentMinor: 0,
        segment: 'new',
        createdAt: new Date().toISOString(),
      })).resolves.not.toThrow()
    })

    it('removeCustomerFromList resolves without throwing', async () => {
      const adapter = build()
      await expect(adapter.removeCustomerFromList('cust-1')).resolves.not.toThrow()
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
