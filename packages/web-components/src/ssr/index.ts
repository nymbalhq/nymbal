import { restoreCreateRenderRoot } from './render-root.js'
import type { RenderInfo } from '@lit-labs/ssr'
import { LitElementRenderer } from '@lit-labs/ssr/lib/lit-element-renderer.js'
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js'
import type { LitElement } from 'lit'
import { ELEMENTS } from '../register-components.js'

export { cardImageOf, cardProductOf, type CardProduct } from '../components/product-card.js'

restoreCreateRenderRoot()

/** Thrown for a tag the server does not render: neither a package element nor one a project registered. */
export class UnknownElement extends Error {
  override name = 'UnknownElement'
}

type LitElementClass = (new () => LitElement) & { _$litElement$?: boolean }

/** Mounted by its payment driver in the browser, in the light DOM; a checkout's server render leaves its slot. */
const CLIENT_MOUNTED = new Set(['nymbal-payment-element'])

const PACKAGE = new Map<string, LitElementClass>(
  ELEMENTS.filter((e) => !CLIENT_MOUNTED.has(e.schema.tag)).map((e) => [
    e.schema.tag,
    e as unknown as LitElementClass,
  ]),
)

/** The project's elements by tag (its `serverElements`), which the server renders in place of the package's. */
const projectElements = new Map<string, LitElementClass>()

/**
 * Registers a project's own element classes by tag, as its elements entry exports them: the server renders each in
 * place of the package's element under that tag, as the browser defines it there. A tag keeps the first class it was
 * registered with; a different class under it is refused, so the server and the browser cannot disagree.
 */
export function registerServerElements(map: Record<string, CustomElementConstructor>): void {
  for (const [tag, element] of Object.entries(map)) {
    const lit = element as unknown as LitElementClass
    if (lit._$litElement$ !== true) {
      throw new TypeError(`${tag}: the server renders Lit elements only`)
    }
    const registered = projectElements.get(tag)
    if (registered !== undefined && registered !== lit) {
      throw new Error(`${tag} is already registered for the server with another class`)
    }
    projectElements.set(tag, lit)
  }
}

/** The class the server renders under `tag`, resolved per call, so a registration after a first render wins. */
function classFor(tag: string): LitElementClass | undefined {
  return projectElements.get(tag) ?? PACKAGE.get(tag)
}

/**
 * Lit SSR finds the elements a template renders, and constructs them, through `customElements`, which defines a tag
 * once per process. This renderer constructs the class `classFor` resolves instead, so a project's element renders
 * under its tag whatever `customElements` held first.
 */
class ServerElementRenderer extends LitElementRenderer {
  static override matchesClass(_ctor: typeof HTMLElement, tagName?: string): boolean {
    return tagName !== undefined && classFor(tagName) !== undefined
  }

  constructor(tagName: string) {
    super(tagName)
    const element = classFor(tagName)!
    if (this.element.constructor !== element) this.element = new element()
  }
}

/**
 * Every tag the server may render is known to `customElements`, which is where Lit SSR finds nested elements. A DOM
 * (not Lit's server shim) constructs only the classes it defined, so a project class whose tag already holds another
 * class is defined under a name of its own.
 */
function defineAll(): void {
  for (const tag of new Set([...projectElements.keys(), ...PACKAGE.keys()])) {
    const element = classFor(tag)!
    if (customElements.get(tag) === undefined) customElements.define(tag, element)
    else if (customElements.getName(element) === null)
      customElements.define(`${tag}-server`, element)
  }
}

/**
 * The elements' styles, with their indentation collapsed: written for reading, they would otherwise be bytes a page
 * downloads before its first paint, once per element.
 */
function compactStyles(html: string): string {
  return html.replace(
    /<style>([^<]*)<\/style>/g,
    (_, css: string) => `<style>${css.replace(/\s+/g, ' ').trim()}</style>`,
  )
}

export interface RenderOptions {
  /** The host's attributes; a JSON attribute's value is its JSON text. */
  attributes?: Record<string, string> | undefined
  /** Light-DOM HTML after the shadow root: a slotted child, as the payment element is the checkout's. */
  children?: string | undefined
}

/**
 * One element as HTML: `<tag …attributes><template shadowrootmode="open">…</template>…children</tag>`, the template
 * holding the element's first render from its attributes (no client, no store) with its styles, and the markers Lit's
 * hydration reads. The browser parses the template into the element's shadow root, and the element takes it over.
 */
export function renderElement(tag: string, options: RenderOptions = {}): string {
  if (CLIENT_MOUNTED.has(tag)) {
    throw new UnknownElement(`${tag} is client-mounted and is not server-rendered`)
  }
  if (classFor(tag) === undefined) {
    throw new UnknownElement(`${tag} is neither a Nymbal element nor a registered server element`)
  }
  defineAll()

  const renderer = new ServerElementRenderer(tag)
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    renderer.setAttribute(name, value)
  }
  renderer.connectedCallback()
  const renderInfo: RenderInfo = {
    elementRenderers: [ServerElementRenderer, LitElementRenderer],
    customElementInstanceStack: [renderer],
    customElementHostStack: [renderer],
    eventTargetStack: [renderer.element],
    slotStack: [],
    deferHydration: false,
  }
  const attributes = collectResultSync(renderer.renderAttributes())
  const shadow = compactStyles(collectResultSync(renderer.renderShadow(renderInfo)))
  const { mode = 'open' } = renderer.shadowRootOptions
  return `<${tag}${attributes}><template shadowrootmode="${mode}">${shadow}</template>${options.children ?? ''}</${tag}>`
}
