import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { OrderLineItem, OrderStatus } from '@nymbalhq/types'
import { address, type Kernel } from './kernel.js'
import { unaudited } from './write-audit.js'

// Orders written straight to the command store in any status, at any time, for any email, as the admin lists read
// them: a list filter reads the rows, not how they came to be.

export interface OrderSpec {
  status: OrderStatus
  createdAt?: Date
  customerId?: string | null
  email?: string
}

export interface WrittenOrder {
  id: string
  orderNumber: string
  status: OrderStatus
  createdAt: Date
}

function line(): OrderLineItem {
  const tag = randomUUID()
  return {
    variantId: `variant-${tag}`,
    productId: `product-${tag}`,
    productName: 'Listed product',
    variantName: 'Default',
    sku: `LIST-${tag}`,
    qty: 1,
    unitPriceMinor: 1200,
    lineSubtotalMinor: 1200,
    lineTaxMinor: 0,
    lineTotalMinor: 1200,
    imageUrl: '',
  }
}

/** Writes the orders in one transaction, outside the write audit; answers them in the given order. */
export async function insertOrders(
  k: Pick<Kernel, 'store' | 'repos'>,
  specs: OrderSpec[],
): Promise<WrittenOrder[]> {
  const written = specs.map((spec) => ({
    id: uuidv7(),
    orderNumber: `LIST-${randomUUID().slice(0, 12)}`,
    status: spec.status,
    createdAt: spec.createdAt ?? new Date(),
  }))
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      for (const [i, spec] of specs.entries()) {
        const order = written[i]!
        const lineItems = [line()]
        const sequence = await k.repos.orderSequence.nextSequence(tx)
        await k.repos.order.insert(tx, {
          id: order.id,
          orderNumber: order.orderNumber,
          sequence,
          customerId: spec.customerId ?? null,
          status: spec.status,
          email: spec.email ?? `buyer-${randomUUID()}@listed.test`,
          billingAddress: address,
          shippingAddress: address,
          lineItems,
          subtotalMinor: 1200,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor: 1200,
          currency: 'GBP',
          notes: '',
          metadata: {},
          paymentIntentId: null,
          createdAt: order.createdAt,
          updatedAt: order.createdAt,
        })
      }
    }),
  )
  return written
}
