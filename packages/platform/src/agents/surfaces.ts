import type { NymbalConfig } from '@nymbalhq/config'
import type { AgentSurfaces, AgentSurfaceUrls, Caller } from '@nymbalhq/types'
import { createAcpSurface, type AcpSurfaceDeps } from './acp/surface.js'
import { llmsTxt, robotsTxt } from './documents.js'
import { createUcpSurface, searchCatalog, type UcpSurfaceDeps } from './ucp-surface.js'

export interface AgentSurfacesDeps {
  config: Pick<NymbalConfig, 'store' | 'agents'>
  mcp: UcpSurfaceDeps['mcp']
  variants: UcpSurfaceDeps['variants']
  cart: UcpSurfaceDeps['cart']
  /** What the ACP surface needs beside these, when `agents.acp` is on. */
  acp?: Omit<AcpSurfaceDeps, 'mcp' | 'cart' | 'variants' | 'urls' | 'store'>
}

/** Who reads the catalogue for a crawl file. */
const CRAWL: Caller = { agent: { name: 'nymbal-crawl-files' } }

/** The products `llms.txt` lists: the first page of the catalogue. */
const LLMS_PRODUCTS = 100

/**
 * The agent surfaces the config turns on (UCP, and ACP when it is given its dependencies) and the crawl files beside
 * them. The surfaces' tools take their
 * origins from whoever serves them (`useUrls`); until then links are made on the configured storefront, if any.
 */
export function createAgentSurfaces(deps: AgentSurfacesDeps): AgentSurfaces {
  const { config, mcp } = deps
  const { ucp, crawl } = config.agents
  let urls: () => AgentSurfaceUrls = () => ({ api: '', storefront: config.store.url })
  const surface = createUcpSurface({
    mcp,
    variants: deps.variants,
    cart: deps.cart,
    urls: () => urls(),
    links: ucp.links,
  })
  const acp =
    deps.acp === undefined
      ? undefined
      : createAcpSurface({
          ...deps.acp,
          mcp,
          cart: deps.cart,
          variants: deps.variants,
          urls: () => urls(),
          store: { currency: config.store.currency, name: config.store.name },
        })

  async function items<T>(tool: string, args: Record<string, unknown>): Promise<T[]> {
    const result = await mcp.call(tool, args, CRAWL)
    if (result.isError === true) {
      const { code } = (result.structuredContent ?? {}) as { code?: unknown }
      throw new Error(`${tool} refused the crawl file's read: ${String(code)}`)
    }
    return (result.structuredContent?.['items'] ?? []) as T[]
  }

  return {
    surfaces: [...(ucp.enabled ? [surface] : []), ...(acp === undefined ? [] : [acp])],
    useUrls(next) {
      urls = next
    },
    robots() {
      return robotsTxt(crawl)
    },
    async llms(at) {
      if (!crawl.llms) return null
      const [categories, products] = await Promise.all([
        items<{ slug: string; name: string }>('categories_list', {}),
        items<{ slug: string; name: string }>('products_list', { limit: String(LLMS_PRODUCTS) }),
      ])
      return llmsTxt({
        storeName: config.store.name,
        urls: at,
        ucp: ucp.enabled,
        feed: crawl.feed,
        categories,
        products,
      })
    },
    async feed(at, cursor) {
      if (!crawl.feed) return null
      const page = await searchCatalog(
        mcp,
        { pagination: { limit: 100, ...(cursor !== undefined && { cursor }) } },
        CRAWL,
        at,
      )
      return page.structuredContent ?? {}
    },
    async handoff(token) {
      return (await deps.cart(token)) !== null
    },
  }
}
