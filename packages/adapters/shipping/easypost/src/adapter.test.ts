import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AdapterContext, Logger, ShippingAdapter, Slot } from '@nymbalhq/types'
import {
  EASYPOST_TEST_WEBHOOK_SECRET,
  signedPost,
  trackerEvent,
} from '../../../../../tests/support/easypost'
import { createAdapter, createEasyPostShippingAdapter, settings } from './index.js'
import {
  FAKE_EASYPOST_API_KEY,
  startFakeEasyPost,
  type FakeEasyPost,
} from './tests/fake-easypost.js'

// The package's entry as the kernel's loader calls it, and what the adapter declares by its config: with an API key it
// rates, sells labels and registers tracking numbers through EasyPost's API (the in-process fake here), and says so
// with all three words; without one it has none of those methods, declares nothing, and still verifies webhooks.

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
})

const WORDS = ['rates', 'labels', 'tracking'] as const
const METHOD = { rates: 'rate', labels: 'createLabel', tracking: 'startTracking' } as const

/** The words whose method the adapter has, in the words' order. */
const served = (a: ShippingAdapter): string[] =>
  WORDS.filter((w) => typeof (a as unknown as Record<string, unknown>)[METHOD[w]] === 'function')

describe('AC-7: EasyPost declares by its config', () => {
  let fake: FakeEasyPost

  beforeAll(async () => {
    fake = await startFakeEasyPost()
  })
  afterAll(async () => {
    await fake.close()
  })

  it('AC-7: built with an apiKey it declares rates, labels and tracking, has the three methods, and startTracking reaches EasyPost', async () => {
    const a = createEasyPostShippingAdapter({
      logger,
      config: {
        apiKey: FAKE_EASYPOST_API_KEY,
        apiBase: fake.apiBase,
        webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET,
      },
    })
    const before = fake.requests.length

    const answer = await a.startTracking!({
      trackingNumber: '9400100000000000000005',
      carrier: null,
    })

    expect([...a.capabilities()]).toEqual(['rates', 'labels', 'tracking'])
    expect(served(a)).toEqual([...a.capabilities()])
    expect(answer).toEqual({ status: 'tracking' })
    expect(fake.requests.slice(before).map((r) => [r.method, r.path])).toEqual([
      ['POST', '/v2/trackers'],
    ])
  })

  it('AC-7: built without an apiKey (none, empty) it declares nothing, has no rate, createLabel or startTracking property, and a signed post still verifies', async () => {
    const keyless = [
      createEasyPostShippingAdapter({
        logger,
        config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
      }),
      createEasyPostShippingAdapter({
        logger,
        config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET, apiKey: '' },
      }),
      createAdapter(
        ctx('shipping', { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET }),
      ) as ShippingAdapter,
    ]
    const post = signedPost(trackerEvent('9400100000000000000006', 'delivered'))

    for (const a of keyless) {
      const delivery = await a.receiveWebhook!(post.rawBody, post.headers)

      expect([...a.capabilities()]).toEqual([])
      expect(['rate', 'createLabel', 'startTracking'].filter((m) => m in a)).toEqual([])
      expect(served(a)).toEqual([...a.capabilities()])
      expect([delivery.verified, delivery.events.length]).toEqual([true, 1])
    }
  })

  it('AC-7: settings lists apiKey and webhookSecret, both secret and optional, and nothing else', () => {
    expect(settings.map((s) => [s.path, s.secret === true, s.optional === true]).sort()).toEqual([
      ['apiKey', true, true],
      ['webhookSecret', true, true],
    ])
  })
})
