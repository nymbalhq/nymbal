import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/confirmation.module.css'

interface OrderLineItem {
  variantId: string
  productId: string
  productName: string
  variantName: string
  sku: string
  qty: number
  unitPriceMinor: number
  lineTotalMinor: number
  imageUrl?: string
}

interface OrderSummaryProps {
  items: OrderLineItem[]
  subtotalMinor: number
  currency: string
  shippingTotalMinor: number
  taxTotalMinor: number
  totalMinor: number
}

export function OrderSummary({
  items,
  subtotalMinor,
  currency,
  shippingTotalMinor,
  taxTotalMinor,
  totalMinor,
}: OrderSummaryProps) {
  return (
    <div className={styles.orderCard}>
      <h3 className={styles.orderCardTitle}>Order Items</h3>
      <div className={styles.lineItems}>
        {items.map((item) => (
          <div key={item.variantId} className={styles.lineItem}>
            {item.imageUrl && (
              <div className={styles.lineItemImage}>
                <img src={item.imageUrl} alt={item.productName} />
              </div>
            )}
            <div className={styles.lineItemInfo}>
              <p className={styles.lineItemName}>{item.productName}</p>
              {item.variantName && (
                <p className={styles.lineItemVariant}>{item.variantName}</p>
              )}
              <p className={styles.lineItemQty}>Qty: {item.qty}</p>
            </div>
            <span className={styles.lineItemPrice}>
              {formatPrice(item.lineTotalMinor, currency)}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.totals}>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Subtotal</span>
          <span>{formatPrice(subtotalMinor, currency)}</span>
        </div>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Shipping</span>
          <span>
            {shippingTotalMinor === 0 ? 'Free' : formatPrice(shippingTotalMinor, currency)}
          </span>
        </div>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Tax</span>
          <span>{formatPrice(taxTotalMinor, currency)}</span>
        </div>
        <div className={`${styles.totalRow} ${styles.totalGrand}`}>
          <span>Total</span>
          <span>{formatPrice(totalMinor, currency)}</span>
        </div>
      </div>
    </div>
  )
}
