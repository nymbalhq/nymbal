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
  const { products, pagination, loading, load, loadMore } = useProductList()
  const [initialized, setInitialized] = useState(false)
  const [showMobileFilters, setShowMobileFilters] = useState(false)

  useEffect(() => {
    load({ limit: 24, category: categorySlug })
    setInitialized(true)
  }, [categorySlug, load])

  const displayProducts = initialized && products.length > 0 ? products : initialProducts
  const hasMore = initialized ? pagination.hasMore : !!initialCursor

  const handleLoadMore = useCallback(() => {
    if (hasMore && !loading) {
      loadMore()
    }
  }, [hasMore, loading, loadMore])

  const facets = [
    {
      name: 'category',
      label: 'Category',
      values: categories.map((c) => ({ value: c.slug, label: c.name })),
    },
  ]

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
          <ProductFilter facets={JSON.stringify(facets)} />
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
