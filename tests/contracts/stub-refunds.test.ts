import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createLogger, createNativeStubPaymentsAdapter } from '@nymbalhq/platform'
import { PaymentError, type PaymentsAdapter } from '@nymbalhq/types'

// AC-9: the stub refunds like a provider, within its memory. It refuses an id it did not mint, an intent it holds that
// was never captured, and more than it captured on an intent it holds; it accepts its own id after a restart (a new
// adapter, an empty memory), where the service's refundable check is the guard; and it answers in the intent's
// currency.

const logger = createLogger({ pretty: false, level: 'error' })
const build = (): PaymentsAdapter => createNativeStubPaymentsAdapter({ logger })

/** The rejection a refund call ended in, or null when it resolved. */
async function rejection(call: Promise<unknown>): Promise<PaymentError | null> {
  return call.then(
    () => null,
    (err: unknown) => {
      if (!(err instanceof PaymentError)) throw err
      return err
    },
  )
}

describe('native stub: refunds (AC-9)', () => {
  it('AC-9: a refund of an id the stub did not mint (not pi_stub_) is refused refund_rejected', async () => {
    const stub = build()
    for (const id of ['pi_3Nreal', 'pi_unknown_1', '']) {
      const err = await rejection(stub.refund(id, 100))
      expect(err?.code, id).toBe('payment.refund_rejected')
    }
  })

  it('AC-9: a refund of an intent the stub holds and never captured (+stub-pending) is refused refund_rejected', async () => {
    const stub = build()
    const intent = await stub.createPaymentIntent({
      amountMinor: 2_000,
      currency: 'GBP',
      receiptEmail: 'buyer+stub-pending@money.test',
    })
    expect(intent.status).not.toBe('succeeded')

    const err = await rejection(stub.refund(intent.id, 500))

    expect(err?.code).toBe('payment.refund_rejected')
  })

  it("AC-9: over generated refund sequences on a captured intent it holds, each refund is accepted iff it fits in what is left, in the intent's currency; Σ accepted never exceeds the capture", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 60_000 }), { minLength: 1, maxLength: 6 }),
        fc.constantFrom('EUR', 'JPY', 'GBP'),
        async (amountMinor, refunds, currency) => {
          const stub = build()
          const intent = await stub.createPaymentIntent({ amountMinor, currency })
          expect(intent.status).toBe('succeeded')
          let refunded = 0
          for (const requested of refunds) {
            const fits = refunded + requested <= amountMinor
            const outcome = await stub.refund(intent.id, requested).then(
              (answer) => ({
                amountMinor: answer.amountMinor,
                currency: answer.currency.toUpperCase(),
                status: answer.status as string,
              }),
              (err: unknown) => ({
                code: err instanceof PaymentError ? err.code : String(err),
              }),
            )
            expect(outcome).toEqual(
              fits
                ? {
                    amountMinor: requested,
                    currency: intent.currency.toUpperCase(),
                    status: 'succeeded',
                  }
                : { code: 'payment.refund_rejected' },
            )
            if (fits) refunded += requested
            expect(refunded).toBeLessThanOrEqual(amountMinor)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-9: after a restart (a new adapter, an empty memory) its own pi_stub_ id is accepted for the amount asked, in the currency the request names (opts.currency), and an id it never minted is still refused', async () => {
    const before = build()
    const intent = await before.createPaymentIntent({ amountMinor: 3_000, currency: 'GBP' })
    const after = build()

    const answer = await after.refund(intent.id, 1_200, 'requested_by_customer', {
      idempotencyKey: 'refund-row-1',
      currency: 'GBP',
    })
    const foreign = await rejection(
      after.refund(intent.id.replace(/^pi_stub_/, 'pi_other_'), 1_200, 'requested_by_customer', {
        currency: 'GBP',
      }),
    )

    expect(answer.status).toBe('succeeded')
    expect(answer.paymentId).toBe(intent.id)
    expect(answer.amountMinor).toBe(1_200)
    expect(answer.currency.toUpperCase()).toBe(intent.currency.toUpperCase())
    expect(foreign?.code).toBe('payment.refund_rejected')
  })
})

// AC-4: the stub keeps a key → refund map, so a refund repeated with the same idempotency key answers the first refund
// and refunds once. Seen through the payments surface alone: after T/2 twice under one key, the remainder still fits
// and one more minor unit does not.
describe('native stub: a refund repeated with one idempotency key refunds once', () => {
  it('AC-4: over generated amounts T, refunding T/2 twice under key K gives one refund id; T − T/2 then succeeds and one more minor unit is refund_rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 1_000_000 }),
        fc.constantFrom('EUR', 'JPY', 'GBP'),
        fc.uuid(),
        async (total, currency, key) => {
          const stub = build()
          const intent = await stub.createPaymentIntent({ amountMinor: total, currency })
          const half = Math.floor(total / 2)

          const first = await stub.refund(intent.id, half, 'requested_by_customer', {
            idempotencyKey: key,
          })
          const again = await stub.refund(intent.id, half, 'requested_by_customer', {
            idempotencyKey: key,
          })
          expect(again.refundId).toBe(first.refundId)
          expect(again.amountMinor).toBe(first.amountMinor)
          const rest = await stub.refund(intent.id, total - half, 'requested_by_customer', {
            idempotencyKey: `${key}-rest`,
          })
          const over = await rejection(
            stub.refund(intent.id, 1, 'requested_by_customer', { idempotencyKey: `${key}-over` }),
          )

          expect(rest.amountMinor + first.amountMinor).toBe(total)
          expect(over?.code).toBe('payment.refund_rejected')
        },
      ),
      { numRuns: 50 },
    )
  })
})
