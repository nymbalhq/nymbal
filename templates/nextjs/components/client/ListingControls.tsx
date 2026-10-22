'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Facet, ProductSortKey } from '@nymbalhq/types'
import { ProductFilter, SortDropdown, useNymbalClient } from '@nymbalhq/react'
import styles from '@/styles/pages/plp.module.css'

interface ListingControlsProps {
  /** The server-rendered listing's sort and category: the product-list store loads the same page on mount. */
  sort: ProductSortKey
  category?: string
  /** The listing's facets: none when the store's search cannot facet, and then no filter. */
  facets: Facet[]
  /** The sort keys the store reports, in order, and the one it lists by when none is asked. */
  sortKeys: ProductSortKey[]
  defaultSort?: ProductSortKey | undefined
  /** The listing's `nymbal-product-grid`, which follows the store once this load settles. */
  children: ReactNode
}

/** A listing's filter and sort around its grid: they drive the product-list store, which the grid follows. */
export function ListingControls({
  sort,
  category,
  facets,
  sortKeys,
  defaultSort,
  children,
}: ListingControlsProps) {
  const client = useNymbalClient()
  const [showMobileFilters, setShowMobileFilters] = useState(false)

  useEffect(() => {
    void client.productList.load({ limit: 24, category, sort })
  }, [client, category, sort])

  // The URL carries the sort, so a reload or a shared link renders the same order server-side.
  const handleSort = useCallback(
    (event: CustomEvent<{ sort: string }>) => {
      const key = event.detail.sort as ProductSortKey
      const url = new URL(window.location.href)
      url.searchParams.set('sort', key)
      window.history.replaceState(window.history.state, '', url)
      void client.productList.setSort(key)
    },
    [client],
  )

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        {facets.length > 0 && (
          <>
            <button
              className={styles.mobileFilterToggle}
              onClick={() => setShowMobileFilters((v) => !v)}
              type="button"
            >
              {showMobileFilters ? 'Hide Filters' : 'Show Filters'}
            </button>
            <div
              className={styles.filterSection}
              style={{ display: showMobileFilters ? 'block' : undefined }}
            >
              <ProductFilter facets={facets} />
            </div>
          </>
        )}
      </aside>

      <div className={styles.content}>
        {sortKeys.length > 0 && (
          <div className={styles.sortBar}>
            <SortDropdown
              className={styles.sortSelect}
              sortKeys={sortKeys}
              value={sort}
              defaultSort={defaultSort}
              onSortChange={handleSort}
            />
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
