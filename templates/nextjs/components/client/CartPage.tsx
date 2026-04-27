'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useCart, QuantitySelector } from '@nymbal/react'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/cart.module.css'

export function CartPage() {
  const { items, subtotalMinor, currency, removeItem, updateQuantity, loading } = useCart()

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner spinner-lg" role="status">
          <span className="visually-hidden">Loading cart...</span>
        </div>
      </div>
    )
  }

  if (!items || items.length === 0) {
    return (
      <div className={`container ${styles.page}`}>
        <h1 className={styles.pageTitle}>Shopping Cart</h1>
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>Your cart is empty</h2>
          <p className={styles.emptyText}>
            Looks like you have not added anything to your cart yet.
          </p>
          <Link href="/products" className="btn btn-primary" data-testid="continue-shopping">
            Continue Shopping
          </Link>
        </div>
      </div>
    )
  }

  const cartCurrency = currency ?? 'GBP'

  return (
    <div className={`container ${styles.page}`}>
      <h1 className={styles.pageTitle}>Shopping Cart</h1>
      <div className={styles.layout}>
        <div className={styles.itemsSection}>
          <div className={styles.itemsList}>
            {items.map((item) => (
              <div key={item.variantId} className={styles.item} data-testid={`cart-item-${item.variantId}`}>
                <div className={styles.itemImage}>
                  {item.imageUrl ? (
                    <Image
                      src={item.imageUrl}
                      alt={item.productName}
                      width={96}
                      height={96}
                    />
                  ) : (
                    <span className="visually-hidden">No image</span>
                  )}
                </div>
                <div className={styles.itemDetails}>
                  <Link href={`/product/${item.productId}`} className={styles.itemName}>
                    {item.productName}
                  </Link>
                  {item.variantName && (
                    <span className={styles.itemVariant}>{item.variantName}</span>
                  )}
                  <div className={styles.itemActions}>
                    <QuantitySelector
                      value={item.qty}
                      min={1}
                      max={99}
                      onQuantityChange={(e) => updateQuantity(item.variantId, e.detail.value)}
                    />
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => removeItem(item.variantId)}
                      aria-label={`Remove ${item.productName} from cart`}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <span className={styles.itemPrice}>
                  {formatPrice(item.priceMinor * item.qty, cartCurrency)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.summary}>
          <h2 className={styles.summaryTitle}>Order Summary</h2>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Subtotal</span>
            <span className={styles.summaryValue}>
              {formatPrice(subtotalMinor ?? 0, cartCurrency)}
            </span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Shipping</span>
            <span className={styles.summaryValue}>Calculated at checkout</span>
          </div>
          <hr className={styles.summaryDivider} />
          <div className={`${styles.summaryRow} ${styles.summaryTotal}`}>
            <span>Estimated Total</span>
            <span>{formatPrice(subtotalMinor ?? 0, cartCurrency)}</span>
          </div>
          <Link href="/checkout" className={styles.checkoutButton}>
            Proceed to Checkout
          </Link>
          <Link href="/products" className={styles.continueShoppingLink}>
            Continue Shopping
          </Link>
        </div>
      </div>
    </div>
  )
}
