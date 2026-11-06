import { createServer } from 'node:net'
import type { Caller, ToolSurface } from '@nymbalhq/types'
import { createHttpServer, mountAgentSurfaces, mountMcp } from '../../../http/src/index.js'
import type { Kernel } from './kernel.js'
import type { CookieJar } from './shopper.js'

// A kernel built from `src/` served as `nymbal dev` serves it: the routes (`attachHttp`), then `/api/mcp`, then the
// agent surfaces (the UCP profile and endpoint, the crawl files, the checkout handoff). Beside it, what an agent and
// the buyer it hands off to do: a UCP `create_checkout` as a named agent, and the buyer's browser opening the answer's
// `continue_url`. Nothing here knows how a cart records who opened it.

const HOST = '127.0.0.1'
export const STOREFRONT = 'http://localhost:4321'
const CART_COOKIE = 'nymbal.cart'

export interface AgentStore {
  kernel: Kernel
  baseUrl: string
  /** The UCP endpoint's tools, as `/api/ucp/mcp` serves them. */
  ucp: ToolSurface
  /** The route tools, as `/api/mcp` serves them. */
  mcp: ToolSurface
  /** Stops the server, then the kernel. */
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

export async function serveWithAgents(kernel: Kernel): Promise<AgentStore> {
  const port = await freePort()
  const baseUrl = `http://${HOST}:${port}`
  const config = { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } }
  const server = createHttpServer({
    config,
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
    network: kernel.app.network,
  })
  const verify = (token: string) => kernel.services.auth.verifyAccessToken(token)
  await kernel.app.attachHttp(server.adapter)
  await mountMcp(server, {
    app: kernel.app,
    verify,
    origins: config.http.cors.allowedOrigins,
    enabled: config.agents.mcp.enabled,
  })
  await mountAgentSurfaces(server, {
    app: kernel.app,
    verify,
    origins: config.http.cors.allowedOrigins,
    urls: () => ({ api: baseUrl, storefront: STOREFRONT }),
    version: '0.0.0',
  })
  await server.start()
  const ucp = kernel.app.agents?.surfaces.find((s) => s.name === 'ucp')?.endpoint?.tools
  const mcp = kernel.app.mcp
  if (ucp === undefined || mcp === undefined) {
    await server.stop()
    throw new Error('attachHttp built no UCP endpoint or no /api/mcp tool surface')
  }
  return {
    kernel,
    baseUrl,
    ucp,
    mcp,
    async stop() {
      try {
        await server.stop()
      } finally {
        await kernel.close()
      }
    },
  }
}

/** A caller as a transport hands it over for an agent with this name and no bearer. */
export function agentCaller(name: string): Caller {
  return { agent: { name } }
}

/** The cart a UCP `create_checkout` opened, and the URL it hands the buyer. */
export interface AgentCheckout {
  token: string
  continueUrl: string
}

/** `create_checkout` on the store's UCP tools for these variants, one unit each; throws on a refusal. */
export async function ucpCheckout(
  store: AgentStore,
  caller: Caller,
  variantIds: readonly string[],
  meta?: Record<string, unknown>,
): Promise<AgentCheckout> {
  const result = await store.ucp.call(
    'create_checkout',
    {
      ...(meta !== undefined && { meta }),
      checkout: { line_items: variantIds.map((id) => ({ item: { id }, quantity: 1 })) },
    },
    caller,
  )
  const payload = (result.structuredContent ?? {}) as { id?: unknown; continue_url?: unknown }
  if (
    result.isError === true ||
    typeof payload.id !== 'string' ||
    typeof payload.continue_url !== 'string'
  ) {
    throw new Error(`create_checkout refused: ${JSON.stringify(result.structuredContent)}`)
  }
  return { token: payload.id, continueUrl: payload.continue_url }
}

/**
 * The buyer's browser opening a handoff URL: no redirect followed, the cookies it sets kept in `jar`, as a browser
 * keeps them before it follows the 303.
 */
export async function openContinueUrl(
  url: string,
  jar: CookieJar,
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: jar.size > 0 ? { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') } : {},
  })
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';')
    const at = pair!.indexOf('=')
    if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim())
  }
  await res.arrayBuffer()
  return { status: res.status, location: res.headers.get('location') }
}

/** The browser's cart token, from its jar. */
export function cartTokenOf(jar: CookieJar): string {
  const token = jar.get(CART_COOKIE)
  if (token === undefined || token === '') throw new Error(`the jar holds no ${CART_COOKIE} cookie`)
  return token
}

/** The cart row's source as the cart repository reads it; undefined when there is no row. */
export async function storedCartSource(kernel: Kernel, token: string): Promise<string | undefined> {
  const cart = await kernel.store.read((tx) => kernel.repos.cart.findByToken(tx, token))
  return cart?.source
}
