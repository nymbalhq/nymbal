import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import robotsParser from 'robots-parser'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEFAULT_AGENT_CRAWLERS, type NymbalConfig } from '@nymbalhq/config'
import type { AgentSurfaceAdapter, AgentSurfaceUrls } from '@nymbalhq/types'
import { validateUcp } from '../../../tests/fixtures/ucp/validate.js'
import { createHttpServer } from './server.js'
import { mountMcp } from './mcp-route.js'
import { FEED_PATH, HANDOFF_PATH, UCP_MCP_PATH, mountAgentSurfaces } from './agent-surface.js'
import { ucpProfile } from '../../platform/src/agents/profile.js'
import { createKernel, type Kernel } from '../../platform/tests/support/kernel.js'
import { ANONYMOUS, AGENT } from '../../platform/tests/support/mcp.js'
import { unaudited } from '../../platform/tests/support/write-audit.js'

// AC-8 to AC-10: the agent surfaces over HTTP, mounted as `nymbal dev` mounts them (after `attachHttp` and `mountMcp`)
// on a kernel built from source. The storefront origin is read per request, as under `nymbal dev`, so one store
// answers with it and without it.

const HOST = '127.0.0.1'
const STOREFRONT = 'http://localhost:4321'
const ALLOWED_ORIGIN = 'http://localhost:4321'
const UCP_TOOLS = [
  'create_checkout',
  'get_checkout',
  'get_product',
  'lookup_catalog',
  'search_catalog',
]
const CACHE = 'public, max-age=300'

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

interface Served {
  kernel: Kernel
  base: string
  /** What the store takes as its origins; `storefront` may be changed between requests. */
  urls: AgentSurfaceUrls
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function served(configure?: (config: NymbalConfig) => NymbalConfig): Promise<Served> {
  const kernel = await createKernel({
    dialect: 'sqlite',
    ...(configure !== undefined && { configure }),
  })
  cleanups.push(() => kernel.close())
  const port = await freePort()
  const base = `http://${HOST}:${port}`
  const config = { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } }
  const server = createHttpServer({
    config,
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
    network: kernel.app.network,
  })
  const urls: AgentSurfaceUrls = { api: base, storefront: STOREFRONT }
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
    urls: () => ({ ...urls }),
    version: '0.0.0',
  })
  await server.start()
  cleanups.push(() => server.stop())
  return { kernel, base, urls }
}

function withAgents(
  change: (agents: NymbalConfig['agents']) => NymbalConfig['agents'],
): (config: NymbalConfig) => NymbalConfig {
  return (config) => ({ ...config, agents: change(config.agents) })
}

/** A GET with no cookie, no CSRF header and no redirect followed. */
async function get(
  store: Served,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string; setCookies: string[] }> {
  const res = await fetch(`${store.base}${path}`, { redirect: 'manual', headers })
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
    setCookies: res.headers.getSetCookie(),
  }
}

/** A raw GET whose Host header the test sets, which fetch does not allow. */
function rawGet(store: Served, path: string, headers: Record<string, string>): Promise<string> {
  const { port } = new URL(store.base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: HOST, port: Number(port), path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** A cookie's attributes, by lower-cased name; flags are `true`. */
function cookieAttributes(header: string): {
  name: string
  value: string
  attributes: Record<string, string | true>
} {
  const [pair, ...rest] = header.split(';').map((part) => part.trim())
  const at = pair!.indexOf('=')
  const attributes: Record<string, string | true> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq < 0) attributes[part.toLowerCase()] = true
    else attributes[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1).toLowerCase()
  }
  return { name: pair!.slice(0, at), value: pair!.slice(at + 1), attributes }
}

const COMPARED = ['path', 'httponly', 'samesite', 'secure', 'max-age']
const pick = (attributes: Record<string, string | true>) =>
  Object.fromEntries(COMPARED.map((key) => [key, attributes[key] ?? null]))

/** A new cart through `GET /api/cart` with no cookie: its token and the cookie the route set for it. */
async function newCart(store: Served): Promise<{ token: string; cookie: string }> {
  const res = await get(store, '/api/cart')
  const token = (JSON.parse(res.text) as { data: { token: string } }).data.token
  const cookie = res.setCookies.find((c) => c.startsWith('nymbal.cart='))
  if (cookie === undefined) throw new Error('GET /api/cart set no nymbal.cart cookie')
  return { token, cookie }
}

