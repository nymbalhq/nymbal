import type { NymbalConfig } from '@nymbal/config'
import type { EventBusAdapter, Logger, NymbalEvent } from '@nymbal/types'
import {
  EVT_CATEGORY_CREATED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_PRODUCT_CREATED,
} from '@nymbal/types'
import { createEventBuilder } from './events/builder.js'
import type { Repositories } from './repositories/index.js'

export interface WarmDocumentStoreDeps {
  config: NymbalConfig
  repos: Repositories
  eventBus: EventBusAdapter
  logger: Logger
  version: string
}

export interface WarmResult {
  products: number
  orders: number
  customers: number
}

export async function warmDocumentStore(deps: WarmDocumentStoreDeps): Promise<WarmResult> {
  const { config, repos, eventBus, logger, version } = deps
  const makeEvent = createEventBuilder({
    storeId: config.store.name,
    environment:
      process.env.NODE_ENV === 'production'
        ? 'production'
        : process.env.NODE_ENV === 'staging'
          ? 'staging'
          : 'development',
    version,
    source: 'nymbal-warm',
  })

  const [products, categories, orders, customers] = await Promise.all([
    repos.product.list(),
    repos.category.list(),
    repos.order.list(),
    repos.customer.list(),
  ])

  const events: NymbalEvent<unknown>[] = []

  for (const c of categories) {
    events.push(makeEvent(EVT_CATEGORY_CREATED, { category: c }))
  }

  for (const p of products) {
    const [variants, categoryIds] = await Promise.all([
      repos.variant.findByProduct(p.id),
      repos.productCategory.listCategoriesForProduct(p.id),
    ])
    events.push(makeEvent(EVT_PRODUCT_CREATED, { product: { ...p, variants, categoryIds } }))
  }

  for (const o of orders) {
    events.push(makeEvent(EVT_ORDER_PLACED, { order: o }))
  }

  for (const c of customers) {
    events.push(makeEvent(EVT_CUSTOMER_CREATED, { customerId: c.id, email: c.email }))
  }

  if (events.length > 0) {
    await eventBus.publishBatch(events)
  }

  logger.info(
    { products: products.length, orders: orders.length, customers: customers.length },
    `Warmed document store: ${products.length} products, ${orders.length} orders, ${customers.length} customers`,
  )

  return { products: products.length, orders: orders.length, customers: customers.length }
}
