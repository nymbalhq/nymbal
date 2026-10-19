import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../logger.js'
import { createNativeStubPaymentsAdapter } from './native-stub.js'

// P1-12 decisions 1, 7 and 11: the stub reports when money is captured. By the receipt email's local part it answers
// like Stripe's test cards: `+stub-pending` needs action, `+stub-decline` fails, anything else succeeds at creation (a
// synchronous capture). `cancelPaymentIntent` marks the intent cancelled. AC-2, AC-3, AC-4 and AC-9 lean on these
// triggers; this pins them where they are decided. Kills: a trigger matched anywhere in the address (or not at the end
// of the local part), the default left at `requires_confirmation`, and a cancel the intent does not remember.

const stub = () =>
  createNativeStubPaymentsAdapter({ logger: createLogger({ pretty: false, level: 'error' }) })

const localPart = fc.stringMatching(/^[a-z][a-z0-9.]{0,15}$/)
const domain = fc.constantFrom('p1-12.test', 'example.com', 'shop.dev')

describe('native-stub payments: the receipt email decides the outcome', () => {
  it('AC-2 (decision 7): over generated addresses, +stub-pending answers requires_action, +stub-decline failed, and any other address succeeded; the intent keeps the amount and currency', async () => {
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

  it('AC-2 (decision 7): a trigger in the domain, not the local part, does not count', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 500,
      currency: 'GBP',
      receiptEmail: 'ada@stub-pending.test',
    })
    expect(intent.status).toBe('succeeded')
  })

  it('AC-12 (decision 11): cancelPaymentIntent marks a pending intent cancelled', async () => {
    const adapter = stub()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 900,
      currency: 'GBP',
      receiptEmail: 'ada+stub-pending@p1-12.test',
    })
    const before = await adapter.getPaymentStatus(intent.id)

    await adapter.cancelPaymentIntent(intent.id)

    expect(before).toBe('requires_action')
    expect(await adapter.getPaymentStatus(intent.id)).toBe('cancelled')
  })
})
