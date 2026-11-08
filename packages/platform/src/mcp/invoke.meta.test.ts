import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  Address,
  Caller,
  Logger,
  ResponseEnvelope,
  ToolDefinition,
  ToolSurface,
} from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../../tests/support/audit-http.js'
import { serveKernel, type ServedKernel } from '../../tests/support/http.js'
import { address, createKernel } from '../../tests/support/kernel.js'
import { insertOrders } from '../../tests/support/listed-orders.js'
import { contentOf, productBody } from '../../tests/support/mcp.js'
import { createInvoker } from './invoke.js'
import type { Policy } from './proposals.js'
import { RouteTable } from './route-table.js'

// AC-4: a tool result of a paged list carries the route's `meta` beside its items: `admin_orders_list` its `total`,
// `admin_activity_list` its `nextCursor`. A served SQLite kernel answers the same request over HTTP and through the
// assistant's tool surface; a route table of the test's own answers what no store route answers (a `meta` holding
// `items`, an object with a `meta`).

const ship = (postalCode: string): Address => ({ ...address, postalCode })

let served: ServedKernel
let admin: AdminSession
let tools: ToolSurface
let caller: Caller
/** The orders shipped to a postcode starting SW1. */
let sw1: string[]

beforeAll(async () => {
  const k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  admin = await adminSession(k, served.baseUrl)
  tools = k.app.assistantTools!
  caller = { auth: { userId: admin.userId, roles: ['admin'] }, agent: { name: 'acceptance' } }
  const placed = await insertOrders(
    k,
    ['SW1A 1AA', 'SW1V 3LP', 'E1 6AN', 'SW10 9AB', 'M1 1AE'].map((postalCode) => ({
      status: 'confirmed' as const,
      shippingAddress: ship(postalCode),
    })),
  )
  sw1 = placed.filter((_, i) => [0, 1, 3].includes(i)).map((o) => o.id)
  // Two admin writes, so the activity trail pages at one entry.
  for (let i = 0; i < 2; i += 1) {
    const made = await admin.send('POST', '/api/admin/products', productBody())
    if (made.status !== 201)
      throw new Error(`POST /api/admin/products: ${JSON.stringify(made.body)}`)
  }
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

/** An invoker over one read route of the store's registry, answered by `answer` instead of its handler. */
function invokerAnswering(key: string, answer: ResponseEnvelope): ToolSurface {
  const [method, path] = key.split(' ') as ['GET', string]
  const name = `stub_${path.replaceAll(/[^A-Za-z]/g, '_')}`
  const table = new RouteTable()
  table.record(key, async () => answer)
  const tool: ToolDefinition = {
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    scope: 'admin',
    kind: 'read',
    route: { method, path, command: null },
  }
  return createInvoker({
    table,
    tools: [tool],
    proposals: {
      propose: async () => {
        throw new Error('no proposal in a read')
      },
      run: async () => {
        throw new Error('no proposal in a read')
      },
    },
    policy: (() => null) as Policy,
    logger: silent,
    withhold: [],
  })
}

const nameOf = (key: string) => `stub_${key.split(' ')[1]!.replaceAll(/[^A-Za-z]/g, '_')}`

describe('AC-4: a paged list’s tool result carries its total or its cursor', () => {
  it("AC-4: admin_orders_list { postcode: 'SW1', limit: '1' } answers structuredContent { items, total } equal to GET /api/admin/orders?postcode=SW1&limit=1's data and meta.total, one order of the SW1 orders with total their count, and a text that parses to it", async () => {
    const route = await admin.send<Array<{ id: string }>>(
      'GET',
      '/api/admin/orders?postcode=SW1&limit=1',
    )
    const result = await tools.call('admin_orders_list', { postcode: 'SW1', limit: '1' }, caller)
    const { structured, text } = contentOf(result)

    expect(route.status).toBe(200)
    expect(result.isError ?? false).toBe(false)
    expect(structured).toEqual({ items: route.body.data, total: sw1.length })
    expect(route.body.meta?.['total']).toBe(sw1.length)
    expect((structured['items'] as Array<{ id: string }>).map((o) => sw1.includes(o.id))).toEqual([
      true,
    ])
    expect(text).toEqual(structured)
  })

  it("AC-4: admin_activity_list { limit: '1' } answers structuredContent { items, nextCursor } equal to GET /api/admin/activity?limit=1's data and meta, the cursor a string", async () => {
    const route = await admin.send<unknown[]>('GET', '/api/admin/activity?limit=1')
    const result = await tools.call('admin_activity_list', { limit: '1' }, caller)
    const { structured, text } = contentOf(result)

    expect(route.status).toBe(200)
    expect(typeof route.body.meta?.['nextCursor']).toBe('string')
    expect(structured).toEqual({
      items: route.body.data,
      nextCursor: route.body.meta?.['nextCursor'],
    })
    expect(text).toEqual(structured)
  })

  it('AC-4: a route whose meta holds items answers its data as the items, the rest of its meta beside them; an object answer with a meta is its data alone, as before', async () => {
    const listKey = 'GET /api/admin/activity'
    const objectKey = 'GET /api/admin/dashboard'
    const listed = await invokerAnswering(listKey, {
      status: 200,
      body: { data: [{ id: 'a' }, { id: 'b' }], meta: { items: ['forged'], nextCursor: 'c1' } },
    }).call(nameOf(listKey), {}, caller)
    const object = await invokerAnswering(objectKey, {
      status: 200,
      body: { data: { revenueMinor: 1900, orders: 2 }, meta: { total: 9 } },
    }).call(nameOf(objectKey), {}, caller)

    expect(contentOf(listed).structured).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'c1',
    })
    expect(contentOf(listed).text).toEqual(contentOf(listed).structured)
    expect(contentOf(object).structured).toEqual({ revenueMinor: 1900, orders: 2 })
    expect(contentOf(object).text).toEqual(contentOf(object).structured)
  })
})
