import './hydrate-support.js'
import {
  css,
  LitElement,
  type PropertyDeclaration,
  type PropertyDeclarations,
  type PropertyValues,
} from 'lit'
import type { NymbalClient } from '@nymbalhq/sdk'
import { getClient, hasClient, hasSettled } from './registry.js'
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

export interface Subscribable {
  subscribe(fn: () => void): () => void
  getState(): unknown
}

/** A JSON property's value: parsed when it came from the attribute, undefined when unset or malformed (reported). */
export function parsedJson<T>(element: Element, name: string, value: unknown): T | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch (err) {
    console.error(`[${element.localName}] failed to parse the ${name} attribute`, err)
    return undefined
  }
}

export abstract class NymbalElement extends LitElement {
  declare static schema: ElementSchema

  /** Defines this element, and those it renders, unless its tag is already defined (see `define`). */
  static define(this: NymbalElementClass): void {
    define(this)
  }

  private _unsubs: Array<() => void> = []
  /** Set while the element's first render takes over a server's shadow root (see `readsStores`). */
  private _serverRender = false

  protected get client(): NymbalClient {
    return getClient()
  }

  /** Whether a client is registered: never on a server. Without one the element subscribes to no store. */
  protected get hasClient(): boolean {
    return hasClient()
  }

  /**
   * Whether this render reads the client's stores. Not on a server, and not in the first render of an element taking
   * over a server's shadow root: hydration needs the server's render (a store still loading would change it), so that
   * render is the server's, and the element renders again from its stores straight after.
   */
  protected get readsStores(): boolean {
    return this.hasClient && !this._serverRender
  }

  /** The SDK stores the element renders from; it re-renders on each change while connected. */
  protected stores(): Subscribable[] {
    return []
  }

  /**
   * A store `stores()` named has settled (an update that is not `loading`): the properties a server rendered this
   * element from give way to it. An update while loading leaves them showing, so a count does not flip to 0 and back.
   */
  protected storeSettled(_store: Subscribable): void {}

  override connectedCallback(): void {
    super.connectedCallback()
    if (!this.hasClient) return
    for (const store of this.stores()) {
      this._unsubs.push(
        store.subscribe(() => {
          if ((store.getState() as { loading?: unknown }).loading !== true) this.storeSettled(store)
          this.requestUpdate()
        }),
      )
    }
    // A hydrating element keeps the server's properties for its first render (see `update`).
    if (!this._serverRender) this.takeSettledStores()
  }

  /**
   * A store that settled before this element connected sends it no update, so the properties a server gave (a page
   * restored from a router's cache after the cart changed elsewhere) give way to it here.
   */
  private takeSettledStores(): void {
    for (const store of this.stores()) if (hasSettled(store)) this.storeSettled(store)
  }

  /**
   * React inserts a soft navigation's server HTML with `innerHTML`, which leaves the declarative shadow root an unparsed
   * template: it becomes this element's shadow root here, before Lit looks for one, so the element hydrates it rather
   * than rendering a second. A parsed declarative shadow root (a full load) is already `shadowRoot`.
   */
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    if (this.shadowRoot === null) {
      const template = [...this.children].find(
        (c): c is HTMLTemplateElement =>
          c instanceof HTMLTemplateElement && c.getAttribute('shadowrootmode') === 'open',
      )
      if (template !== undefined) {
        const root = this.attachShadow((this.constructor as typeof LitElement).shadowRootOptions)
        const markup = template.innerHTML
        if (typeof root.setHTMLUnsafe === 'function') root.setHTMLUnsafe(markup)
        else root.innerHTML = markup
        template.remove()
      }
    }
    this._serverRender = this.shadowRoot !== null
    return super.createRenderRoot()
  }

  protected override update(changed: PropertyValues): void {
    super.update(changed)
    if (!this._serverRender) return
    // The render above hydrated the server's; this one, in the same update, is from the stores. A scheduled update
    // here would be a second update per element, which Lit warns of.
    this._serverRender = false
    if (this.hasClient) this.takeSettledStores()
    this.willUpdate(changed)
    super.update(changed)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    for (const fn of this._unsubs) fn()
    this._unsubs = []
  }
}
