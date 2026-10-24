import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { cards, categories, columns, crumbs, links } from '../__fixtures__/server-data.js'

// AC-7, the element's half: the anchors in the elements' shadow roots are plain <a>, which Next does not route, so
// every element whose part is an anchor (the card, the grid's cards, the header's logo, links and account link, the
// breadcrumb's items, the category nav's cards, the footer's links) dispatches `nymbal:navigate` with `{ href }` on a
// plain left click: bubbling, composed (it leaves the shadow roots) and cancelable, synchronously inside the click
// handler; when a listener cancels it, the element prevents the click's default (Next has routed it), and when nobody
// does the click goes on as a navigation (Astro). A click with a modifier key or another button dispatches nothing
// and is left alone, so a new tab still opens. The router half (NymbalSetup's `router.push`) is the prod E2E's.

interface Case {
  tag: string
  attributes: fc.Arbitrary<Record<string, string>>
}

const CASES: Case[] = [
  {
    tag: 'nymbal-product-card',
    attributes: cards('n-', 1).map((c) => ({ product: JSON.stringify(c[0]) })),
  },
  {
    tag: 'nymbal-product-grid',
    attributes: cards('n-', 1).map((c) => ({ products: JSON.stringify(c) })),
  },
  {
    tag: 'nymbal-site-header',
    attributes: links('n-', 1).map((l) => ({
      links: JSON.stringify(l),
      logo: 'Nymbal',
      'account-href': '/account',
    })),
  },
  {
    tag: 'nymbal-breadcrumb',
    attributes: crumbs('n-')
      // A link before the current page's crumb, which is text (`aria-current`) whatever it carries.
      .filter((items) => items.slice(0, -1).some((i) => i.href !== undefined))
      .map((items) => ({ items: JSON.stringify(items) })),
  },
  {
    tag: 'nymbal-category-nav',
    attributes: categories('n-', 1).map((c) => ({ categories: JSON.stringify(c) })),
  },
  {
    tag: 'nymbal-site-footer',
    attributes: columns('n-', 1)
      .filter((cols) => cols.some((c) => c.links.length > 0))
      .map((cols) => ({ columns: JSON.stringify(cols), year: '2026' })),
  },
]

type Click = 'plain' | 'meta' | 'ctrl' | 'shift' | 'alt' | 'middle'

function clickEvent(kind: Click): MouseEvent {
  return new MouseEvent('click', {
    bubbles: true,
    composed: true,
    cancelable: true,
    button: kind === 'middle' ? 1 : 0,
    metaKey: kind === 'meta',
    ctrlKey: kind === 'ctrl',
    shiftKey: kind === 'shift',
    altKey: kind === 'alt',
  })
}

async function settledDeep(el: Element): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
    for (const nested of deepAll(el.shadowRoot, '*')) {
      await (nested as Element & { updateComplete?: Promise<unknown> }).updateComplete
    }
  }
}

/** Every element matching `selector` in `root` and every open shadow root beneath it. */
function deepAll(root: ParentNode | null, selector: string): Element[] {
  if (root === null) return []
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

interface Seen {
  href: unknown
  bubbles: boolean
  composed: boolean
  cancelable: boolean
}

/** Clicks `anchor` once: the `nymbal:navigate` events the document saw, and whether the click's default was prevented. */
function clickOnce(
  anchor: Element,
  kind: Click,
  cancel: boolean,
): { seen: Seen[]; prevented: boolean } {
  const seen: Seen[] = []
  let prevented = false
  const onNavigate = (e: Event): void => {
    seen.push({
      href: (e as CustomEvent<{ href?: unknown }>).detail?.href,
      bubbles: e.bubbles,
      composed: e.composed,
      cancelable: e.cancelable,
    })
    if (cancel) e.preventDefault()
  }
  // Last on the click's path: reads the element's verdict, then stops the test DOM following the link.
  const onClick = (e: Event): void => {
    prevented = e.defaultPrevented
    e.preventDefault()
  }
  document.addEventListener('nymbal:navigate', onNavigate)
  window.addEventListener('click', onClick)
  try {
    anchor.dispatchEvent(clickEvent(kind))
  } finally {
    document.removeEventListener('nymbal:navigate', onNavigate)
    window.removeEventListener('click', onClick)
  }
  return { seen, prevented }
}

describe('AC-7: element anchors dispatch nymbal:navigate', () => {
  for (const { tag, attributes } of CASES) {
    it(`AC-7: property: ${tag}: a plain click on each anchor part dispatches one bubbling, composed, cancelable nymbal:navigate with its href, and the click is prevented exactly when a listener cancels it; a modifier or middle click dispatches nothing and is left alone`, async () => {
      expect(customElements.get(tag), `${tag} is defined by registerComponents()`).toBeDefined()
      await fc.assert(
        fc.asyncProperty(
          attributes,
          fc.constantFrom<Click>('meta', 'ctrl', 'shift', 'alt', 'middle'),
          async (attrs, modifier) => {
            document.body.innerHTML = ''
            setupMockClient()
            const el = document.createElement(tag)
            for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
            document.body.append(el)
            await settledDeep(el)

            const anchors = deepAll(el.shadowRoot, 'a[href]').filter((a) => a.hasAttribute('part'))
            expect(anchors.length, `${tag} renders anchor parts`).toBeGreaterThan(0)
            for (const anchor of anchors) {
              const href = new URL(anchor.getAttribute('href')!, document.baseURI).href
              const resolved = (seen: Seen[]) =>
                seen.map((s) => ({ ...s, href: new URL(String(s.href), document.baseURI).href }))
              const event = { href, bubbles: true, composed: true, cancelable: true }

              const routed = clickOnce(anchor, 'plain', true)
              expect(resolved(routed.seen), `cancelled: ${href}`).toEqual([event])
              expect(routed.prevented, 'a cancelled navigate prevents the click').toBe(true)

              const plain = clickOnce(anchor, 'plain', false)
              expect(resolved(plain.seen), `not cancelled: ${href}`).toEqual([event])
              expect(
                plain.prevented,
                'an uncancelled navigate leaves the click to the browser',
              ).toBe(false)

              const other = clickOnce(anchor, modifier, true)
              expect(other.seen, `${modifier} click`).toEqual([])
              expect(other.prevented, `${modifier} click left alone`).toBe(false)
            }
          },
        ),
        { numRuns: 10 },
      )
    })
  }
})
