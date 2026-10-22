// P2-18 AC-3: a project's elements entry that overrides `nymbal-mini-cart`, as a store's `elements/index.ts` would
// (spec Decision 3). The `astro-override` and `nextjs-override` E2E targets (tests/e2e/playwright.config.ts) start a
// template with NYMBAL_ELEMENTS_ENTRY naming this file, which the template then uses in place of its own entry on both
// sides: the server registers `serverElements` (renderElement renders the project's class under the tag), and the
// browser defines the class before any Nymbal element is defined. Bare imports here resolve as they do from the
// template. JavaScript, not TypeScript: it is compiled by the template's build, not by the repository's typecheck.

// The hydrate support evaluates before lit, as every override must import it (Decision 1).
import '@nymbalhq/web-components/hydrate-support'
import { html, LitElement } from 'lit'

export class ProjectMiniCart extends LitElement {
  /** Read by theming.spec.ts: the class customElements holds under the tag is the project's. */
  static projectOwned = true

  static schema = {
    tag: 'nymbal-mini-cart',
    reactName: 'MiniCart',
    attributes: [],
    events: [],
    parts: ['project-marker'],
    slots: [],
    children: false,
  }

  render() {
    return html`<span part="project-marker" data-testid="project-mini-cart-marker">cart</span>`
  }
}

// P2-17 AC-4 (spec Decision 8): the project also overrides the site footer, one of the chrome elements P2-17 adds.
export class ProjectSiteFooter extends LitElement {
  /** Read by footer-override.spec.ts: the class customElements holds under the tag is the project's. */
  static projectOwned = true

  static schema = {
    tag: 'nymbal-site-footer',
    reactName: 'SiteFooter',
    attributes: [],
    events: [],
    parts: ['project-marker'],
    slots: [],
    children: false,
  }

  render() {
    return html`<p part="project-marker" data-testid="project-site-footer-marker">footer</p>`
  }
}

/** The project's server-side overrides, by tag. */
export const serverElements = {
  'nymbal-mini-cart': ProjectMiniCart,
  'nymbal-site-footer': ProjectSiteFooter,
}

if (typeof window !== 'undefined') {
  if (customElements.get('nymbal-mini-cart') === undefined) {
    customElements.define('nymbal-mini-cart', ProjectMiniCart)
  }
  if (customElements.get('nymbal-site-footer') === undefined) {
    customElements.define('nymbal-site-footer', ProjectSiteFooter)
  }
}
