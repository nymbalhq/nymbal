import {
  EVT_ORDER_SHIPPED,
  normaliseTrackingNumber,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderShippedV1Payload,
  type ShippingAdapter,
} from '@nymbalhq/types'
import type { ProcessedEventRepository } from '../../repositories/processed-event.js'
import { withIdempotency } from '../idempotency.js'

export interface RegisterShippingStartTrackingHandlerDeps {
  eventBus: EventBusAdapter
  shipping: ShippingAdapter
  processedEventRepo: ProcessedEventRepository
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
 * with a function, so the word decides. A refusal is logged and not retried; a rejection is thrown, so the relay tries
 * the event again (and holds it while the slot's health is down). It holds nothing that writes orders, so it cannot
 * move one. The tracking number is never logged.
 */
export async function registerShippingStartTrackingHandler(
  deps: RegisterShippingStartTrackingHandlerDeps,
): Promise<void> {
  const { eventBus, shipping, processedEventRepo, logger } = deps
  if (!shipping.capabilities().includes('tracking')) return
  const startTracking = shipping.startTracking?.bind(shipping)
  if (typeof startTracking !== 'function') {
    logger.warn(
      { provider: shipping.providerName },
      'the shipping adapter declares tracking but has no startTracking: shipped orders are not registered with it',
    )
    return
  }

  const onShipped: EventHandler<OrderShippedV1Payload> = async (event) => {
    const { orderId, trackingNumber, carrier } = event.payload
    const normalised = normaliseTrackingNumber(trackingNumber)
    const result = await startTracking({ trackingNumber: normalised, carrier })
    if (result.status === 'tracking') {
      logger.info({ eventId: event.id, orderId }, 'the tracking number is registered')
      return
    }
    logger.warn(
      {
        eventId: event.id,
        orderId,
        provider: shipping.providerName,
        reason: redact(result.reason, [trackingNumber, normalised]),
      },
      'the shipping provider refused the tracking number; its updates will not arrive by webhook',
    )
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
