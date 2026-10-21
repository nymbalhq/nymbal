'use client'

import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ProductFilter, SearchResults, useSearch } from '@nymbalhq/react'
import styles from '@/styles/pages/search.module.css'

const POPULAR = ['Shirts', 'Shoes', 'Jackets', 'Accessories', 'New Arrivals']

/** The URL owns the term and the category; `SearchResults` renders the store's answer. */
export function SearchView() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const category = searchParams.get('category')
  const { results, facets, query: searched, category: searchedCategory, search } = useSearch()

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

  const filtered = facets.length > 0 && results.length > 0

  return (
    <div className={`container ${styles.page}`}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Search Results</h1>
      </div>

      <div className={filtered ? styles.layout : undefined}>
        {filtered && (
          <aside className={styles.sidebar}>
            <ProductFilter source="search" onFilterChange={onFilterChange} />
          </aside>
        )}
        <SearchResults data-testid="search-results" />
      </div>

      <div className={styles.suggestions}>
        <h3 className={styles.suggestionsTitle}>Popular searches</h3>
        <div className={styles.suggestionTags}>
          {POPULAR.map((term) => (
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
