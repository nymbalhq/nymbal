import { runShippingTrackingContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createAfterShipShippingAdapter } from '../../packages/adapters/shipping/aftership/src/index.js'
import {
  AFTERSHIP_TEST_WEBHOOK_SECRET,
  aftershipRequest,
  changeOneByte,
  signAfterShip,
  signedPost,
  trackingUpdate,
  webhookBody,
} from '../support/aftership'

// The shipping tracking contract and the webhook contract on @nymbalhq/shipping-aftership with a test webhook secret.
// Each sample is the same tracking_update built afresh under the same event_id, as AfterShip's retry posts it.
// AfterShip signs the whole raw body, so the tampered delivery is the signed body with one byte of the tracking number
// changed, under the header signed for the original.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const AT = new Date('2026-10-29T12:00:00.000Z')
const DELIVERED = '9400 1000 0000 0000 0000 21'
const IN_TRANSIT = '9400100000000000000022'
const DELIVERED_ID = '0b7e2c1a-6f3d-4e8b-9a2c-5d1e0f7a3b61'
const IN_TRANSIT_ID = '0b7e2c1a-6f3d-4e8b-9a2c-5d1e0f7a3b62'
const CONTRACT_ID = '0b7e2c1a-6f3d-4e8b-9a2c-5d1e0f7a3b63'

const build = () =>
  createAfterShipShippingAdapter({
    logger,
    config: { webhookSecret: AFTERSHIP_TEST_WEBHOOK_SECRET },
  })

runShippingTrackingContract('aftership', build, {
  delivered: () => ({
    request: signedPost(trackingUpdate(DELIVERED, 'Delivered', { id: DELIVERED_ID, at: AT })),
    trackingNumber: DELIVERED,
  }),
  inTransit: () => ({
    request: signedPost(
      trackingUpdate(IN_TRANSIT, 'InTransit', { id: IN_TRANSIT_ID, slug: null, at: AT }),
    ),
    trackingNumber: IN_TRANSIT,
  }),
})

const update = () => trackingUpdate(DELIVERED, 'OutForDelivery', { id: CONTRACT_ID, at: AT })

runWebhookContract('aftership', build, {
  delivery: () => signedPost(update()),
  tampered: () => {
    const body = webhookBody(update())
    // A byte of the tracking number: still JSON, still a tracking_update, only the signature can refuse it.
    const at = body.indexOf('"tracking_number":"') + '"tracking_number":"'.length
    return aftershipRequest(
      changeOneByte(Buffer.from(body, 'utf8'), at),
      signAfterShip(body, AFTERSHIP_TEST_WEBHOOK_SECRET),
    )
  },
})
