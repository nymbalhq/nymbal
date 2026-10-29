import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { HealthReport, Logger } from '@nymbalhq/types'
import {
  EASYPOST_TEST_WEBHOOK_SECRET,
  signedPost,
  trackerEvent,
} from '../../../tests/support/easypost'
import { createEasyPostShippingAdapter, type EasyPostShippingAdapterConfig } from './index.js'

// The slot's health without a webhook secret: such a store answers every EasyPost post 400, so health says so
// (degraded, naming the secret), where a store with one is healthy. Nothing here reaches EasyPost: the adapter only
// verifies and maps.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const SECRET_NAMED = /webhook ?secret/i

/** The configs a store may have without a secret: no block, an empty one, an empty string. */
const WITHOUT_SECRET: ReadonlyArray<EasyPostShippingAdapterConfig | undefined> = [
  undefined,
  {},
  { webhookSecret: '' },
]

function health(config: EasyPostShippingAdapterConfig | undefined): Promise<HealthReport> {
  return createEasyPostShippingAdapter({
    logger,
    ...(config !== undefined && { config }),
  }).healthCheck()
}

describe('AC-5: health without a webhook secret', () => {
  it('AC-5: without a webhookSecret the slot is degraded naming the secret, where with one it is healthy and names none', async () => {
    const withSecret = await health({ webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET })
    const without = await Promise.all(WITHOUT_SECRET.map(health))

    expect([withSecret.status, ...without.map((h: HealthReport) => h.status)]).toEqual([
      'healthy',
      ...WITHOUT_SECRET.map(() => 'degraded'),
    ])
    for (const report of without) expect(report.detail ?? '').toMatch(SECRET_NAMED)
    expect(withSecret.detail ?? '').not.toMatch(SECRET_NAMED)
  })

  it('AC-5: without a webhookSecret a post signed with any secret, the empty one included, is not verified, where a store holding the tests’ secret verifies the same event signed with it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(''),
          fc.constant(EASYPOST_TEST_WEBHOOK_SECRET),
          fc.string({ minLength: 1, maxLength: 64 }),
        ),
        fc.constantFrom(...WITHOUT_SECRET),
        async (secret, config) => {
          const event = trackerEvent('9400100000000000000002', 'delivered')
          const without = createEasyPostShippingAdapter({
            logger,
            ...(config !== undefined && { config }),
          })
          const holding = createEasyPostShippingAdapter({
            logger,
            config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
          })
          const forged = signedPost(event, secret)
          const real = signedPost(event)

          const refused = await without.receiveWebhook!(forged.rawBody, forged.headers)
          const accepted = await holding.receiveWebhook!(real.rawBody, real.headers)

          expect([refused.verified, accepted.verified], JSON.stringify(secret)).toEqual([
            false,
            true,
          ])
        },
      ),
    )
  })
})
