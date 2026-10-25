import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupMockClient, createMockClient, type createMockStore } from '../testing/index.js'
import { registerClient } from '../registry.js'
import type { Facet } from '@nymbalhq/types'

// The element is a Lit element that renders in an open shadow root, so its internals are read through `shadowRoot`,
// once its render has settled (`updateComplete`).

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

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function mount(facets?: string): Promise<HTMLElement> {
  const el = document.createElement('nymbal-product-filter')
  if (facets !== undefined) el.setAttribute('facets', facets)
  document.body.appendChild(el)
  await settled(el)
  return el
}

async function check(el: HTMLElement, value: string, checked: boolean): Promise<void> {
  const checkbox = shadow(el).querySelector(
    `input[data-filter-value="${value}"]`,
  ) as HTMLInputElement
  expect(checkbox).toBeTruthy()
  checkbox.checked = checked
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await settled(el)
}

describe('nymbal-product-filter', () => {
  it('renders filter checkboxes from facets attribute', async () => {
    const el = await mount(JSON.stringify(sampleFacets))
    const checkboxes = shadow(el).querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes).toHaveLength(sampleFacets.flatMap((f) => f.values).length)
  })

  it('checking a box applies its facet value as the product list’s filter', async () => {
    const mock = createMockClient()
    const store = mock.productList as unknown as ReturnType<typeof createMockStore>
    mock.productList.applyFilter = async (name: string, value: string | string[]) =>
      store.setState({ filters: { ...mock.productList.getState().filters, [name]: value } })
    registerClient(mock)

    const el = await mount(JSON.stringify(sampleFacets))
    const before = mock.productList.getState().filters
    await check(el, 'books', true)

    expect(before).toEqual({})
    expect(mock.productList.getState().filters).toEqual({ category: 'books' })
  })

  it('emits nymbal:filter:changed event when a checkbox is checked', async () => {
    const mock = createMockClient()
    vi.spyOn(mock.productList, 'applyFilter').mockResolvedValue(undefined)
    registerClient(mock)

    const el = await mount(JSON.stringify(sampleFacets))

    const filterEvents: CustomEvent[] = []
    el.addEventListener('nymbal:filter:changed', (e) => {
      filterEvents.push(e as CustomEvent)
    })

    await check(el, 'books', true)

    expect(filterEvents).toHaveLength(1)
    expect(filterEvents[0]!.detail).toMatchObject({ name: 'category', value: 'books' })
  })

  it('unchecking the only active filter removes it from the product list', async () => {
    const mock = createMockClient()
    const store = mock.productList as unknown as ReturnType<typeof createMockStore>
    store.setState({ filters: { category: 'books' } })
    mock.productList.removeFilter = async (name: string) => {
      const { [name]: _removed, ...rest } = mock.productList.getState().filters as Record<
        string,
        string
      >
      store.setState({ filters: rest })
    }
    registerClient(mock)

    const el = await mount(JSON.stringify(sampleFacets))
    await check(el, 'books', false)

    expect(mock.productList.getState().filters).toEqual({})
  })

  it('renders no checkboxes when facets attribute is absent', async () => {
    const el = await mount()
    expect(shadow(el).querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it('renders no checkboxes when facets attribute is malformed JSON', async () => {
    const el = await mount('{ not valid json }')
    expect(shadow(el).querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })
})
