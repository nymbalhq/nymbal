import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { createNativeStubPaymentsAdapter, createLogger } from '@nymbalhq/platform'
import type { PaymentsAdapter } from '@nymbalhq/types'

// The payments contract on the native stub, the refund idempotency case and the saved-card case included, and, since
// `signedWebhook` is given, parsing one webhook twice. The stub verifies no signature, so its "signed" webhook is the unsigned JSON body it
// reads, with an event id so two parses can be equal.

const logger = createLogger({ pretty: false, level: 'error' })

runPaymentsContract('native-stub', () => createNativeStubPaymentsAdapter({ logger }), {
  savedCard: () => ({ customerRef: 'cus_stub_ok', paymentMethodRef: 'pm_stub' }),
  signedWebhook: () => ({
    rawBody: JSON.stringify({
      id: 'evt_stub_contracts',
      kind: 'payment.captured',
      paymentIntentId: 'pi_stub_contracts_not_held',
      amountMinor: 1234,
      currency: 'GBP',
    }),
    signature: '',
  }),
})

type SavedCardStub = PaymentsAdapter & {
  chargeSavedCard?: (charge: {
    customerRef: string
    paymentMethodRef: string
    amountMinor: number
    currency: string
    idempotencyKey: string
  }) => Promise<{ status: string; paymentId?: string; detail?: string }>
}

describe('the native stub’s saved card', () => {
  // Kills: the stub's declining customer charged anyway, or answered with a payment the heartbeat would then refund.
  it('AC-7: on the stub, the customer cus_stub_decline is card_refused and holds no payment, while cus_stub_ok on the same adapter is captured, and a retry under its key is that same charge', async () => {
    const stub = createNativeStubPaymentsAdapter({ logger }) as SavedCardStub
    expect(stub.capabilities()).toContain('saved-card')
    const charge = (customerRef: string, idempotencyKey = `stub-decline-${randomUUID()}`) =>
      stub.chargeSavedCard!({
        customerRef,
        paymentMethodRef: 'pm_stub',
        amountMinor: 100,
        currency: 'GBP',
        idempotencyKey,
      })
    const okKey = `stub-ok-${randomUUID()}`
    const declined = await charge('cus_stub_decline')
    const captured = await charge('cus_stub_ok', okKey)
    expect(declined).toEqual({ status: 'card_refused', detail: expect.any(String) })
    expect(captured.status).toBe('captured')
    expect(captured).toEqual(await charge('cus_stub_ok', okKey))
    if (captured.status !== 'captured') return
    await expect(stub.getPaymentStatus(captured.paymentId)).resolves.toBe('succeeded')
  })
})
