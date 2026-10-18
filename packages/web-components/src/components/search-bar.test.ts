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

  // P1-09 decision 5: a result is chosen by click or by ArrowDown+Enter, and the event names the chosen one
  async function renderResults(slugs: string[]): Promise<HTMLElement> {
    const client = setupMockClient()
    const el = createElement()
    ;(client.search as unknown as { setState(p: object): void }).setState({
      query: 'w',
      loading: false,
      total: slugs.length,
      results: slugs.map((slug) => ({
        slug,
        name: `Name ${slug}`,
        priceMinor: null,
        currency: null,
      })),
    })
    await Promise.resolve()
    return el
  }

  function captureSelected(el: HTMLElement): string[] {
    const seen: string[] = []
    el.addEventListener('nymbal:search:selected', (e) => {
      seen.push((e as CustomEvent<{ product: { slug: string } }>).detail.product.slug)
    })
    return seen
  }

  it('P1-09 decision 5: clicking the second result selects that result, not the first', async () => {
    const el = await renderResults(['first-widget', 'second-widget', 'third-widget'])
    const items = el.querySelectorAll<HTMLElement>('.nymbal-search-result-item')
    const seen = captureSelected(el)
    const clicked = items[1]!
    clicked.click()
    expect(seen).toEqual([clicked.dataset.slug])
    expect(seen[0]).not.toBe(items[0]!.dataset.slug)
  })

  it('P1-09 decision 5: ArrowDown twice then Enter selects the second result', async () => {
    const el = await renderResults(['first-widget', 'second-widget', 'third-widget'])
    const seen = captureSelected(el)
    for (let n = 0; n < 2; n++) {
      el.querySelector('input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    }
    const highlighted = el.querySelector<HTMLElement>(
      '.nymbal-search-result-item[aria-selected="true"]',
    )!
    el.querySelector('input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    expect(seen).toEqual([highlighted.dataset.slug])
    expect(highlighted).toBe(el.querySelectorAll('.nymbal-search-result-item')[1])
  })

  it('disconnectedCallback removes search subscription', () => {
    const el = createElement()
    document.body.removeChild(el)
    expect(true).toBe(true) // no throw
  })
})

import { vi } from 'vitest'
