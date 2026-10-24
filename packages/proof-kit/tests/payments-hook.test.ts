import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { stubPaymentWebhook } from '@nymbalhq/proof-kit/payments'
import { createLogger, createNativeStubPaymentsAdapter } from '@nymbalhq/platform'

// AC-13: the request stubPaymentWebhook builds is one the real route accepts (a stripe-signature header, a body the
// stub adapter's parseWebhook reads back field for field) and carries id = eventId, generated unique when absent.

const payments = createNativeStubPaymentsAdapter({
  logger: createLogger({ pretty: false, level: 'error' }),
})

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

const hookOptions = fc.record(
  {
    paymentIntentId: fc.string({ minLength: 1, maxLength: 40 }),
    amountMinor: fc.integer({ min: 1, max: 1_000_000_000 }),
    currency: fc.constantFrom('GBP', 'USD', 'EUR', 'JPY', 'KWD'),
    kind: fc.constantFrom('payment.captured' as const, 'payment.failed' as const),
    eventId: fc.string({ minLength: 1, maxLength: 40 }),
  },
  { requiredKeys: ['paymentIntentId', 'amountMinor', 'currency'] },
)

describe('AC-13: stubPaymentWebhook builds a request the real route accepts', () => {
  it('AC-13: a stripe-signature header, and a body parseWebhook reads back with id = eventId and every field given', async () => {
    await fc.assert(
      fc.asyncProperty(hookOptions, async (opts) => {
        const request = stubPaymentWebhook(opts)
        expect({ method: request.method, path: request.path }).toEqual({
          method: 'POST',
          path: '/api/webhooks/stripe',
        })
        const signature = header(request.headers, 'stripe-signature')
        expect(signature?.length ?? 0).toBeGreaterThan(0)

        const body = JSON.parse(request.body) as { id?: unknown }
        expect(body.id).toBe(opts.eventId ?? body.id)
        expect(typeof body.id === 'string' && body.id.length > 0).toBe(true)

        const parsed = await payments.parseWebhook(Buffer.from(request.body), signature!)
        expect(parsed).toMatchObject({
          verified: true,
          eventId: body.id,
          kind: opts.kind ?? 'payment.captured',
          paymentIntentId: opts.paymentIntentId,
          amountMinor: opts.amountMinor,
          currency: opts.currency,
        })
      }),
      { numRuns: 200 },
    )
  })

  it('AC-13: without an eventId, 100 calls produce 100 distinct ids', () => {
    const ids = Array.from({ length: 100 }, () => {
      const request = stubPaymentWebhook({
        paymentIntentId: 'pi_same',
        amountMinor: 1000,
        currency: 'GBP',
      })
      return (JSON.parse(request.body) as { id: string }).id
    })
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
