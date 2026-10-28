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
  const el = document.createElement('nymbal-cart-drawer')
  document.body.appendChild(el)
  await settled(el)
  return el
}

type Line = {
  variantId: string
  productId: string
  productName: string
  variantName: string
  priceMinor: number
  qty: number
  imageUrl: string
}

const line = (variantId: string): Line => ({
  variantId,
  productId: 'p1',
  productName: `Product ${variantId}`,
  variantName: 'D',
  priceMinor: 1000,
  qty: 1,
  imageUrl: '',
})

describe('nymbal-cart-drawer', () => {
  it('a line’s remove control removes that line, and only it, from the cart and the drawer', async () => {
    const cart = client.cart as unknown as {
      setState(p: object): void
      getState(): { items: Line[] }
    }
    const sync = (items: Line[]) =>
      cart.setState({ items, itemCount: items.length, subtotalMinor: 1000 * items.length })
    sync([line('var-1'), line('var-2')])
    client.cart.removeItem = async (variantId: string) =>
      sync(cart.getState().items.filter((l) => l.variantId !== variantId))
    const el = await createElement()
    const shown = () =>
      [...shadow(el).querySelectorAll('[data-testid^="cart-item-"]')].map((n) =>
        n.getAttribute('data-testid'),
      )
    const before = shown()

    ;(shadow(el).querySelector('[data-testid="remove-item-var-2"]') as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 0))
    await settled(el)

    expect(cart.getState().items.map((l) => l.variantId)).toEqual(['var-1'])
    expect(shown()).toEqual(before.filter((id) => id !== 'cart-item-var-2'))
  })
})
