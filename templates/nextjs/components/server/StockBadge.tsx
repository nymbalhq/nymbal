import styles from '@/styles/pages/pdp.module.css'

interface StockBadgeProps {
  stock: number
}

export function StockBadge({ stock }: StockBadgeProps) {
  const inStock = stock > 0

  return (
    <span
      className={`${styles.stockBadge} ${inStock ? styles.inStock : styles.outOfStock}`}
      data-testid="stock-badge"
    >
      <span className={styles.stockDot} aria-hidden="true" />
      {inStock ? (stock <= 5 ? `Only ${stock} left` : 'In Stock') : 'Out of Stock'}
    </span>
  )
}
