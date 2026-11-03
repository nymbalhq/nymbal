import type { ToolSurface } from './adapters/http.js'

/** The origins a surface builds its absolute URLs from: never the request's `Host`. */
export interface AgentSurfaceUrls {
  /** The API's origin: the profile, the MCP endpoint and the handoff link live there. */
  api: string
  /** The storefront's origin, when one is known; product and category links are made on it. */
  storefront: string | undefined
}

/** What an agent can do through a surface; part of the operator's view of it. */
export interface AgentSurfaceCapabilities {
  search: boolean
  lookup: boolean
  /** `handoff`: the agent opens a checkout and the buyer pays on the store's page; `agentic`: the agent pays. */
  checkout: 'handoff' | 'agentic' | 'none'
}

/** One agent protocol a store serves (UCP, ACP): a discovery document and a tool endpoint, either optional. */
export interface AgentSurfaceAdapter {
  name: string
  capabilities: AgentSurfaceCapabilities
  wellKnown?: {
    path: string
    document(urls: AgentSurfaceUrls): Record<string, unknown>
  }
  endpoint?: {
    path: string
    tools: ToolSurface
  }
}

/** The agent surfaces a store serves and the crawl files beside them; built by `attachHttp`. */
export interface AgentSurfaces {
  surfaces: AgentSurfaceAdapter[]
  /** Where the surfaces' tools take their origins from; the mount that serves them sets it. */
  useUrls(urls: () => AgentSurfaceUrls): void
  /** `robots.txt`, or null when it is off. */
  robots(urls: AgentSurfaceUrls): string | null
  /** `llms.txt`, or null when it is off. */
  llms(urls: AgentSurfaceUrls): Promise<string | null>
  /** One page of the product feed, or null when it is off. */
  feed(urls: AgentSurfaceUrls, cursor?: string): Promise<Record<string, unknown> | null>
  /** Whether `token` names a live cart a browser may be handed. */
  handoff(token: string): Promise<boolean>
}
