import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import type { NymbalClient } from '@nymbalhq/sdk'

// P2-06 decisions 1 and 2: the element is a Lit element that renders in an open shadow root, so its internals are
// read through `shadowRoot`, once its render has settled (`updateComplete`).

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

async function createElement(): Promise<HTMLElement> {
  const el = document.createElement('nymbal-mini-cart')
  document.body.appendChild(el)
  await settled(el)
  return el
}

describe('nymbal-mini-cart', () => {
  it('renders button with data-testid mini-cart', async () => {
    const el = await createElement()
    const btn = shadow(el).querySelector('[data-testid="mini-cart"]')
    expect(btn).toBeTruthy()
  })

  it('badge is empty when cart is empty', async () => {
    const el = await createElement()
    // When itemCount=0, badge renders empty string
    const badge = shadow(el).querySelector('.nymbal-mini-cart-badge')
    expect(badge?.textContent?.trim()).toBe('')
  })

  it('updates badge when cart state changes', async () => {
    const el = await createElement()
    ;(client.cart as unknown as { setState(p: object): void }).setState({ itemCount: 3 })
    await settled(el)
    const badge = shadow(el).querySelector('.nymbal-mini-cart-badge')
    expect(badge?.textContent?.trim()).toBe('3')
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
