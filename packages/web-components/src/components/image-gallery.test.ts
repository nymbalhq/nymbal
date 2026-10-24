import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { images } from '../__fixtures__/server-data.js'

// AC-3, the unit half: `nymbal-image-gallery`'s `main` image is the first image; one `thumbnail` per image when there
// are several; clicking thumbnail i shows image i in `main` (its url and alt), whatever was shown before.

const TAG = 'nymbal-image-gallery'

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

function parts(el: Element, part: string): HTMLElement[] {
  return [...(el.shadowRoot?.querySelectorAll('[part]') ?? [])].filter((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).includes(part),
  ) as HTMLElement[]
}

/** The main image: the `main` part itself when it is the <img>, else the <img> inside it. */
function mainImage(el: Element): { src: string | null; alt: string | null } {
  const main = parts(el, 'main')[0]
  const img = main?.localName === 'img' ? main : main?.querySelector('img')
  return { src: img?.getAttribute('src') ?? null, alt: img?.getAttribute('alt') ?? null }
}

describe('AC-3: a thumbnail click swaps the gallery’s main image', () => {
  it('AC-3: property: main shows the first image, one thumbnail per image, and after clicking thumbnails in any order main shows the last one clicked', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        images('g-', 2).chain((list) =>
          fc.tuple(
            fc.constant(list),
            fc.array(fc.nat({ max: list.length - 1 }), { minLength: 1, maxLength: 5 }),
          ),
        ),
        async ([list, clicks]) => {
          document.body.innerHTML = ''
          const el = document.createElement(TAG)
          el.setAttribute('images', JSON.stringify(list))
          document.body.append(el)
          await settled(el)

          expect(mainImage(el)).toEqual({ src: list[0]!.url, alt: list[0]!.alt })
          expect(parts(el, 'thumbnail').length).toBe(list.length)

          for (const i of clicks) {
            parts(el, 'thumbnail')[i]!.click()
            await settled(el)
            expect(mainImage(el), `after thumbnail ${i}`).toEqual({
              src: list[i]!.url,
              alt: list[i]!.alt,
            })
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})
