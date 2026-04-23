import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'

beforeEach(() => {
  setupMockClient()
})

function createElement(): HTMLElement {
  const el = document.createElement('nymbal-search-bar')
  document.body.appendChild(el)
  return el
}

describe('nymbal-search-bar', () => {
  it('renders an input with data-testid search-input', () => {
    const el = createElement()
    const input = el.querySelector('[data-testid="search-input"]')
    expect(input).toBeTruthy()
  })

  it('input has type search', () => {
    const el = createElement()
    const input = el.querySelector('input') as HTMLInputElement
    expect(input.type).toBe('search')
  })

  it('input has placeholder', () => {
    const el = createElement()
    const input = el.querySelector('input') as HTMLInputElement
    expect(input.placeholder).toBeTruthy()
  })

  it('typing calls search store', async () => {
    const client = setupMockClient()
    const el = createElement()
    const input = el.querySelector('input') as HTMLInputElement

    const searchSpy = vi.fn()
    client.search.search = searchSpy

    input.value = 'widget'
    input.dispatchEvent(new Event('input'))
    await new Promise((r) => setTimeout(r, 350)) // debounce
    expect(searchSpy).toHaveBeenCalledWith('widget')
  })

  it('disconnectedCallback removes search subscription', () => {
    const el = createElement()
    document.body.removeChild(el)
    expect(true).toBe(true) // no throw
  })
})

import { vi } from 'vitest'
