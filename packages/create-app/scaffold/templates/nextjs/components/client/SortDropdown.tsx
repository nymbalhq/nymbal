'use client'

import type { ProductSortKey } from '@nymbalhq/types'
import styles from '@/styles/pages/plp.module.css'

const OPTIONS: Array<{ value: ProductSortKey; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'name-asc', label: 'Name: A to Z' },
  { value: 'name-desc', label: 'Name: Z to A' },
]

interface SortDropdownProps {
  value: ProductSortKey
  onChange: (sort: ProductSortKey) => void
}

export function SortDropdown({ value, onChange }: SortDropdownProps) {
  return (
    <select
      className={styles.sortSelect}
      value={value}
      onChange={(e) => onChange(e.target.value as ProductSortKey)}
      data-testid="sort-dropdown"
      aria-label="Sort products"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
