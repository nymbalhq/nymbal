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

async function createElementWithItems(): Promise<HTMLElement> {
  ;(client.cart as unknown as { setState(p: object): void }).setState({
    items: [
      {
        variantId: 'var-1',
        productId: 'p1',
        productName: 'Test',
        variantName: 'D',
        priceMinor: 1000,
        qty: 1,
        imageUrl: '',
      },
    ],
    subtotalMinor: 1000,
    itemCount: 1,
  })
  return createElement()
}

async function createElement(): Promise<HTMLElement> {
  const el = document.createElement('nymbal-cart-drawer')
  document.body.appendChild(el)
  await settled(el)
  return el
}

describe('nymbal-cart-drawer', () => {
  it('renders inner panel with data-testid cart-drawer', async () => {
    const el = await createElement()
    const panel = shadow(el).querySelector('[data-testid="cart-drawer"]')
    expect(panel).toBeTruthy()
  })

  it('inner panel has role=dialog', async () => {
    const el = await createElement()
    const panel = shadow(el).querySelector('[data-testid="cart-drawer"]')
    expect(panel?.getAttribute('role')).toBe('dialog')
  })

  it('close button exists with aria-label', async () => {
    const el = await createElement()
    const closeBtn = shadow(el).querySelector('[data-testid="cart-drawer-close"]')
    expect(closeBtn).toBeTruthy()
    expect(closeBtn?.getAttribute('aria-label')).toBeTruthy()
  })

  it('checkout button renders when cart has items', async () => {
    const el = await createElementWithItems()
    const btn = shadow(el).querySelector('[data-testid="cart-checkout-btn"]')
    expect(btn).toBeTruthy()
  })

  it('overlay element renders', async () => {
    const el = await createElement()
    expect(shadow(el).querySelector('[data-testid="cart-drawer-overlay"]')).toBeTruthy()
  })

  it('renders cart items when cart has items', async () => {
    const el = await createElementWithItems()
    const item = shadow(el).querySelector('[data-testid="cart-item-var-1"]')
    expect(item).toBeTruthy()
  })

  it('disconnects cleanly', async () => {
    const live = liveSubscriptions(client.cart)
    const el = await createElement()
    const connected = live()
    expect(connected).toBeGreaterThan(0)
    document.body.removeChild(el)
    expect(live()).toBeLessThan(connected)
    expect(live()).toBe(0)
  })
})
