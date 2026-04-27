'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useSearch } from '@nymbal/react'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/search.module.css'

export function SearchResults() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const { results, loading, search } = useSearch()

  useEffect(() => {
    if (query) {
      search(query)
    }
  }, [query, search])

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

      {loading ? (
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
      ) : results && results.length > 0 ? (
        <>
          <p className={styles.resultCount}>
            {results.length} result{results.length !== 1 ? 's' : ''} found
          </p>
          <div className={styles.grid}>
            {results.map((product) => {
              const media = Array.isArray(product.media) ? product.media : []
              const imageUrl = media.length > 0 && typeof (media[0] as Record<string, unknown>)?.url === 'string'
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
        </>
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
