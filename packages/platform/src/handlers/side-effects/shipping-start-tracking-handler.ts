import {
  EVT_ORDER_NOTE_ADDED,
  EVT_ORDER_SHIPPED,
  normaliseTrackingNumber,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderShippedV1Payload,
  type ShippingAdapter,
} from '@nymbalhq/types'
import type { EventPublisher } from '../../events/publisher.js'
import { parseNotes } from '../../order-notes.js'
import type { Repositories } from '../../repositories/index.js'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'
import { withIdempotency } from '../idempotency.js'

export interface RegisterShippingStartTrackingHandlerDeps {
  eventBus: EventBusAdapter
  shipping: ShippingAdapter
  processedEventRepo: ProcessedEventRepository
  repos: Pick<Repositories, 'order'>
  publisher: Pick<EventPublisher, 'publish'>
  logger: Logger
}

/** `text` with every spelling of the tracking number in it replaced, so a provider's reason can be logged. */
function redact(text: string, numbers: readonly string[]): string {
  let out = text
  for (const n of numbers) if (n !== '') out = out.split(n).join('***')
  return out
}

/**
 * Registers each shipped order's tracking number with the shipping provider, so its updates come back by webhook.
 * Only when the adapter declares `tracking` and has `startTracking`: the not-configured adapter answers every property
 * with a function, so the word decides. A refusal is logged, left as a system note on the order and not retried; a
 * rejection is thrown, so the relay tries the event again (and holds it while the slot's health is down). The note is
 * its only write to an order, so it cannot move one. The tracking number is never logged or noted.
 */
export async function registerShippingStartTrackingHandler(
  deps: RegisterShippingStartTrackingHandlerDeps,
): Promise<void> {
  const { eventBus, shipping, processedEventRepo, repos, publisher, logger } = deps
  if (!shipping.capabilities().includes('tracking')) return
  const startTracking = shipping.startTracking?.bind(shipping)
  if (typeof startTracking !== 'function') {
    logger.warn(
      { provider: shipping.providerName },
      'the shipping adapter declares tracking but has no startTracking: shipped orders are not registered with it',
    )
    return
  }

  const noteRefusal = (orderId: string, reason: string) =>
    repos.order.store.transaction(async (tx) => {
      const order = await repos.order.findById(tx, orderId)
      if (order === null) return
      const actor = 'system'
      const note = {
        body: `Tracking was not registered with ${shipping.providerName}: ${reason}. Carrier updates will not arrive for this order.`,
        actor,
        at: new Date().toISOString(),
      }
      const notes = [...parseNotes(order.notes, order.createdAt), note]
      await repos.order.setNotes(tx, orderId, JSON.stringify(notes), new Date())
      await publisher.publish(EVT_ORDER_NOTE_ADDED, {
        orderId,
        orderNumber: order.orderNumber,
        actor,
      })
    })

  const onShipped: EventHandler<OrderShippedV1Payload> = async (event) => {
    const { orderId, trackingNumber, carrier } = event.payload
    const normalised = normaliseTrackingNumber(trackingNumber)
    const result = await startTracking({ trackingNumber: normalised, carrier })
    if (result.status === 'tracking') {
      logger.info({ eventId: event.id, orderId }, 'the tracking number is registered')
      return
    }
    const reason = redact(result.reason, [trackingNumber, normalised])
    logger.warn(
      { eventId: event.id, orderId, provider: shipping.providerName, reason },
      'the shipping provider refused the tracking number; its updates will not arrive by webhook',
    )
    await noteRefusal(orderId, reason)
  }

  await eventBus.subscribe(
    EVT_ORDER_SHIPPED,
    withIdempotency('shipping:order-shipped', onShipped as EventHandler, {
      repo: processedEventRepo,
      logger,
    }),
    { name: 'shipping-start-tracking' },
  )
}
