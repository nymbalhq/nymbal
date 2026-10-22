import { css, LitElement, type PropertyDeclaration, type PropertyDeclarations } from 'lit'
import type { NymbalClient } from '@nymbalhq/sdk'
import { getClient } from './registry.js'
import { define, type NymbalElementClass } from './define.js'

/** How an attribute's value reads: the React wrapper types its prop from this, and JSON travels stringified. */
export type ElementAttributeType = 'string' | 'number' | 'boolean' | 'json'

/**
 * An element's public interface, declared once on the class. Its Lit properties are derived from `attributes`, and the
 * React wrappers are generated from it, so neither can disagree with the element.
 */
export interface ElementSchema {
  tag: string
  /** The React wrapper's component name. */
  reactName: string
  /** `name` is the HTML attribute, `prop` the React prop and the Lit property. */
  attributes: Array<{ name: string; prop: string; type: ElementAttributeType }>
  /** `name` is the DOM event, `prop` the React handler, `detail` the TypeScript type of its detail. */
  events: Array<{ name: string; prop: string; detail: string }>
  /** Every `part` the element renders, for `::part()` styling. */
  parts: string[]
  /** Every named `slot` it renders, each with its default content as the fallback. */
  slots: string[]
  /** Whether the React wrapper passes children through. */
  children: boolean
}

const TYPES: Record<ElementAttributeType, PropertyDeclaration['type']> = {
  string: String,
  number: Number,
  boolean: Boolean,
  // JSON attributes are parsed where they are read, so a malformed value is reported by the element that needs it.
  json: String,
}

/** The Lit property declarations for a schema's attributes. */
export function propertiesOf(schema: ElementSchema): PropertyDeclarations {
  return Object.fromEntries(
    schema.attributes.map((a) => [a.prop, { attribute: a.name, type: TYPES[a.type] }]),
  )
}

/** A page's reset does not reach a shadow root, so each element brings the one it relied on in the light DOM. */
export const baseStyles = css`
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
`

interface Subscribable {
  subscribe(fn: () => void): () => void
}

export abstract class NymbalElement extends LitElement {
  declare static schema: ElementSchema

  /** Defines this element, and those it renders, unless its tag is already defined (see `define`). */
  static define(this: NymbalElementClass): void {
    define(this)
  }

  private _unsubs: Array<() => void> = []

  protected get client(): NymbalClient {
    return getClient()
  }

  /** The SDK stores the element renders from; it re-renders on each change while connected. */
  protected stores(): Subscribable[] {
    return []
  }

  override connectedCallback(): void {
    super.connectedCallback()
    for (const store of this.stores()) {
      this._unsubs.push(store.subscribe(() => this.requestUpdate()))
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    for (const fn of this._unsubs) fn()
    this._unsubs = []
  }
}
