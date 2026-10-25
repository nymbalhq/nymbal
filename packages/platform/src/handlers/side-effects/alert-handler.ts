import {
  EVT_ALERT_REQUESTED,
  EVT_PRODUCT_RESTOCKED,
  type AlertRequestedV1Payload,
  type EmailAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type Product,
  type ProductRestockedV1Payload,
} from '@nymbalhq/types'
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
      template: 'alert-confirm',
      to: row.email,
      vars: { storeName, productName: product.name, productUrl, confirmUrl, unsubscribeUrl },
    })
    await store.transaction((tx) =>
      repos.processedEvent.markProcessed(tx, HANDLER, key, new Date()),
    )
  }

  // Each active row is mailed, marked and fired on its own: one refused address neither stops nor repeats another's
  // alert, and stays active for the variant's next restock.
  const onRestocked: EventHandler<ProductRestockedV1Payload> = async (event) => {
    const { variantId, productId } = event.payload
    const { rows, product } = await store.read(async (tx) => ({
      rows: await repos.alertSubscription.listActive(tx, variantId, 'back_in_stock'),
      product: await repos.product.findById(tx, productId),
    }))
    if (product === null) return
    let attempted = 0
    let failed = 0
    for (const row of rows) {
      const key = `${event.id}:${row.id}`
      if (await store.read((tx) => repos.processedEvent.seen(tx, HANDLER, key))) continue
      attempted += 1
      try {
        const { productUrl, unsubscribeUrl } = links(row, product)
        await email.sendTransactional({
          template: 'alert-back-in-stock',
          to: row.email,
          vars: { storeName, productName: product.name, productUrl, unsubscribeUrl },
        })
        await store.transaction(async (tx) => {
          await repos.processedEvent.markProcessed(tx, HANDLER, key, new Date())
          await alerts.recordSent(tx, row, event)
        })
      } catch (err) {
        failed += 1
        logger.warn(
          { err, subscriptionId: row.id, eventId: event.id },
          'back-in-stock alert failed; the subscription stays active for the next restock',
        )
      }
    }
    if (attempted > 0 && failed === attempted) {
      throw new Error(`every back-in-stock alert for event ${event.id} failed`)
    }
  }

  await eventBus.subscribe(EVT_ALERT_REQUESTED, onRequested as EventHandler, {
    name: 'email-alert-requested',
  })
  await eventBus.subscribe(EVT_PRODUCT_RESTOCKED, onRestocked as EventHandler, {
    name: 'email-alert-back-in-stock',
  })
}
