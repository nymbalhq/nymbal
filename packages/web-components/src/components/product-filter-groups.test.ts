import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import type { Facet } from '@nymbalhq/types'
import { setupMockClient, type createMockStore } from '../testing/index.js'

// A facet with no values is no filter: a search whose hits carry no category answers a `category` facet with
// `values: []`, and the filter drew its label alone as a group, without `empty`, so the page drew a filter column
// holding only a header. The filter renders one group per facet with a value, one option per value, and carries
// `empty` exactly when it renders none, from the `facets` attribute and from the search store alike.

type Filter = HTMLElement & { updateComplete: Promise<unknown> }

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

const word = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/)

const facetValues = fc.uniqueArray(
  fc.record({ value: word, label: word, count: fc.nat({ max: 40 }) }),
  { maxLength: 4, selector: (v) => v.value },
)

/** Facets with unique fields, `category` among the candidates so the search mode has one to keep. */
const facets: fc.Arbitrary<Facet[]> = fc.uniqueArray(
  fc.record({
    field: fc.oneof(fc.constantFrom('category', 'brand', 'colour', 'size'), word),
    label: word,
    values: facetValues,
  }),
  { maxLength: 4, selector: (f) => f.field },
)

/** Each rendered group's field and its option count, in document order. */
function groups(el: Filter): Array<{ field: string; options: number }> {
  const root = el.shadowRoot
  if (root === null) throw new Error('nymbal-product-filter has no open shadow root')
  return [...root.querySelectorAll('[data-testid^="filter-group-"]')].map((g) => ({
    field: g.getAttribute('data-testid')!.slice('filter-group-'.length),
    options: g.querySelectorAll('[part~="option"]').length,
  }))
}

const expected = (shown: Facet[]): Array<{ field: string; options: number }> =>
  shown
    .filter((f) => f.values.length > 0)
    .map((f) => ({ field: f.field, options: f.values.length }))

describe('nymbal-product-filter renders only facets with values', () => {
  it('AC-4: property: from the facets attribute, before and after it changes, the filter renders one filter-group-<field> per facet with at least one value, one option per value, and carries empty iff it renders none', async () => {
    await fc.assert(
      fc.asyncProperty(facets, facets, async (first, second) => {
        document.body.innerHTML = ''
        const el = document.createElement('nymbal-product-filter') as Filter
        el.setAttribute('facets', JSON.stringify(first))
        document.body.appendChild(el)

        for (const given of [first, second]) {
          el.setAttribute('facets', JSON.stringify(given))
          await el.updateComplete
          const want = expected(given)
          expect(groups(el), JSON.stringify(given)).toEqual(want)
          expect(el.hasAttribute('empty'), JSON.stringify(given)).toBe(want.length === 0)
        }
      }),
      { numRuns: 80 },
    )
  })

  it('AC-4: property: with source="search", from the search store before and after it changes, the filter renders one filter-group-category when the store’s category facet has a value (one option per value), nothing for any other facet, and carries empty iff it renders none', async () => {
    const search = client.search as unknown as ReturnType<
      typeof createMockStore<{ facets: Facet[] }>
    >
    await fc.assert(
      fc.asyncProperty(facets, facets, async (first, second) => {
        document.body.innerHTML = ''
        search.setState({ facets: first })
        const el = document.createElement('nymbal-product-filter') as Filter
        el.setAttribute('source', 'search')
        document.body.appendChild(el)

        for (const given of [first, second]) {
          search.setState({ facets: given })
          await el.updateComplete
          const want = expected(given.filter((f) => f.field === 'category'))
          expect(groups(el), JSON.stringify(given)).toEqual(want)
          expect(el.hasAttribute('empty'), JSON.stringify(given)).toBe(want.length === 0)
        }
      }),
      { numRuns: 80 },
    )
  })
})
