import type { AgentSurfaceUrls } from '@nymbalhq/types'

/** The Universal Commerce Protocol release this store speaks. */
export const UCP_VERSION = '2026-08-25'

const UCP_SITE = `https://ucp.dev/${UCP_VERSION}`

export const UCP_PROFILE_PATH = '/.well-known/ucp'
export const UCP_ENDPOINT_PATH = '/api/ucp/mcp'
export const UCP_SHOPPING = 'dev.ucp.shopping'

export const UCP_CAPABILITY = {
  search: 'dev.ucp.shopping.catalog.search',
  lookup: 'dev.ucp.shopping.catalog.lookup',
  checkout: 'dev.ucp.shopping.checkout',
} as const

export type UcpCapability = (typeof UCP_CAPABILITY)[keyof typeof UCP_CAPABILITY]

const CAPABILITY_DOCS: Record<UcpCapability, { spec: string; schema: string }> = {
  [UCP_CAPABILITY.search]: {
    spec: `${UCP_SITE}/specification/shopping/catalog/search/`,
    schema: `${UCP_SITE}/schemas/shopping/catalog_search.json`,
  },
  [UCP_CAPABILITY.lookup]: {
    spec: `${UCP_SITE}/specification/shopping/catalog/lookup/`,
    schema: `${UCP_SITE}/schemas/shopping/catalog_lookup.json`,
  },
  [UCP_CAPABILITY.checkout]: {
    spec: `${UCP_SITE}/specification/shopping/checkout/`,
    schema: `${UCP_SITE}/schemas/shopping/checkout.json`,
  },
}

/**
 * The business profile served at `/.well-known/ucp`: one shopping service over MCP and the catalogue and checkout
 * capabilities. Payment happens on the store's own checkout page, so it names no payment handler. Every URL is built
 * from the configured origins, so no request header can change a cached copy.
 */
export function ucpProfile(urls: AgentSurfaceUrls): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP_SHOPPING]: [
          {
            version: UCP_VERSION,
            spec: `${UCP_SITE}/specification/overview/`,
            transport: 'mcp',
            schema: `${UCP_SITE}/services/shopping/mcp.openrpc.json`,
            endpoint: `${urls.api}${UCP_ENDPOINT_PATH}`,
          },
        ],
      },
      capabilities: Object.fromEntries(
        Object.entries(CAPABILITY_DOCS).map(([name, docs]) => [
          name,
          [{ version: UCP_VERSION, ...docs }],
        ]),
      ),
      payment_handlers: {},
    },
  }
}
