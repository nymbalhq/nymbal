import { createHash } from 'node:crypto'
import type { Address, OrderLineItem, OrderStatus } from '@nymbalhq/types'
import type { OrderImportInput } from '@nymbalhq/platform'
import type { WcOrder, WcAddress } from '../client.js'
import { v7 as uuidv7 } from 'uuid'
import { anonymisedCustomerEmail } from './customer.js'
import { toMinorUnits } from './money.js'

export interface OrderMapOptions {
  /** Keep no buyer's name, email, phone, street, postcode or note: only region and country. */
  gdpr?: boolean
  /** Nymbal variant ids by WooCommerce variation id, or by product id for a simple product. */
  variantIds?: Record<number, string>
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

/** WooCommerce statuses whose order was paid; a refunded order was paid, then refunded in full. */
const PAID_STATUSES = new Set(['processing', 'completed', 'refunded'])

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

/** An address that says only where, for tax and sales reporting: a postcode can narrow to a few households. */
function regionOnly(a: WcAddress): Address {
  return {
    firstName: '',
    lastName: '',
    addressLine1: '—',
    city: '—',
    postalCode: '',
    region: a.state,
    country: a.country || 'US',
  }
}

/** A guest's orders are not linked by a hash of their email, which would still be personal data. */
function guestEmail(wcOrderId: number): string {
  const hash = createHash('sha256').update(String(wcOrderId)).digest('hex').slice(0, 12)
  return `order-${hash}@imported.nymbal.local`
}

export function mapOrder(
  wc: WcOrder,
  nymbalCustomerId: string | null,
  nymbalProductIds: Record<number, string>,
  currency: string,
  opts: OrderMapOptions = {},
): OrderImportInput {
  const status: OrderStatus = STATUS_MAP[wc.status] ?? 'pending'
  const orderCurrency = wc.currency || currency
  const minor = (value: string | number | undefined) => toMinorUnits(value ?? '', orderCurrency) ?? 0
  const variantIds = opts.variantIds ?? {}

  const productLines: OrderLineItem[] = wc.line_items.map((li) => ({
    variantId: variantIds[li.variation_id || li.product_id] ?? 'unknown',
    productId: nymbalProductIds[li.product_id] ?? 'unknown',
    productName: li.name,
    variantName: li.name,
    sku: li.sku,
    qty: li.quantity,
    unitPriceMinor: minor(li.price),
    lineSubtotalMinor: minor(li.subtotal),
    lineTaxMinor: minor(li.total_tax),
    lineTotalMinor: minor(li.total),
    imageUrl: '',
  }))
  // The order has no fee field: a fee, or a negative fee as a credit, is a line of its own.
  const feeLines: OrderLineItem[] = (wc.fee_lines ?? []).map((fee) => {
    const amount = minor(fee.total)
    return {
      variantId: `fee:${fee.id}`,
      productId: '',
      productName: fee.name,
      variantName: '',
      sku: '',
      qty: 1,
      unitPriceMinor: amount,
      lineSubtotalMinor: amount,
      lineTaxMinor: minor(fee.total_tax),
      lineTotalMinor: amount,
      imageUrl: '',
    }
  })
  const lineItems = [...productLines, ...feeLines]

  const shippingTotal = wc.shipping_lines.reduce((sum, s) => sum + minor(s.total), 0)
  const totalMinor = minor(wc.total)
  const subtotalMinor = lineItems.reduce((sum, l) => sum + l.lineSubtotalMinor, 0)

  let billing: Address
  let shipping: Address
  let email: string
  if (opts.gdpr) {
    billing = regionOnly(wc.billing)
    shipping = wc.shipping.country ? regionOnly(wc.shipping) : billing
    email = wc.customer_id > 0 ? anonymisedCustomerEmail(wc.customer_id) : guestEmail(wc.id)
  } else {
    billing = mapAddress(wc.billing)
    shipping = wc.shipping.address_1 ? mapAddress(wc.shipping) : billing
    email = wc.billing.email?.trim() || `wc-${wc.id}@unknown.nymbal.local`
  }

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
    taxTotalMinor: minor(wc.total_tax),
    shippingTotalMinor: shippingTotal,
    discountTotalMinor: minor(wc.discount_total),
    totalMinor,
    currency: orderCurrency,
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
  // A free order took no money: nothing captured.
  if (PAID_STATUSES.has(wc.status) && totalMinor > 0) {
    const refunds = (wc.refunds ?? []).reduce((sum, r) => sum + Math.abs(minor(r.total)), 0)
    result.capturedMinor = totalMinor
    result.refundedMinor = wc.status === 'refunded' ? totalMinor : Math.min(totalMinor, refunds)
    result.captureMethod = 'import'
  }
  if (!opts.gdpr && wc.customer_note) result.notes = wc.customer_note
  return result
}
