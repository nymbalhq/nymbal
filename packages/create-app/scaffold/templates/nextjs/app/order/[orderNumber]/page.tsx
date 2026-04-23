import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { fetchOrder } from '@/lib/api'
import { OrderSummary } from '@/components/server/OrderSummary'
import styles from '@/styles/pages/confirmation.module.css'

interface OrderPageProps {
  params: Promise<{ orderNumber: string }>
}

export async function generateMetadata({
  params,
}: OrderPageProps): Promise<Metadata> {
  const { orderNumber } = await params
  return {
    title: `Order ${orderNumber}`,
  }
}

function AddressBlock({ title, address }: { title: string; address: { firstName?: string; lastName?: string; addressLine1: string; addressLine2?: string; city: string; region: string; postalCode: string; country: string } | null }) {
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

export default async function OrderPage({ params }: OrderPageProps) {
  const { orderNumber } = await params
  const order = await fetchOrder(orderNumber)

  if (!order) notFound()

  return (
    <div className={`container ${styles.page}`}>
      <div className={styles.wrapper}>
        <div className={styles.successHeader}>
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
          <h1 className={styles.successTitle}>Order Confirmed</h1>
          <p className={styles.successSubtitle}>
            Thank you for your order. Your order number is{' '}
            <span className={styles.orderNumber} data-testid="order-number">
              {order.orderNumber}
            </span>
            .
          </p>
        </div>

        <OrderSummary
          items={order.lineItems}
          subtotalMinor={order.subtotalMinor}
          currency={order.currency}
          shippingTotalMinor={order.shippingTotalMinor}
          taxTotalMinor={order.taxTotalMinor}
          totalMinor={order.totalMinor}
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
