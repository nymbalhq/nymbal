import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { NymbalConfig } from '@nymbalhq/config'
import { createHttpServer } from './server.js'
import { mountMcp } from './mcp-route.js'
import {
  address,
  cartWith,
  createKernel,
  seedVariant,
  type Kernel,
} from '../../platform/tests/support/kernel.js'
import {
  AGENT,
  ANONYMOUS,
  adminAccount,
  listedNames,
  toolSurface,
} from '../../platform/tests/support/mcp.js'

// AC-9, AC-13 and AC-6 (customer fields withheld from an admin's client): `POST /api/mcp` over HTTP, mounted beside the routes `attachHttp` registers on a kernel built from
// source. Raw requests where only the status matters (an `initialize`, which any MCP server answers); the SDK client
// where the protocol does.

const HOST = '127.0.0.1'
const ALLOWED_ORIGIN = 'http://localhost:4321'

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
  endpoint: URL
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

/** A kernel served over HTTP with the MCP endpoint mounted as `nymbal dev` mounts it, after `attachHttp`. */
async function served(configure?: (config: NymbalConfig) => NymbalConfig): Promise<Served> {
  const kernel = await createKernel({
    dialect: 'sqlite',
    ...(configure !== undefined && { configure }),
  })
  cleanups.push(() => kernel.close())
  const port = await freePort()
  const config = { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } }
  const server = createHttpServer({
    config,
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
    network: kernel.app.network,
  })
  await kernel.app.attachHttp(server.adapter)
  await mountMcp(server, {
    app: kernel.app,
    verify: (token: string) => kernel.services.auth.verifyAccessToken(token),
    origins: config.http.cors.allowedOrigins,
    enabled: config.agents.mcp.enabled,
  })
  await server.start()
  cleanups.push(() => server.stop())
  const base = `http://${HOST}:${port}`
  return { kernel, base, endpoint: new URL('/api/mcp', base) }
}

function withRateRule(
  pattern: string,
  rule: { requests: number; window: string; action: 'block' } | undefined,
): (config: NymbalConfig) => NymbalConfig {
  return (config) => {
    const rateLimit = { ...config.security.rateLimit }
    if (rule === undefined) delete rateLimit[pattern]
    else rateLimit[pattern] = rule
    return { ...config, security: { ...config.security, rateLimit } }
  }
}

/** One raw `initialize` POST; its status and WWW-Authenticate. */
async function initialize(
  store: Served,
  headers: Record<string, string> = {},
): Promise<{ status: number; challenge: string | null }> {
  const res = await fetch(store.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(INITIALIZE),
  })
  await res.arrayBuffer()
  return { status: res.status, challenge: res.headers.get('www-authenticate') }
}

interface Exchange {
  method: string
  status: number
}

/** An SDK client on the endpoint, with a bearer or none; every POST it makes is recorded with its JSON-RPC method. */
async function connect(
  store: Served,
  token?: string,
): Promise<{ client: Client; exchanges: Exchange[] }> {
  const exchanges: Exchange[] = []
  const transport = new StreamableHTTPClientTransport(store.endpoint, {
    ...(token !== undefined && { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    fetch: async (url: string | URL, init?: RequestInit) => {
      const res = await fetch(url, init)
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const message = JSON.parse(init.body) as { method?: string }
        exchanges.push({ method: message.method ?? '', status: res.status })
      }
      return res
    },
  })
  const client = new Client({ name: AGENT.name, version: AGENT.version })
  await client.connect(transport)
  cleanups.push(() => client.close())
  return { client, exchanges }
}

async function toolNames(client: Client): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    names.push(...page.tools.map((tool: { name: string }) => tool.name))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return names
}