/** One active product of `variants` in-stock variants. */
async function seedProduct(
  kernel: Kernel,
  name: string,
  variants = 1,
): Promise<{ slug: string; variantIds: string[] }> {
  const slug = `agents-${randomUUID()}`
  const product = await kernel.services.product.create({
    slug,
    name,
    description: '',
    status: 'active',
    variants: Array.from({ length: variants }, (_, i) => ({
      sku: `AGT-${randomUUID()}`,
      name: `Option ${i + 1}`,
      priceMinor: 1000 + i,
      stock: 50,
      lowStockThreshold: 0,
      options: [],
    })),
  })
  return { slug, variantIds: product.variants.map((v) => v.id) }
}

interface RouteProduct {
  slug: string
  priceRange: unknown
}

async function listedSlugs(store: Served): Promise<string[]> {
  const slugs: string[] = []
  let cursor: string | null | undefined
  do {
    const res = await get(
      store,
      `/api/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    const page = (
      JSON.parse(res.text) as { data: { items: RouteProduct[]; nextCursor: string | null } }
    ).data
    slugs.push(...page.items.filter((p) => p.priceRange !== null).map((p) => p.slug))
    cursor = page.nextCursor
  } while (cursor)
  return slugs
}

async function waitListed(store: Served, slugs: string[]): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await get(store, '/api/products?limit=100')
      const page = JSON.parse(res.text) as { data: { items: RouteProduct[] } }
      const all = new Set(page.data.items.map((p) => p.slug))
      let cursor = (page.data as { nextCursor?: string | null }).nextCursor
      while (cursor) {
        const next = JSON.parse(
          (await get(store, `/api/products?limit=100&cursor=${encodeURIComponent(cursor)}`)).text,
        ) as { data: { items: RouteProduct[]; nextCursor: string | null } }
        for (const p of next.data.items) all.add(p.slug)
        cursor = next.data.nextCursor
      }
      const missing = slugs.filter((slug) => !all.has(slug))
      if (missing.length > 0) throw new Error(`${missing.length} not listed yet`)
    },
    { timeout: 20_000, interval: 100 },
  )
}

/** Markdown link targets of a document, resolved against `base`. */
function linkTargets(markdown: string, base: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => new URL(m[1]!, base).href)
}

describe('AC-8: GET /api/agents/checkout/:token hands a cart to the browser', () => {
  it('AC-8: for a live cart it answers 303 to <storefront>/checkout with a nymbal.cart cookie for that token whose path, HttpOnly, SameSite, Secure and Max-Age are those GET /api/cart sets on a new cart, with no CSRF token sent', async () => {
    const store = await served()
    const cart = await newCart(store)

    const res = await get(store, HANDOFF_PATH.replace(':token', cart.token))
    const handed = res.setCookies.map(cookieAttributes)
    const own = cookieAttributes(cart.cookie)

    expect(HANDOFF_PATH).toBe('/api/agents/checkout/:token')
    expect([res.status, res.headers.get('location')]).toEqual([303, `${STOREFRONT}/checkout`])
    expect(handed.map((c) => [c.name, c.value])).toEqual([['nymbal.cart', cart.token]])
    expect(pick(handed[0]!.attributes)).toEqual(pick(own.attributes))
  })

  it('AC-8: an unknown or an expired cart id answers 303 to <storefront>/cart and sets no cookie', async () => {
    const store = await served()
    const lapsed = await store.kernel.services.cart.getOrCreate()
    await unaudited(() =>
      store.kernel.store.transaction((tx) =>
        store.kernel.repos.cart.put(tx, {
          ...lapsed,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    )

    for (const token of [randomUUID(), lapsed.token]) {
      const res = await get(store, `/api/agents/checkout/${token}`)

      expect([res.status, res.headers.get('location')], token).toEqual([303, `${STOREFRONT}/cart`])
      expect(res.setCookies, token).toEqual([])
    }
  })

  it('AC-8: with no storefront origin known the Location is the relative path, for a live cart and an unknown one alike', async () => {
    const store = await served()
    const cart = await newCart(store)
    store.urls.storefront = undefined

    const live = await get(store, `/api/agents/checkout/${cart.token}`)
    const unknown = await get(store, `/api/agents/checkout/${randomUUID()}`)

    expect([live.status, live.headers.get('location')]).toEqual([303, '/checkout'])
    expect([unknown.status, unknown.headers.get('location')]).toEqual([303, '/cart'])
    expect(live.setCookies.map((c) => cookieAttributes(c).value)).toEqual([cart.token])
  })

  it('AC-8: once a customer signs in and claims the handed-off cart, get_checkout answers not_found and the handoff answers 303 to <storefront>/cart with no cookie, where before the claim both answered the cart', async () => {
    const store = await served()
    const product = await seedProduct(store.kernel, 'Claimed Lamp')
    const tool = (name: string, args: unknown) =>
      rpc(store, UCP_MCP_PATH, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args },
      })
    const created = await tool('create_checkout', {
      checkout: { line_items: [{ item: { id: product.variantIds[0]! }, quantity: 1 }] },
    })
    const token = (created.message?.result?.['structuredContent'] as { id: string }).id
    const read = async () => {
      const checkout = await tool('get_checkout', { id: token })
      const handoff = await get(store, `/api/agents/checkout/${token}`)
      const result = checkout.message?.result ?? {}
      const content = result['structuredContent'] as
        | { messages?: Array<{ code: string }> }
        | undefined
      return {
        isError: result['isError'] ?? false,
        notFound: (content?.messages ?? []).some((m) => m.code === 'not_found'),
        location: handoff.headers.get('location'),
        cookies: handoff.setCookies.map((c) => cookieAttributes(c).value),
      }
    }

    const before = await read()
    const { customer } = await store.kernel.services.auth.register({
      email: `claimer-${randomUUID()}@agents.test`,
      password: 'correct-horse-battery',
    })
    const claimed = await store.kernel.services.cart.signIn(token, customer.id)
    const after = await read()

    expect([claimed?.token, claimed?.customerId]).toEqual([token, customer.id])
    expect(before).toEqual({
      isError: false,
      notFound: false,
      location: `${STOREFRONT}/checkout`,
      cookies: [token],
    })
    expect(after).toEqual({
      isError: true,
      notFound: true,
      location: `${STOREFRONT}/cart`,
      cookies: [],
    })
  }, 30_000)
})

describe('AC-9: the profile and the crawl files over HTTP', () => {
  it('AC-9: /.well-known/ucp answers 200 JSON equal to ucpProfile of the configured origins, byte-identical whatever Host or X-Forwarded-Host the request sends, cached public for 300 s', async () => {
    const store = await served()

    const res = await get(store, '/.well-known/ucp')
    const bodies = await Promise.all(
      [
        { host: 'evil.example' },
        { host: 'localhost:9999' },
        {
          host: 'shop.example',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'https',
        },
      ].map((headers) => rawGet(store, '/.well-known/ucp', headers)),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toMatch(/^application\/json\b/)
    expect(res.headers.get('cache-control')).toBe(CACHE)
    expect(JSON.parse(res.text)).toEqual(ucpProfile({ api: store.base, storefront: STOREFRONT }))
    expect(bodies).toEqual(bodies.map(() => res.text))
  })

  it('AC-9: /robots.txt allows every named AI crawler and everyone else the catalogue and the feed, and keeps all of them out of /api/, /checkout, /cart, /account, /order/, /alerts/ and /admin', async () => {
    const store = await served()
    const res = await get(store, '/robots.txt')
    const robots = robotsParser(`${store.base}/robots.txt`, res.text)
    const agents = [...DEFAULT_AGENT_CRAWLERS, 'ExampleCrawler']
    const at = (path: string) => `${store.base}${path}`
    const allowed = ['/product/x', '/agents/products.json']
    const kept = [
      '/api/products',
      '/checkout',
      '/cart',
      '/account',
      '/order/1',
      '/alerts/x',
      '/admin',
    ]

    expect([res.status, res.headers.get('cache-control')]).toEqual([200, CACHE])
    expect(DEFAULT_AGENT_CRAWLERS.length).toBeGreaterThan(0)
    for (const agent of agents) {
      expect(
        allowed.map((path) => robots.isAllowed(at(path), agent)),
        agent,
      ).toEqual(allowed.map(() => true))
      expect(
        kept.map((path) => robots.isDisallowed(at(path), agent)),
        agent,
      ).toEqual(kept.map(() => true))
    }
  })

  it("AC-9: under others: 'disallow' everyone else is kept out of / while every named crawler may still read the catalogue", async () => {
    const store = await served(
      withAgents((agents) => ({ ...agents, crawl: { ...agents.crawl, others: 'disallow' } })),
    )
    const res = await get(store, '/robots.txt')
    const robots = robotsParser(`${store.base}/robots.txt`, res.text)

    expect(robots.isDisallowed(`${store.base}/`, 'ExampleCrawler')).toBe(true)
    expect(
      DEFAULT_AGENT_CRAWLERS.map((agent: string) =>
        robots.isAllowed(`${store.base}/product/x`, agent),
      ),
    ).toEqual(DEFAULT_AGENT_CRAWLERS.map(() => true))
    expect(robots.isDisallowed(`${store.base}/checkout`, DEFAULT_AGENT_CRAWLERS[0])).toBe(true)
  })

  it("AC-9: /llms.txt starts with '# <store name>' and links the profile, the feed and every category at the storefront", async () => {
    const store = await served()
    const categories = await Promise.all(
      ['Lamps', 'Rugs'].map((name) =>
        store.kernel.services.category.create({ slug: `cat-${randomUUID()}`, name }),
      ),
    )
    await vi.waitFor(
      async () => {
        const listed = JSON.parse((await get(store, '/api/categories')).text) as {
          data: Array<{ slug: string }>
        }
        const slugs = listed.data.map((c) => c.slug)
        if (!categories.every((c) => slugs.includes(c.slug)))
          throw new Error('categories not listed yet')
      },
      { timeout: 10_000, interval: 50 },
    )

    const res = await get(store, '/llms.txt')
    const targets = linkTargets(res.text, store.base)

    expect([res.status, res.headers.get('cache-control')]).toEqual([200, CACHE])
    expect(res.text.split('\n')[0]).toBe(`# ${store.kernel.config.store.name}`)
    expect(targets).toEqual(
      expect.arrayContaining([
        `${store.base}/.well-known/ucp`,
        `${store.base}${FEED_PATH}`,
        ...categories.map((c) => `${STOREFRONT}/category/${c.slug}`),
      ]),
    )
  })

  it('AC-9: /agents/products.json validates as a UCP search response, its first page is search_catalog with no query, and its cursor pages visit every listed product with a price range once and the one without never', async () => {
    const store = await served()
    const seeded = [] as string[]
    for (let i = 0; i < 103; i += 1)
      seeded.push((await seedProduct(store.kernel, `Feed Lamp ${i}`)).slug)
    const unpriced = `agents-${randomUUID()}`
    await store.kernel.services.product.create({
      slug: unpriced,
      name: 'Feed Lamp Unpriced',
      description: '',
      status: 'active',
      variants: [],
    })
    await waitListed(store, [...seeded, unpriced])
    const listed = await listedSlugs(store)

    const seen: string[] = []
    const pages: unknown[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const res = await get(
        store,
        `${FEED_PATH}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      )
      expect([res.status, res.headers.get('cache-control')]).toEqual([200, CACHE])
      const body = JSON.parse(res.text) as {
        products: Array<{ id: string }>
        pagination?: { has_next_page: boolean; cursor?: string }
      }
      pages.push(body)
      seen.push(...body.products.map((p) => p.id))
      if (body.pagination?.has_next_page !== true) break
      cursor = body.pagination.cursor
    }
    const ucp = store.kernel.app.agents?.surfaces.find((s: AgentSurfaceAdapter) => s.name === 'ucp')
      ?.endpoint?.tools
    const search = await ucp?.call(
      'search_catalog',
      { catalog: { pagination: { limit: 100 } } },
      ANONYMOUS,
    )

    expect(FEED_PATH).toBe('/agents/products.json')
    expect(
      pages.map((page) => validateUcp('shopping/catalog_search.json#/$defs/search_response', page)),
    ).toEqual(pages.map(() => []))
    expect(pages.length).toBeGreaterThan(1)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort()).toEqual([...listed].sort())
    expect(seen).not.toContain(unpriced)
    expect((pages[0] as { products: unknown[] }).products).toEqual(
      (search?.structuredContent as { products?: unknown[] } | undefined)?.products,
    )
  }, 60_000)

  it('AC-9: with robots, llms and feed off each of their paths answers 404 while the profile still answers', async () => {
    const store = await served(
      withAgents((agents) => ({
        ...agents,
        crawl: { ...agents.crawl, robots: false, llms: false, feed: false },
      })),
    )

    const statuses = await Promise.all(
      ['/robots.txt', '/llms.txt', FEED_PATH, '/.well-known/ucp'].map(
        async (path) => [path, (await get(store, path)).status] as const,
      ),
    )

    expect(Object.fromEntries(statuses)).toEqual({
      '/robots.txt': 404,
      '/llms.txt': 404,
      [FEED_PATH]: 404,
      '/.well-known/ucp': 200,
    })
  })

  it('AC-9: with ucp.enabled false the profile and POST /api/ucp/mcp answer 404, and /llms.txt still links the feed but not the profile', async () => {
    const store = await served(
      withAgents((agents) => ({ ...agents, ucp: { ...agents.ucp, enabled: false } })),
    )

    const profile = await get(store, '/.well-known/ucp')
    const mcp = await rpc(store, UCP_MCP_PATH, INITIALIZE)
    const llms = await get(store, '/llms.txt')
    const targets = linkTargets(llms.text, store.base)

    expect([profile.status, mcp.status, llms.status]).toEqual([404, 404, 200])
    expect(targets).toContain(`${store.base}${FEED_PATH}`)
    expect(targets.filter((t) => t.endsWith('/.well-known/ucp'))).toEqual([])
  })
})

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: AGENT.name, version: AGENT.version },
  },
}

/** One raw JSON-RPC POST; its status and the JSON-RPC message it answered, from JSON or an SSE stream. */
async function rpc(
  store: Served,
  path: string,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; message: { result?: Record<string, unknown> } | undefined }> {
  const res = await fetch(`${store.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(message),
  })
  const text = await res.text()
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
  const json = data.length > 0 ? data[data.length - 1]! : text
  let parsed: { result?: Record<string, unknown> } | undefined
  try {
    parsed = JSON.parse(json) as { result?: Record<string, unknown> }
  } catch {
    parsed = undefined
  }
  return { status: res.status, message: parsed }
}

describe('AC-10: POST /api/ucp/mcp on the MCP transport', () => {
  it('AC-10: an SDK client over Streamable HTTP lists the five UCP tools and runs search_catalog, whose products are the listed products', async () => {
    const store = await served()
    const product = await seedProduct(store.kernel, 'Transport Lamp', 2)
    await waitListed(store, [product.slug])
    const client = new Client({ name: AGENT.name, version: AGENT.version })
    await client.connect(new StreamableHTTPClientTransport(new URL(UCP_MCP_PATH, store.base)))
    cleanups.push(() => client.close())

    const { tools } = await client.listTools()
    const result = await client.callTool({
      name: 'search_catalog',
      arguments: { catalog: { pagination: { limit: 100 } } },
    })
    const products = (result.structuredContent as { products?: Array<{ id: string }> } | undefined)
      ?.products

    expect(UCP_MCP_PATH).toBe('/api/ucp/mcp')
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(UCP_TOOLS)
    expect(result.isError ?? false).toBe(false)
    expect((products ?? []).map((p) => p.id)).toEqual(await listedSlugs(store))
  }, 30_000)

  it('AC-10: an Origin outside the allowed set answers 403 and a bearer that does not verify 401, as /api/mcp answers them, where an allowed Origin answers 200', async () => {
    const store = await served()
    const statuses = async (path: string) => ({
      foreign: (await rpc(store, path, INITIALIZE, { origin: 'https://evil.example' })).status,
      forged: (await rpc(store, path, INITIALIZE, { authorization: 'Bearer not.a.token' })).status,
      allowed: (await rpc(store, path, INITIALIZE, { origin: ALLOWED_ORIGIN })).status,
    })

    const ucp = await statuses(UCP_MCP_PATH)
    const mcp = await statuses('/api/mcp')

    expect(store.kernel.config.http.cors.allowedOrigins).toContain(ALLOWED_ORIGIN)
    expect(ucp).toEqual({ foreign: 403, forged: 401, allowed: 200 })
    expect(ucp).toEqual(mcp)
  }, 30_000)

  it('AC-10: with /api/ucp/mcp held at 2 a minute, a create_checkout of three lines counts once: the request after it answers 200 and the third request 429', async () => {
    const store = await served((config) => ({
      ...config,
      security: {
        ...config.security,
        rateLimit: {
          ...config.security.rateLimit,
          '/api/ucp/mcp': { requests: 2, window: '1m', action: 'block' },
        },
      },
    }))
    const product = await seedProduct(store.kernel, 'Rate Lamp', 3)

    const created = await rpc(store, UCP_MCP_PATH, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_checkout',
        arguments: {
          checkout: {
            line_items: product.variantIds.map((id) => ({ item: { id }, quantity: 1 })),
          },
        },
      },
    })
    const second = await rpc(store, UCP_MCP_PATH, INITIALIZE)
    const third = await rpc(store, UCP_MCP_PATH, INITIALIZE)
    const checkout = created.message?.result?.['structuredContent'] as
      | { status?: string; line_items?: unknown[] }
      | undefined

    expect([created.status, created.message?.result?.['isError'] ?? false]).toEqual([200, false])
    expect([checkout?.status, checkout?.line_items?.length]).toEqual([
      'requires_escalation',
      product.variantIds.length,
    ])
    expect([second.status, third.status]).toEqual([200, 429])
  }, 30_000)
})
