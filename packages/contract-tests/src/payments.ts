import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PaymentsAdapter, ProviderRefund } from '@nymbalhq/types'
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

/** The refunds the adapter lists for the payment; an adapter that cannot read them lists nothing and so fails below. */
async function refundsListed(
  adapter: Partial<Pick<PaymentsAdapter, 'listRefunds'>>,
  paymentId: string,
): Promise<ProviderRefund[]> {
  return (await adapter.listRefunds?.(paymentId)) ?? []
}

async function capturedIntent(adapter: PaymentsAdapter, amountMinor: number) {
  const intent = await adapter.createPaymentIntent({
    amountMinor,
    currency: 'GBP',
    orderRef: `contract-${randomUUID()}`,
  })
  if (intent.status !== 'succeeded') await adapter.capturePayment(intent.id)
  return intent
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

    // Listing goes through the published contract's own method: an adapter that loses the key, lists another payment's
    // refund or moves money while it reads fails here, whatever else it does right.
    it(
      'refund list: a refund made under key K appears once with K and its amount, a keyless one with null, and another intent’s refunds are absent',
      async () => {
        const adapter = await build()
        const intent = await capturedIntent(adapter, TOTAL)
        const other = await capturedIntent(adapter, TOTAL)
        const key = `contract-list-${randomUUID()}`
        const keyed = await adapter.refund(intent.id, 300, 'requested_by_customer', {
          idempotencyKey: key,
        })
        const plain = await adapter.refund(intent.id, 200, 'requested_by_customer')
        await adapter.refund(other.id, 150, 'requested_by_customer', {
          idempotencyKey: `contract-list-other-${randomUUID()}`,
        })

        const listed = await refundsListed(adapter, intent.id)

        expect(
          listed.map((r) => r.refundId).sort(),
          'the list is exactly the two refunds of this intent',
        ).toEqual([keyed.refundId, plain.refundId].sort())
        const byKey = listed.find((r) => r.refundId === keyed.refundId)
        expect(byKey?.idempotencyKey).toBe(key)
        expect(byKey?.amountMinor).toBe(300)
        const noKey = listed.find((r) => r.refundId === plain.refundId)
        expect(noKey?.idempotencyKey).toBeNull()
        expect(noKey?.amountMinor).toBe(200)
      },
      CASE_MS,
    )

    it(
      'refund list: a lookup moves no money: the remainder still refunds exactly, and one minor unit more is refund_rejected',
      async () => {
        const adapter = await build()
        const intent = await capturedIntent(adapter, TOTAL)
        const half = Math.floor(TOTAL / 2)
        const key = `contract-lookup-${randomUUID()}`
        await adapter.refund(intent.id, half, 'requested_by_customer', { idempotencyKey: key })

        const seen = await refundsListed(adapter, intent.id)
        await refundsListed(adapter, intent.id)

        expect(seen.map((r) => r.amountMinor)).toEqual([half])
        const rest = await adapter.refund(intent.id, TOTAL - half, 'requested_by_customer', {
          idempotencyKey: `${key}-rest`,
        })
        expect(rest.amountMinor).toBe(TOTAL - half)
        const over = await rejectionCode(
          adapter.refund(intent.id, 1, 'requested_by_customer', { idempotencyKey: `${key}-over` }),
        )
        expect(over, 'a lookup left less to refund, or more').toBe('payment.refund_rejected')
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
