import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Address, Caller, OrderLineItem } from '@nymbalhq/types'
import { createHttpServer } from './server.js'
import { mountMcp } from './mcp-route.js'
import { address, createKernel, type Kernel } from '../../platform/tests/support/kernel.js'
import { insertOrders } from '../../platform/tests/support/listed-orders.js'
import { AGENT, adminAccount, type Account } from '../../platform/tests/support/mcp.js'

// AC-8: the order list stays whole for every reader but the assistant's model. On a store whose agents.mcp withholds
// nothing, the assistant's tool surface (`app.assistantTools`) and `POST /api/mcp` answer `admin_orders_list` with every
// order as `GET /api/admin/orders` answers it (the summary is the loop's, not the invoker's), and the store's count.

const HOST = '127.0.0.1'
/** The fields an MCP client and the eval's facts read of an order, which a summary leaves out. */
const WHOLE = [
  'id',
  'customerId',
  'shippingAddress',
  'lineItems',
  'capturedMinor',
  'refundedMinor',
] as const

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const bound = probe.address()
      probe.close(() =>
        typeof bound === 'object' && bound !== null
          ? resolve(bound.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

type Row = Record<string, unknown>
const pick = (order: Row) => Object.fromEntries(WHOLE.map((key) => [key, order[key]]))

let kernel: Kernel
let stop: () => Promise<void>
let base: string
let admin: Account
let client: Client
let placed: number

beforeAll(async () => {
  kernel = await createKernel({
    dialect: 'sqlite',
    configure: (config) => ({
      ...config,
      agents: { ...config.agents, mcp: { ...config.agents.mcp, enabled: true, withhold: [] } },
    }),
  })
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
  base = `http://${HOST}:${port}`
  stop = async () => {
    try {
      await server.stop()
    } finally {
      await kernel.close()
    }
  }
  admin = await adminAccount(kernel, base)

  const ship = (n: number): Address => ({
    ...address,
    firstName: `Shipped${n}`,
    addressLine1: `${n} Harbour Lane`,
    postalCode: `SW1A ${n}AA`,
    phone: `+44 7700 90012${n}`,
  })
  const orders = await insertOrders(
    kernel,
    [1, 2, 3].map((n) => ({
      status: 'confirmed' as const,
      customerId: n === 2 ? null : `cus-${randomUUID()}`,
      email: `whole-${n}-${randomUUID()}@orders.test`,
      shippingAddress: ship(n),
    })),
  )
  placed = orders.length

  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', base), {
    requestInit: { headers: { authorization: `Bearer ${admin.token}` } },
  })
  client = new Client({ name: AGENT.name, version: AGENT.version })
  await client.connect(transport)
}, 60_000)

afterAll(async () => {
  await client?.close()
  await stop?.()
})

describe('AC-8: the order list stays whole outside the assistant’s model', () => {
  it('AC-8: app.assistantTools and POST /api/mcp (admin bearer, withhold []) answer admin_orders_list with each order’s id, customerId, shippingAddress, lineItems, capturedMinor and refundedMinor equal to GET /api/admin/orders, and total the number of orders', async () => {
    const res = await fetch(`${base}/api/admin/orders?limit=50`, {
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const route = (await res.json()) as { data: Row[]; meta?: Row }
    const caller: Caller = {
      auth: { userId: admin.userId, roles: ['admin'] },
      agent: { name: 'acceptance' },
    }
    const surface = await kernel.app.assistantTools!.call(
      'admin_orders_list',
      { limit: '50' },
      caller,
    )
    const mcp = await client.callTool({ name: 'admin_orders_list', arguments: { limit: '50' } })
    const read = (structured: unknown) => {
      const body = (structured ?? {}) as Row
      return {
        items: ((body['items'] as Row[] | undefined) ?? []).map(pick),
        total: body['total'],
      }
    }

    expect(res.status).toBe(200)
    expect(route.data.map((o) => (o['lineItems'] as OrderLineItem[]).length)).toEqual(
      route.data.map(() => 1),
    )
    expect(route.meta?.['total']).toBe(placed)
    expect(read(surface.structuredContent)).toEqual({ items: route.data.map(pick), total: placed })
    expect(read(mcp.structuredContent)).toEqual({ items: route.data.map(pick), total: placed })
  }, 30_000)
})
