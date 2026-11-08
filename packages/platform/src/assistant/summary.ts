import type { Address, Order, OrderStatus, ProductSnapshot, Variant } from '@nymbalhq/types'

// What the admin's assistant sends its model of each item of an orders or products list: a record's own fields under
// the record's own key names, so the mask (`kindOfKey`) reads a summary's customer values as it reads the whole
// record's, and nothing written at length (notes, metadata, a description) rides along.

export type OrderSummary = {
  orderNumber: string
  status: OrderStatus
  createdAt: string
  email: string
  /** The shipping address's; undefined where a result's order has none. */
  firstName: string | undefined
  lastName: string | undefined
  city: string | undefined
  postalCode: string | undefined
  country: string | undefined
  /** The order's own money, never its payment's. */
  totalMinor: number
  capturedMinor: number
  refundedMinor: number
  /** capturedMinor less refundedMinor: the order's revenue. */
  keptMinor: number
  /** Σ of the line quantities. */
  itemCount: number
}

export type ProductSummary = {
  id: string
  slug: string
  name: string
  status: ProductSnapshot['status']
  type: ProductSnapshot['type']
  variants: Array<Pick<Variant, 'id' | 'name' | 'sku' | 'priceMinor' | 'stock' | 'status' | 'options'>>
}

/** An order of a list as the assistant's model reads it. */
export function orderSummary(order: Order): OrderSummary {
  // A tool result is read as it came: an order missing an address or its lines is summarised from what it has.
  const ship = order.shippingAddress as Partial<Address> | undefined
  const lines = (order.lineItems as Order['lineItems'] | undefined) ?? []
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt,
    email: order.email,
    firstName: ship?.firstName,
    lastName: ship?.lastName,
    city: ship?.city,
    postalCode: ship?.postalCode,
    country: ship?.country,
    totalMinor: order.totalMinor,
    capturedMinor: order.capturedMinor,
    refundedMinor: order.refundedMinor,
    keptMinor: order.capturedMinor - order.refundedMinor,
    itemCount: lines.reduce((sum, line) => sum + line.qty, 0),
  }
}

/** A product of a list as the assistant's model reads it. */
export function productSummary(product: ProductSnapshot): ProductSummary {
  const variants = (product.variants as ProductSnapshot['variants'] | undefined) ?? []
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    status: product.status,
    type: product.type,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      sku: v.sku,
      priceMinor: v.priceMinor,
      stock: v.stock,
      status: v.status,
      options: v.options,
    })),
  }
}
