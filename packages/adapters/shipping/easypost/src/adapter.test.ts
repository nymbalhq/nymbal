import { describe, expect, it } from 'vitest'
import type { AdapterContext, Logger, ShippingAdapter, Slot } from '@nymbalhq/types'
import {
  EASYPOST_TEST_WEBHOOK_SECRET,
  signedPost,
  trackerEvent,
} from '../../../../../tests/support/easypost'
import { createAdapter, createEasyPostShippingAdapter } from './index.js'

// The package's entry as the kernel's loader calls it, and the three ShippingAdapter methods EasyPost serves none of
// here: the adapter only verifies and maps tracker webhooks, so a rate, a label or a lookup is refused, naming EasyPost
// and the method, never answered with something made up.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const ctx = (slot: Slot, config: Record<string, unknown>): AdapterContext => ({
  slot,
  config,
  logger,
  env: {},
})

/** What a call left behind: its value, or the error it rejected or threw with. */
async function outcomeOf(call: () => unknown): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await call() }
  } catch (error) {
    return { error }
  }
}

describe('AC-4: the package builds the easypost shipping adapter', () => {
  it('AC-4: createAdapter on the shipping slot builds the easypost adapter with the config block’s secret: a post signed with it verifies as it does on the adapter built directly, one signed with another does not', async () => {
    const a = createAdapter(
      ctx('shipping', { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET }),
    ) as ShippingAdapter
    const event = trackerEvent('9400100000000000000003', 'delivered')

    const real = signedPost(event)
    const wrong = signedPost(event, `${EASYPOST_TEST_WEBHOOK_SECRET}-other`)

    const right = await a.receiveWebhook!(real.rawBody, real.headers)
    const refused = await a.receiveWebhook!(wrong.rawBody, wrong.headers)

    expect([a.kind, a.providerName]).toEqual(['shipping', 'easypost'])
    expect([right.verified, refused.verified]).toEqual([true, false])
    expect(right.deliveryId).toBe(event.id)
    const direct = createEasyPostShippingAdapter({
      logger,
      config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
    })
    expect(right).toEqual(await direct.receiveWebhook!(real.rawBody, real.headers))
  })

  it('AC-4: createAdapter on any other slot throws a ConfigError naming the shipping slot it serves, and builds nothing', async () => {
    const others: Slot[] = ['payments', 'email', 'search', 'tax']
    for (const slot of others) {
      const { value, error } = await outcomeOf(() =>
        createAdapter(ctx(slot, { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET })),
      )

      expect(value, slot).toBeUndefined()
      expect(error, slot).toMatchObject({ name: 'ConfigError' })
      expect((error as Error).message, slot).toMatch(/\bshipping\b/)
    }
  })

  it('AC-4: rate, createLabel and track each reject with adapter.shipping.unsupported, naming EasyPost and the method', async () => {
    const a = createEasyPostShippingAdapter({
      logger,
      config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
    })
    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        'rate',
        () =>
          a.rate({
            fromPostalCode: 'LS1 4AP',
            toPostalCode: 'BS1 4DJ',
            toCountry: 'GB',
            weightGrams: 500,
            currency: 'GBP',
          }),
      ],
      [
        'createLabel',
        () => a.createLabel({ orderId: 'ord_1', carrier: 'USPS', service: 'Priority' }),
      ],
      ['track', () => a.track('9400100000000000000004')],
    ]

    for (const [method, call] of calls) {
      const { value, error } = await outcomeOf(call)

      expect(value, method).toBeUndefined()
      expect(error, method).toMatchObject({
        name: 'AdapterError',
        code: 'adapter.shipping.unsupported',
      })
      expect((error as Error).message, method).toMatch(/EasyPost/)
      expect((error as Error).message, method).toContain(method)
    }
  })
})
