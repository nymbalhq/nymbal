import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import * as wc from '../index.js'
import type { ElementSchema } from '../index.js'
import { getClient } from '../registry.js'
import { STOCK_LABELS, stockLevel } from '@nymbalhq/types'
import {
  addresses,
  cards,
  cart,
  categories,
  columns,
  crumbs,
  customer,
  facets,
  formatMoney,
  images,
  links,
  renderableEntries,
  reviews,
  SORT_KEYS,
  summaryLines,
  TIMELINE_LABELS,
  timelineEntries,
  variantProduct,
  word,
} from '../__fixtures__/server-data.js'
import { renderElement } from './index.js'

// AC-1: `renderElement` renders every element but the payment element to
// `<tag …attrs><template shadowrootmode="open">…</template>…children</tag>`, and what the template holds is what the
// same element renders in happy-dom (which parses no declarative shadow DOM) from the same attributes with no client
// registered: the same parts, as many of each, and the same text. No element throws without a client, on the server
// or on connecting. A host that already holds the server's shadow content keeps it: hydration takes the markup over,
// so the part counts stay the server's rather than doubling. The hydrate support must evaluate before lit
// (tests/setup.ts imports the package's index, whose first import it must be), or the client render appends to the
// server's nodes.
//
// The catalogue and page elements (the product grid, price, stock badge, breadcrumb, image gallery, site header and
// footer, category nav, review list and form, order summary, order timeline, notify-me) meet the same three cases, 31
// elements in all. Each
// renders from its attributes alone: the data it is given is in its server render.

const PAYMENT = 'nymbal-payment-element'

const SCHEMAS: ElementSchema[] = Object.values(wc as Record<string, unknown>)
  .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
  .filter((s): s is ElementSchema => s !== undefined)
const SERVER_RENDERED = SCHEMAS.filter((s) => s.tag !== PAYMENT)

/** The JSON a server passes each JSON attribute, keyed `<tag> <attribute>`. */
const JSON_VALUES: Record<string, fc.Arbitrary<unknown>> = {
  'nymbal-cart-page cart': cart('p-'),
  'nymbal-checkout cart': cart('p-'),
  'nymbal-cart-drawer cart': cart('p-'),
  'nymbal-search-results results': cards('p-'),
  'nymbal-variant-selector product': variantProduct('p-'),
  'nymbal-profile-form customer': customer('p-'),
  'nymbal-address-book addresses': addresses('p-'),
  'nymbal-product-card product': cards('p-', 1).map((c) => c[0]),
  'nymbal-product-filter facets': facets('p-', fc.constantFrom('category', 'colour')),
  'nymbal-sort-dropdown sort-keys': fc.subarray(SORT_KEYS, { minLength: 1 }),
  // Catalogue and page elements
  'nymbal-product-grid products': cards('p-'),
  'nymbal-breadcrumb items': crumbs('p-'),
  'nymbal-image-gallery images': images('p-'),
  'nymbal-site-header links': links('p-'),
  'nymbal-site-footer columns': columns('p-'),
  'nymbal-category-nav categories': categories('p-'),
  'nymbal-review-list reviews': reviews('p-'),
  'nymbal-order-summary items': summaryLines('p-'),
  'nymbal-order-timeline entries': timelineEntries(),
}

/** String attributes whose value is one of a few words; any other string attribute takes a generated word. */
const STRING_VALUES: Record<string, fc.Arbitrary<string>> = {
  'nymbal-product-filter source': fc.constantFrom('search', 'listing'),
  'nymbal-sort-dropdown value': fc.constantFrom(...SORT_KEYS),
  'nymbal-sort-dropdown default-sort': fc.constantFrom(...SORT_KEYS),
  'nymbal-toast position': fc.constantFrom('top-right', 'top-left', 'bottom-right', 'bottom-left'),
  // Catalogue and page elements
  'nymbal-product-grid source': fc.constant('product-list'),
  'nymbal-product-price currency': fc.constantFrom('GBP', 'EUR'),
  'nymbal-order-summary currency': fc.constantFrom('GBP', 'EUR'),
  'nymbal-site-header account-href': fc.constant('/account'),
  'nymbal-order-timeline time-zone': fc.constantFrom('UTC', 'Europe/London', 'America/New_York'),
}

