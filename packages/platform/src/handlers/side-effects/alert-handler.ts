import {
  EVT_ALERT_REQUESTED,
  EVT_PRODUCT_RESTOCKED,
  EVT_PRODUCT_VARIANT_PRICE_CHANGED,
  type AlertRequestedV1Payload,
  type EmailAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type NymbalEvent,
  type Product,
  type ProductRestockedV1Payload,
  type ProductVariantPriceChangedV1Payload,
  type TransactionalEmail,
} from '@nymbalhq/types'
import { formatMoney } from '../../money.js'
import type { AlertSubscription } from '../../repositories/alert-subscription.js'
import type { Repositories } from '../../repositories/index.js'
import { confirmationDue, type AlertService } from '../../services/alert-service.js'

/**
 * The handler name of every alert email's record, keyed `<event id>:<subscription id>`: a redelivered event finds the
 * key and sends that row nothing more.
 */
const HANDLER = 'email:alert'

export interface RegisterAlertHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  logger: Logger
  repos: Pick<
    Repositories,
    'alertSubscription' | 'emailSuppression' | 'processedEvent' | 'product' | 'variant'
  >
  alerts: AlertService
  storeName: string
}

function links(row: AlertSubscription, product: Product) {
  const token = (value: string) => encodeURIComponent(value)
  return {
    confirmUrl: `${row.origin}/alerts/confirm?token=${token(row.confirmToken)}`,
    unsubscribeUrl: `${row.origin}/alerts/unsubscribe?token=${token(row.unsubscribeToken)}`,
    productUrl: `${row.origin}/product/${encodeURIComponent(product.slug)}`,
  }
}

