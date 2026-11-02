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

/** What the browser raises on `window` when it shows a page: `persisted` is true for one restored from its cache. */
function pageshow(persisted: boolean): void {
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }))
}

/** Lets a handler's cart read settle and the element render what it left. */
async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
  }
}

const badgeText = (el: Element): string =>
  shadow(el).querySelector('.nymbal-mini-cart-badge')?.textContent?.trim() ?? ''
const shownAs = (count: number): string => (count === 0 ? '' : String(count))

describe('nymbal-mini-cart on a page the browser restores from its back/forward cache', () => {
  it('AC-1: property: a restored page reads the cart once and the badge shows the server’s count; a first load reads nothing; a disconnected badge reads nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        async (before, now) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          const cart = client.cart as unknown as {
            setState(p: object): void
            load: () => Promise<void>
          }
          // The store settled at `before` when the page was left; the server's cart has since moved to `now`.
          cart.setState({ itemCount: before, loading: false })
          let reads = 0
          cart.load = async () => {
            reads += 1
            cart.setState({ loading: true })
            await Promise.resolve()
            cart.setState({ itemCount: now, loading: false })
          }

          const el = await createElement()
          await flush(el)
          const shownBefore = badgeText(el)
          expect(shownBefore).toBe(shownAs(before))

          pageshow(false)
          await flush(el)
          expect(reads, 'a first load reads no cart: the template already loads it').toBe(0)
          expect(badgeText(el)).toBe(shownBefore)

          pageshow(true)
          await flush(el)
          expect(reads, 'a restore reads the cart once').toBe(1)
          expect(badgeText(el)).toBe(shownAs(now))

          el.remove()
          pageshow(true)
          await flush(el)
          expect(reads, 'a removed badge reads no cart on a later restore').toBe(1)
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)
})
