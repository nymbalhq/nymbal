import { renderNymbal } from '@nymbalhq/react/server'
import {
  cardImageOf,
  cardProductOf,
  registerServerElements,
  renderElement,
} from '@nymbalhq/web-components/ssr'
import { serverElements } from '@/elements'

// Server components only: this loads Lit SSR. The store's own elements render on the server under their tags, as the
// browser defines them there.
registerServerElements(serverElements)

export { cardImageOf, cardProductOf, renderElement, renderNymbal }
