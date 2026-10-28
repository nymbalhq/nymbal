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

async function createElement(): Promise<HTMLElement> {
  const el = document.createElement('nymbal-search-bar')
  document.body.appendChild(el)
  await settled(el)
  return el
}

const inputOf = (el: HTMLElement): HTMLInputElement =>
  shadow(el).querySelector('input') as HTMLInputElement

describe('nymbal-search-bar', () => {
  it('typing searches the store for what was typed', async () => {
    const client = setupMockClient()
    const el = await createElement()
    const input = inputOf(el)
    const store = client.search as unknown as { setState(p: object): void }
    client.search.search = async (query: string) => store.setState({ query })

    input.value = 'widget'
    input.dispatchEvent(new Event('input'))
    // The search is debounced; it lands within the 350 ms the test has always allowed.
    await vi.waitFor(() => expect(client.search.getState().query).toBe('widget'), {
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

  it('n ArrowDowns then Enter select result n, and every press past the last stays on the last', async () => {
    const slugs = ['first-widget', 'second-widget', 'third-widget']
    for (let presses = 1; presses <= slugs.length + 2; presses++) {
      const el = await renderResults(slugs)
      const seen = captureSelected(el)
      for (let n = 0; n < presses; n++) {
        inputOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await settled(el)
      }
      inputOf(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await settled(el)
      expect(seen, `${presses} presses`).toEqual([slugs[Math.min(presses, slugs.length) - 1]])
      document.body.innerHTML = ''
    }
  })
})
