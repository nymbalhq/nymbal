import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// `nymbal-product-card` shows the product's own image, and a placeholder seeded by its slug when it has none, as both
// templates' search cards did, so a product without media still renders a square image, not an empty box.
// Kills: a card with no media rendering no image, a placeholder that ignores the slug, a placeholder over real media.

const TAG = 'nymbal-product-card'

beforeEach(() => {
  setupMockClient()
})

async function imageSrc(product: Record<string, unknown>): Promise<string | null | undefined> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  el.setAttribute('product', JSON.stringify(product))
  document.body.appendChild(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el.shadowRoot?.querySelector('[part~="image"]')?.getAttribute('src')
}

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/)
const name = fc.stringMatching(/^[A-Z][a-z]{1,10}$/)
const url = fc.stringMatching(/^[a-z]{1,8}$/).map((p) => `https://cdn.example.test/${p}.jpg`)

describe('nymbal-product-card image', () => {
  it('property: a product with no media and no imageUrl shows https://picsum.photos/seed/<slug>/600/600', async () => {
    await fc.assert(
      fc.asyncProperty(
        slug,
        name,
        fc.constantFrom({}, { media: [] }, { media: [{}] }),
        async (s, n, rest) => {
          expect(await imageSrc({ slug: s, name: n, priceMinor: 1000, ...rest })).toBe(
            `https://picsum.photos/seed/${encodeURIComponent(s)}/600/600`,
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  it('property: a product with media or an imageUrl shows that image, not the placeholder', async () => {
    await fc.assert(
      fc.asyncProperty(slug, name, url, fc.boolean(), async (s, n, u, viaMedia) => {
        const own = viaMedia ? { media: [{ url: u, alt: n }] } : { imageUrl: u, media: [] }
        expect(await imageSrc({ slug: s, name: n, priceMinor: 1000, ...own })).toBe(u)
      }),
      { numRuns: 30 },
    )
  })
})