describe('AC-9: POST /api/mcp', () => {
  it('AC-9: tools/list with no Authorization lists what the anonymous caller is listed, and with an admin bearer what an admin is, a strict superset', async () => {
    const store = await served()
    const admin = await adminAccount(store.kernel, store.base)
    const surface = toolSurface(store.kernel.app)

    const anonymous = await toolNames((await connect(store)).client)
    const asAdmin = await toolNames((await connect(store, admin.token)).client)

    expect(anonymous.sort()).toEqual((await listedNames(surface, ANONYMOUS)).sort())
    expect(asAdmin.sort()).toEqual((await listedNames(surface, admin.caller)).sort())
    expect(asAdmin).toEqual(expect.arrayContaining(anonymous))
    expect(asAdmin.length).toBeGreaterThan(anonymous.length)
  }, 30_000)

  it('AC-9: a bearer that does not verify answers 401 with WWW-Authenticate: Bearer, where the same request with no Authorization answers 200', async () => {
    const store = await served()

    const forged = await initialize(store, { authorization: 'Bearer not.a.token' })
    const none = await initialize(store)

    expect(forged.status).toBe(401)
    expect(forged.challenge ?? '').toMatch(/^Bearer\b/)
    expect(none.status).toBe(200)
  }, 30_000)

  it("AC-9: an Origin outside the store's CORS origins answers 403, while the same request from an allowed Origin or with none answers 200", async () => {
    const store = await served()

    const statuses = {
      foreign: (await initialize(store, { origin: 'https://evil.example' })).status,
      allowed: (await initialize(store, { origin: ALLOWED_ORIGIN })).status,
      none: (await initialize(store)).status,
    }

    expect(store.kernel.config.http.cors.allowedOrigins).toContain(ALLOWED_ORIGIN)
    expect(statuses).toEqual({ foreign: 403, allowed: 200, none: 200 })
  }, 30_000)

  it('AC-9: tools/call with no x-csrf-token and no cookie succeeds: products_list answers the data GET /api/products answers', async () => {
    const store = await served()
    const { client } = await connect(store)

    const result = await client.callTool({ name: 'products_list', arguments: {} })
    const route = (await (await fetch(`${store.base}/api/products`)).json()) as { data?: unknown }

    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toEqual(route.data)
  }, 30_000)

  it('AC-9: with security.rateLimit holding /api/mcp at 2 a minute, the second request answers 200 and the third 429', async () => {
    const store = await served(
      withRateRule('/api/mcp', { requests: 2, window: '1m', action: 'block' }),
    )

    const statuses: number[] = []
    for (let i = 0; i < 3; i += 1) statuses.push((await initialize(store)).status)

    expect(statuses).toEqual([200, 200, 429])
  }, 30_000)

  it("AC-9: a tool call is admitted under its own route's rule: on the built-in /api/orders/link rule, the sixth orders_requestLink call in an hour is an isError result rate.limited with a retryAfter, over HTTP 200, where the five before were not refused", async () => {
    const store = await served(withRateRule('/api/orders/link', undefined))
    const { client, exchanges } = await connect(store)

    const results: Array<{ isError: boolean; code: unknown; retryAfter: unknown }> = []
    for (let i = 0; i < 6; i += 1) {
      const result = await client.callTool({
        name: 'orders_requestLink',
        arguments: { orderNumber: 'NYM-000404', email: 'agent@mcp.test' },
      })
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>
      results.push({
        isError: result.isError ?? false,
        code: structured['code'],
        retryAfter: structured['retryAfter'],
      })
    }
    const statuses = exchanges.filter((e) => e.method === 'tools/call').map((e) => e.status)
    const sixth = results[5]!

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200])
    expect(results.slice(0, 5).map((r) => r.isError)).toEqual([false, false, false, false, false])
    expect([sixth.isError, sixth.code]).toEqual([true, 'rate.limited'])
    expect(typeof sixth.retryAfter === 'number' ? sixth.retryAfter : 0).toBeGreaterThan(0)
  }, 30_000)

  it('AC-13: tools/call of orders_get, listed for nobody, answers isError tool.unknown for an anonymous and an admin caller, as a name no tool has does', async () => {
    const store = await served()
    const admin = await adminAccount(store.kernel, store.base)
    const args = { orderNumber: 'NYM-000001' }

    const answers: Array<[unknown, unknown, unknown]> = []
    for (const token of [undefined, admin.token]) {
      const { client } = await connect(store, token)
      const unlisted = await client.callTool({ name: 'orders_get', arguments: args })
      const unknown = await client.callTool({ name: 'orders_nonexistent', arguments: args })
      answers.push([
        (unlisted.structuredContent as { code?: unknown } | undefined)?.code,
        (unknown.structuredContent as { code?: unknown } | undefined)?.code,
        unlisted.isError,
      ])
    }

    expect(answers).toEqual([
      ['tool.unknown', 'tool.unknown', true],
      ['tool.unknown', 'tool.unknown', true],
    ])
  }, 30_000)

  it('AC-9: with agents.mcp.enabled false, POST /api/mcp answers 404 while the store serves its routes', async () => {
    const store = await served((config) => ({
      ...config,
      agents: { ...config.agents, mcp: { ...config.agents.mcp, enabled: false } },
    }))

    const mcp = await initialize(store)
    const products = await fetch(`${store.base}/api/products`)
    await products.arrayBuffer()

    expect([mcp.status, products.status]).toEqual([404, 200])
  }, 30_000)
})

