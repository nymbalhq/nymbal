'use client'

import { useState } from 'react'
import type { DenormalisedProduct } from '@nymbalhq/sdk'
import { STOCK_LABELS, stockLevel } from '@nymbalhq/types'
import { useProduct, VariantSelector, AddToCart, QuantitySelector } from '@nymbalhq/react'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/pdp.module.css'

interface ProductInteractiveProps {
  product: DenormalisedProduct
}

export function ProductInteractive({ product }: ProductInteractiveProps) {
  const { selectedVariant } = useProduct(product.slug)

  const variant = selectedVariant ?? product.variants?.[0]
  const price = variant?.priceMinor ?? product.priceMinor ?? 0
  const currency = product.currency ?? 'GBP'
  // A product with no variants has nothing to sell, so it reads as out of stock.
  const stock = variant?.stock ?? 0
  const level = stockLevel(stock)

  // The quantity belongs to the variant it was chosen for, so a variant change starts again at 1.
  const [chosen, setChosen] = useState<{ variantId: string | undefined; qty: number }>({
    variantId: variant?.id,
    qty: 1,
  })
  const qty = chosen.variantId === variant?.id ? chosen.qty : 1

  // The selector derives its option groups from the product's variants.
  const hasVariantChoice = (product.variants?.length ?? 0) > 1

  return (
    <div>
      <h1 className={styles.productTitle} data-testid="product-title">
        {product.name}
      </h1>

      <div className={styles.price} data-testid="product-price">
        {formatPrice(price, currency)}
      </div>

      <div className={styles.stockBadge} data-testid="stock-badge" data-level={level}>
        <span className={styles.stockDot} aria-hidden="true" />
        {STOCK_LABELS[level]}
      </div>

      {hasVariantChoice && (
        <div className={styles.variantSection}>
          <VariantSelector />
        </div>
      )}

      <div className={styles.addToCartSection}>
        <div className={styles.quantityWrapper}>
          <QuantitySelector
            key={variant?.id}
            value={1}
            min={1}
            max={99}
            onQuantityChange={(e) => setChosen({ variantId: variant?.id, qty: e.detail.value })}
          />
        </div>
        <AddToCart variantId={variant?.id ?? product.id} qty={qty} disabled={stock <= 0} />
      </div>
    </div>
  )
}
