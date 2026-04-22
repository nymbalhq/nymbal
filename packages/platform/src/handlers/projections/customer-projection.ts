import {
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_DELETED,
  EVT_CUSTOMER_UPDATED,
  EVT_ORDER_PAID,
  type CustomerCreatedV1Payload,
  type CustomerDeletedV1Payload,
  type CustomerProfile,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type OrderPaidV1Payload,
} from '@nymbal/types'
import type { CustomerRepository } from '../../repositories/customer.js'
import type { OrderRepository } from '../../repositories/order.js'

const COLLECTION = 'customer-profiles'

export interface RegisterCustomerProjectionDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  logger: Logger
  customerRepo: CustomerRepository
  orderRepo: OrderRepository
}

function profileFrom(
  customerId: string,
  orderCount: number,
  totalSpentMinor: number,
  createdAt: string,
): CustomerProfile {
  return {
    customerId,
    orderCount,
    totalSpentMinor,
    segment:
      totalSpentMinor > 100_000 ? 'vip' : orderCount > 3 ? 'returning' : orderCount > 0 ? 'active' : 'new',
    createdAt,
  }
}

export async function registerCustomerProjection(deps: RegisterCustomerProjectionDeps): Promise<void> {
  const { eventBus, documentStore, logger, customerRepo } = deps

  const onCreated: EventHandler<CustomerCreatedV1Payload> = async (event) => {
    const { customerId } = event.payload
    const c = await customerRepo.findById(customerId)
    if (!c) return
    const profile = profileFrom(customerId, 0, 0, String(c.createdAt))
    await documentStore.put<CustomerProfile>(COLLECTION, customerId, profile)
    logger.debug({ customerId }, 'customer profile created')
  }

  const onUpdated: EventHandler<{ customerId: string }> = async (event) => {
    const c = await customerRepo.findById(event.payload.customerId)
    if (!c) return
    await documentStore.put<CustomerProfile>(
      COLLECTION,
      c.id,
      profileFrom(c.id, c.orderCount, c.totalSpentMinor, String(c.createdAt)),
    )
  }

  const onDeleted: EventHandler<CustomerDeletedV1Payload> = async (event) => {
    await documentStore.delete(COLLECTION, event.payload.customerId)
  }

  const onOrderPaid: EventHandler<OrderPaidV1Payload> = async (event) => {
    // Bump customer stats projection via repo reload.
    // Repo has already been incremented by CheckoutService.finalize.
    // Here we just re-project.
    const fresh = await customerRepo.findById(event.payload.orderId)
    if (!fresh) return
    await documentStore.put<CustomerProfile>(
      COLLECTION,
      fresh.id,
      profileFrom(fresh.id, fresh.orderCount, fresh.totalSpentMinor, String(fresh.createdAt)),
    )
  }

  await eventBus.subscribe(EVT_CUSTOMER_CREATED, onCreated as EventHandler, {
    name: 'customer-projection-created',
  })
  await eventBus.subscribe(EVT_CUSTOMER_UPDATED, onUpdated as EventHandler, {
    name: 'customer-projection-updated',
  })
  await eventBus.subscribe(EVT_CUSTOMER_DELETED, onDeleted as EventHandler, {
    name: 'customer-projection-deleted',
  })
  await eventBus.subscribe(EVT_ORDER_PAID, onOrderPaid as EventHandler, {
    name: 'customer-projection-order-paid',
  })
}
