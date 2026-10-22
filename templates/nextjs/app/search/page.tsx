import type { Metadata } from 'next'
import { Suspense } from 'react'
import { fetchSearch } from '@/lib/api'
import { renderNymbal } from '@/lib/render'
import { SearchView } from './SearchView'

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search our product catalog.',
}

const first = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const q = first(params['q'])?.trim() ?? ''
  const search = q === '' ? null : await fetchSearch(q, first(params['category']))
  // The results the page's search would show, so they are in the HTML; the search store takes over once it answers.
  const given = search === null ? null : { results: search.items, query: q }
  const serverHtml = renderNymbal(
    'nymbal-search-results',
    given === null ? {} : { results: JSON.stringify(given.results), query: given.query },
  ).__html
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
      <SearchView given={given} serverHtml={serverHtml} />
    </Suspense>
  )
}
