import {
  EVT_ORDER_PAID,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type TaxAdapter,
} from '@nymbalhq/types'
import type { TaxDocuments } from '../../services/tax-documents.js'

export interface RegisterTaxDocumentsHandlerDeps {
  eventBus: EventBusAdapter
  tax: TaxAdapter
  documents: TaxDocuments
  logger: Logger
}

/**
 * Files each paid order, and each of its refunds, with a tax provider that declares `commit`. It runs after the command
 * has answered, so a provider outage never holds up an order. A provider failure is left on the order's record for the
 * sweep and the event is delivered; a store failure is thrown, so the relay tries the event again. The record is the
 * idempotency: a redelivered event finds nothing owed and calls nothing.
 */
export async function registerTaxDocumentsHandler(
  deps: RegisterTaxDocumentsHandlerDeps,
): Promise<void> {
  const { eventBus, tax, documents, logger } = deps
  if (!tax.capabilities().includes('commit')) return
  if (typeof tax.commit !== 'function') {
    logger.warn(
      { provider: tax.providerName },
      'the tax adapter declares commit but has no commit method: paid orders are not filed with it',
    )
    return
  }

  const onOrder: EventHandler<{ orderId: string }> = async (event) => {
    const { orderId } = event.payload
    if ((await documents.file(orderId)) === 'due') {
      logger.warn(
        { eventId: event.id, orderId, provider: tax.providerName },
        'filing with the tax provider failed; the sweep retries it',
      )
    }
  }

  await eventBus.subscribe(
    [EVT_ORDER_PAID, EVT_ORDER_REFUNDED, EVT_ORDER_PARTIALLY_REFUNDED],
    onOrder as EventHandler,
    { name: 'tax-documents' },
  )
}
