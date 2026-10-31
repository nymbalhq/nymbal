// Two small packages for the namespace-import scan, as path -> source. A file whose name starts with `bad-` is one the
// scan must report; every other file must pass.

/** A package of elements: every module under `src` but its tests is client-side. */
export const ELEMENTS_TREE: Record<string, string> = {
  // Reads checkout across lines, with only the cart's module imported.
  'src/bad-reads-checkout.ts': `import '@nymbalhq/sdk/ns/cart'
import type { NymbalClient } from '@nymbalhq/sdk'

export class Summary {
  constructor(private readonly client: NymbalClient) {}
  total(): number {
    return this.client
      .checkout.getState().order === null
      ? this.client.cart.getState().subtotalMinor
      : 0
  }
}
`,
  // A value from the index, in an import spread over lines.
  'src/bad-index-value.ts': `import {
  type PaymentDriver,
  registerPaymentDriver,
} from '@nymbalhq/sdk'

export const own = (driver: PaymentDriver): void => registerPaymentDriver('own', driver)
`,
  // Every name is a type, but without \`import type\` the module is still loaded (verbatimModuleSyntax).
  'src/bad-type-names-only.ts': `import { type NymbalClient } from '@nymbalhq/sdk'

export const empty = (client: NymbalClient | null): boolean => client === null
`,
  // Destructured, and renamed, from this.client.
  'src/bad-destructured.ts': `export class Gallery {
  declare client: { product: { getState(): unknown } }
  shown(): unknown {
    const { product: current } = this.client
    return current.getState()
  }
}
`,
  // Reads search through getClient(), destructured; the module it imports imports ns/search.
  'src/ok-through-sibling.ts': `import { getClient } from './ok-registry.js'
import './ok-registers-search.js'

export function total(): number {
  const { search } = getClient()
  return search.getState().total
}
`,
  'src/ok-registers-search.ts': `import '@nymbalhq/sdk/ns/search'
`,
  'src/ok-registry.ts': `import type { NymbalClient } from '@nymbalhq/sdk'

export declare function getClient(): NymbalClient
`,
  // Types from the index, across lines, and a read through optional chaining with its module imported.
  'src/ok-type-only.ts': `import type {
  NymbalClient,
  AuthState,
} from '@nymbalhq/sdk'
import '@nymbalhq/sdk/ns/auth'

export const signedIn = (client: NymbalClient | undefined): AuthState | undefined => client?.auth.getState()
`,
  // Names that are not a client: a state's cart, an order's checkout.
  'src/ok-not-a-client.ts': `export function lines(state: { cart: { items: unknown[] } }, order: { checkout: string }): number {
  const { cart } = state
  return cart.items.length + order.checkout.length
}
`,
  // Tests are not shipped.
  'src/ok-ignored.test.ts': `declare const client: { checkout: unknown }
export const read = client.checkout
`,
}

/** An Astro template: the bundled `<script>` blocks of its `.astro` files, and the modules they reach, are client-side. */
export const ASTRO_TREE: Record<string, string> = {
  'src/lib/client.ts': `import { createNymbalClient } from '@nymbalhq/sdk/core'
import '@nymbalhq/sdk/ns/cart'

export const client = createNymbalClient({ baseUrl: '/' })
`,
  // The frontmatter runs on the server; the script reads the cart its client module registers.
  'src/pages/ok-cart.astro': `---
import { NymbalApiError } from '@nymbalhq/sdk'
const failed = Astro.props.error instanceof NymbalApiError
---
<p>{failed ? 'Try again' : 'Cart'}</p>
<script>
  import { client } from '../lib/client.js'
  client.cart.load()
</script>
`,
  // Reads auth, which nothing it imports registers.
  'src/pages/bad-account.astro': `---
---
<p>Account</p>
<script>
  import { client } from '../lib/client.js'

  client.auth.logout()
</script>
`,
  // Fine itself; the script module it reaches imports a value from the index.
  'src/pages/ok-order.astro': `<p>Order</p>
<script>
  import '../scripts/bad-order-access.js'
</script>
`,
  'src/scripts/bad-order-access.ts': `import { NymbalApiError } from '@nymbalhq/sdk'

export const expired = (error: unknown): boolean => error instanceof NymbalApiError
`,
  // A page script no page of the template imports: a store's own page may.
  'src/scripts/bad-unreferenced.ts': `import { client } from '../lib/client.js'

export const query = (): string => client.search.getState().query
`,
  // Server-only: no script reaches it.
  'src/lib/ok-server-only.ts': `import { createNymbalClient } from '@nymbalhq/sdk'

export const server = createNymbalClient({ baseUrl: 'http://localhost:3001' })
`,
  // Not bundled.
  'src/pages/ok-inline.astro': `<script is:inline>
  client.checkout.reset()
</script>
`,
}
