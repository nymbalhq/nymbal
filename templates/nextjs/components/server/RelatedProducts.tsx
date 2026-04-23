import { ProductCard } from './ProductCard'
import type { DenormalisedProduct } from '@nymbal/sdk'

interface RelatedProductsProps {
  products: DenormalisedProduct[]
}

export function RelatedProducts({ products }: RelatedProductsProps) {
  if (products.length === 0) return null

  return (
    <section className="section">
      <h2 className="section-title">You may also like</h2>
      <div className="product-grid">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={{
              slug: product.slug,
              name: product.name,
              priceMinor: product.priceMinor ?? null,
              currency: product.currency ?? null,
              media: product.media,
            }}
          />
        ))}
      </div>
    </section>
  )
}
