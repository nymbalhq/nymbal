import {
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_DELETED,
  EVT_CUSTOMER_UPDATED,
  EVT_ORDER_PAID,
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  type CustomerProfile,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
} from '@nymbalhq/types'
import type { CustomerRepository } from '../../repositories/customer.js'
import type { OrderRepository } from '../../repositories/order.js'
import { buildCustomerProfile, CUSTOMER_PROFILES } from '../../read-models/builders.js'
import { subscribeDerived, type DerivedHandler } from '../derived.js'

export interface CustomerProjectionDeps {
  documentStore: DocumentStoreAdapter
  logger: Logger
  customerRepo: CustomerRepository
  orderRepo: OrderRepository
}

export interface RegisterCustomerProjectionDeps extends CustomerProjectionDeps {
  eventBus: EventBusAdapter
}

/** `customer-profiles`, from the customer row as it is at handle time: its stats move with payments and refunds. */
export function customerProjection(deps: CustomerProjectionDeps): DerivedHandler[] {
  const { documentStore, logger, customerRepo, orderRepo } = deps

  async function reproject(customerId: string): Promise<void> {
    const c = await customerRepo.store.read((tx) => customerRepo.findById(tx, customerId))
    if (!c) {
      await documentStore.delete(CUSTOMER_PROFILES, customerId)
      return
    }
    await documentStore.put<CustomerProfile>(CUSTOMER_PROFILES, c.id, buildCustomerProfile(c))
    logger.debug({ customerId }, 'customer profile projected')
  }

  const onCustomer: EventHandler<{ customerId: string }> = (event) =>
    reproject(event.payload.customerId)

  const onOrder: EventHandler<{ orderId: string }> = async (event) => {
    const order = await orderRepo.store.read((tx) => orderRepo.findById(tx, event.payload.orderId))
    if (order?.customerId) await reproject(order.customerId)
  }

  return [
    {
      name: 'customer-projection-created',
      types: [EVT_CUSTOMER_CREATED],
      handle: onCustomer as EventHandler,
    },
    {
      name: 'customer-projection-updated',
      types: [EVT_CUSTOMER_UPDATED],
      handle: onCustomer as EventHandler,
    },
    {
      name: 'customer-projection-deleted',
      types: [EVT_CUSTOMER_DELETED],
      handle: onCustomer as EventHandler,
    },
    {
      name: 'customer-projection-order-paid',
      types: [EVT_ORDER_PAID],
      handle: onOrder as EventHandler,
    },
    {
      name: 'customer-projection-order-refunded',
      types: [EVT_ORDER_REFUNDED, EVT_ORDER_PARTIALLY_REFUNDED],
      handle: onOrder as EventHandler,
    },
  ]
}

export async function registerCustomerProjection(
  deps: RegisterCustomerProjectionDeps,
): Promise<void> {
  await subscribeDerived(deps.eventBus, customerProjection(deps))
}
