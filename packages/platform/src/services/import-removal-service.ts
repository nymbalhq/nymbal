import { EVT_CUSTOMER_DELETED, EVT_ORDER_DELETED, type Logger } from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Repositories } from '../repositories/index.js'

/** A record already gone is `absent`, not an error, so a removal stopped half way can run again. */
export type RemovalOutcome = 'removed' | 'absent'

/** What the store did on its own since an import began: orders and reviews no import created. */
export interface StoreActivity {
  /** Orders not held, created since; and held orders that have been shipped, refunded or given a key since. */
  orders: number
  /** Reviews not held, submitted since. */
  reviews: number
}

/**
 * Takes records an import created back out of the store. Each removal is one transaction under its own audit entry.
 * Products and categories go through their own services' `delete`.
 */
export interface ImportRemovalService {
  /** Deletes the order with its history, refunds, access keys and shipment, and publishes `order.deleted.v1`. */
  removeOrder(id: string): Promise<RemovalOutcome>
  /** Deletes the customer and its refresh tokens, and publishes `customer.deleted.v1`. */
  removeCustomer(id: string): Promise<RemovalOutcome>
  /** Deletes the review row; as a submission publishes nothing, neither does this. */
  removeReview(id: string): Promise<RemovalOutcome>
  activitySince(
    since: string,
    held: { orders: string[]; reviews: string[] },
  ): Promise<StoreActivity>
}

export interface ImportRemovalServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}

export function createImportRemovalService(deps: ImportRemovalServiceDeps): ImportRemovalService {
  const { store, repos, publisher, logger } = deps

  return {
    async removeOrder(id) {
      return store.transaction(async (tx) => {
        const order = await repos.order.findById(tx, id)
        if (order === null) return 'absent'
        audit.note('order.remove', [{ type: 'order', id }])
        // The shipment references the order by a foreign key, so it goes before the order.
        await repos.orderShipment.deleteByOrder(tx, id)
        await repos.orderAccessKey.deleteByOrder(tx, id)
        await repos.orderRefund.deleteByOrder(tx, id)
        await repos.orderHistory.deleteByOrder(tx, id)
        await repos.order.delete(tx, id)
        await publisher.publish(EVT_ORDER_DELETED, {
          orderId: id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          createdAt: order.createdAt,
          source: order.source,
          currency: order.currency,
          capturedMinor: order.capturedMinor,
          refundedMinor: order.refundedMinor,
          lineItems: order.lineItems,
        })
        logger.debug({ orderId: id }, 'imported order removed')
        return 'removed'
      })
    },

    async removeCustomer(id) {
      return store.transaction(async (tx) => {
        const customer = await repos.customer.findById(tx, id)
        if (customer === null) return 'absent'
        audit.note('customer.remove', [{ type: 'customer', id }])
        await repos.refreshToken.deleteByCustomer(tx, id)
        await repos.passwordResetToken.deleteByCustomer(tx, id)
        await repos.emailVerificationToken.deleteByCustomer(tx, id)
        await repos.customer.delete(tx, id)
        await publisher.publish(EVT_CUSTOMER_DELETED, { customerId: id })
        logger.debug({ customerId: id }, 'imported customer removed')
        return 'removed'
      })
    },

    async removeReview(id) {
      return store.transaction(async (tx) => {
        const review = await repos.review.findById(tx, id)
        if (review === null) return 'absent'
        audit.note('review.remove', [{ type: 'review', id }])
        await repos.review.delete(tx, id)
        logger.debug({ reviewId: id }, 'imported review removed')
        return 'removed'
      })
    },

    // The ids read are those written since the import began, which a store with no activity of its own keeps to the
    // imported reviews; they are compared in memory, so no statement binds the whole held set.
    async activitySince(since, held) {
      const at = new Date(since)
      const heldOrders = new Set(held.orders)
      const heldReviews = new Set(held.reviews)
      return store.read(async (tx) => {
        const live = new Set<string>()
        for (const orderId of await repos.order.idsCreatedSince(tx, at)) {
          if (!heldOrders.has(orderId)) live.add(orderId)
        }
        const touched = [
          ...(await repos.orderHistory.orderIdsSince(tx, at)),
          ...(await repos.orderRefund.orderIdsSince(tx, at)),
          ...(await repos.orderAccessKey.orderIdsSince(tx, at)),
          ...(await repos.orderShipment.orderIdsSince(tx, at)),
        ]
        for (const orderId of touched) if (heldOrders.has(orderId)) live.add(orderId)
        const reviews = (await repos.review.idsSubmittedSince(tx, at)).filter(
          (reviewId) => !heldReviews.has(reviewId),
        )
        return { orders: live.size, reviews: reviews.length }
      })
    },
  }
}
