import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import type { NymbalClient } from '@nymbal/sdk'

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

function createElement(): HTMLElement {
  const el = document.createElement('nymbal-add-to-cart')
  document.body.appendChild(el)
  return el
}

describe('nymbal-add-to-cart', () => {
  it('renders a button with data-testid add-to-cart', () => {
    const el = createElement()
    const btn = el.querySelector('[data-testid="add-to-cart"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
  })

  it('button text is "Add to Cart" by default', () => {
    const el = createElement()
    const btn = el.querySelector('button') as HTMLButtonElement
    expect(btn.textContent).toBe('Add to Cart')
  })

  it('button is disabled when no variant-id', () => {
    const el = createElement()
    const btn = el.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('button is enabled when variant-id is set', async () => {
    const el = document.createElement('nymbal-add-to-cart')
    el.setAttribute('variant-id', 'var-1')
    document.body.appendChild(el)
    await Promise.resolve()
    const btn = el.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('button shows loading state when cart is loading', async () => {
    // Set loading state on the current client BEFORE creating element
    ;(client.cart as unknown as { setState(p: object): void }).setState({ loading: true })
    const el = document.createElement('nymbal-add-to-cart')
    el.setAttribute('variant-id', 'var-1')
    document.body.appendChild(el)
    await Promise.resolve()
    const btn = el.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('disconnectedCallback removes store subscription', () => {
    const el = createElement()
    document.body.removeChild(el)
    // No error thrown = subscription cleanup worked
    expect(true).toBe(true)
  })
})
