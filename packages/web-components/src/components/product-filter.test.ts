import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupMockClient, createMockClient } from '../testing/index.js'
import { registerClient } from '../registry.js'
import type { Facet } from '@nymbal/types'

const sampleFacets: Facet[] = [
  {
    field: 'category',
    label: 'Category',
    values: [
      { value: 'books', label: 'Books', count: 3 },
      { value: 'electronics', label: 'Electronics', count: 2 },
    ],
  },
]

beforeEach(() => {
  setupMockClient()
})

describe('nymbal-product-filter', () => {
  it('renders without error', () => {
    const el = document.createElement('nymbal-product-filter')
    document.body.appendChild(el)
    expect(el).toBeTruthy()
  })

  it('disconnects cleanly without throwing', () => {
    const el = document.createElement('nymbal-product-filter')
    document.body.appendChild(el)
    expect(() => document.body.removeChild(el)).not.toThrow()
  })

  it('renders filter checkboxes from facets attribute', () => {
    const el = document.createElement('nymbal-product-filter')
    el.setAttribute('facets', JSON.stringify(sampleFacets))
    document.body.appendChild(el)
    const checkboxes = el.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
  })

  it('calls applyFilter on the product list store when a checkbox is checked', () => {
    const mock = createMockClient()
    vi.spyOn(mock.productList, 'applyFilter').mockResolvedValue(undefined)
    registerClient(mock)

    const el = document.createElement('nymbal-product-filter')
    el.setAttribute('facets', JSON.stringify(sampleFacets))
    document.body.appendChild(el)

    const checkbox = el.querySelector('input[data-filter-value="books"]') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))

    expect(mock.productList.applyFilter).toHaveBeenCalledWith('category', 'books')
  })

  it('emits nymbal:filter:changed event when a checkbox is checked', () => {
    const mock = createMockClient()
    vi.spyOn(mock.productList, 'applyFilter').mockResolvedValue(undefined)
    registerClient(mock)

    const el = document.createElement('nymbal-product-filter')
    el.setAttribute('facets', JSON.stringify(sampleFacets))
    document.body.appendChild(el)

    let filterEvent: CustomEvent | null = null
    el.addEventListener('nymbal:filter:changed', (e) => { filterEvent = e as CustomEvent })

    const checkbox = el.querySelector('input[data-filter-value="books"]') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))

    expect(filterEvent).not.toBeNull()
    expect((filterEvent as CustomEvent).detail).toMatchObject({ name: 'category', value: 'books' })
  })

  it('calls removeFilter when unchecking the only active filter', () => {
    const mock = createMockClient()
    vi.spyOn(mock.productList, 'removeFilter').mockResolvedValue(undefined)
    ;(mock.productList as ReturnType<typeof createMockStore>).setState({
      filters: { category: 'books' },
    })
    registerClient(mock)

    const el = document.createElement('nymbal-product-filter')
    el.setAttribute('facets', JSON.stringify(sampleFacets))
    document.body.appendChild(el)

    const checkbox = el.querySelector('input[data-filter-value="books"]') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))

    expect(mock.productList.removeFilter).toHaveBeenCalledWith('category')
  })

  it('renders no checkboxes when facets attribute is absent', () => {
    const el = document.createElement('nymbal-product-filter')
    document.body.appendChild(el)
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it('renders no checkboxes when facets attribute is malformed JSON', () => {
    const el = document.createElement('nymbal-product-filter')
    el.setAttribute('facets', '{ not valid json }')
    document.body.appendChild(el)
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })
})
