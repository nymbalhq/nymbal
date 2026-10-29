import {
  StatusTransitionError,
  shippingTrackingType,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type ShippingAdapter,
  type ShippingTrackingV1Payload,
} from '@nymbalhq/types'
import { runAsActor } from '../../audit/actor.js'
import type { Repositories } from '../../repositories/index.js'
import { isHooked } from '../../routes/webhooks-inbound.js'
import type { OrderService } from '../../services/order-service.js'

const ACTOR = 'system:shipping-tracking'

export interface RegisterShippingTrackingHandlerDeps {
  eventBus: EventBusAdapter
  shipping: ShippingAdapter
  repos: Pick<Repositories, 'order' | 'orderShipment'>
  orderService: Pick<OrderService, 'markDelivered'>
  logger: Logger
}

/**
 * Delivers the shipped orders a delivered tracking update names. Only when the shipping adapter takes webhooks itself,
 * by the route's own test: a hookless shipping adapter's name may be another slot's, whose events must not move orders.
 * Nothing else is acted on and nothing it skips throws, so a carrier's updates are never retried for an order they
 * cannot move. The tracking number is never logged.
 */
export async function registerShippingTrackingHandler(
  deps: RegisterShippingTrackingHandlerDeps,
): Promise<void> {
  const { eventBus, shipping, repos, orderService, logger } = deps
  if (!isHooked(shipping)) return
  const { store } = repos.orderShipment

  async function deliver(eventId: string, orderId: string): Promise<void> {
    try {
      await runAsActor({ kind: 'system', id: 'shipping-tracking' }, () =>
        orderService.markDelivered(orderId, ACTOR),
      )
      logger.info({ eventId, orderId }, 'a tracking update delivered the order')
    } catch (err) {
      // The order moved between the read and the move: another update or the admin delivered it first.
      if (!(err instanceof StatusTransitionError)) throw err
      logger.info({ eventId, orderId }, 'the order was no longer shipped')
    }
  }

  const onTracking: EventHandler<ShippingTrackingV1Payload> = async (event) => {
    const { status, trackingNumber } = event.payload
    if (status !== 'delivered') {
      logger.info({ eventId: event.id, status }, 'a tracking update other than delivered')
      return
    }
    const orders = await store.read(async (tx) => {
      const found = []
      for (const id of await repos.orderShipment.ordersByTrackingNumber(tx, trackingNumber)) {
        const order = await repos.order.findById(tx, id)
        if (order !== null) found.push(order)
      }
      return found
    })
    if (orders.length === 0) {
      logger.info({ eventId: event.id }, 'no order was shipped under the tracking number')
      return
    }
    for (const order of orders) {
      if (order.status !== 'shipped') {
        logger.info(
          { eventId: event.id, orderId: order.id, orderStatus: order.status },
          'the order is not shipped',
        )
        continue
      }
      await deliver(event.id, order.id)
    }
  }

  await eventBus.subscribe(
    shippingTrackingType(shipping.providerName),
    onTracking as EventHandler,
    {
      name: 'shipping-tracking',
    },
  )
}
