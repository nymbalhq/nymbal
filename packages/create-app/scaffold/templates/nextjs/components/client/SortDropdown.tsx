'use client'

import { useCallback } from 'react'
import { useProductList } from '@nymbal/react'
import styles from '@/styles/pages/plp.module.css'

const SORT_OPTIONS: Record<string, { field: string; direction: 'asc' | 'desc' }> = {
  'price-asc': { field: 'price', direction: 'asc' },
  'price-desc': { field: 'price', direction: 'desc' },
  'name-asc': { field: 'name', direction: 'asc' },
  'name-desc': { field: 'name', direction: 'desc' },
  newest: { field: 'createdAt', direction: 'desc' },
}

export function SortDropdown() {
  const { setSort } = useProductList()

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const option = SORT_OPTIONS[e.target.value]
      if (option) {
        setSort(option.field, option.direction)
      }
    },
    [setSort],
  )

  return (
    <select
      className={styles.sortSelect}
      onChange={handleChange}
      defaultValue=""
      data-testid="sort-dropdown"
      aria-label="Sort products"
    >
      <option value="">Sort by</option>
      <option value="price-asc">Price: Low to High</option>
      <option value="price-desc">Price: High to Low</option>
      <option value="name-asc">Name: A to Z</option>
      <option value="name-desc">Name: Z to A</option>
      <option value="newest">Newest</option>
    </select>
  )
}
