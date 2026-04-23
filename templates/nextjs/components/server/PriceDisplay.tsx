import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/pdp.module.css'

interface PriceDisplayProps {
  priceMinor: number
  currency: string
  compareAtMinor?: number
}

export function PriceDisplay({ priceMinor, currency, compareAtMinor }: PriceDisplayProps) {
  const hasDiscount = compareAtMinor != null && compareAtMinor > priceMinor

  return (
    <div className={styles.price} data-testid="product-price">
      <span>{formatPrice(priceMinor, currency)}</span>
      {hasDiscount && (
        <span
          style={{
            textDecoration: 'line-through',
            fontSize: '0.875em',
            color: 'var(--nymbal-color-text-muted)',
            marginLeft: 'var(--nymbal-spacing-sm)',
            fontWeight: 'var(--nymbal-font-weight-normal)',
          }}
        >
          {formatPrice(compareAtMinor, currency)}
        </span>
      )}
    </div>
  )
}
