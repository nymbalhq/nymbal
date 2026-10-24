import { LitElement } from 'lit'

type WithRenderRoot = { createRenderRoot: () => HTMLElement | DocumentFragment }

// Lit SSR replaces LitElement's createRenderRoot when it loads, dropping the hydrate support's, which is what makes a
// client element take over a server's shadow root. A realm that both renders on the server and runs elements (a test,
// a DOM-shimmed server) keeps the one it had: this module is imported before Lit SSR, and the ssr entry restores it.
const prototype = LitElement.prototype as unknown as WithRenderRoot
const createRenderRoot = prototype.createRenderRoot

export function restoreCreateRenderRoot(): void {
  prototype.createRenderRoot = createRenderRoot
}
