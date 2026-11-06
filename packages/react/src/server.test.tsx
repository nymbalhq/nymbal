// @vitest-environment node
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { renderElement } from '@nymbalhq/web-components/ssr'
import * as committed from './generated/wrappers.js'
import { renderNymbal } from './server.js'

// AC-7, the server half on Next: a page computes `renderNymbal(tag, attributes, children)` on the server and hands it
// to the element's generated wrapper as `serverHtml`; the wrapper renders it on its own tag, with no wrapping element,
// so the server HTML is that one element: its attributes on the tag, and inside it the same declarative shadow root
// and light-DOM children `renderElement` gives for the same tag and attributes. Runs in Node, as a server component
// does. A wrapping div would make React's hydration miss the parsed template and re-render it.

type Wrapper = React.ComponentType<Record<string, unknown>>

const SCHEMAS: ElementSchema[] = Object.values(wc as Record<string, unknown>)
  .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
  .filter((s): s is ElementSchema => s !== undefined)
  .filter((s) => s.tag !== 'nymbal-payment-element')

const wrappers = committed as unknown as Record<string, Wrapper>

/** `<tag …>inner</tag>` → inner; null when the HTML is not exactly one `tag` element. */
function innerOf(html: string, tag: string): string | null {
  const match = new RegExp(`^<${tag}(?:\\s[^>]*)?>([\\s\\S]*)</${tag}>$`).exec(html)
  return match?.[1] ?? null
}

/** The attributes of `html`'s opening tag, each name lower-cased as an HTML parser reads it, to its raw value. */
const openingAttributes = (html: string): Map<string, string> =>
  new Map(
    [...html.slice(0, html.indexOf('>') + 1).matchAll(/\s([^\s=>]+)="([^"]*)"/g)].map(
      ([, name, value]) => [name!.toLowerCase(), value!],
    ),
  )

const occurrences = (html: string, needle: string): number => html.split(needle).length - 1

const LINE = {
  variantId: 'v-1',
  productId: 'p-1',
  productName: 'Merino Crew Sweater',
  variantName: 'M',
  qty: 2,
  priceMinor: 8900,
  imageUrl: '',
}
const CART = { items: [LINE], subtotalMinor: 17800, currency: 'GBP', itemCount: 2 }

describe('AC-7: a wrapper given serverHtml renders it on its own tag', () => {
  it('AC-7: for every server-rendered element, renderToString(<Wrapper serverHtml={renderNymbal(tag).__html} />) is one <tag> holding what renderElement(tag) holds', () => {
    expect(SCHEMAS.length).toBeGreaterThan(0)
    for (const s of SCHEMAS) {
      const expected = innerOf(renderElement(s.tag), s.tag)
      expect(expected, `renderElement(${s.tag}) is one <${s.tag}>`).not.toBeNull()
      const out = renderToString(
        React.createElement(wrappers[s.reactName]!, { serverHtml: renderNymbal(s.tag).__html }),
      )
      expect(innerOf(out, s.tag), `${s.reactName}: ${out.slice(0, 120)}`).toBe(expected)
      expect(occurrences(out, `<${s.tag}`)).toBe(occurrences(expected!, `<${s.tag}`) + 1)
    }
  })

  it('AC-7: the cart page, mini-cart and checkout given data and serverHtml carry their attributes on the tag, and the checkout its light-DOM payment element inside it', () => {
    const cart = JSON.stringify(CART)
    const payment =
      '<nymbal-payment-element slot="payment" client="{&quot;provider&quot;:&quot;test-mode&quot;}" data-testid="payment-element"></nymbal-payment-element>'
    const cases: Array<{
      tag: string
      wrapper: string
      props: Record<string, unknown>
      attributes: Record<string, string>
      children?: string
    }> = [
      { tag: 'nymbal-cart-page', wrapper: 'CartPage', props: { cart: CART }, attributes: { cart } },
      {
        tag: 'nymbal-mini-cart',
        wrapper: 'MiniCart',
        props: { count: 2 },
        attributes: { count: '2' },
      },
      {
        tag: 'nymbal-checkout',
        wrapper: 'Checkout',
        props: { cart: CART },
        attributes: { cart },
        children: payment,
      },
    ]
    for (const c of cases) {
      const expected = innerOf(
        renderElement(c.tag, { attributes: c.attributes, children: c.children }),
        c.tag,
      )
      const out = renderToString(
        React.createElement(wrappers[c.wrapper]!, {
          ...c.props,
          serverHtml: renderNymbal(c.tag, c.attributes, c.children).__html,
        }),
      )
      expect(innerOf(out, c.tag), c.wrapper).toBe(expected)
      const open = openingAttributes(out)
      for (const [name, value] of Object.entries(c.attributes)) {
        const escaped = value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
        expect(open.get(name), `${c.wrapper} [${name}]`).toBe(escaped)
      }
    }
    // The line the checkout and cart page were given is in what they render.
    const checkout = renderNymbal('nymbal-checkout', { cart }, payment).__html
    expect(occurrences(checkout, LINE.productName)).toBeGreaterThan(0)
    expect(checkout.lastIndexOf('<nymbal-payment-element')).toBeGreaterThan(
      checkout.lastIndexOf('</template>'),
    )
  })
})
