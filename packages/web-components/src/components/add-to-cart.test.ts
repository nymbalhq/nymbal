import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import type { NymbalClient } from '@nymbalhq/sdk'

// The element is a Lit element that renders in an open shadow root, so its internals are read through `shadowRoot`,
// once its render has settled (`updateComplete`).

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
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

async function createElement(attrs: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement('nymbal-add-to-cart')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  await settled(el)
  return el
}

describe('nymbal-add-to-cart', () => {
  it('renders a button with data-testid add-to-cart', async () => {
    const el = await createElement()
    const btn = shadow(el).querySelector('[data-testid="add-to-cart"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON')
  })

  it('button text is "Add to Cart" by default', async () => {
    const el = await createElement()
    const btn = shadow(el).querySelector('button') as HTMLButtonElement
    expect(btn.textContent?.trim()).toBe('Add to Cart')
  })

  it('button is disabled when no variant-id', async () => {
    const el = await createElement()
    const btn = shadow(el).querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('button is enabled when variant-id is set', async () => {
    const el = await createElement({ 'variant-id': 'var-1' })
    const btn = shadow(el).querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('button shows loading state when cart is loading', async () => {
    // Set loading state on the current client BEFORE creating element
    ;(client.cart as unknown as { setState(p: object): void }).setState({ loading: true })
    const el = await createElement({ 'variant-id': 'var-1' })
    const btn = shadow(el).querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('disconnectedCallback removes store subscription', async () => {
    const live = liveSubscriptions(client.cart)
    const el = await createElement()
    const connected = live()
    expect(connected).toBeGreaterThan(0)
    document.body.removeChild(el)
    expect(live()).toBeLessThan(connected)
    expect(live()).toBe(0)
  })
})
