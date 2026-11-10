import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z, type ZodTypeAny } from 'zod'
import type {
  Caller,
  HttpAdapter,
  RequestAuth,
  RequestContext,
  ResponseEnvelope,
  RouteHandler,
  ToolDefinition,
} from '@nymbalhq/types'
import { routeSchemas, type RouteSchema } from '../routes/schemas.js'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import { AGENT, ANONYMOUS, listedNames, toolSurface } from '../../tests/support/mcp.js'
import { jsonSchemaOf, toolName, toolsOf } from './registry.js'
import { RouteTable, recordingAdapter } from './route-table.js'

// AC-1 and AC-2: the tool set is a function of the route registry and the routes' gates. The table is filled the way
// attachHttp fills the app's own (recordingAdapter around the adapter it is given); the adapter under it keeps each
// composed handler as an HTTP server would run it, so a route's scope can be observed by calling it.

/**
 * Every entry the registry keeps from the tool list: credentials, streams, provider-signed bytes, files, view history,
 * the AI key; a proposal's decision, so no agent approves its own; a settings value, so none sits in a proposal, and its clearing, so no agent clears one; the
 * assistant's turn and stream, which spend the AI key, so no agent calls the assistant.
 */
const EXCLUDED = [
  'auth.register',
  'auth.login',
  'auth.refresh',
  'auth.logout',
  'auth.forgotPassword',
  'auth.resetPassword',
  'customers.changePassword',
  'admin.events.ticket',
  'admin.events.stream',
  'admin.activity.export',
  'webhooks.receive',
  'admin.app.redirect',
  'admin.app.index',
  'admin.app.asset',
  'recentlyViewed.record',
  'recentlyViewed.list',
  'admin.products.enhance',
  'admin.proposals.approve',
  'admin.proposals.reject',
  'admin.settings.put',
  'admin.settings.delete',
  'admin.assistant.turn',
  'admin.assistant.stream',
  'cart.addCode',
  'cart.removeCode',
  'admin.promotions.list',
  'admin.promotions.create',
  'admin.promotions.update',
  'admin.promotions.delete',
].sort()

/** The routes a cookie names the cart of; their tools take it as `cart`. */
const CART_HANDLES = [
  'GET /api/cart',
  'POST /api/cart/items',
  'PATCH /api/cart/items/:variantId',
  'DELETE /api/cart/items/:variantId',
  'DELETE /api/cart',
  'POST /api/checkout',
].sort()

/** Listed for nobody until a guest's order key can travel as an argument. */
const UNLISTED = ['orders_get']

const NAME = /^[A-Za-z0-9_-]{1,128}$/
const RANK = { public: 0, customer: 1, admin: 2 } as const

interface Captured {
  adapter: HttpAdapter
  routes: Map<string, RouteHandler>
  streams: Set<string>
}

/** An adapter that serves nothing and keeps each handler registered on it by `"<METHOD> <path>"`. */
function capturingAdapter(): Captured {
  const routes = new Map<string, RouteHandler>()
  const streams = new Set<string>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler)
    },
    registerStreamRoute(method, path) {
      streams.add(`${method} ${path}`)
    },
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  return { adapter, routes, streams }
}

const silent = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
}

/** A request with no input at all: a gate that admits it leaves the schema to refuse it, or the handler to answer. */
function bareRequest(key: string, auth: RequestAuth | undefined): RequestContext {
  const [method, path] = key.split(' ') as [RequestContext['method'], string]
  return {
    method,
    path,
    url: `http://127.0.0.1${path}`,
    params: {},
    query: {},
    body: undefined,
    headers: {},
    cookies: {},
    ...(auth !== undefined && { auth }),
    requestId: 'registry-probe',
    correlationId: 'registry-probe',
    logger: silent,
    ip: '127.0.0.1',
  }
}

/** Whether the composed handler lets `auth` past its gate: anything but the gate's own 401 or 403. */
async function admits(handler: RouteHandler, key: string, auth?: RequestAuth): Promise<boolean> {
  const answer = (await Promise.resolve(handler(bareRequest(key, auth))).catch(
    () => null,
  )) as ResponseEnvelope | null
  const code = (answer?.body as { error?: { code?: string } } | undefined)?.error?.code
  return !(code === 'auth.unauthorized' || code === 'auth.forbidden')
}

const PROBE_CUSTOMER: RequestAuth = { userId: 'registry-probe-customer', roles: ['customer'] }

/** The object a part of a route's input is, unwrapped, and whether the part itself may be left out. */
function partOf(schema: ZodTypeAny | undefined): {
  shape: Record<string, ZodTypeAny>
  optional: boolean
} {
  let at = schema
  let optional = at === undefined
  for (;;) {
    if (at instanceof z.ZodOptional) {
      optional = true
      at = at.unwrap() as ZodTypeAny
    } else if (at instanceof z.ZodPipe) {
      at = at.in as ZodTypeAny
    } else break
  }
  return {
    shape: at instanceof z.ZodObject ? (at.shape as Record<string, ZodTypeAny>) : {},
    optional,
  }
}

