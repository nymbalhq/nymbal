'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DenormalisedProduct } from '@nymbalhq/sdk'
import type { Facet, ProductSortKey } from '@nymbalhq/types'
import { ProductFilter, SortDropdown, useProductList } from '@nymbalhq/react'
import { ProductCard } from '@/components/server/ProductCard'
import styles from '@/styles/pages/plp.module.css'

interface ProductGridProps {
  initialProducts: DenormalisedProduct[]
  initialCursor: string | null
  initialSort: ProductSortKey
  /** The server-rendered listing's facets: none when the store's search cannot facet, and then no filter. */
  initialFacets: Facet[]
  /** The sort keys the store reports, in order, and the one it lists by when none is asked. */
  sortKeys: ProductSortKey[]
  defaultSort?: ProductSortKey | undefined
  categorySlug?: string
}

export function ProductGrid({
  initialProducts,
  initialCursor,
  initialSort,
  initialFacets,
  sortKeys,
  defaultSort,
  categorySlug,
}: ProductGridProps) {
  const { products, pagination, loading, sort, load, loadMore, setSort } = useProductList()
  const [initialized, setInitialized] = useState(false)
  const [showMobileFilters, setShowMobileFilters] = useState(false)

  useEffect(() => {
    load({ limit: 24, category: categorySlug, sort: initialSort })
    setInitialized(true)
  }, [categorySlug, initialSort, load])

  // The URL carries the sort, so a reload or a shared link renders the same order server-side.
  const handleSort = useCallback(
    (event: CustomEvent<{ sort: string }>) => {
      const key = event.detail.sort as ProductSortKey
      const url = new URL(window.location.href)
      url.searchParams.set('sort', key)
      window.history.replaceState(window.history.state, '', url)
      void setSort(key)
    },
    [setSort],
  )

  const displayProducts = initialized && products.length > 0 ? products : initialProducts
  const hasMore = initialized ? pagination.hasMore : !!initialCursor

  const handleLoadMore = useCallback(() => {
    if (hasMore && !loading) {
      loadMore()
    }
  }, [hasMore, loading, loadMore])

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        {initialFacets.length > 0 && (
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
              <ProductFilter facets={initialFacets} />
            </div>
          </>
        )}
      </aside>

      <div className={styles.content}>
        <div className={styles.sortBar}>
          <span className={styles.resultCount}>
            {displayProducts.length} product{displayProducts.length !== 1 ? 's' : ''}
          </span>
          {sortKeys.length > 0 && (
            <SortDropdown
              className={styles.sortSelect}
              sortKeys={sortKeys}
              value={initialized ? sort : initialSort}
              defaultSort={defaultSort}
              onSortChange={handleSort}
            />
          )}
        </div>

        {displayProducts.length > 0 ? (
          <div className="product-grid">
            {displayProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={{
                  slug: product.slug,
                  name: product.name,
                  priceMinor: product.priceMinor ?? null,
                  priceRange: product.priceRange ?? null,
                  currency: product.currency ?? null,
                  media: product.media,
                }}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <p>No products found.</p>
          </div>
        )}

        {hasMore && (
          <div className={styles.pagination}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleLoadMore}
              disabled={loading}
              data-testid="load-more"
            >
              {loading ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
