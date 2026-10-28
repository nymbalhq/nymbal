import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { AddToCart, CartDrawer, MiniCart, QuantitySelector, SearchBar, Toast } from './wrappers.js'

const SCHEMAS = new Map(
  Object.values(wc as Record<string, unknown>)
    .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
    .filter((s): s is ElementSchema => s !== undefined)
    .map((s) => [s.reactName, s.tag]),
)

const WRAPPERS: Array<[string, ComponentType<Record<string, unknown>>, Record<string, unknown>]> = [
  ['AddToCart', AddToCart as never, {}],
  ['CartDrawer', CartDrawer as never, {}],
  ['MiniCart', MiniCart as never, {}],
  ['QuantitySelector', QuantitySelector as never, { value: 1 }],
  ['SearchBar', SearchBar as never, {}],
  ['Toast', Toast as never, {}],
]

// Stubs, so JSDOM renders the tags without the elements' own behaviour.
for (const tag of SCHEMAS.values()) {
  if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {})
}

describe('Generated wrappers', () => {
  it.each(WRAPPERS)(
    '%s renders its schema’s tag as the outermost node and forwards data-testid to it',
    (name, Wrapper, props) => {
      const testId = `my-${name.toLowerCase()}`
      const { container } = render(<Wrapper data-testid={testId} {...props} />)
      const outer = container.firstElementChild
      expect(outer?.localName).toBe(SCHEMAS.get(name))
      expect(outer?.getAttribute('data-testid')).toBe(`my-${name.toLowerCase()}`)
    },
  )
})
