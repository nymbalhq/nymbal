import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// The element is a Lit element that renders in an open shadow root, so its internals are read through `shadowRoot`,
// once its render has settled (`updateComplete`).

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

/** Counts the store's live subscriptions, from the moment it is installed. */
function liveSubscriptions(store: unknown): () => number {
  const s = store as { subscribe(fn: () => void): () => void }
  const subscribe = s.subscribe.bind(s)
  let live = 0
  s.subscribe = (fn) => {
    const unsubscribe = subscribe(fn)
    live += 1
    let done = false
    return () => {
      if (!done) live -= 1
      done = true
      unsubscribe()
    }
  }
  return () => live
}

async function createElement(): Promise<HTMLElement> {
  const el = document.createElement('nymbal-search-bar')
  document.body.appendChild(el)
  await settled(el)
  return el
}

const inputOf = (el: HTMLElement): HTMLInputElement =>
  shadow(el).querySelector('input') as HTMLInputElement

describe('nymbal-search-bar', () => {
  it('renders an input with data-testid search-input', async () => {
    const el = await createElement()
    const input = shadow(el).querySelector('[data-testid="search-input"]')
    expect(input).toBeTruthy()
  })

  it('input has type search', async () => {
    const el = await createElement()
    expect(inputOf(el).type).toBe('search')
  })

  it('input has placeholder', async () => {
    const el = await createElement()
    expect(inputOf(el).placeholder).toBeTruthy()
  })

  it('typing calls search store', async () => {
    const client = setupMockClient()
    const el = await createElement()
    const input = inputOf(el)

    const searchSpy = vi.fn()
    client.search.search = searchSpy

    input.value = 'widget'
    input.dispatchEvent(new Event('input'))
    // The search is debounced; it lands within the 350 ms the test has always allowed.
    await vi.waitFor(() => expect(searchSpy).toHaveBeenCalledWith('widget'), {
      timeout: 350,
      interval: 10,
    })
  })

  // A result is chosen by click or by ArrowDown+Enter, and the event names the chosen one
  async function renderResults(slugs: string[]): Promise<HTMLElement> {
    const client = setupMockClient()
    const el = await createElement()
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
    await settled(el)
    return el
  }

  function captureSelected(el: HTMLElement): string[] {
    const seen: string[] = []
    el.addEventListener('nymbal:search:selected', (e) => {
      seen.push((e as CustomEvent<{ product: { slug: string } }>).detail.product.slug)
    })
    return seen
  }

  it('clicking the second result selects that result, not the first', async () => {
    const el = await renderResults(['first-widget', 'second-widget', 'third-widget'])
    const items = shadow(el).querySelectorAll<HTMLElement>('.nymbal-search-result-item')
    const seen = captureSelected(el)
    const clicked = items[1]!
    clicked.click()
    await settled(el)
    expect(seen).toEqual([clicked.dataset.slug])
    expect(seen[0]).not.toBe(items[0]!.dataset.slug)
  })

  it('ArrowDown twice then Enter selects the second result', async () => {
    const el = await renderResults(['first-widget', 'second-widget', 'third-widget'])
    const seen = captureSelected(el)
    for (let n = 0; n < 2; n++) {
      inputOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await settled(el)
    }
    const highlighted = shadow(el).querySelector<HTMLElement>(
      '.nymbal-search-result-item[aria-selected="true"]',
    )!
    const second = shadow(el).querySelectorAll('.nymbal-search-result-item')[1]
    inputOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settled(el)
    expect(seen).toEqual([highlighted.dataset.slug])
    expect(highlighted).toBe(second)
  })

  it('disconnectedCallback removes search subscription', async () => {
    const client = setupMockClient()
    const live = liveSubscriptions(client.search)
    const el = await createElement()
    const connected = live()
    expect(connected).toBeGreaterThan(0)
    document.body.removeChild(el)
    expect(live()).toBeLessThan(connected)
    expect(live()).toBe(0)
  })
})
