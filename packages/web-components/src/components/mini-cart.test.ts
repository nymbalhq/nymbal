import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import type { NymbalClient } from '@nymbal/sdk'

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

function createElement(): HTMLElement {
  const el = document.createElement('nymbal-mini-cart')
  document.body.appendChild(el)
  return el
}

describe('nymbal-mini-cart', () => {
  it('renders button with data-testid mini-cart', () => {
    const el = createElement()
    const btn = el.querySelector('[data-testid="mini-cart"]')
    expect(btn).toBeTruthy()
  })

  it('badge is empty when cart is empty', () => {
    const el = createElement()
    // When itemCount=0, badge renders empty string
    const badge = el.querySelector('.nymbal-mini-cart-badge')
    expect(badge?.textContent).toBe('')
  })

  it('updates badge when cart state changes', async () => {
    const el = createElement()
    ;(client.cart as unknown as { setState(p: object): void }).setState({ itemCount: 3 })
    await Promise.resolve()
    const badge = el.querySelector('.nymbal-mini-cart-badge')
    expect(badge?.textContent).toBe('3')
  })

  it('disconnects cleanly', () => {
    const el = createElement()
    document.body.removeChild(el)
    expect(true).toBe(true)
  })
})
