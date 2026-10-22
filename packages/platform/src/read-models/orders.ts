import { orderProjection } from '../handlers/projections/order-projection.js'
import {
  buildOrderDoc,
  orderWrites,
  ORDERS,
  ORDERS_BY_CUSTOMER,
  type OrderDoc,
} from './builders.js'
import type { ReadModel } from './model.js'

export const orders: ReadModel = {
  name: 'orders',
  target: 'documents',
  collections: [ORDERS, ORDERS_BY_CUSTOMER],

  async *rebuild(ctx) {
    const { repos } = ctx.deps
    const docs = ctx.pages('orders', async (tx, page) => {
      const out: Array<OrderDoc & { id: string }> = []
      for (const order of await repos.order.listPage(tx, page)) {
        out.push(buildOrderDoc(order, await repos.orderHistory.listByOrder(tx, order.id)))
      }
      return out
    })
    for await (const page of docs) {
      for (const doc of page) yield* orderWrites(doc)
    }
  },

  handlers({ documentStore, logger, repos }) {
    return orderProjection({
      documentStore,
      logger,
      orderRepo: repos.order,
      orderHistoryRepo: repos.orderHistory,
    })
  },
}
