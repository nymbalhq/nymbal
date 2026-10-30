import '@nymbalhq/sdk/ns/search'
import { NymbalProductFilter } from '@nymbalhq/web-components/elements/nymbal-product-filter'
import { NymbalSearchResults } from '@nymbalhq/web-components/elements/nymbal-search-results'
import { client } from '../lib/client.js'

NymbalProductFilter.define()
NymbalSearchResults.define()

// The page owns the term and the category: the URL and the search input search, `nymbal-search-results` renders.
const searchInput = document.getElementById('search-input') as HTMLInputElement | null

const urlParams = new URLSearchParams(window.location.search)
const initialQuery = urlParams.get('q')

if (initialQuery) {
  if (searchInput) searchInput.value = initialQuery
  client.search.search(initialQuery, { category: urlParams.get('category') })
}

// The category filter has narrowed the search; the URL follows, beside ?q.
document.addEventListener('nymbal:filter:changed', (event) => {
  const { value } = (event as CustomEvent<{ name: string; value: string }>).detail
  const url = new URL(window.location.href)
  if (value) url.searchParams.set('category', value)
  else url.searchParams.delete('category')
  window.history.replaceState({}, '', url.toString())
})

// A new query searches every category again.
searchInput?.addEventListener('input', () => {
  const value = searchInput.value.trim()
  if (value.length >= 2) {
    client.search.search(value)
    const url = new URL(window.location.href)
    url.searchParams.set('q', value)
    url.searchParams.delete('category')
    window.history.replaceState({}, '', url.toString())
  } else if (value.length === 0) {
    client.search.clearSearch()
    const url = new URL(window.location.href)
    url.searchParams.delete('q')
    url.searchParams.delete('category')
    window.history.replaceState({}, '', url.toString())
  }
})
