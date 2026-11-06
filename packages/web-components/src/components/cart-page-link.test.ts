import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// `nymbal-cart-page` links a line's name to its product page by slug; a line stored before lines carried a slug
// shows its name as text with no link.

const TAG = 'nymbal-cart-page'

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

function setCart(state: Record<string, unknown>): void {
  ;(client.cart as unknown as { setState(p: object): void }).setState(state)
}

async function mount(): Promise<ShadowRoot> {
  const el = document.createElement(TAG)
  document.body.appendChild(el)
  await settled(el)
  if (el.shadowRoot === null) throw new Error(`<${TAG}> has no open shadow root`)
  return el.shadowRoot
}

// Slugs as an importer brings them, some with characters a path must encode.
const slug = fc.oneof(
  fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+){0,3}$/),
  fc.constantFrom('mug & saucer', 'café-noir', 'a/b', '100%-wool', 'ünïcode'),
)

const line = fc.record({
  variantId: fc.stringMatching(/^v[a-z0-9]{1,8}$/),
  productId: fc.stringMatching(/^p[a-z0-9]{1,8}$/),
  productSlug: fc.option(slug, { nil: undefined }),
  productName: fc.stringMatching(/^[A-Z][a-z]{1,10}$/),
  variantName: fc.constantFrom('', 'Blue'),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  qty: fc.integer({ min: 1, max: 99 }),
  imageUrl: fc.constant(''),
})

describe('nymbal-cart-page line links', () => {
  // Kills: the name linked by productId (a 404 on /product/[slug]), and an old line linked to /product/undefined.
  it('AC-14: property: a line with a productSlug names its product with a link to /product/<encoded slug>; a line without one shows its name as text with no href', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(line, { minLength: 1, maxLength: 4, selector: (l) => l.variantId }),
        async (items) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          setCart({
            items,
            subtotalMinor: items.reduce((n, i) => n + i.priceMinor * i.qty, 0),
            currency: 'GBP',
            itemCount: items.reduce((n, i) => n + i.qty, 0),
            loading: false,
            error: null,
          })
          const root = await mount()

          for (const item of items) {
            const shown = root.querySelector(`[data-testid="cart-item-${item.variantId}"]`)
            const name = shown?.querySelector('[part~="item-name"]')
            const label = `${item.variantId} (slug ${String(item.productSlug)})`
            expect(name?.textContent?.trim(), label).toBe(item.productName)
            const productLinks = [...(shown?.querySelectorAll('[href]') ?? [])].map((a) =>
              a.getAttribute('href'),
            )
            expect(productLinks, label).toEqual(
              item.productSlug === undefined
                ? []
                : [`/product/${encodeURIComponent(item.productSlug)}`],
            )
            expect(name?.getAttribute('href') ?? null, label).toBe(
              item.productSlug === undefined
                ? null
                : `/product/${encodeURIComponent(item.productSlug)}`,
            )
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
