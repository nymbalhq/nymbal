import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../logger.js'
import { createNativeStubPaymentsAdapter } from './native-stub.js'

// The stub reports when money is captured. By the receipt email's local part it answers like Stripe's test cards:
// `+stub-pending` needs action, `+stub-decline` fails, anything else succeeds at creation (a synchronous capture).
// `cancelPaymentIntent` marks the intent cancelled. Other tests lean on these triggers; this pins them.

const stub = () =>
  createNativeStubPaymentsAdapter({ logger: createLogger({ pretty: false, level: 'error' }) })

/** What the stub's own list answers; an adapter without one lists nothing. */
async function refundList(
  adapter: ReturnType<typeof stub>,
  paymentId: string,
): Promise<Array<{ refundId: string; amountMinor: number; status: string; idempotencyKey: string | null }>> {
  const list = adapter as unknown as { listRefunds?: (id: string) => Promise<never[]> }
  return (await list.listRefunds?.(paymentId)) ?? []
}

const localPart = fc.stringMatching(/^[a-z][a-z0-9.]{0,15}$/)
const domain = fc.constantFrom('checkout.test', 'example.com', 'shop.dev')

describe('native-stub payments: refunds it can list', () => {
  const webhookBody = (paymentIntentId: string, refund?: { id: string; amountMinor: number; status?: string }) =>
    JSON.stringify({ id: 'evt_listed', kind: 'payment.refunded', paymentIntentId, ...(refund && { refund }) })

  // Defect: the stub cannot stand in for a dashboard refund, so nothing above can be tested through the real route.
  it('AC-14: a payment.refunded body holds its refund on the intent once per id, listRefunds returns it keyless, and parseWebhook answers kind and paymentIntentId as sent', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({ amountMinor: 5_000, currency: 'GBP' })
    const refund = { id: 're_dashboard', amountMinor: 1_200 }

    const parsed = await adapter.parseWebhook(webhookBody(intent.id, refund), '')
    await adapter.parseWebhook(webhookBody(intent.id, refund), '')

    expect([parsed.kind, parsed.paymentIntentId]).toEqual(['payment.refunded', intent.id])
    const listed = await refundList(adapter, intent.id)
    expect(listed.map((r) => [r.refundId, r.amountMinor, r.idempotencyKey, r.status])).toEqual([
      ['re_dashboard', 1_200, null, 'succeeded'],
    ])
  })

  // Defect: the stub loses a keyed refund, so a pending row can never be matched.
  it('AC-14: a keyed refund lists with its key, a keyless one with null, and an intent the process no longer holds lists empty', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({ amountMinor: 5_000, currency: 'GBP' })
    const keyed = await adapter.refund(intent.id, 500, 'requested_by_customer', {
      idempotencyKey: 'row-1',
    })
    const plain = await adapter.refund(intent.id, 300, 'requested_by_customer')

    const listed = await refundList(adapter, intent.id)
    const byId = new Map(listed.map((r) => [r.refundId, r]))

    expect(byId.size).toBe(2)
    expect(byId.get(keyed.refundId)?.idempotencyKey).toBe('row-1')
    expect(byId.get(plain.refundId)?.idempotencyKey).toBeNull()
    expect(await refundList(adapter, 'pi_stub_forgotten')).toEqual([])
    expect(await refundList(adapter, intent.id)).toHaveLength(listed.length)
  })
})

describe('native-stub payments: the receipt email decides the outcome', () => {
  it('AC-2: over generated addresses, +stub-pending answers requires_action, +stub-decline failed, and any other address succeeded; the intent keeps the amount and currency', async () => {
    await fc.assert(
      fc.asyncProperty(
        localPart,
        fc.constantFrom('', '+stub-pending', '+stub-decline', '+stub-pendingx', '+other'),
        domain,
        fc.integer({ min: 1, max: 1_000_000 }),
        async (local, suffix, host, amountMinor) => {
          const adapter = stub()
          const intent = await adapter.createPaymentIntent({
            amountMinor,
            currency: 'GBP',
            receiptEmail: `${local}${suffix}@${host}`,
          })
          const expected =
            suffix === '+stub-pending'
              ? 'requires_action'
              : suffix === '+stub-decline'
                ? 'failed'
                : 'succeeded'
          expect(intent.status).toBe(expected)
          expect(await adapter.getPaymentStatus(intent.id)).toBe(intent.status)
          expect(intent.amountMinor).toBe(amountMinor)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-2: a trigger in the domain, not the local part, does not count', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 500,
      currency: 'GBP',
      receiptEmail: 'ada@stub-pending.test',
    })
    expect(intent.status).toBe('succeeded')
  })

  it('AC-12: cancelPaymentIntent marks a pending intent cancelled', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 900,
      currency: 'GBP',
      receiptEmail: 'ada+stub-pending@checkout.test',
    })
    const before = await adapter.getPaymentStatus(intent.id)

    await adapter.cancelPaymentIntent(intent.id)

    expect(before).toBe('requires_action')
    expect(await adapter.getPaymentStatus(intent.id)).toBe('cancelled')
  })
})
