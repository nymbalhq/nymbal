import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createLogger, createNativeStubPaymentsAdapter } from '@nymbalhq/platform'
import { PaymentError, type PaymentsAdapter } from '@nymbalhq/types'

// P1-13 AC-9 (decision 9, M6): the stub refunds like a provider, within its memory. It refuses an id it did not mint,
// an intent it holds that was never captured, and more than it captured on an intent it holds; it accepts its own id
// after a restart (a new adapter, an empty memory), where the service's refundable check is the guard; and it answers
// in the intent's currency. Kills: the stub still accepting any refund, and pre-restart orders made unrefundable.

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
      receiptEmail: 'buyer+stub-pending@p1-13.test',
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

  it('AC-9: after a restart (a new adapter, an empty memory) its own pi_stub_ id is accepted for the amount asked, and an id it never minted is still refused', async () => {
    const before = build()
    const intent = await before.createPaymentIntent({ amountMinor: 3_000, currency: 'GBP' })
    const after = build()

    const answer = await after.refund(intent.id, 1_200)
    const foreign = await rejection(
      after.refund(intent.id.replace(/^pi_stub_/, 'pi_other_'), 1_200),
    )

    expect(answer.status).toBe('succeeded')
    expect(answer.paymentId).toBe(intent.id)
    expect(answer.amountMinor).toBe(1_200)
    expect(foreign?.code).toBe('payment.refund_rejected')
  })
})