/** An order placed through checkout by a guest whose email, phone, street line and postcode are its own. */
async function placedOrder(kernel: Kernel): Promise<{
  orderNumber: string
  values: { email: string; phone: string; addressLine1: string; postalCode: string }
}> {
  const tag = randomUUID()
  const values = {
    email: `buyer-${tag}@mcp.test`,
    phone: `07700 9${String(parseInt(tag.slice(0, 5), 16) % 100_000).padStart(5, '0')}`,
    addressLine1: `${tag.slice(0, 8)} Withheld Lane`,
    postalCode: 'SW1A 1AA',
  }
  const home = {
    ...address,
    addressLine1: values.addressLine1,
    postalCode: values.postalCode,
    phone: values.phone,
  }
  const cartToken = await cartWith(kernel, await seedVariant(kernel, 10), 1)
  const placed = await kernel.services.checkout.beginCheckout({
    cartToken,
    email: values.email,
    billingAddress: home,
    shippingAddress: home,
  })
  return { orderNumber: placed.orderNumber, values }
}

/** `GET /api/admin/orders/:orderNumber` with the bearer: its status, its body as text, and its data. */
async function adminOrderRoute(store: Served, orderNumber: string, token: string) {
  const res = await fetch(`${store.base}/api/admin/orders/${orderNumber}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, text, data: (JSON.parse(text) as { data?: unknown }).data }
}

describe('AC-6: POST /api/mcp withholds customer contact details from an admin', () => {
  // Kills: the strip landing in the route (the admin UI loses the fields), or the transport answering around it.
  it('AC-6: on a default-config store, an admin bearer’s admin_orders_get holds none of the order’s email, phone, street line and postcode and holds withheld email, phone, address, postcode, while GET /api/admin/orders/:orderNumber with the same bearer answers all four; on a store with agents.mcp.withhold [] the tool’s structuredContent equals that route’s data, with no withheld', async () => {
    const store = await served()
    const open = await served((config) => ({
      ...config,
      agents: { ...config.agents, mcp: { ...config.agents.mcp, withhold: [] } },
    }))
    const reads = []
    for (const one of [store, open]) {
      const admin = await adminAccount(one.kernel, one.base)
      const order = await placedOrder(one.kernel)
      const { client } = await connect(one, admin.token)
      const result = await client.callTool({
        name: 'admin_orders_get',
        arguments: { orderNumber: order.orderNumber },
      })
      reads.push({
        values: Object.values(order.values),
        result,
        route: await adminOrderRoute(one, order.orderNumber, admin.token),
      })
    }
    const [withheld, sent] = reads as [(typeof reads)[number], (typeof reads)[number]]
    const read = JSON.stringify(withheld.result.structuredContent)

    expect([withheld.route.status, withheld.result.isError ?? false]).toEqual([200, false])
    expect(withheld.values.filter((value) => withheld.route.text.includes(value))).toEqual(
      withheld.values,
    )
    expect(withheld.values.filter((value) => read.includes(value))).toEqual([])
    expect((withheld.result.structuredContent as { withheld?: unknown }).withheld).toEqual([
      'email',
      'phone',
      'address',
      'postcode',
    ])
    expect(sent.route.status).toBe(200)
    expect(sent.result.structuredContent).toEqual(sent.route.data)
    expect(Object.keys(sent.result.structuredContent ?? {})).not.toContain('withheld')
  }, 60_000)
})
