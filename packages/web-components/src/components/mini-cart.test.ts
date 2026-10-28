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

async function createElement(): Promise<HTMLElement> {
  const el = document.createElement('nymbal-mini-cart')
  document.body.appendChild(el)
  await settled(el)
  return el
}

describe('nymbal-mini-cart', () => {
  it('the badge follows the cart’s item count as it changes, and is empty at zero', async () => {
    const el = await createElement()
    for (const itemCount of [3, 1, 0, 12]) {
      ;(client.cart as unknown as { setState(p: object): void }).setState({ itemCount })
      await settled(el)
      const badge = shadow(el).querySelector('.nymbal-mini-cart-badge')
      expect(badge?.textContent?.trim(), `itemCount ${itemCount}`).toBe(
        itemCount === 0 ? '' : String(itemCount),
      )
    }
  })
})
