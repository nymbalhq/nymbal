import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SearchResults } from '@/components/client/SearchResults'

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search our product catalog.',
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="loading-center">
          <div className="spinner spinner-lg" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  )
}
