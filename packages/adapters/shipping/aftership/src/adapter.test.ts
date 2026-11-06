import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AdapterContext, ShippingAdapter, Slot } from '@nymbalhq/types'
import {
  AFTERSHIP_TEST_WEBHOOK_SECRET,
  signedPost,
  trackingUpdate,
} from '../../../../../tests/support/aftership'
import { createAdapter, createAfterShipShippingAdapter, settings } from './index.js'
import {
  FAKE_AFTERSHIP_API_KEY,
  startFakeAfterShip,
  type FakeAfterShip,
} from './tests/fake-aftership.js'
import { outcomeOf, silent } from './tests/support.js'

// The package's entry as the kernel's loader calls it, and what the adapter declares by its config: with an API key
// it registers tracking numbers with AfterShip and says `tracking`; without one it declares nothing. It never rates or
// sells labels, so it never has rate or createLabel.

const ctx = (slot: Slot, config: Record<string, unknown>): AdapterContext => ({
  slot,
  config,
  logger: silent,
  env: {},
})

const METHODS = ['rate', 'createLabel', 'startTracking'] as const
const WORD_OF = { rate: 'rates', createLabel: 'labels', startTracking: 'tracking' } as const

/** The words whose method the adapter has. */
const served = (a: ShippingAdapter): string[] =>
  METHODS.filter((m) => typeof (a as unknown as Record<string, unknown>)[m] === 'function').map(
    (m) => WORD_OF[m],
  )

let fake: FakeAfterShip

beforeAll(async () => {
  fake = await startFakeAfterShip()
})
afterAll(async () => {
  await fake.close()
})

describe('AC-14: the package builds the aftership shipping adapter', () => {
  it('AC-14: createAdapter on the shipping slot builds the aftership adapter with the config block: a post signed with its secret verifies as on the adapter built directly, one signed with another does not, and its key reaches AfterShip', async () => {
    const config = {
      apiKey: FAKE_AFTERSHIP_API_KEY,
      apiBase: fake.apiBase,
      webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET,
    }
    const a = createAdapter(ctx('shipping', config)) as ShippingAdapter
    const direct = createAfterShipShippingAdapter({ logger: silent, config })
    const update = trackingUpdate('9400100000000000000011', 'Delivered')
    const real = signedPost(update)
    const wrong = signedPost(update, `${AFTERSHIP_TEST_WEBHOOK_SECRET}-other`)
    const before = fake.requests.length

    const right = await a.receiveWebhook!(real.rawBody, real.headers)
    const refused = await a.receiveWebhook!(wrong.rawBody, wrong.headers)
    const registered = await a.startTracking!({
      trackingNumber: '9400100000000000000011',
      carrier: null,
    })

    expect([a.kind, a.providerName]).toEqual(['shipping', 'aftership'])
    expect([right.verified, refused.verified]).toEqual([true, false])
    expect(right).toEqual(await direct.receiveWebhook!(real.rawBody, real.headers))
    expect(registered).toEqual({ status: 'tracking' })
    expect(fake.requests.slice(before).map((r) => r.apiKey)).toEqual([FAKE_AFTERSHIP_API_KEY])
  })

  it('AC-14: createAdapter on any other slot throws a ConfigError naming the shipping slot it serves, and builds nothing', async () => {
    const others: Slot[] = ['payments', 'email', 'search', 'tax', 'reviews']
    for (const slot of others) {
      const { value, error } = await outcomeOf(() =>
        createAdapter(ctx(slot, { apiKey: FAKE_AFTERSHIP_API_KEY })),
      )

      expect(value, slot).toBeUndefined()
      expect(error, slot).toMatchObject({ name: 'ConfigError' })
      expect((error as Error).message, slot).toMatch(/\bshipping\b/)
    }
  })
})

describe('AC-13: AfterShip declares tracking by its config, and never rates or labels', () => {
  // Kills: a keyless store declaring tracking (every ship refused), a keyed one hiding it, a rate or label stub.
  it('AC-13: with an apiKey the words are tracking alone and its methods are exactly startTracking; without one (none, empty) the words are none and so are the methods; neither has rate or createLabel', () => {
    const builds: Array<[string, ShippingAdapter]> = [
      [
        'keyed',
        createAfterShipShippingAdapter({
          logger: silent,
          config: { apiKey: FAKE_AFTERSHIP_API_KEY },
        }),
      ],
      [
        'no key',
        createAfterShipShippingAdapter({ logger: silent, config: { webhookSecret: 'whsec_a' } }),
      ],
      ['empty key', createAfterShipShippingAdapter({ logger: silent, config: { apiKey: '' } })],
      ['loader, no key', createAdapter(ctx('shipping', {})) as ShippingAdapter],
    ]

    expect(builds.map(([name, a]) => [name, [...a.capabilities()]])).toEqual([
      ['keyed', ['tracking']],
      ['no key', []],
      ['empty key', []],
      ['loader, no key', []],
    ])
    for (const [name, a] of builds) {
      expect(served(a), name).toEqual([...a.capabilities()])
      expect(
        ['rate', 'createLabel'].filter((m) => m in a),
        name,
      ).toEqual([])
    }
  })

  it('AC-13: settings lists apiKey and webhookSecret, both secret and optional, and nothing else', () => {
    expect(settings.map((s) => [s.path, s.secret === true, s.optional === true]).sort()).toEqual([
      ['apiKey', true, true],
      ['webhookSecret', true, true],
    ])
  })
})
