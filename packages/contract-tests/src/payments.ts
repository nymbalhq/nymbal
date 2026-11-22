import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { PaymentsAdapter, ProviderRefund } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

export interface PaymentsContractOptions extends ContractOptions<PaymentsAdapter> {
  /** One webhook as the provider would deliver it, signed. Given, the suite parses it twice and compares. */
  signedWebhook?: () => { rawBody: string | Buffer; signature: string }
  /**
   * A saved card the provider charges in full: a customer and a payment method of its own. Given, the suite checks the
   * `saved-card` capability: the charge, its refund, and one refund under a repeated key.
   */
  savedCard?: () => { customerRef: string; paymentMethodRef: string }
}

/** A charge of a saved card, as the heartbeat's card check asks it. */
interface SavedCardRequest {
  customerRef: string
  paymentMethodRef: string
  amountMinor: number
  currency: string
  idempotencyKey: string
  metadata?: Record<string, string>
}

type SavedCardAnswer =
  | { status: 'captured'; paymentId: string; amountMinor: number; currency: string }
  | { status: 'card_refused' | 'key_refused'; detail: string }
  | { status: 'provider_unreachable'; detail: string; paymentId?: string }

/** An adapter as this suite reaches its saved-card charge: the optional method behind the capability. */
type SavedCardAdapter = PaymentsAdapter & {
  chargeSavedCard?: (charge: SavedCardRequest) => Promise<SavedCardAnswer>
}

/** Currencies with two, zero and three-letter-only minor units, upper-cased as the kernel names them. */
const SAVED_CARD_CURRENCIES = ['GBP', 'USD', 'EUR', 'JPY', 'SEK', 'CHF'] as const

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

    const savedCard = options.savedCard
    if (savedCard !== undefined) {
      // Kills: a charge that is not captured, an amount or currency that moves on the way, a refund of a saved-card
      // charge that is refused or partial, and a repeated refund key that refunds twice.
      it(
        'saved card: property: the adapter declares saved-card; chargeSavedCard captures exactly the amount and currency asked, a refund of it under key K returns that amount, and the same refund again under K is the same refund, the only one listed',
        async () => {
          const adapter = (await build()) as SavedCardAdapter
          expect(adapter.capabilities()).toContain('saved-card')
          await fc.assert(
            fc.asyncProperty(
              fc.integer({ min: 50, max: 500_000 }),
              fc.constantFrom(...SAVED_CARD_CURRENCIES),
              async (amountMinor, currency) => {
                const charged = await adapter.chargeSavedCard!({
                  ...savedCard(),
                  amountMinor,
                  currency,
                  idempotencyKey: `contract-charge-${randomUUID()}`,
                  metadata: { contract: 'saved-card' },
                })
                expect(charged.status, JSON.stringify(charged)).toBe('captured')
                if (charged.status !== 'captured') return
                expect(charged.amountMinor).toBe(amountMinor)
                expect(charged.currency).toBe(currency)

                const key = `contract-saved-refund-${randomUUID()}`
                const refund = await adapter.refund(
                  charged.paymentId,
                  charged.amountMinor,
                  'requested_by_customer',
                  { idempotencyKey: key, currency },
                )
                expect(refund.amountMinor).toBe(charged.amountMinor)
                expect(refund.status).not.toBe('failed')
                const again = await adapter.refund(
                  charged.paymentId,
                  charged.amountMinor,
                  'requested_by_customer',
                  { idempotencyKey: key, currency },
                )
                expect(again.refundId).toBe(refund.refundId)
                const listed = await refundsListed(adapter, charged.paymentId)
                expect(listed.map((r) => [r.refundId, r.amountMinor])).toEqual([
                  [refund.refundId, charged.amountMinor],
                ])
              },
            ),
            { numRuns: 12 },
          )
        },
        CASE_MS * 2,
      )
    }

    healthAndDowntime(build, options.unreachable, 'createPaymentIntent()', (adapter) =>
      adapter.createPaymentIntent({ amountMinor: 100, currency: 'GBP' }),
    )
  })
}
