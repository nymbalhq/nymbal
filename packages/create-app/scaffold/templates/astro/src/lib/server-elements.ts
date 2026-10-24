import { registerServerElements } from '@nymbalhq/web-components/ssr'
import { serverElements } from '../elements/index.js'

// The store's own elements render on the server under their tags, as the browser defines them there.
registerServerElements(serverElements)
