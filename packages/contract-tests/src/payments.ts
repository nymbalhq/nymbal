import { describe, it, expect } from 'vitest'
import type { PaymentsAdapter } from '@nymbal/types'

export function runPaymentsContract(build: () => PaymentsAdapter): void {
  describe('PaymentsAdapter contract', () => {
    it('createPaymentIntent returns a clientSecret and id', async () => {
      const adapter = build()
      const intent = await adapter.createPaymentIntent({
        amountMinor: 1000,
        currency: 'GBP',
        orderRef: 'test-order-1',
      })
      expect(intent.id).toBeTruthy()
      expect(intent.clientSecret).toBeTruthy()
      expect(intent.amountMinor).toBe(1000)
      expect(intent.currency).toBe('GBP')
    })

    it('getPaymentStatus returns a valid status', async () => {
      const adapter = build()
      const intent = await adapter.createPaymentIntent({ amountMinor: 500, currency: 'GBP' })
      const status = await adapter.getPaymentStatus(intent.id)
      expect(typeof status).toBe('string')
      expect(['requires_payment_method', 'requires_confirmation', 'requires_action',
               'processing', 'requires_capture', 'succeeded', 'cancelled', 'failed',
              ]).toContain(status)
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
