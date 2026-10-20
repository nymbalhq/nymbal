import {
  DEFAULT_PRODUCT_SORT,
  PRODUCT_SORT_KEYS,
  type HttpAdapter,
  type PaymentsAdapter,
  type SearchAdapter,
  type StoreCapabilities,
} from '@nymbalhq/types'
import { ok, renderError } from './envelope.js'

/**
 * What a storefront needs to decide what to render, from the adapters' own answers. It is public, so it carries no
 * provider name and nothing from an adapter's config but the payments client half, whose options are public values.
 */
function storeCapabilities(adapters: {
  payments: PaymentsAdapter
  search: SearchAdapter
}): StoreCapabilities {
  const client = adapters.payments.client?.() ?? null
  return {
    payments: {
      capabilities: [...adapters.payments.capabilities()],
      client: client === null ? null : { driver: client.driver, options: { ...client.options } },
    },
    search: { capabilities: [...adapters.search.capabilities()] },
    // The document store runs the listing's sort, so these are the catalogue's keys, not the search adapter's.
    catalog: { sortKeys: [...PRODUCT_SORT_KEYS], defaultSort: DEFAULT_PRODUCT_SORT },
  }
}

export function registerCapabilitiesRoute(
  adapter: HttpAdapter,
  adapters: { payments: PaymentsAdapter; search: SearchAdapter },
): void {
  adapter.registerRoute('GET', '/api/capabilities', async () => {
    try {
      return ok(storeCapabilities(adapters))
    } catch (err) {
      return renderError(err)
    }
  })
}
