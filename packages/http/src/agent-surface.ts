import type {
  AgentSurfaces,
  AgentSurfaceUrls,
  ResponseCookie,
  ResponseEnvelope,
} from '@nymbalhq/types'
import { mountToolEndpoint, type MountMcpDeps } from './mcp-route.js'
import type { HttpServer } from './server.js'

export const UCP_MCP_PATH = '/api/ucp/mcp'
export const HANDOFF_PATH = '/api/agents/checkout/:token'
export const FEED_PATH = '/agents/products.json'

const CART_COOKIE = 'nymbal.cart'
/** Crawl files and the profile change with the catalogue, not per shopper. */
const CACHE = { 'cache-control': 'public, max-age=300' }
const TEXT = { ...CACHE, 'content-type': 'text/plain; charset=utf-8' }

export interface MountAgentSurfacesDeps {
  /** The app `attachHttp` ran on: its agent surfaces. */
  app: { readonly agents: AgentSurfaces | undefined }
  verify: MountMcpDeps['verify']
  /** The origins CORS allows: an MCP request from any other is refused. */
  origins: readonly string[]
  /** The API's and the storefront's origins, read per request (`nymbal dev` picks the storefront's port late). */
  urls: () => AgentSurfaceUrls
  version?: string
}

const notFound: ResponseEnvelope = {
  status: 404,
  body: { error: { code: 'not_found', message: 'This store does not serve this file' } },
}

/** The cookie `GET /api/cart` sets on a new cart, so the storefront reads the handed cart as its own. */
function cartCookie(token: string): ResponseCookie {
  return {
    name: CART_COOKIE,
    value: token,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
  }
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Each agent surface's discovery document, MCP endpoint and REST routes, the crawl files (`/robots.txt`, `/llms.txt`,
 * the product feed) and the checkout handoff. Mounted after `attachHttp` and `mountMcp`, outside the route registry:
 * none of these is an agent tool.
 */
export async function mountAgentSurfaces(
  server: HttpServer,
  deps: MountAgentSurfacesDeps,
): Promise<void> {
  const agents = deps.app.agents
  if (agents === undefined) {
    throw new Error(
      'mountAgentSurfaces needs the agent surfaces attachHttp builds: call attachHttp first',
    )
  }
  const { adapter } = server
  agents.useUrls(deps.urls)

  for (const surface of agents.surfaces) {
    const { wellKnown, endpoint, routes = [] } = surface
    if (wellKnown !== undefined) {
      adapter.registerRoute('GET', wellKnown.path, async () => ({
        status: 200,
        headers: CACHE,
        body: wellKnown.document(deps.urls()),
      }))
    }
    if (endpoint !== undefined) {
      await mountToolEndpoint(server, {
        path: endpoint.path,
        surface: endpoint.tools,
        verify: deps.verify,
        origins: deps.origins,
        admitTools: false,
        ...(deps.version !== undefined && { version: deps.version }),
      })
    }
    // Server to server under the surface's own bearer, with no cookie to ride on: no CSRF token, as for a webhook.
    for (const route of routes) {
      adapter.registerRoute(
        route.method,
        route.path,
        (ctx) =>
          route.handle({
            params: ctx.params,
            query: ctx.query,
            headers: ctx.headers,
            body: ctx.body,
            ip: ctx.ip,
            requestId: ctx.requestId,
          }),
        { csrf: false },
      )
    }
  }

  adapter.registerRoute('GET', '/robots.txt', async () => {
    const body = agents.robots(deps.urls())
    return body === null ? notFound : { status: 200, headers: TEXT, body }
  })
  adapter.registerRoute('GET', '/llms.txt', async () => {
    const body = await agents.llms(deps.urls())
    return body === null ? notFound : { status: 200, headers: TEXT, body }
  })
  adapter.registerRoute('GET', FEED_PATH, async (ctx) => {
    const page = await agents.feed(deps.urls(), queryValue(ctx.query.cursor))
    if (page === null) return notFound
    const failed = (page['ucp'] as { status?: unknown } | undefined)?.status === 'error'
    return failed ? { status: 400, body: page } : { status: 200, headers: CACHE, body: page }
  })

  // A GET that changes nothing but the browser's cart cookie, so it takes no CSRF token.
  adapter.registerRoute('GET', HANDOFF_PATH, async (ctx) => {
    const token = ctx.params.token ?? ''
    const live = token !== '' && (await agents.handoff(token))
    const storefront = deps.urls().storefront ?? ''
    return {
      status: 303,
      headers: { location: `${storefront}${live ? '/checkout' : '/cart'}` },
      ...(live && { cookies: [cartCookie(token)] }),
    }
  })
}