const PARTS = ['params', 'query', 'body'] as const

function declaredKeys(entry: RouteSchema): { keys: string[]; required: string[] } {
  const keys: string[] = []
  const required: string[] = []
  for (const part of PARTS) {
    const { shape, optional } = partOf(entry[part])
    for (const [key, field] of Object.entries(shape)) {
      keys.push(key)
      if (!optional && !field.isOptional()) required.push(key)
    }
  }
  return { keys, required }
}

function keyOf(tool: ToolDefinition): string {
  return `${tool.route.method} ${tool.route.path}`
}

let kernel: Kernel
let table: RouteTable
let captured: Captured
let tools: ToolDefinition[]

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  table = new RouteTable()
  captured = capturingAdapter()
  await kernel.app.attachHttp(recordingAdapter(table, captured.adapter), { adminRoot: null })
  tools = toolsOf(table)
}, 30_000)

afterAll(async () => {
  await kernel?.close()
})

describe('AC-1: one tool per registry entry', () => {
  it('AC-1: the tools are exactly the entries neither marked tool: false nor streamed, each named by its dotted name with . as _, matching ^[A-Za-z0-9_-]{1,128}$, titled and described by its entry, and kind read, session or command by its method and command', () => {
    const expected = Object.keys(routeSchemas)
      .filter((key) => routeSchemas[key]!.tool !== false && !captured.streams.has(key))
      .sort()

    expect(tools.map(keyOf).sort()).toEqual(expected)
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    for (const tool of tools) {
      const entry = routeSchemas[keyOf(tool)]!
      expect(tool.name, entry.name).toBe(entry.name.split('.').join('_'))
      expect(toolName(entry.name)).toBe(tool.name)
      expect(tool.name, entry.name).toMatch(NAME)
      expect(tool.title).toBe(entry.name)
      expect(tool.description).toBe(entry.description)
      expect(tool.route.command, entry.name).toBe(entry.command)
      const kind =
        tool.route.method === 'GET' ? 'read' : entry.command === null ? 'session' : 'command'
      expect(tool.kind, entry.name).toBe(kind)
    }
  })

  it('AC-13: the entries marked tool: false are exactly the fourteen kept from agents plus proposal approve, proposal reject, settings put and delete, the assistant’s turn and stream, the cart-code and admin-promotion routes and the three password routes, and every stream route is among them', () => {
    const marked = Object.values(routeSchemas)
      .filter((entry) => entry.tool === false)
      .map((entry) => entry.name)
      .sort()
    const streamed = [...captured.streams].map((key) => routeSchemas[key]!.name)

    expect(marked).toEqual(EXCLUDED)
    expect(streamed.filter((name) => !marked.includes(name))).toEqual([])
  })

  it("AC-1: each tool's inputSchema is one object whose properties are its params, query and body keys flattened, plus cart on the six cookie-named cart routes and idempotencyKey on every admin command, and whose required keys are the parts' required keys", () => {
    const handled = Object.entries(routeSchemas)
      .filter(([, entry]) => entry.handles?.['cart'] === 'nymbal.cart')
      .map(([key]) => key)
      .sort()
    expect(handled).toEqual(CART_HANDLES)

    for (const tool of tools) {
      const key = keyOf(tool)
      const entry = routeSchemas[key]!
      const { keys, required } = declaredKeys(entry)
      const extra = [
        ...(CART_HANDLES.includes(key) ? ['cart'] : []),
        ...(tool.kind === 'command' && tool.route.path.startsWith('/api/admin/')
          ? ['idempotencyKey']
          : []),
      ]
      const schema = tool.inputSchema as {
        type?: string
        properties?: Record<string, unknown>
        required?: string[]
      }

      expect(schema.type, key).toBe('object')
      expect(Object.keys(schema.properties ?? {}).sort(), key).toEqual([...keys, ...extra].sort())
      expect([...(schema.required ?? [])].sort(), key).toEqual([...required].sort())
    }
  })

  it('AC-1: no registry entry declares one key in two of its parts', () => {
    const shared = Object.values(routeSchemas).flatMap((entry) => {
      const seen = new Map<string, string>()
      const clashes: string[] = []
      for (const part of PARTS) {
        for (const key of Object.keys(partOf(entry[part]).shape)) {
          const first = seen.get(key)
          if (first !== undefined) clashes.push(`${entry.name}: ${key} in ${first} and ${part}`)
          seen.set(key, part)
        }
      }
      return clashes
    })

    expect(shared).toEqual([])
  })

  it('AC-1: property: jsonSchemaOf flattens any params, query and body with distinct keys into one object of their union, and refuses, naming the key, two parts that share one', () => {
    const key = fc.stringMatching(/^[a-z][a-zA-Z]{0,7}$/)
    fc.assert(
      fc.property(
        fc.uniqueArray(key, { maxLength: 4 }),
        fc.uniqueArray(key, { maxLength: 4 }),
        fc.uniqueArray(key, { maxLength: 4 }),
        (params, query, body) => {
          const objectOf = (keys: string[]) =>
            z.object(Object.fromEntries(keys.map((k) => [k, z.string()])))
          const entry: RouteSchema = {
            name: 'probe.route',
            description: 'A generated route.',
            params: objectOf(params),
            query: objectOf(query),
            body: objectOf(body),
          }
          const all = [...params, ...query, ...body]
          const clash = all.find((k, i) => all.indexOf(k) !== i)
          let answer: { keys: string[] } | { refusedNaming: string | undefined }
          try {
            const schema = jsonSchemaOf(entry) as { properties?: Record<string, unknown> }
            answer = { keys: Object.keys(schema.properties ?? {}).sort() }
          } catch (error) {
            const message = (error as Error).message
            answer = { refusedNaming: all.find((k) => k === clash && message.includes(k)) }
          }
          const expected =
            clash === undefined ? { keys: [...all].sort() } : { refusedNaming: clash }

          expect(answer).toEqual(expected)
        },
      ),
    )
  })
})

