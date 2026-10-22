import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SearchView } from './SearchView'

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
      <SearchView />
    </Suspense>
  )
}
