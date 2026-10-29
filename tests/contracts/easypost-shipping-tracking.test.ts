import { runShippingTrackingContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createEasyPostShippingAdapter } from '../../packages/adapter-easypost/src/index.js'
import {
  changeOneByte,
  EASYPOST_TEST_WEBHOOK_SECRET,
  easypostRequest,
  eventBody,
  signEasyPost,
  signedPost,
  trackerEvent,
} from '../support/easypost'

// The shipping tracking contract and the webhook contract on @nymbalhq/adapter-easypost with a test webhook secret.
// Each sample is the same Event built afresh, as EasyPost's retry of an Event posts the same bytes under the same id.
// EasyPost signs the whole raw body, so the tampered delivery is the signed body with one byte changed, under the
// header signed for the original.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const AT = new Date('2026-10-29T12:00:00.000Z')
const DELIVERED = '9400 1000 0000 0000 0000 01'
const IN_TRANSIT = '9400100000000000000002'

const build = () =>
  createEasyPostShippingAdapter({ logger, config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET } })

runShippingTrackingContract('easypost', build, {
  delivered: () => ({
    request: signedPost(trackerEvent(DELIVERED, 'delivered', { id: 'evt_delivered', at: AT })),
    trackingNumber: DELIVERED,
  }),
  inTransit: () => ({
    request: signedPost(
      trackerEvent(IN_TRANSIT, 'in_transit', {
        id: 'evt_in_transit',
        description: 'tracker.created',
        carrier: null,
        at: AT,
      }),
    ),
    trackingNumber: IN_TRANSIT,
  }),
})

const event = () => trackerEvent(DELIVERED, 'out_for_delivery', { id: 'evt_contracts', at: AT })

runWebhookContract('easypost', build, {
  delivery: () => signedPost(event()),
  tampered: () => {
    const body = eventBody(event())
    // A byte of the tracking code: still JSON, still a tracker Event, only the signature can refuse it.
    const at = body.indexOf('"tracking_code":"') + '"tracking_code":"'.length
    return easypostRequest(
      changeOneByte(Buffer.from(body, 'utf8'), at),
      signEasyPost(body, EASYPOST_TEST_WEBHOOK_SECRET),
    )
  },
})
