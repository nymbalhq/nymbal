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
import type { AlertService } from '../../services/alert-service.js'

/**
 * The handler name of every alert email's record, keyed `<event id>:<subscription id>`: a redelivered event finds the
 * key and sends that row nothing more.
 */
const HANDLER = 'email:alert'

export interface RegisterAlertHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  logger: Logger
  repos: Pick<Repositories, 'alertSubscription' | 'processedEvent' | 'product'>
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

  // A confirmation goes only to a row still waiting for one: a row confirmed or left since is sent nothing.
  const onRequested: EventHandler<AlertRequestedV1Payload> = async (event) => {
    const key = `${event.id}:${event.payload.subscriptionId}`
    const found = await store.read(async (tx) => {
      if (await repos.processedEvent.seen(tx, HANDLER, key)) return null
      const row = await repos.alertSubscription.findById(tx, event.payload.subscriptionId)
      if (row === null || row.status !== 'pending') return null
      const product = await repos.product.findById(tx, row.productId)
      return product === null ? null : { row, product }
    })
    if (found === null) return
    const { row, product } = found
    const { confirmUrl, unsubscribeUrl, productUrl } = links(row, product)
    await email.sendTransactional({
      template: row.kind === 'price_drop' ? 'alert-confirm-price-drop' : 'alert-confirm',
      to: row.email,
      vars: { storeName, productName: product.name, productUrl, confirmUrl, unsubscribeUrl },
    })
    await store.transaction((tx) =>
      repos.processedEvent.markProcessed(tx, HANDLER, key, new Date()),
    )
  }

  // Each row is mailed and recorded on its own: one refused address neither stops nor repeats another's alert, and keeps
  // its status (and a price-drop row its baseline). Any refused row fails the delivery, so the event is retried; the
  // retry finds the mailed rows' keys and mails only the refused ones.
  async function fanOut(
    event: NymbalEvent<unknown>,
    rows: AlertSubscription[],
    what: { alert: string; next: string },
    message: (row: AlertSubscription) => Omit<TransactionalEmail, 'to'>,
  ): Promise<void> {
    const failed: string[] = []
    for (const row of rows) {
      const key = `${event.id}:${row.id}`
      if (await store.read((tx) => repos.processedEvent.seen(tx, HANDLER, key))) continue
      try {
        await email.sendTransactional({ ...message(row), to: row.email })
        await store.transaction(async (tx) => {
          await repos.processedEvent.markProcessed(tx, HANDLER, key, new Date())
          await alerts.recordSent(tx, row, event)
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
    const { rows, product } = await store.read(async (tx) => ({
      rows: await repos.alertSubscription.listActive(tx, variantId, 'back_in_stock'),
      product: await repos.product.findById(tx, productId),
    }))
    if (product === null) return
    await fanOut(event, rows, { alert: 'back-in-stock', next: 'restock' }, (row) => {
      const { productUrl, unsubscribeUrl } = links(row, product)
      return {
        template: 'alert-back-in-stock',
        vars: { storeName, productName: product.name, productUrl, unsubscribeUrl },
      }
    })
  }

  // A row is mailed when the price falls below both the previous price and the last price it was told (its baseline).
  const onPriceChanged: EventHandler<ProductVariantPriceChangedV1Payload> = async (event) => {
    const { variantId, productId, previousPriceMinor, priceMinor, currency } = event.payload
    if (priceMinor >= previousPriceMinor) return
    const { rows, product } = await store.read(async (tx) => ({
      rows: await repos.alertSubscription.listActive(tx, variantId, 'price_drop'),
      product: await repos.product.findById(tx, productId),
    }))
    if (product === null) return
    const due = rows.filter(
      (row) => row.baselinePriceMinor !== null && priceMinor < row.baselinePriceMinor,
    )
    const previousPriceFormatted = formatMoney(previousPriceMinor, currency)
    const priceFormatted = formatMoney(priceMinor, currency)
    await fanOut(event, due, { alert: 'price-drop', next: 'drop' }, (row) => {
      const { productUrl, unsubscribeUrl } = links(row, product)
      return {
        template: 'alert-price-drop',
        vars: {
          storeName,
          productName: product.name,
          productUrl,
          unsubscribeUrl,
          previousPriceFormatted,
          priceFormatted,
        },
      }
    })
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
