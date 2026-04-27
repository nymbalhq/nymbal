import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient, createMockClient } from '../testing/index.js'
import { registerClient } from '../registry.js'
import type { NymbalClient } from '@nymbal/sdk'

beforeEach(() => {
  setupMockClient()
})

function createElement(options: Array<{ name: string; values: string[]; selected?: string }> = []): HTMLElement {
  const el = document.createElement('nymbal-variant-selector')
  if (options.length > 0) {
    el.setAttribute('options', JSON.stringify(options))
  }
  document.body.appendChild(el)
  return el
}

describe('nymbal-variant-selector', () => {
  it('renders without error when no options set', () => {
    const el = createElement()
    expect(el).toBeTruthy()
  })

  it('renders option buttons when options attribute and product are set', () => {
    const mock = createMockClient()
    ;(mock.product as ReturnType<typeof import('../testing/index.js').createMockStore>).setState({
      product: {
        id: 'p1', slug: 'shirt', name: 'Shirt',
        description: '', shortDescription: '',
        status: 'active', type: 'simple',
        media: [], variantCount: 1,
        inStock: true, priceRange: null,
        currency: 'GBP', priceMinor: 1000,
        categoryIds: [], categories: [],
        createdAt: '', updatedAt: '',
        variants: [{ id: 'v1', sku: 'S1', name: 'S', priceMinor: 1000, stock: 5, options: [{ name: 'Size', value: 'S' }] }],
      },
      selectedVariant: null,
      loading: false,
      error: null,
    })
    registerClient(mock)
    const el = document.createElement('nymbal-variant-selector')
    el.setAttribute('options', JSON.stringify([{ name: 'Size', values: ['S', 'M', 'L'] }]))
    document.body.appendChild(el)
    expect(el.querySelectorAll('.nymbal-option-btn')).toHaveLength(3)
  })

  it('disconnects cleanly without throwing', () => {
    const el = createElement()
    expect(() => document.body.removeChild(el)).not.toThrow()
  })

  describe('options attribute parsing guard', () => {
    function makeClientWithProduct(variantOptions: unknown): NymbalClient {
      const mock = createMockClient()
      ;(mock.product as ReturnType<typeof import('../testing/index.js').createMockStore>).setState({
        product: {
          id: 'p1', slug: 'shirt', name: 'Shirt',
          description: '', shortDescription: '',
          status: 'active', type: 'simple',
          media: [], variantCount: 1,
          inStock: true, priceRange: null,
          currency: 'GBP', priceMinor: 1000,
          categoryIds: [], categories: [],
          createdAt: '', updatedAt: '',
          variants: [
            { id: 'v1', sku: 'S1', name: 'Default', priceMinor: 1000, stock: 5, options: variantOptions },
          ],
        },
        selectedVariant: null,
        loading: false,
        error: null,
      })
      return mock
    }

    it('does not crash when variant options is an array', () => {
      const client = makeClientWithProduct([{ name: 'Size', value: 'M' }])
      registerClient(client)
      const el = document.createElement('nymbal-variant-selector')
      document.body.appendChild(el)
      expect(() => el.isConnected).not.toThrow()
    })

    it('does not crash when variant options is a JSON string', () => {
      const client = makeClientWithProduct('[{"name":"Size","value":"M"}]')
      registerClient(client)
      const el = document.createElement('nymbal-variant-selector')
      document.body.appendChild(el)
      expect(() => el.isConnected).not.toThrow()
    })

    it('does not crash when variant options is null', () => {
      const client = makeClientWithProduct(null)
      registerClient(client)
      const el = document.createElement('nymbal-variant-selector')
      document.body.appendChild(el)
      expect(() => el.isConnected).not.toThrow()
    })

    it('does not crash when variant options is undefined', () => {
      const client = makeClientWithProduct(undefined)
      registerClient(client)
      const el = document.createElement('nymbal-variant-selector')
      document.body.appendChild(el)
      expect(() => el.isConnected).not.toThrow()
    })

    it('does not crash when variant options is malformed JSON string', () => {
      const client = makeClientWithProduct('{ not valid json at all }')
      registerClient(client)
      const el = document.createElement('nymbal-variant-selector')
      document.body.appendChild(el)
      expect(() => el.isConnected).not.toThrow()
      expect(el.querySelectorAll('.nymbal-option-btn')).toHaveLength(0)
    })
  })
})
