'use client'

import { useRef, useState } from 'react'
import type { DenormalisedProduct } from '@nymbalhq/sdk'
import {
  useProduct,
  VariantSelector,
  AddToCart,
  ProductPrice,
  QuantitySelector,
  StockBadge,
} from '@nymbalhq/react'
import styles from '@/styles/pages/pdp.module.css'

interface ProductInteractiveProps {
  product: DenormalisedProduct
  /** The server's render of each element, for the product's first variant (app/product/[slug]/page.tsx). */
  serverHtml?: {
    price: string
    stock: string
    variantSelector: string
    quantity: string
    addToCart: string
  }
}

export function ProductInteractive({ product, serverHtml }: ProductInteractiveProps) {
  const { selectedVariant } = useProduct(product.slug)

  const variant = selectedVariant ?? product.variants?.[0]
  // A product with no variants has nothing to sell, so it reads as out of stock.
  const stock = variant?.stock ?? 0
  // The price and the badge are the server's first variant until the store settles on this product; they follow it
  // themselves, so a soft navigation from another product never shows that product's price here.
  const first = product.variants?.[0]

  // The quantity belongs to the variant it was chosen for, so a variant change starts again at 1.
  const [chosen, setChosen] = useState<{ variantId: string | undefined; qty: number }>({
    variantId: variant?.id,
    qty: 1,
  })
  // Reset on the change itself, so a quantity left on a variant is not there again when the shopper comes back to it.
  if (chosen.variantId !== variant?.id) setChosen({ variantId: variant?.id, qty: 1 })
  const qty = chosen.variantId === variant?.id ? chosen.qty : 1
  const addToCartRef = useRef<HTMLElement>(null)

  // The selector derives its option groups from the product's variants.
  const hasVariantChoice = (product.variants?.length ?? 0) > 1

  return (
    <div>
      <h1 className={styles.productTitle} data-testid="product-title">
        {product.name}
      </h1>

      <ProductPrice
        productId={product.id}
        priceMinor={first?.priceMinor ?? product.priceMinor ?? 0}
        currency={product.currency ?? 'GBP'}
        serverHtml={serverHtml?.price}
      />

      <StockBadge productId={product.id} stock={first?.stock ?? 0} serverHtml={serverHtml?.stock} />

      {hasVariantChoice && (
        <div className={styles.variantSection}>
          <VariantSelector product={product} serverHtml={serverHtml?.variantSelector} />
        </div>
      )}

      <div className={styles.addToCartSection}>
        <div className={styles.quantityWrapper}>
          <QuantitySelector
            key={variant?.id}
            value={1}
            min={1}
            max={99}
            serverHtml={serverHtml?.quantity}
            onQuantityChange={(e) => {
              // A typed quantity changes on blur, and the press on Add is what blurs it: the wrapper's effect lands
              // after a fast click has already read `qty`, so the element gets it here, in the same event.
              addToCartRef.current?.setAttribute('qty', String(e.detail.value))
              setChosen({ variantId: variant?.id, qty: e.detail.value })
            }}
          />
        </div>
        <AddToCart
          ref={addToCartRef}
          variantId={variant?.id ?? product.id}
          qty={qty}
          disabled={stock <= 0}
          serverHtml={serverHtml?.addToCart}
        />
      </div>
    </div>
  )
}
