import type { Address, OrderLineItem, OrderStatus } from '@nymbal/types'
import type { OrderImportInput } from '@nymbal/platform'
import type { WcOrder, WcAddress } from '../client.js'
import { v7 as uuidv7 } from 'uuid'

const PRICE_MINOR_FACTOR = 100

function toMinor(value: string | number): number {
  const n = typeof value === 'string' ? parseFloat(value) : value
  return isNaN(n) ? 0 : Math.round(n * PRICE_MINOR_FACTOR)
}

const STATUS_MAP: Record<string, OrderStatus> = {
  pending: 'pending',
  processing: 'processing',
  'on-hold': 'pending',
  completed: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
  failed: 'cancelled',
}

function mapAddress(a: WcAddress): Address {
  const addr: Address = {
    firstName: a.first_name,
    lastName: a.last_name,
    addressLine1: a.address_1 || '—',
    city: a.city || '—',
    region: a.state,
    postalCode: a.postcode,
    country: a.country || 'US',
  }
  if (a.address_2) addr.addressLine2 = a.address_2
  if (a.phone) addr.phone = a.phone
  if (a.company) addr.company = a.company
  return addr
}

export function mapOrder(
  wc: WcOrder,
  nymbalCustomerId: string | null,
  nymbalProductIds: Record<number, string>,
  currency: string,
): OrderImportInput {
  const status: OrderStatus = STATUS_MAP[wc.status] ?? 'pending'

  const lineItems: OrderLineItem[] = wc.line_items.map((li) => ({
    variantId: nymbalProductIds[li.product_id] ?? 'unknown',
    productId: nymbalProductIds[li.product_id] ?? 'unknown',
    productName: li.name,
    variantName: li.name,
    sku: li.sku,
    qty: li.quantity,
    unitPriceMinor: toMinor(li.price),
    lineSubtotalMinor: toMinor(li.subtotal),
    lineTaxMinor: 0,
    lineTotalMinor: toMinor(li.total),
    imageUrl: '',
  }))

  const shippingTotal = wc.shipping_lines.reduce((sum, s) => sum + toMinor(s.total), 0)
  const taxTotal = toMinor(wc.total_tax)
  const discountTotal = toMinor(wc.discount_total)
  const totalMinor = toMinor(wc.total)
  const subtotalMinor = totalMinor - taxTotal - shippingTotal + discountTotal

  const billing = mapAddress(wc.billing)
  const shipping = wc.shipping.address_1 ? mapAddress(wc.shipping) : billing
  const email = wc.billing.email ?? `wc-${wc.id}@unknown.nymbal.local`

  const result: OrderImportInput = {
    orderId: uuidv7(),
    orderNumber: `WC-${wc.number}`,
    status,
    customerId: nymbalCustomerId,
    email,
    billingAddress: billing,
    shippingAddress: shipping,
    lineItems,
    subtotalMinor,
    taxTotalMinor: taxTotal,
    shippingTotalMinor: shippingTotal,
    discountTotalMinor: discountTotal,
    totalMinor,
    currency: wc.currency || currency,
    metadata: {
      woocommerce: {
        orderId: wc.id,
        orderNumber: wc.number,
        originalStatus: wc.status,
        paymentMethod: wc.payment_method,
        syncedAt: new Date().toISOString(),
      },
    },
    createdAt: new Date(wc.date_created),
  }
  if (wc.customer_note) result.notes = wc.customer_note
  return result
}
