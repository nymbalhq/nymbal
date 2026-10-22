import { renderNymbal } from '@nymbalhq/react/server'
import { registerServerElements } from '@nymbalhq/web-components/ssr'
import { serverElements } from '@/elements'

// Server components only: this loads Lit SSR. The store's own elements render on the server under their tags, as the
// browser defines them there.
registerServerElements(serverElements)

export { renderNymbal }
