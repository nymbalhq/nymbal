import { runShippingTrackingContract, runWebhookContract } from '@nymbalhq/contract-tests'
import {
  createTestShipAdapter,
  shipDelivery,
  tampered,
  update,
} from '../../packages/platform/tests/support/test-ship'

// The shipping tracking contract and the webhook contract on the kernel's test shipping provider: a delivered update,
// written with the carrier's own spacing and case, and an in-transit one.

const AT = new Date('2026-10-29T12:00:00.000Z')
const DELIVERED = '1ZCONTRACTS0001'
const IN_TRANSIT = '1ZCONTRACTS0002'

runShippingTrackingContract('test-ship', () => createTestShipAdapter(), {
  delivered: () => ({
    request: shipDelivery({
      id: 'dlv_delivered',
      updates: [update('1z contracts 0001', 'delivered', { at: AT })],
    }),
    trackingNumber: DELIVERED,
  }),
  inTransit: () => ({
    request: shipDelivery({
      id: 'dlv_in_transit',
      updates: [update(IN_TRANSIT, 'in_transit', { carrier: null, at: AT })],
    }),
    trackingNumber: IN_TRANSIT,
  }),
})

const delivery = () =>
  shipDelivery({
    id: 'dlv_contracts',
    updates: [
      update(DELIVERED, 'out_for_delivery', { at: AT }),
      update(DELIVERED, 'delivered', { at: AT }),
    ],
  })

runWebhookContract('test-ship', () => createTestShipAdapter(), {
  delivery,
  tampered: () => tampered(delivery()),
})
