import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { loadOrder } from '@/lib/api'
import { OrderSummary, OrderTimeline } from '@/components/client/elements'
import { renderNymbal } from '@/lib/render'
import { OrderStatusRefresh } from '@/components/client/OrderStatusRefresh'
import { isPaid, orderHeading } from '@/lib/order-status'
import styles from '@/styles/pages/confirmation.module.css'

interface OrderPageProps {
  params: Promise<{ orderNumber: string }>
  searchParams: Promise<{ key?: string | string[] }>
}

// The URL carries the order's key (`?key=`), so nothing this page links to or loads may be told the URL: the meta
// tag here, and the header next.config.mjs sets on every /order/<n> response, the not-found render's too.
export async function generateMetadata({ params }: OrderPageProps): Promise<Metadata> {
  const { orderNumber } = await params
  return {
    title: `Order ${orderNumber}`,
    referrer: 'no-referrer',
  }
}

function AddressBlock({
  title,
  address,
}: {
  title: string
  address: {
    firstName?: string
    lastName?: string
    addressLine1: string
    addressLine2?: string
    city: string
    region: string
    postalCode: string
    country: string
  } | null
}) {
  if (!address) return null

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

export default async function OrderPage({ params, searchParams }: OrderPageProps) {
  const { orderNumber } = await params
  const { key: keyParam } = await searchParams
  const key = Array.isArray(keyParam) ? keyParam[0] : keyParam
  // Rejects when the API fails, so a failed read is a 500 and never a 404 for an order the shopper has.
  const order = await loadOrder(orderNumber, key)

  if (!order) notFound()
  const paid = isPaid(order.status)
  const items = order.lineItems.map((item) => ({
    name: `${item.productName}${item.variantName ? ` - ${item.variantName}` : ''}`,
    qty: item.qty,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.lineTotalMinor,
  }))
  const summary = {
    items: JSON.stringify(items),
    'subtotal-minor': String(order.subtotalMinor),
    'discount-minor': String(order.discountTotalMinor ?? 0),
    'shipping-minor': String(order.shippingTotalMinor ?? 0),
    'tax-minor': String(order.taxTotalMinor ?? 0),
    'total-minor': String(order.totalMinor),
    currency: order.currency,
  }
  const timeline = order.timeline ?? []

  return (
    <div className={`container ${styles.page}`}>
      <OrderStatusRefresh orderNumber={order.orderNumber} orderKey={key} status={order.status} />
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
          serverHtml={
            renderNymbal('nymbal-order-timeline', { entries: JSON.stringify(timeline) }).__html
          }
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
          serverHtml={renderNymbal('nymbal-order-summary', summary).__html}
        />

        <div className={styles.orderCard}>
          <h3 className={styles.orderCardTitle}>Delivery Details</h3>
          <div className={styles.addressGrid}>
            <AddressBlock title="Shipping Address" address={order.shippingAddress} />
            <AddressBlock title="Billing Address" address={order.billingAddress} />
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
