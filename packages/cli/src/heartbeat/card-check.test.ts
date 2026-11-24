import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PaymentError, type PaymentsAdapter, type Refund } from '@nymbalhq/types'
import { runCardCheck } from './index.js'

// The heartbeat's card check at the payments adapter, with an adapter the test scripts: the saved card's charge
// answers what a case says, and so does its refund. The check refunds exactly what was captured, once, under a key
// derived from the run, and reports each way the money can be left on the card with the payment that holds it.

type Charged =
  | { status: 'captured'; paymentId: string; amountMinor: number; currency: string }
  | { status: 'card_refused' | 'key_refused'; detail: string }
  | { status: 'provider_unreachable'; detail: string; paymentId?: string }

interface ChargeAsked {
  customerRef: string
  paymentMethodRef: string
  amountMinor: number
  currency: string
  idempotencyKey: string
  metadata?: Record<string, string>
}

interface RefundAsked {
  paymentId: string
  amountMinor: number | undefined
  reason: string | undefined
  opts: { idempotencyKey?: string; currency?: string } | undefined
}

/** A refund's answer: its status and, when given, an amount other than the one asked. */
type RefundScript =
  | { status: Refund['status']; amountMinor?: number }
  | { throws: 'refund_rejected' | 'refund_unknown' }

interface Scripted {
  adapter: PaymentsAdapter
  charges: ChargeAsked[]
  refunds: RefundAsked[]
}

/** A payments adapter with the saved-card capability whose charge answers `charged` and whose refund answers `refund`. */
function scripted(
  charged: (asked: ChargeAsked) => Charged,
  refund: RefundScript = { status: 'succeeded' },
): Scripted {
  const charges: ChargeAsked[] = []
  const refunds: RefundAsked[] = []
  const unused = async (): Promise<never> => {
    throw new Error('the card check called a payments method it has no use for')
  }
  const adapter = {
    kind: 'payments' as const,
    providerName: 'scripted',
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    capabilities: () => ['intent', 'capture', 'refund', 'saved-card'],
    async chargeSavedCard(asked: ChargeAsked): Promise<Charged> {
      charges.push(structuredClone(asked))
      return charged(asked)
    },
    async refund(
      paymentId: string,
      amountMinor?: number,
      reason?: string,
      opts?: { idempotencyKey?: string; currency?: string },
    ): Promise<Refund> {
      refunds.push({ paymentId, amountMinor, reason, opts: structuredClone(opts) })
      if ('throws' in refund) throw new PaymentError(refund.throws, `scripted ${refund.throws}`)
      return {
        refundId: `re_${refunds.length}`,
        paymentId,
        amountMinor: refund.amountMinor ?? amountMinor ?? 0,
        currency: opts?.currency ?? 'GBP',
        reason: reason ?? null,
        status: refund.status,
      }
    },
    createPaymentIntent: unused,
    capturePayment: unused,
    listRefunds: unused,
    getPaymentStatus: unused,
    getPaymentIntent: unused,
    cancelPaymentIntent: unused,
    parseWebhook: unused,
  }
  return { adapter: adapter as unknown as PaymentsAdapter, charges, refunds }
}

const captured =
  (paymentId: string) =>
  (asked: ChargeAsked): Charged => ({
    status: 'captured',
    paymentId,
    amountMinor: asked.amountMinor,
    currency: asked.currency,
  })

const CARD = {
  customer: 'cus_heartbeat',
  paymentMethod: 'pm_heartbeat',
  amountMinor: 100,
  currency: 'GBP',
}
const CURRENCIES = ['GBP', 'USD', 'EUR', 'JPY', 'SEK'] as const

/** An amount as the check's line writes it: in the currency's major unit. */
function major(amountMinor: number, currency: string): string {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  return (amountMinor / 10 ** digits).toFixed(digits)
}