/** One attribute's value as the HTML carries it, or undefined to leave it off. */
function valueOf(
  schema: ElementSchema,
  a: ElementSchema['attributes'][number],
): fc.Arbitrary<string | undefined> {
  const key = `${schema.tag} ${a.name}`
  let value: fc.Arbitrary<string>
  switch (a.type) {
    case 'boolean':
      return fc.constantFrom('', undefined)
    case 'number':
      value = fc.integer({ min: 0, max: 99 }).map(String)
      break
    case 'string':
      value = STRING_VALUES[key] ?? word
      break
    case 'json': {
      const json = JSON_VALUES[key]
      if (json === undefined) {
        throw new Error(
          `AC-1 has no generator for the JSON attribute ${key}; add the shape the element takes`,
        )
      }
      value = json.map((v) => JSON.stringify(v))
      break
    }
  }
  return fc.option(value, { nil: undefined })
}

function attributesFor(schema: ElementSchema): fc.Arbitrary<Record<string, string>> {
  return fc
    .tuple(...schema.attributes.map((a) => valueOf(schema, a)))
    .map((values) =>
      Object.fromEntries(
        schema.attributes.flatMap((a, i) =>
          values[i] === undefined ? [] : [[a.name, values[i]!]],
        ),
      ),
    )
}

/** Light-DOM children the caller passes: a few marked spans. */
const children = fc
  .array(word, { maxLength: 2 })
  .map((ws) => ws.map((w, i) => `<span data-child="${i}">${w}</span>`).join(''))

/** HTML parsed inert, as a template's content: nothing in it is upgraded or connected. */
function parse(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

/** The declarative shadow root template a host holds as its first child, or null. */
function serverTemplate(host: Element): HTMLTemplateElement | null {
  const first = host.firstElementChild
  return first?.localName === 'template' && first.getAttribute('shadowrootmode') === 'open'
    ? (first as HTMLTemplateElement)
    : null
}

/** Each part name in this root (not in nested shadow roots or templates) and how many nodes carry it. */
function partCounts(root: ParentNode): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of root.querySelectorAll('[part]')) {
    for (const part of (node.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== '')) {
      counts[part] = (counts[part] ?? 0) + 1
    }
  }
  return counts
}

