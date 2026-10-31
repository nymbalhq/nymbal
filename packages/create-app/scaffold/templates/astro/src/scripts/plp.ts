import '@nymbalhq/sdk/ns/product-list'
import type { ProductSortKey } from '@nymbalhq/types'
import { NymbalBreadcrumb } from '@nymbalhq/web-components/elements/nymbal-breadcrumb'
import { NymbalProductFilter } from '@nymbalhq/web-components/elements/nymbal-product-filter'
import { NymbalProductGrid } from '@nymbalhq/web-components/elements/nymbal-product-grid'
import { NymbalSortDropdown } from '@nymbalhq/web-components/elements/nymbal-sort-dropdown'
import { client } from '../lib/client.js'

NymbalBreadcrumb.define()
NymbalProductFilter.define()
NymbalSortDropdown.define()
NymbalProductGrid.define()

const grid = document.querySelector<HTMLElement>('nymbal-product-grid')
const sortDropdown = document.querySelector('nymbal-sort-dropdown')

// A category page carries its category in the path, which the server render puts on the grid; /products may carry
// one in the query. The server render puts the sort it resolved from the URL on the dropdown's `value`. The grid shows
// the server's page until this load settles, then follows the store (sort, filter, load more).
const initialCategory =
  grid?.dataset.category ?? new URLSearchParams(window.location.search).get('category') ?? undefined
const initialSort = (sortDropdown?.getAttribute('value') || 'newest') as ProductSortKey
void client.productList.load({ limit: 24, category: initialCategory, sort: initialSort })

// The element's event, not its select's `change`: the select may be the element's own rather than the server's.
// The URL carries the sort, so a reload or a shared link renders the same order server-side.
sortDropdown?.addEventListener('nymbal:sort:changed', (e) => {
  const sort = (e as CustomEvent<{ sort: ProductSortKey }>).detail.sort
  const url = new URL(window.location.href)
  url.searchParams.set('sort', sort)
  window.history.replaceState(window.history.state, '', url)
  void client.productList.setSort(sort)
})