export async function registerAlertHandler(deps: RegisterAlertHandlerDeps): Promise<void> {
  const { eventBus, email, logger, repos, alerts, storeName } = deps
  const { store } = repos.processedEvent

  // A suppressed address is skipped, not failed: its row keeps its status and baseline, and the event is not retried
  // for it. The log names the row, never the address.
  const skipped = (subscriptionId: string, eventId: string) =>
    logger.info({ subscriptionId, eventId }, 'alert mail skipped: the address is suppressed')

  // A confirmation goes only to a row still waiting for one: a row confirmed or left since is sent nothing, and a row
  // sent one within the interval (by another request's event) is sent nothing more.
  const onRequested: EventHandler<AlertRequestedV1Payload> = async (event) => {
    const key = `${event.id}:${event.payload.subscriptionId}`
    const found = await store.read(async (tx) => {
      if (await repos.processedEvent.seen(tx, HANDLER, key)) return null
      const row = await repos.alertSubscription.findById(tx, event.payload.subscriptionId)
      if (row === null || row.status !== 'pending' || !confirmationDue(row, new Date())) return null
      if (await repos.emailSuppression.isSuppressed(tx, row.email)) return 'suppressed' as const
      const product = await repos.product.findById(tx, row.productId)
      return product === null ? null : { row, product }
    })
    if (found === null) return
    if (found === 'suppressed') return skipped(event.payload.subscriptionId, event.id)
    const { row, product } = found
    const { confirmUrl, unsubscribeUrl, productUrl } = links(row, product)
    await email.sendTransactional({
      template: row.kind === 'price_drop' ? 'alert-confirm-price-drop' : 'alert-confirm',
      to: row.email,
      vars: { storeName, productName: product.name, productUrl, confirmUrl, unsubscribeUrl },
    })
    await store.transaction(async (tx) => {
      const at = new Date()
      await repos.processedEvent.markProcessed(tx, HANDLER, key, at)
      await alerts.recordConfirmationSent(tx, row, event, at)
    })
  }

  // Each row is mailed and recorded on its own: one refused address neither stops nor repeats another's alert, and keeps
  // its status (and a price-drop row its baseline). Any refused row fails the delivery, so the event is retried; the
  // retry finds the mailed rows' keys and mails only the refused ones. Each row is read again just before its send, so
  // one unsubscribed (or already told a lower price) since the list was read is passed over.
  async function fanOut(
    event: NymbalEvent<unknown>,
    listed: AlertSubscription[],
    what: { alert: string; next: string },
    due: (row: AlertSubscription) => boolean,
    message: (row: AlertSubscription) => Omit<TransactionalEmail, 'to'>,
    variantPriceMinor: number,
  ): Promise<void> {
    const failed: string[] = []
    for (const { id } of listed.filter(due)) {
      const key = `${event.id}:${id}`
      const current = await store.read(async (tx) => {
        if (await repos.processedEvent.seen(tx, HANDLER, key)) return 'sent'
        const row = await repos.alertSubscription.findById(tx, id)
        if (row === null || !due(row)) return 'gone'
        return (await repos.emailSuppression.isSuppressed(tx, row.email)) ? 'suppressed' : row
      })
      if (current === 'suppressed') skipped(id, event.id)
      if (typeof current === 'string') continue
      const row = current
      try {
        await email.sendTransactional({ ...message(row), to: row.email })
        await store.transaction(async (tx) => {
          await repos.processedEvent.markProcessed(tx, HANDLER, key, new Date())
          await alerts.recordSent(tx, row, event, variantPriceMinor)
        })
      } catch (err) {
        failed.push(row.id)
        logger.warn(
          { err, subscriptionId: row.id, eventId: event.id },
          `${what.alert} alert failed; the subscription stays active until a retry or the next ${what.next}`,
        )
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `${what.alert} alerts for event ${event.id} failed for subscriptions ${failed.join(', ')}`,
      )
    }
  }

  const onRestocked: EventHandler<ProductRestockedV1Payload> = async (event) => {
    const { variantId, productId } = event.payload
    const { rows, product, variant } = await store.read(async (tx) => ({
      rows: await repos.alertSubscription.listActive(tx, variantId, 'back_in_stock'),
      product: await repos.product.findById(tx, productId),
      variant: await repos.variant.findById(tx, variantId),
    }))
    if (product === null || variant === null) return
    // A restock delivered late may meet a variant sold out since: an alert then would be false and fire the row.
    const due = (row: AlertSubscription) => row.status === 'active' && variant.stock > 0
    await fanOut(
      event,
      rows,
      { alert: 'back-in-stock', next: 'restock' },
      due,
      (row) => {
        const { productUrl, unsubscribeUrl } = links(row, product)
        return {
          template: 'alert-back-in-stock',
          vars: { storeName, productName: product.name, productUrl, unsubscribeUrl },
        }
      },
      variant.priceMinor,
    )
  }

  // A drop mails a row whose baseline (the last price it was told) is above the variant's price now, and quotes that
  // price: the event may be behind it, and a rise behind a failed drop mails nothing, so the drop must carry the news.
  const onPriceChanged: EventHandler<ProductVariantPriceChangedV1Payload> = async (event) => {
    const { variantId, productId, previousPriceMinor, priceMinor: eventPriceMinor, currency } =
      event.payload
    if (eventPriceMinor >= previousPriceMinor) return
    const { rows, product, variant } = await store.read(async (tx) => ({
      rows: await repos.alertSubscription.listActive(tx, variantId, 'price_drop'),
      product: await repos.product.findById(tx, productId),
      variant: await repos.variant.findById(tx, variantId),
    }))
    if (product === null || variant === null) return
    const { priceMinor } = variant
    const due = (row: AlertSubscription) =>
      row.status === 'active' &&
      row.baselinePriceMinor !== null &&
      priceMinor < row.baselinePriceMinor
    const priceFormatted = formatMoney(priceMinor, currency)
    await fanOut(
      event,
      rows,
      { alert: 'price-drop', next: 'drop' },
      due,
      (row) => {
        const { productUrl, unsubscribeUrl } = links(row, product)
        return {
          template: 'alert-price-drop',
          vars: {
            storeName,
            productName: product.name,
            productUrl,
            unsubscribeUrl,
            previousPriceFormatted: formatMoney(row.baselinePriceMinor!, currency),
            priceFormatted,
          },
        }
      },
      priceMinor,
    )
  }

  await eventBus.subscribe(EVT_ALERT_REQUESTED, onRequested as EventHandler, {
    name: 'email-alert-requested',
  })
  await eventBus.subscribe(EVT_PRODUCT_RESTOCKED, onRestocked as EventHandler, {
    name: 'email-alert-back-in-stock',
  })
  await eventBus.subscribe(EVT_PRODUCT_VARIANT_PRICE_CHANGED, onPriceChanged as EventHandler, {
    name: 'email-alert-price-drop',
  })
}
