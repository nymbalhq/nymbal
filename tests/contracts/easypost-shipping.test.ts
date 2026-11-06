import { afterAll, beforeAll, describe } from 'vitest'
import { runShippingContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createEasyPostShippingAdapter } from '../../packages/adapters/shipping/easypost/src/index.js'
import {
  closedApiBase,
  FAKE_EASYPOST_API_KEY,
  startFakeEasyPost,
  type FakeEasyPost,
} from '../../packages/adapters/shipping/easypost/src/tests/fake-easypost.js'
import { EASYPOST_TEST_WEBHOOK_SECRET } from '../support/easypost'

// The shipping suite on @nymbalhq/shipping-easypost: with an API key against the in-process EasyPost fake (all three
// words; unreachable is a closed apiBase), and without one (no word, webhooks only). With EASYPOST_TEST_API_KEY set,
// the same suite runs against EasyPost's test mode (US addresses, test tracking code EZ1000000001); without it, that
// block is skipped. The live run is started by hand; it never runs in CI.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

let fake: FakeEasyPost
let dead = ''

beforeAll(async () => {
  fake = await startFakeEasyPost()
  dead = await closedApiBase()
})
afterAll(async () => {
  await fake.close()
})

const keyed = (apiBase: string, apiKey = FAKE_EASYPOST_API_KEY) =>
  createEasyPostShippingAdapter({
    logger,
    config: { apiKey, apiBase, webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET, timeoutMs: 3000 },
  })

runShippingContract('easypost (fake EasyPost)', () => keyed(fake.apiBase), {
  unreachable: () => keyed(dead),
})

runShippingContract('easypost (no API key)', () =>
  createEasyPostShippingAdapter({
    logger,
    config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
  }),
)

const liveKey = process.env['EASYPOST_TEST_API_KEY'] ?? ''

describe.runIf(liveKey !== '')(
  'EasyPost test mode (EASYPOST_TEST_API_KEY; skipped without it)',
  () => {
    runShippingContract(
      'easypost (EasyPost test mode)',
      () =>
        createEasyPostShippingAdapter({
          logger,
          config: { apiKey: liveKey, webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
        }),
      {
        trackingNumber: () => 'EZ1000000001',
        unreachable: () => keyed(dead, liveKey),
      },
    )
  },
)
