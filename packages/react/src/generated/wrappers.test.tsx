import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AddToCart, CartDrawer, MiniCart, QuantitySelector, SearchBar, Toast } from './wrappers.js'

// Register custom elements as stubs so JSDOM doesn't error on unknown elements
const tags = [
  'nymbal-add-to-cart', 'nymbal-cart-drawer', 'nymbal-mini-cart',
  'nymbal-variant-selector', 'nymbal-quantity-selector', 'nymbal-search-bar',
  'nymbal-product-filter', 'nymbal-toast',
]
for (const tag of tags) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends HTMLElement {})
  }
}

describe('Generated wrappers — data-testid forwarding', () => {
  it('AddToCart forwards data-testid to outermost DOM node', () => {
    const { container } = render(<AddToCart data-testid="my-add-to-cart" />)
    const el = container.querySelector('nymbal-add-to-cart')
    expect(el?.getAttribute('data-testid')).toBe('my-add-to-cart')
  })

  it('CartDrawer forwards data-testid', () => {
    const { container } = render(<CartDrawer data-testid="my-cart-drawer" />)
    const el = container.querySelector('nymbal-cart-drawer')
    expect(el?.getAttribute('data-testid')).toBe('my-cart-drawer')
  })

  it('MiniCart forwards data-testid', () => {
    const { container } = render(<MiniCart data-testid="my-mini-cart" />)
    const el = container.querySelector('nymbal-mini-cart')
    expect(el?.getAttribute('data-testid')).toBe('my-mini-cart')
  })

  it('QuantitySelector forwards data-testid', () => {
    const { container } = render(<QuantitySelector data-testid="my-qty" value={1} />)
    const el = container.querySelector('nymbal-quantity-selector')
    expect(el?.getAttribute('data-testid')).toBe('my-qty')
  })

  it('SearchBar forwards data-testid', () => {
    const { container } = render(<SearchBar data-testid="my-search" />)
    const el = container.querySelector('nymbal-search-bar')
    expect(el?.getAttribute('data-testid')).toBe('my-search')
  })

  it('Toast forwards data-testid', () => {
    const { container } = render(<Toast data-testid="my-toast" />)
    const el = container.querySelector('nymbal-toast')
    expect(el?.getAttribute('data-testid')).toBe('my-toast')
  })
})

describe('Generated wrappers — rendering', () => {
  it('AddToCart renders the correct custom element tag', () => {
    const { container } = render(<AddToCart />)
    const el = container.querySelector('nymbal-add-to-cart')
    expect(el).toBeTruthy()
    expect(el?.tagName.toLowerCase()).toBe('nymbal-add-to-cart')
  })
})
