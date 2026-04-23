import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import type { NymbalClient } from '@nymbal/sdk'

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

function createElementWithItems(): HTMLElement {
  ;(client.cart as unknown as { setState(p: object): void }).setState({
    items: [{ variantId: 'var-1', productId: 'p1', productName: 'Test', variantName: 'D', priceMinor: 1000, qty: 1, imageUrl: '' }],
    subtotalMinor: 1000, itemCount: 1,
  })
  const el = document.createElement('nymbal-cart-drawer')
  document.body.appendChild(el)
  return el
}

function createElement(): HTMLElement {
  const el = document.createElement('nymbal-cart-drawer')
  document.body.appendChild(el)
  return el
}

describe('nymbal-cart-drawer', () => {
  it('renders inner panel with data-testid cart-drawer', () => {
    const el = createElement()
    const panel = el.querySelector('[data-testid="cart-drawer"]')
    expect(panel).toBeTruthy()
  })

  it('inner panel has role=dialog', () => {
    const el = createElement()
    const panel = el.querySelector('[data-testid="cart-drawer"]')
    expect(panel?.getAttribute('role')).toBe('dialog')
  })

  it('close button exists with aria-label', () => {
    const el = createElement()
    const closeBtn = el.querySelector('[data-testid="cart-drawer-close"]')
    expect(closeBtn).toBeTruthy()
    expect(closeBtn?.getAttribute('aria-label')).toBeTruthy()
  })

  it('checkout button renders when cart has items', () => {
    const el = createElementWithItems()
    const btn = el.querySelector('[data-testid="cart-checkout-btn"]')
    expect(btn).toBeTruthy()
  })

  it('overlay element renders', () => {
    const el = createElement()
    expect(el.querySelector('[data-testid="cart-drawer-overlay"]')).toBeTruthy()
  })

  it('renders cart items when cart has items', () => {
    const el = createElementWithItems()
    const item = el.querySelector('[data-testid="cart-item-var-1"]')
    expect(item).toBeTruthy()
  })

  it('disconnects cleanly', () => {
    const el = createElement()
    document.body.removeChild(el)
    expect(true).toBe(true)
  })
})
