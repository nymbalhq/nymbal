'use client'

import type { DenormalisedProduct, DenormalisedVariant } from '@nymbal/sdk'
import { useProduct, VariantSelector, AddToCart } from '@nymbal/react'
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
  const stock = variant?.stock ?? (product.inStock ? 10 : 0)

  const variantOptions = product.variants?.map((v) => ({
    id: v.id,
    name: v.name,
    options: v.options ?? [],
  })) ?? []

  const handleVariantSelected = (e: CustomEvent<{ variant: unknown }>) => {
    const v = e.detail.variant as DenormalisedVariant | undefined
    if (v) {
      // The product store handles variant selection internally
    }
  }

  return (
    <div>
      <h1 className={styles.productTitle} data-testid="product-title">{product.name}</h1>

      <div className={styles.price} data-testid="product-price">
        {formatPrice(price, currency)}
      </div>

      <div className={styles.stockBadge} data-testid="stock-badge">
        {stock === 0 ? (
          <span style={{ color: 'var(--nymbal-color-error)' }}>Out of Stock</span>
        ) : stock < 5 ? (
          <span style={{ color: 'var(--nymbal-color-warning)' }}>Low Stock — {stock} left</span>
        ) : (
          <span style={{ color: 'var(--nymbal-color-success)' }}>In Stock</span>
        )}
      </div>

      {variantOptions.length > 1 && (
        <div className={styles.variantSection}>
          <VariantSelector
            options={JSON.stringify(variantOptions)}
            onVariantSelected={handleVariantSelected}
          />
        </div>
      )}

      <div className={styles.addToCartSection}>
        <AddToCart
          variantId={variant?.id ?? product.id}
          disabled={stock === 0}
        />
      </div>
    </div>
  )
}
