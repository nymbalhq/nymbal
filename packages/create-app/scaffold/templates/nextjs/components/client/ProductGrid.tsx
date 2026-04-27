'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DenormalisedProduct } from '@nymbal/sdk'
import type { Category } from '@nymbal/types'
import { useProductList } from '@nymbal/react'
import { ProductFilter } from '@nymbal/react'
import { ProductCard } from '@/components/server/ProductCard'
import { SortDropdown } from './SortDropdown'
import styles from '@/styles/pages/plp.module.css'

interface ProductGridProps {
  initialProducts: DenormalisedProduct[]
  initialCursor: string | null
  categorySlug?: string
  categories: Category[]
}

export function ProductGrid({
  initialProducts,
  initialCursor,
  categorySlug,
  categories,
}: ProductGridProps) {
  const { products, facets, pagination, loading, load, loadMore } = useProductList()
  const [initialized, setInitialized] = useState(false)
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  // Preserve the widest facet list seen so filter options never disappear during a
  // filtered query (the API always returns full facets, but this guards against regressions).
  const [stableFacets, setStableFacets] = useState(
    categories.length > 0
      ? [{ field: 'category', label: 'Category', values: categories.map((c) => ({ value: c.slug, label: c.name })) }]
      : [],
  )

  useEffect(() => {
    load({ limit: 24, category: categorySlug })
    setInitialized(true)
  }, [categorySlug, load])

  // Keep stableFacets updated whenever the store returns a wider facet list.
  useEffect(() => {
    if (facets.length > 0) {
      const incomingValues = facets.reduce((acc, f) => acc + f.values.length, 0)
      const stableValues = stableFacets.reduce((acc, f) => acc + f.values.length, 0)
      if (incomingValues >= stableValues) {
        setStableFacets(facets)
      }
    }
  }, [facets, stableFacets])

  const displayProducts = initialized && products.length > 0 ? products : initialProducts
  const hasMore = initialized ? pagination.hasMore : !!initialCursor

  const handleLoadMore = useCallback(() => {
    if (hasMore && !loading) {
      loadMore()
    }
  }, [hasMore, loading, loadMore])

  // Use stableFacets (which always contains the full category list) so all filter
  // options remain visible after a category filter is applied.
  const displayFacets = stableFacets

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
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
          <ProductFilter facets={displayFacets} />
        </div>
      </aside>

      <div className={styles.content}>
        <div className={styles.sortBar}>
          <span className={styles.resultCount}>
            {displayProducts.length} product{displayProducts.length !== 1 ? 's' : ''}
          </span>
          <SortDropdown />
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
