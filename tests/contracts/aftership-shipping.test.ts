import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe } from 'vitest'
import { runShippingContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createAfterShipShippingAdapter } from '../../packages/adapters/shipping/aftership/src/index.js'
import {
  closedApiBase,
  FAKE_AFTERSHIP_API_KEY,
  startFakeAfterShip,
  type FakeAfterShip,
} from '../../packages/adapters/shipping/aftership/src/tests/fake-aftership.js'
import { AFTERSHIP_TEST_WEBHOOK_SECRET } from '../support/aftership'

// The shipping suite on @nymbalhq/shipping-aftership: with an API key against the in-process AfterShip fake (tracking
// only; unreachable is a closed apiBase), and without one (no word). With AFTERSHIP_API_KEY set, the same suite runs
// against AfterShip itself with the slug testing-courier and its single-use test numbers; without it, that block is
// skipped. AfterShip has no sandbox: each live run spends a real account's quota, so it is started by hand and
// never runs in CI.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

let fake: FakeAfterShip
let dead = ''

beforeAll(async () => {
  fake = await startFakeAfterShip()
  dead = await closedApiBase()
})
afterAll(async () => {
  await fake.close()
})

const keyed = (apiBase: string, apiKey = FAKE_AFTERSHIP_API_KEY) =>
  createAfterShipShippingAdapter({
    logger,
    config: { apiKey, apiBase, webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET, timeoutMs: 3000 },
  })

runShippingContract('aftership (fake AfterShip)', () => keyed(fake.apiBase), {
  carrier: 'UPS',
  unreachable: () => keyed(dead),
})

runShippingContract('aftership (no API key)', () =>
  createAfterShipShippingAdapter({
    logger,
    config: { webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET },
  }),
)

const liveKey = process.env['AFTERSHIP_API_KEY'] ?? ''

describe.runIf(liveKey !== '')('AfterShip (AFTERSHIP_API_KEY; skipped without it)', () => {
  runShippingContract(
    'aftership (AfterShip, testing-courier)',
    () =>
      createAfterShipShippingAdapter({
        logger,
        config: { apiKey: liveKey, webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET },
      }),
    {
      carrier: 'testing-courier',
      // In transit, out for delivery, delivered, three minutes apart; each number is single use.
      trackingNumber: () => `ITOD-3-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      unreachable: () => keyed(dead, liveKey),
    },
  )
})
