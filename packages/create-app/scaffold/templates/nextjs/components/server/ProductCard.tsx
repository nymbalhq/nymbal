import Link from 'next/link'
import Image from 'next/image'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/home.module.css'

interface ProductCardProps {
  product: {
    slug: string
    name: string
    priceMinor: number | null
    currency: string | null
    media?: unknown
    imageUrl?: string
  }
}

function getImageUrl(product: ProductCardProps['product']): string | null {
  if (product.imageUrl) return product.imageUrl
  if (Array.isArray(product.media) && product.media.length > 0) {
    const first = product.media[0] as Record<string, unknown>
    if (typeof first?.url === 'string') return first.url
  }
  return null
}

export function ProductCard({ product }: ProductCardProps) {
  const imageUrl = getImageUrl(product)

  return (
    <Link
      href={`/product/${product.slug}`}
      className={styles.productCard}
      data-testid={`product-card-${product.slug}`}
    >
      <div className={styles.productImage}>
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={product.name}
            width={400}
            height={400}
            sizes="(max-width: 639px) 100vw, (max-width: 1023px) 50vw, 25vw"
          />
        ) : (
          <span className="visually-hidden">No image available</span>
        )}
      </div>
      <div className={styles.productInfo}>
        <p className={styles.productName}>{product.name}</p>
        {product.priceMinor != null && product.currency && (
          <p className={styles.productPrice}>
            {formatPrice(product.priceMinor, product.currency)}
          </p>
        )}
      </div>
    </Link>
  )
}