describe('AC-12: the card check charges the saved card and refunds it', () => {
  // Kills: money left on the card (no refund), a partial or second refund, a refund of the configured amount rather
  // than the one captured, a charge of another card or amount.
  it('AC-12: property: a captured charge of the card asked is refunded once, for the captured amount in its currency with reason requested_by_customer and a key, and the check is ok', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom(...CURRENCIES),
        fc.stringMatching(/^pi_[A-Za-z0-9]{6,12}$/),
        async (amountMinor, currency, paymentId) => {
          const s = scripted(captured(paymentId))
          const result = await runCardCheck(
            s.adapter,
            { ...CARD, amountMinor, currency },
            { runId: 'run-1' },
          )

          expect(
            s.charges.map((c) => [c.customerRef, c.paymentMethodRef, c.amountMinor, c.currency]),
          ).toEqual([[CARD.customer, CARD.paymentMethod, amountMinor, currency]])
          expect(s.refunds).toHaveLength(1)
          const [refund] = s.refunds
          expect([refund!.paymentId, refund!.amountMinor, refund!.reason]).toEqual([
            paymentId,
            amountMinor,
            'requested_by_customer',
          ])
          expect(refund!.opts?.currency).toBe(currency)
          expect(typeof refund!.opts?.idempotencyKey).toBe('string')
          expect({
            check: result.check,
            status: result.status,
            paymentId: result.paymentId,
          }).toEqual({
            check: 'card',
            status: 'ok',
            paymentId,
          })
          expect(result.refund).toBe('succeeded')
        },
      ),
      { numRuns: 50 },
    )
  })

  // Kills: a fresh random key each call (a retried run would refund twice) or one fixed key (every run's refund is the
  // first run's, so only the first is ever refunded).
  it('AC-12: property: the refund key is derived from the run: the same run id gives the same key, two run ids two keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z0-9-]{4,20}$/),
        fc.stringMatching(/^[a-z0-9-]{4,20}$/),
        async (a, b) => {
          fc.pre(a !== b)
          const keyOf = async (runId: string) => {
            const s = scripted(captured('pi_same'))
            await runCardCheck(s.adapter, CARD, { runId })
            return s.refunds[0]!.opts!.idempotencyKey
          }
          const [first, again, other] = [await keyOf(a), await keyOf(a), await keyOf(b)]
          expect(first).toBe(again)
          expect(other).not.toBe(first)
        },
      ),
      { numRuns: 25 },
    )
  })

  // Kills: a refund the provider has not finished reported as failed, or as done with nothing said.
  it('AC-12: a refund answered pending is ok with refund pending, and its detail says pending', async () => {
    const s = scripted(captured('pi_pending'), { status: 'pending' })
    const result = await runCardCheck(s.adapter, CARD, { runId: 'run-pending' })
    expect({ status: result.status, refund: result.refund }).toEqual({
      status: 'ok',
      refund: 'pending',
    })
    expect(result.detail).toMatch(/pending/i)
    expect(s.refunds).toHaveLength(1)
  })

  // Kills: a refund for less than was captured reported as ok, so the rest stays on the card unreported.
  it('AC-12: property: a refund answered succeeded for less than the captured amount is refund_failed naming the payment and both amounts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 1_000_000 })
          .chain((amount) =>
            fc.tuple(fc.constant(amount), fc.integer({ min: 1, max: amount - 1 })),
          ),
        fc.constantFrom(...CURRENCIES),
        async ([amountMinor, refundedMinor], currency) => {
          const s = scripted(captured('pi_partial'), {
            status: 'succeeded',
            amountMinor: refundedMinor,
          })
          const result = await runCardCheck(
            s.adapter,
            { ...CARD, amountMinor, currency },
            { runId: 'run-partial' },
          )
          expect({ status: result.status, paymentId: result.paymentId }).toEqual({
            status: 'refund_failed',
            paymentId: 'pi_partial',
          })
          expect(s.refunds.map((r) => r.amountMinor)).toEqual([amountMinor])
          expect(result.detail).toContain('pi_partial')
          for (const amount of [amountMinor, refundedMinor]) {
            expect(result.detail).toContain(major(amount, currency))
          }
        },
      ),
      { numRuns: 30 },
    )
  })

  // Kills: a refund that did not happen (or may not have) reported as ok, or reported without the payment to refund.
  it('AC-12: a refund answered failed, or throwing refund_rejected or refund_unknown, is refund_failed naming the payment', async () => {
    const scripts: RefundScript[] = [
      { status: 'failed' },
      { throws: 'refund_rejected' },
      { throws: 'refund_unknown' },
    ]
    for (const script of scripts) {
      const paymentId = `pi_left_${JSON.stringify(script).replace(/\W/g, '')}`
      const s = scripted(captured(paymentId), script)
      const result = await runCardCheck(s.adapter, CARD, { runId: 'run-refund-failed' })
      expect({ script, status: result.status, paymentId: result.paymentId }).toEqual({
        script,
        status: 'refund_failed',
        paymentId,
      })
      expect(result.detail).toContain(paymentId)
    }
  })

  // Kills: a refund attempted on a charge that never happened, or the provider's answer folded into one failure.
  it('AC-12: card_refused, key_refused and provider_unreachable are reported as that status, with the payment when given, and nothing is refunded', async () => {
    const outcomes: Charged[] = [
      { status: 'card_refused', detail: 'card_declined: insufficient_funds' },
      { status: 'key_refused', detail: 'Invalid API key' },
      { status: 'provider_unreachable', detail: 'connect ECONNREFUSED' },
      {
        status: 'provider_unreachable',
        detail: 'payment pi_processing still processing',
        paymentId: 'pi_processing',
      },
    ]
    for (const outcome of outcomes) {
      const s = scripted(() => outcome)
      const result = await runCardCheck(s.adapter, CARD, { runId: 'run-refused' })
      expect({ status: result.status, paymentId: result.paymentId }).toEqual({
        status: outcome.status,
        paymentId: 'paymentId' in outcome ? outcome.paymentId : undefined,
      })
      expect(s.refunds).toEqual([])
    }
  })
})
