import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PaymentsAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

export interface PaymentsContractOptions extends ContractOptions<PaymentsAdapter> {
  /** One webhook as the provider would deliver it, signed. Given, the suite parses it twice and compares. */
  signedWebhook?: () => { rawBody: string | Buffer; signature: string }
}

/** The intent amount of the refund idempotency case: odd, so its two halves differ. */
const TOTAL = 1999

/** The code a call rejected with, or null when it resolved. */
async function rejectionCode(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => null,
    (err: unknown) => (err as { code?: unknown } | null)?.code ?? err,
  )
}

export function runPaymentsContract(
  name: string,
  build: Build<PaymentsAdapter>,
  options: PaymentsContractOptions = {},
): void {
  describe(`PaymentsAdapter contract: ${name}`, () => {
    it(
      'createPaymentIntent returns a clientSecret and id',
      async () => {
        const adapter = await build()
        const intent = await adapter.createPaymentIntent({
          amountMinor: 1000,
          currency: 'GBP',
          orderRef: `contract-${randomUUID()}`,
        })
        expect(intent.id).toBeTruthy()
        expect(intent.clientSecret).toBeTruthy()
        expect(intent.amountMinor).toBe(1000)
        expect(intent.currency).toBe('GBP')
      },
      CASE_MS,
    )

    it(
      'getPaymentStatus returns a valid status',
      async () => {
        const adapter = await build()
        const intent = await adapter.createPaymentIntent({ amountMinor: 500, currency: 'GBP' })
        const status = await adapter.getPaymentStatus(intent.id)
        expect([
          'requires_payment_method',
          'requires_confirmation',
          'requires_action',
          'processing',
          'requires_capture',
          'succeeded',
          'cancelled',
          'failed',
        ]).toContain(status)
      },
      CASE_MS,
    )

    // Seen through the payments surface alone: after T/2 twice under one key, the remainder still fits and one more
    // minor unit does not, which holds only when the retry refunded nothing. Kills: a retry that refunds again.
    it(
      'idempotency: a refund repeated with the same idempotencyKey returns the same refund and refunds once',
      async () => {
        const adapter = await build()
        const intent = await adapter.createPaymentIntent({
          amountMinor: TOTAL,
          currency: 'GBP',
          orderRef: `contract-${randomUUID()}`,
        })
        if (intent.status !== 'succeeded') await adapter.capturePayment(intent.id)
        const half = Math.floor(TOTAL / 2)
        const key = `contract-refund-${randomUUID()}`

        const first = await adapter.refund(intent.id, half, 'requested_by_customer', {
          idempotencyKey: key,
        })
        const again = await adapter.refund(intent.id, half, 'requested_by_customer', {
          idempotencyKey: key,
        })
        expect(again.refundId, 'the retry under the same key made another refund').toBe(
          first.refundId,
        )
        expect(again.amountMinor).toBe(first.amountMinor)

        const rest = await adapter.refund(intent.id, TOTAL - half, 'requested_by_customer', {
          idempotencyKey: `${key}-rest`,
        })
        expect(rest.amountMinor + first.amountMinor).toBe(TOTAL)
        const over = await rejectionCode(
          adapter.refund(intent.id, 1, 'requested_by_customer', { idempotencyKey: `${key}-over` }),
        )
        expect(over, 'a minor unit past the amount was refunded').toBe('payment.refund_rejected')
      },
      CASE_MS,
    )

    const signedWebhook = options.signedWebhook
    if (signedWebhook !== undefined) {
      it(
        'idempotency: parsing one signed webhook event twice gives equal results',
        async () => {
          const adapter = await build()
          const { rawBody, signature } = signedWebhook()
          const first = await adapter.parseWebhook(rawBody, signature)
          const second = await adapter.parseWebhook(rawBody, signature)
          expect(second).toEqual(first)
        },
        CASE_MS,
      )
    }

    healthAndDowntime(build, options.unreachable, 'createPaymentIntent()', (adapter) =>
      adapter.createPaymentIntent({ amountMinor: 100, currency: 'GBP' }),
    )
  })
}
