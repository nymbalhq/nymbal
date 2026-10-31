import { shipDelivery, update } from '../../../../packages/platform/tests/support/test-ship'

const AT = new Date('2026-10-29T12:00:00.000Z')

/** A signed delivered update and an in-transit one, each with its tracking number: the options every tracking breaker shares. */
export const shippingTrackingOptions = {
  delivered: () => ({
    request: shipDelivery({
      id: 'dlv_breakers_delivered',
      updates: [update('1ZBREAKERS0001', 'delivered', { at: AT })],
    }),
    trackingNumber: '1ZBREAKERS0001',
  }),
  inTransit: () => ({
    request: shipDelivery({
      id: 'dlv_breakers_in_transit',
      updates: [update('1ZBREAKERS0002', 'in_transit', { at: AT })],
    }),
    trackingNumber: '1ZBREAKERS0002',
  }),
}
