import fc from 'fast-check'
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

async function createElement(attrs: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement('nymbal-add-to-cart')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  await settled(el)
  return el
}

describe('nymbal-add-to-cart', () => {
  it('the button is enabled exactly while a variant-id is set', async () => {
    const el = await createElement()
    const disabled = () => (shadow(el).querySelector('button') as HTMLButtonElement).disabled
    const seen = [disabled()]
    el.setAttribute('variant-id', 'var-1')
    await settled(el)
    seen.push(disabled())
    el.removeAttribute('variant-id')
    await settled(el)
    seen.push(disabled())
    expect(seen).toEqual([true, false, true])
  })

  it('property: a click adds the qty attribute as whole units clamped to 1-99 (1 when it is not a whole number)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: -5, max: 150 }).map(String),
          fc.constantFrom('', '2.5', 'two', ' 3 '),
        ),
        async (qtyAttr) => {
          client = setupMockClient()
          const cart = client.cart as unknown as {
            setState(p: object): void
            getState(): { itemCount: number }
          }
          client.cart.addItem = async (_variantId: string, qty = 1) =>
            cart.setState({ itemCount: cart.getState().itemCount + qty })
          const el = await createElement({ 'variant-id': 'var-1', qty: qtyAttr })
          const before = cart.getState().itemCount
          ;(shadow(el).querySelector('button') as HTMLButtonElement).click()
          await new Promise((r) => setTimeout(r, 0))

          const n = qtyAttr.trim() === '' ? Number.NaN : Number(qtyAttr)
          const expected = Math.min(99, Math.max(1, Number.isInteger(n) ? n : 1))
          expect(cart.getState().itemCount).toBe(before + expected)
          el.remove()
        },
      ),
      { numRuns: 40 },
    )
  })

  it('button shows loading state when cart is loading', async () => {
    // Set loading state on the current client BEFORE creating element
    ;(client.cart as unknown as { setState(p: object): void }).setState({ loading: true })
    const el = await createElement({ 'variant-id': 'var-1' })
    const btn = shadow(el).querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
