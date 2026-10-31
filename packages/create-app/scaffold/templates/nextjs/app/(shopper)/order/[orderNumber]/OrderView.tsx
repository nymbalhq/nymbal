import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ShopperAddress, ShopperOrder } from '@nymbalhq/types'
import { OrderSummary, OrderTimeline } from '@/components/client/elements'
import { isPaid, orderHeading } from '@/lib/order-status'
import styles from '@/styles/pages/confirmation.module.css'

function AddressBlock({ title, address }: { title: string; address: ShopperAddress }) {
  return (
    <div className={styles.addressCard}>
      <h4 className={styles.addressTitle}>{title}</h4>
      <p className={styles.addressText}>
        {address.firstName} {address.lastName}
        <br />
        {address.addressLine1}
        {address.addressLine2 && <>, {address.addressLine2}</>}
        <br />
        {address.city}, {address.region} {address.postalCode}
        <br />
        {address.country}
      </p>
    </div>
  )
}

/** The order summary element's attributes, as the server renders them and the browser keeps them. */
export function summaryAttributes(order: ShopperOrder): Record<string, string> {
  return {
    items: JSON.stringify(summaryItems(order)),
    'subtotal-minor': String(order.subtotalMinor),
    'discount-minor': String(order.discountTotalMinor ?? 0),
    'shipping-minor': String(order.shippingTotalMinor ?? 0),
    'tax-minor': String(order.taxTotalMinor ?? 0),
    'total-minor': String(order.totalMinor),
    currency: order.currency,
  }
}

function summaryItems(order: ShopperOrder) {
  return order.lineItems.map((item) => ({
    name: `${item.productName}${item.variantName ? ` - ${item.variantName}` : ''}`,
    qty: item.qty,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.lineTotalMinor,
  }))
}

/**
 * The order as its key opens it: the confirmation page's fields and where it ships. A key holder reads no billing
 * address and no email, so the page shows neither. The server passes the elements' server HTML and the status poll;
 * the email prompt renders it in the browser with neither.
 */
export function OrderView({
  order,
  timelineHtml,
  summaryHtml,
  refresh,
}: {
  order: ShopperOrder
  timelineHtml?: string
  summaryHtml?: string
  refresh?: ReactNode
}) {
  const paid = isPaid(order.status)
  const items = summaryItems(order)
  const timeline = order.timeline ?? []

  return (
    <div className={`container ${styles.page}`}>
      {refresh}
      <div className={styles.wrapper}>
        <div className={styles.successHeader}>
          {paid && (
            <div className={styles.checkCircle}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
          <h1 className={styles.successTitle} data-testid="order-heading">
            {orderHeading(order.status)}
          </h1>
          <p className={styles.successSubtitle}>
            {paid ? 'Thank you for your order. ' : ''}Your order number is{' '}
            <span className={styles.orderNumber} data-testid="order-number">
              {order.orderNumber}
            </span>
            . Status:{' '}
            <span data-testid="order-status" style={{ textTransform: 'capitalize' }}>
              {order.status}
            </span>
            .{order.status === 'pending' && ' We will confirm it once the payment arrives.'}
          </p>
        </div>

        <OrderTimeline
          className={styles.summary}
          entries={timeline}
          {...(timelineHtml !== undefined && { serverHtml: timelineHtml })}
        />

        <OrderSummary
          className={styles.summary}
          items={items}
          subtotalMinor={order.subtotalMinor}
          discountMinor={order.discountTotalMinor ?? 0}
          shippingMinor={order.shippingTotalMinor ?? 0}
          taxMinor={order.taxTotalMinor ?? 0}
          totalMinor={order.totalMinor}
          currency={order.currency}
          {...(summaryHtml !== undefined && { serverHtml: summaryHtml })}
        />

        <div className={styles.orderCard}>
          <h3 className={styles.orderCardTitle}>Delivery Details</h3>
          <div className={styles.addressGrid}>
            <AddressBlock title="Shipping Address" address={order.shippingAddress} />
          </div>
        </div>

        <div className={styles.actions}>
          <Link href="/products" className={styles.continueButton}>
            Continue Shopping
          </Link>
          <Link href="/account/orders" className={styles.orderLink}>
            View All Orders
          </Link>
        </div>
      </div>
    </div>
  )
}