/** The root's text without its styles, whitespace collapsed. */
function textOf(root: ParentNode): string {
  const copy = document.createElement('div')
  for (const node of root.childNodes) copy.append(document.importNode(node, true))
  for (const style of copy.querySelectorAll('style')) style.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * What an element given data must show (the defect: a property it renders its empty state from): the strings its
 * shadow text holds, and how many product cards it renders.
 */
function shownFrom(
  tag: string,
  attributes: Record<string, string>,
): { text: string[]; cards: number | null } {
  const json = (name: string): unknown =>
    attributes[name] === undefined ? undefined : (JSON.parse(attributes[name]!) as unknown)
  const lines = (json('cart') as { items: Array<{ productName: string }> } | undefined)?.items ?? []
  switch (tag) {
    case 'nymbal-cart-page':
    case 'nymbal-cart-drawer':
    case 'nymbal-checkout':
      return { text: lines.map((l) => l.productName), cards: null }
    case 'nymbal-mini-cart': {
      const count = Number(attributes['count'] ?? 0)
      return { text: count > 0 ? [String(count)] : [], cards: null }
    }
    case 'nymbal-search-results': {
      const results = json('results') as unknown[] | undefined
      return { text: [], cards: results === undefined ? null : results.length }
    }
    case 'nymbal-variant-selector': {
      const product = json('product') as
        | { variants: Array<{ options: Array<{ value: string }> }> }
        | undefined
      return {
        text: product?.variants.flatMap((v) => v.options.map((o) => o.value)) ?? [],
        cards: null,
      }
    }
    case 'nymbal-address-book': {
      const list = json('addresses') as Array<{ addressLine1: string }> | undefined
      return { text: list?.map((a) => a.addressLine1) ?? [], cards: null }
    }
    case 'nymbal-product-card': {
      const product = json('product') as { name: string } | undefined
      return { text: product === undefined ? [] : [product.name], cards: null }
    }
    // Catalogue and page elements
    case 'nymbal-product-grid': {
      const products = json('products') as unknown[] | undefined
      return { text: [], cards: products === undefined ? null : products.length }
    }
    case 'nymbal-product-price': {
      const minor = attributes['price-minor']
      const currency = attributes['currency']
      return {
        text:
          minor === undefined || currency === undefined
            ? []
            : [formatMoney(Number(minor), currency)],
        cards: null,
      }
    }
    case 'nymbal-stock-badge': {
      const stock = attributes['stock']
      return {
        text: stock === undefined ? [] : [STOCK_LABELS[stockLevel(Number(stock))]],
        cards: null,
      }
    }
    case 'nymbal-breadcrumb': {
      const items = json('items') as Array<{ label: string }> | undefined
      return { text: items?.map((i) => i.label) ?? [], cards: null }
    }
    case 'nymbal-site-header': {
      const list = json('links') as Array<{ label: string }> | undefined
      const logo = attributes['logo']
      return {
        text: [...(list?.map((l) => l.label) ?? []), ...(logo === undefined ? [] : [logo])],
        cards: null,
      }
    }
    case 'nymbal-site-footer': {
      const list = json('columns') as
        | Array<{ heading: string; links: Array<{ label: string }> }>
        | undefined
      return {
        text: list?.flatMap((c) => [c.heading, ...c.links.map((l) => l.label)]) ?? [],
        cards: null,
      }
    }
    case 'nymbal-category-nav': {
      const list = json('categories') as Array<{ name: string }> | undefined
      return { text: list?.map((c) => c.name) ?? [], cards: null }
    }
    case 'nymbal-review-list': {
      const list = json('reviews') as Array<{ title: string }> | undefined
      return { text: list?.map((r) => r.title) ?? [], cards: null }
    }
    case 'nymbal-order-summary': {
      const list = json('items') as Array<{ name: string }> | undefined
      return { text: list?.map((l) => l.name) ?? [], cards: null }
    }
    case 'nymbal-order-timeline': {
      const list = json('entries') as Array<{ kind: string; at: string }> | undefined
      return {
        text: renderableEntries(list ?? []).map((e) => TIMELINE_LABELS[e.kind]),
        cards: null,
      }
    }
    case 'nymbal-product-filter': {
      const list = json('facets') as
        | Array<{ field: string; values: Array<{ label: string }> }>
        | undefined
      // With `source="search"` the filter shows the search's category facets only.
      const shown =
        attributes['source'] === 'search' ? list?.filter((f) => f.field === 'category') : list
      return { text: shown?.flatMap((f) => f.values.map((v) => v.label)) ?? [], cards: null }
    }
    default:
      return { text: [], cards: null }
  }
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

/** Errors the page reports while `fn` runs: thrown, rejected, or dispatched as a window `error`. */
async function errorsDuring(fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = []
  const onError = (event: Event): void => {
    errors.push(String((event as ErrorEvent).error ?? (event as ErrorEvent).message))
  }
  window.addEventListener('error', onError)
  try {
    await fn()
  } catch (error) {
    errors.push(String(error))
  } finally {
    window.removeEventListener('error', onError)
  }
  return errors
}

beforeEach(() => {
  // No client registered: the server has none, and the comparison is with the client render that has none either.
  expect(() => getClient()).toThrow(/not registered/)
})

const CATALOGUE_ELEMENTS = [
  'nymbal-product-grid',
  'nymbal-product-price',
  'nymbal-stock-badge',
  'nymbal-breadcrumb',
  'nymbal-image-gallery',
  'nymbal-site-header',
  'nymbal-site-footer',
  'nymbal-category-nav',
  'nymbal-review-list',
  'nymbal-review-form',
  'nymbal-order-summary',
  'nymbal-order-timeline',
  'nymbal-notify-me',
]

describe('AC-1: renderElement renders every element', () => {
  it('AC-1: the package has 31 server-rendered elements, every one but the payment element, the catalogue and page elements among them', () => {
    expect(SERVER_RENDERED.length).toBe(SCHEMAS.length - 1)
    expect(CATALOGUE_ELEMENTS.filter((tag) => !SERVER_RENDERED.some((s) => s.tag === tag))).toEqual(
      [],
    )
    expect(SERVER_RENDERED.length).toBe(18 + CATALOGUE_ELEMENTS.length)
  })

  for (const schema of SERVER_RENDERED) {
    const { tag } = schema

    it(`AC-1: property: ${tag} renders <tag …attrs><template shadowrootmode="open">…</template>…children</tag>, its template holding the parts, counts and text the client renders from the same attributes, and nothing throws without a client`, async () => {
      await fc.assert(
        fc.asyncProperty(attributesFor(schema), children, async (attributes, childHtml) => {
          let out = ''
          const serverErrors = await errorsDuring(async () => {
            out = renderElement(tag, { attributes, children: childHtml })
          })
          expect(serverErrors, `${tag} on the server`).toEqual([])

          const top = parse(out)
          expect(top.children.length, 'one element at the top').toBe(1)
          const host = top.firstElementChild!
          expect(host.localName).toBe(tag)
          for (const [name, value] of Object.entries(attributes)) {
            expect(host.getAttribute(name), `${tag} [${name}]`).toBe(value)
          }
          const template = serverTemplate(host)
          expect(
            template,
            `${tag}'s first child is <template shadowrootmode="open">`,
          ).not.toBeNull()
          const after = [...host.children].slice(1)
          expect(after.map((c) => c.outerHTML).join('')).toBe(childHtml)

          const shown = shownFrom(tag, attributes)
          const serverText = textOf(template!.content)
          expect(
            shown.text.filter((s) => !serverText.includes(s)),
            `${tag} data missing from its render`,
          ).toEqual([])
          const cardCount = template!.content.querySelectorAll('nymbal-product-card').length
          expect(shown.cards === null ? null : cardCount, `${tag} product cards`).toBe(shown.cards)

          const el = document.createElement(tag)
          for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
          el.append(document.importNode(parse(childHtml), true))
          const clientErrors = await errorsDuring(async () => {
            document.body.append(el)
            await settled(el)
          })
          expect(clientErrors, `${tag} connected with no client`).toEqual([])
          const client = el.shadowRoot
          expect(client, `${tag} has an open shadow root`).not.toBeNull()

          expect(partCounts(template!.content)).toEqual(partCounts(client!))
          expect(textOf(template!.content)).toBe(textOf(client!))
          el.remove()
        }),
        { numRuns: 15 },
      )
    })

    it(`AC-1: property: a ${tag} host already holding the server's shadow content (lit-part markers included) hydrates it on connecting: the same shadow root, the server's part counts, not double`, async () => {
      await fc.assert(
        fc.asyncProperty(attributesFor(schema), async (attributes) => {
          const host = parse(renderElement(tag, { attributes })).firstElementChild!
          const server = serverTemplate(host)!.content
          const expected = partCounts(server)

          // What the browser's parser builds from the server HTML: the host, its attributes and its shadow root holding
          // the template's content, before the element's class runs.
          const el = document.createElement(tag)
          for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
          const root = el.attachShadow({ mode: 'open' })
          root.append(document.importNode(server, true))

          const errors = await errorsDuring(async () => {
            document.body.append(el)
            await settled(el)
          })
          expect(errors, `${tag} hydrating`).toEqual([])
          expect(el.shadowRoot, 'the server shadow root is the one in use').toBe(root)
          expect(partCounts(el.shadowRoot!)).toEqual(expected)
          expect(textOf(el.shadowRoot!)).toBe(textOf(server))
          el.remove()
        }),
        { numRuns: 5 },
      )
    })

    it(`AC-1: property: a ${tag} host given the server string unparsed, as React's innerHTML inserts it on a soft navigation, upgrades its own template and keeps the server's part counts`, async () => {
      await fc.assert(
        fc.asyncProperty(attributesFor(schema), async (attributes) => {
          const out = renderElement(tag, { attributes })
          const expected = partCounts(serverTemplate(parse(out).firstElementChild!)!.content)

          // Parsed detached, then inserted, as a browser's innerHTML does: happy-dom parses into a connected parent
          // node by node, so the element would connect before its template child exists and never meet it.
          const container = document.createElement('div')
          const errors = await errorsDuring(async () => {
            container.innerHTML = out
            document.body.append(container)
            await settled(container.firstElementChild!)
          })
          expect(errors, `${tag} upgrading its template`).toEqual([])
          const el = container.firstElementChild!
          expect(
            [...el.children].some((c) => c.localName === 'template'),
            'the template is gone',
          ).toBe(false)
          expect(el.shadowRoot, `${tag} has an open shadow root`).not.toBeNull()
          expect(partCounts(el.shadowRoot!)).toEqual(expected)
          container.remove()
        }),
        { numRuns: 5 },
      )
    })
  }

  it('AC-1: nymbal-payment-element is refused with an UnknownElement error naming the tag as client-mounted, as is a tag neither the package nor the registry knows', () => {
    const nameOf = (tag: string): string[] => {
      try {
        renderElement(tag)
      } catch (error) {
        return [(error as Error).name, (error as Error).constructor.name]
      }
      return []
    }
    expect(nameOf(PAYMENT)).toContain('UnknownElement')
    expect(nameOf('nymbal-no-such-element')).toContain('UnknownElement')
    expect(() => renderElement(PAYMENT)).toThrow(/nymbal-payment-element .*client-mounted/)
  })
})