describe('AC-13: proposals are read by agents and decided by people', () => {
  it('AC-13: admin_proposals_list and admin_proposals_get are admin read tools of GET /api/admin/proposals and GET /api/admin/proposals/:id; no tool approves or rejects a proposal or puts or clears a setting', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const shape = (name: string) => {
      const tool = byName.get(name)
      return tool && { kind: tool.kind, scope: tool.scope, route: keyOf(tool) }
    }

    expect([shape('admin_proposals_list'), shape('admin_proposals_get')]).toEqual([
      { kind: 'read', scope: 'admin', route: 'GET /api/admin/proposals' },
      { kind: 'read', scope: 'admin', route: 'GET /api/admin/proposals/:id' },
    ])
    expect(
      [
        'admin_proposals_approve',
        'admin_proposals_reject',
        'admin_settings_put',
        'admin_settings_delete',
      ].filter((name) => byName.has(name)),
    ).toEqual([])
    expect(
      tools.filter(
        (tool) => tool.kind === 'command' && tool.route.path.startsWith('/api/admin/proposals'),
      ),
    ).toEqual([])
  })
})

describe('AC-2: scope comes from the gate, and the listing follows the caller', () => {
  it("AC-2: each tool's scope is the least caller its route's own gate admits: public when an anonymous request passes, customer when only a signed-in one does, admin otherwise", async () => {
    const observed: Record<string, string> = {}
    const derived: Record<string, string> = {}
    for (const tool of tools) {
      const key = keyOf(tool)
      const handler = captured.routes.get(key)!
      observed[tool.name] = (await admits(handler, key))
        ? 'public'
        : (await admits(handler, key, PROBE_CUSTOMER))
          ? 'customer'
          : 'admin'
      derived[tool.name] = tool.scope
    }

    expect(derived).toEqual(observed)
  }, 30_000)

  it('AC-2: every /api/admin tool is admin; customers.* and orders.list are customer; products.*, categories.*, capabilities.get, the cart and checkout.begin are public', () => {
    const scopeOf = (tool: ToolDefinition) => tool.scope
    const named = (test: (name: string, path: string) => boolean) =>
      tools.filter((tool) => test(tool.title, tool.route.path))

    const admin = named((_, path) => path.startsWith('/api/admin/'))
    const customer = named((name) => name.startsWith('customers.') || name === 'orders.list')
    const open = named(
      (name) =>
        /^(products|categories|cart)\./.test(name) ||
        name === 'capabilities.get' ||
        name === 'checkout.begin',
    )

    expect(admin.length + customer.length + open.length).toBeLessThanOrEqual(tools.length)
    expect(admin.map(scopeOf)).toEqual(admin.map(() => 'admin'))
    expect(customer.map(scopeOf)).toEqual(customer.map(() => 'customer'))
    expect(open.map(scopeOf)).toEqual(open.map(() => 'public'))
    expect(open.map((tool) => tool.title)).toEqual(
      expect.arrayContaining([
        'capabilities.get',
        'checkout.begin',
        'cart.get',
        'categories.list',
        'products.list',
      ]),
    )
  })

  it('AC-2: property: list(caller) is exactly the tools whose scope the caller meets (anonymous public, a customer up to customer, an admin all), never one kept unlisted', async () => {
    const surface = toolSurface(kernel.app)
    const caller = fc.oneof(
      fc.constant<Caller>(ANONYMOUS),
      fc
        .subarray(['customer', 'admin', 'guest'])
        .map<Caller>((roles) => ({ auth: { userId: 'listing-probe', roles }, agent: AGENT })),
    )

    await fc.assert(
      fc.asyncProperty(caller, async (who) => {
        const level =
          who.auth === undefined ? 0 : who.auth.roles?.includes('admin') === true ? 2 : 1
        const expected = tools
          .filter(
            (tool) =>
              RANK[tool.scope as keyof typeof RANK] <= level && !UNLISTED.includes(tool.name),
          )
          .map((tool) => tool.name)
          .sort()

        expect((await listedNames(surface, who)).sort()).toEqual(expected)
      }),
      { numRuns: 30 },
    )
  })
})
