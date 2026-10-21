'use client'

import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { ProductFilter, useSearch } from '@nymbalhq/react'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/search.module.css'

export function SearchResults() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const category = searchParams.get('category')
  const {
    results,
    total,
    nextCursor,
    facets,
    loading,
    query: searched,
    category: searchedCategory,
    search,
    loadMore,
  } = useSearch()

  useEffect(() => {
    // Runs when the URL changes; the filter has already searched the category it writes there.
    if (query && (query !== searched || category !== searchedCategory)) {
      void search(query, { category })
    }
  }, [query, category, search])

  const onFilterChange = useCallback((event: CustomEvent<{ name: string; value: string }>) => {
    const url = new URL(window.location.href)
    if (event.detail.value) url.searchParams.set('category', event.detail.value)
    else url.searchParams.delete('category')
    window.history.replaceState(null, '', url.toString())
  }, [])

  return (
    <div className={`container ${styles.page}`}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Search Results</h1>
        {query && (
          <p className={styles.queryText}>
            Showing results for <span className={styles.queryTerm}>&ldquo;{query}&rdquo;</span>
          </p>
        )}
      </div>

      {loading && results.length === 0 ? (
        <div className={styles.loading}>
          <div className="spinner spinner-lg" role="status">
            <span className="visually-hidden">Searching...</span>
          </div>
        </div>
      ) : !query ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <h2 className={styles.emptyTitle}>Search our store</h2>
          <p className={styles.emptyText}>
            Use the search bar above to find what you are looking for.
          </p>
        </div>
      ) : results.length > 0 ? (
        <div className={facets.length > 0 ? styles.layout : undefined}>
          {facets.length > 0 && (
            <aside className={styles.sidebar}>
              <ProductFilter source="search" onFilterChange={onFilterChange} />
            </aside>
          )}
          <div>
            <p className={styles.resultCount} data-testid="search-total">
              {total} result{total !== 1 ? 's' : ''} found
            </p>
            <div className={styles.grid}>
              {results.map((product) => {
                const media = Array.isArray(product.media) ? product.media : []
                const imageUrl =
                  media.length > 0 && typeof (media[0] as Record<string, unknown>)?.url === 'string'
                    ? (media[0] as Record<string, string>).url
                    : null
                return (
                  <Link
                    key={product.id}
                    href={`/product/${product.slug}`}
                    className={styles.productCard}
                    data-testid={`product-card-${product.slug}`}
                  >
                    <div className={styles.productImage}>
                      {imageUrl && (
                        <Image
                          src={imageUrl}
                          alt={product.name}
                          width={400}
                          height={400}
                          sizes="(max-width: 639px) 100vw, (max-width: 1023px) 50vw, 25vw"
                        />
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
              })}
            </div>
            {nextCursor !== null && (
              <div className={styles.pagination}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void loadMore()}
                  disabled={loading}
                  data-testid="search-load-more"
                >
                  {loading ? 'Loading...' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <h2 className={styles.emptyTitle}>No results found</h2>
          <p className={styles.emptyText}>
            We could not find anything matching &ldquo;{query}&rdquo;. Try a different search term.
          </p>
        </div>
      )}

      <div className={styles.suggestions}>
        <h3 className={styles.suggestionsTitle}>Popular searches</h3>
        <div className={styles.suggestionTags}>
          {['Shirts', 'Shoes', 'Jackets', 'Accessories', 'New Arrivals'].map((term) => (
            <Link
              key={term}
              href={`/search?q=${encodeURIComponent(term)}`}
              className={styles.suggestionTag}
            >
              {term}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
