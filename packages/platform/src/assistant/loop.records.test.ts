import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Caller,
  Logger,
  ProposalView,
  ToolDefinition,
  ToolResult,
  ToolSurface,
} from '@nymbalhq/types'
import { scriptedAi } from '../../tests/support/scripted-ai.js'
import { runAssistantTurn } from './loop.js'

// AC-10: the `record` frames a turn emits, one per order or customer a successful admin read of the turn answered,
// taken from the store's result (never the model's arguments or text), de-duplicated, at most five a turn, each right
// after its call's frame. The loop is the real one; the model is scripted from a generated plan and the tool surface
// answers each call as the plan says, failing some.

const read = (name: string, path: string): ToolDefinition => ({
  name,
  title: name.replaceAll('_', '.'),
  description: name,
  inputSchema: { type: 'object', properties: {} },
  scope: 'admin',
  kind: 'read',
  route: { method: 'GET', path, command: null },
})

const ORDER_GET = read('admin_orders_get', '/api/admin/orders/:orderNumber')
const ORDERS = read('admin_orders_list', '/api/admin/orders')
const CUSTOMER_ORDERS = read('admin_customers_orders', '/api/admin/customers/:id/orders')
const CUSTOMER_GET = read('admin_customers_get', '/api/admin/customers/:id')
const CUSTOMERS = read('admin_customers_list', '/api/admin/customers')
const PRODUCTS = read('admin_products_list', '/api/admin/products')
const CANCEL: ToolDefinition = {
  ...read('admin_orders_cancel', '/api/admin/orders/:id/cancel'),
  kind: 'command',
  route: { method: 'POST', path: '/api/admin/orders/:id/cancel', command: 'order.cancel' },
}
const TOOLS = [ORDER_GET, ORDERS, CUSTOMER_ORDERS, CUSTOMER_GET, CUSTOMERS, PRODUCTS, CANCEL]
const PAGE = '/orders/NYM-PAGE'

const caller: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

/** The Interface's cap: records past this many in one turn are not emitted. */
const MAX = 5

type Rec = { kind: 'order'; orderNumber: string } | { kind: 'customer'; id: string }

/** A key a result may hold: from a small pool, so turns repeat records; empty or missing now and then. */
const orderNumberArb = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      'NYM-1001',
      'NYM-1002',
      'NYM-1003',
      'NYM-1004',
      'NYM-1005',
      'NYM-1006',
      'NYM-1007',
    ),
  },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant(undefined) },
)
const customerIdArb = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom('cus_1', 'cus_2', 'cus_3', 'cus_4', 'cus_5', 'cus_6', 'cus_7'),
  },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant(undefined) },
)

type Planned =
  | { kind: 'orderGet'; arg: string; number: string | undefined; fail: boolean }
  | { kind: 'orders' | 'customerOrders'; numbers: Array<string | undefined>; fail: boolean }
  | { kind: 'customerGet'; id: string | undefined; fail: boolean }
  | { kind: 'customers'; ids: Array<string | undefined>; fail: boolean }
  | { kind: 'products' }
  | { kind: 'proposed' }
  | { kind: 'applied'; number: string }
  | { kind: 'page' }
  | { kind: 'unknown' }

const plannedArb: fc.Arbitrary<Planned> = fc.oneof(
  fc.record({
    kind: fc.constant('orderGet' as const),
    arg: fc.constantFrom('NYM-9001', 'NYM-1001', 'NYM-1006'),
    number: orderNumberArb,
    fail: fc.boolean(),
  }),
  fc.record({
    kind: fc.constantFrom('orders' as const, 'customerOrders' as const),
    numbers: fc.array(orderNumberArb, { minLength: 0, maxLength: 8 }),
    fail: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('customerGet' as const), id: customerIdArb, fail: fc.boolean() }),
  fc.record({
    kind: fc.constant('customers' as const),
    ids: fc.array(customerIdArb, { minLength: 0, maxLength: 8 }),
    fail: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('products' as const) }),
  fc.record({ kind: fc.constant('proposed' as const) }),
  fc.record({
    kind: fc.constant('applied' as const),
    number: fc.constantFrom('NYM-1001', 'NYM-2001'),
  }),
  fc.record({ kind: fc.constant('page' as const) }),
  fc.record({ kind: fc.constant('unknown' as const) }),
)

/** 1-4 replies of 1-4 calls. */
const planArb = fc.array(fc.array(plannedArb, { minLength: 1, maxLength: 4 }), {
  minLength: 1,
  maxLength: 4,
})

const withKey = <K extends string>(key: K, value: string | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, string>)

const orderOf = (number: string | undefined) => ({
  id: `ord_${number ?? 'none'}`,
  ...withKey('orderNumber', number),
  email: 'buyer@shop.test',
  shippingAddress: {
    firstName: 'Ada',
    lastName: 'Okafor',
    addressLine1: '1 Acacia Road',
    postalCode: 'SW1A 1AA',
  },
})
const customerOf = (id: string | undefined) => ({
  ...withKey('id', id),
  email: 'buyer@shop.test',
  phone: '+44 7700 900123',
})

const resultOf = (structured: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
  ...(isError && { isError: true }),
})

const refused = () => resultOf({ code: 'orders.not_found', message: 'Order not found' }, true)

/** What the surface answers a planned call. */
function answer(p: Planned): ToolResult {
  switch (p.kind) {
    case 'orderGet':
      return p.fail ? refused() : resultOf(orderOf(p.number))
    case 'orders':
    case 'customerOrders':
      return p.fail
        ? refused()
        : resultOf({
            items: p.numbers.map(orderOf),
            ...(p.kind === 'orders' && { total: p.numbers.length }),
          })
    case 'customerGet':
      return p.fail ? refused() : resultOf({ customer: customerOf(p.id), stats: { orderCount: 2 } })
    case 'customers':
      return p.fail ? refused() : resultOf({ customers: p.ids.map(customerOf) })
    case 'products':
      return resultOf({ items: [{ id: 'prod_1', name: 'Mug', orderNumber: 'NYM-1001' }] })
    case 'proposed':
      return resultOf({
        status: 'proposed',
        id: 'prop_1',
        tool: CANCEL.name,
        command: 'order.cancel',
      })
    case 'applied':
      return resultOf(orderOf(p.number))
    default:
      throw new Error(`${p.kind} never reaches the surface`)
  }
}

/** The call the model makes for a planned one; `tag` tells the surface which plan entry it is. */
function callOf(p: Planned, tag: string): { name: string; args: Record<string, unknown> } {
  switch (p.kind) {
    case 'orderGet':
      return { name: ORDER_GET.name, args: { orderNumber: p.arg, tag } }
    case 'orders':
      return { name: ORDERS.name, args: { limit: '8', tag } }
    case 'customerOrders':
      return { name: CUSTOMER_ORDERS.name, args: { id: 'cus_1', tag } }
    case 'customerGet':
      return { name: CUSTOMER_GET.name, args: { id: 'cus_9', tag } }
    case 'customers':
      return { name: CUSTOMERS.name, args: { q: 'buyer', tag } }
    case 'products':
      return { name: PRODUCTS.name, args: { tag } }
    case 'proposed':
    case 'applied':
      return { name: CANCEL.name, args: { id: 'ord_NYM-1001', tag } }
    case 'page':
      return { name: 'assistant_page', args: {} }
    case 'unknown':
      return { name: 'admin_orders_vanish', args: { orderNumber: 'NYM-1001' } }
  }
}

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value !== ''
const asOrders = (numbers: Array<string | undefined>): Rec[] =>
  numbers.filter(nonEmpty).map((orderNumber) => ({ kind: 'order', orderNumber }))
const asCustomers = (ids: Array<string | undefined>): Rec[] =>
  ids.filter(nonEmpty).map((id) => ({ kind: 'customer', id }))

/** The records a successful marked read answers, per the Interface's table; none for anything else. */
function recordsOf(p: Planned): Rec[] {
  if ('fail' in p && p.fail) return []
  switch (p.kind) {
    case 'orderGet':
      return asOrders([p.number])
    case 'orders':
    case 'customerOrders':
      return p.numbers.length <= MAX ? asOrders(p.numbers) : []
    case 'customerGet':
      return asCustomers([p.id])
    case 'customers':
      return p.ids.length <= MAX ? asCustomers(p.ids) : []
    default:
      return []
  }
}

/** Per call, in call order, the records it should emit: new to the turn, while fewer than five were emitted. */
function expectedGroups(calls: Planned[]): Rec[][] {
  const seen = new Set<string>()
  return calls.map((p) =>
    recordsOf(p).filter((r) => {
      const key = r.kind === 'order' ? `order:${r.orderNumber}` : `customer:${r.id}`
      if (seen.has(key) || seen.size >= MAX) return false
      seen.add(key)
      return true
    }),
  )
}

interface Frame {
  event: string
  data: Record<string, unknown>
}

async function runPlan(plan: Planned[][]): Promise<Frame[]> {
  const byTag = new Map<string, Planned>()
  const replies = plan.map((reply, r) =>
    reply.map((p, c) => {
      const tag = `c${r}.${c}`
      byTag.set(tag, p)
      return callOf(p, tag)
    }),
  )
  const tools: ToolSurface = {
    list: () => TOOLS,
    call: async (_name, args) =>
      answer(byTag.get(String((args as Record<string, unknown>)['tag']))!),
  }
  const model = scriptedAi((request) =>
    request.index < replies.length ? { calls: replies[request.index]! } : { text: 'Done.' },
  )
  const frames: Frame[] = []
  await runAssistantTurn(
    {
      ai: model.ai,
      tools,
      proposals: {
        get: async (id: string) =>
          ({ id, tool: CANCEL.name, status: 'pending' }) as unknown as ProposalView,
      },
      logger: silent,
      limits: { maxSteps: 8 },
    } as Parameters<typeof runAssistantTurn>[0],
    { caller, page: PAGE, messages: [{ role: 'user', content: 'Who ordered what?' }] },
    (frame) => void frames.push(frame as unknown as Frame),
  )
  return frames
}

/** The record frames after each call's frame (`tool` or `proposal`), in call order; and those before the first. */
function groupsOf(frames: Frame[]): { before: Frame[]; groups: Frame[][]; afterDone: Frame[] } {
  const before: Frame[] = []
  const groups: Frame[][] = []
  const done = frames.findIndex((f) => f.event === 'done')
  for (const f of frames.slice(0, done === -1 ? frames.length : done)) {
    if (f.event === 'tool' || f.event === 'proposal') groups.push([])
    else if (f.event === 'record') (groups.at(-1) ?? before).push(f)
  }
  return { before, groups, afterDone: done === -1 ? [] : frames.slice(done + 1) }
}

describe('AC-10: record frames come from the store’s results, at most five a turn', () => {
  it('AC-10: property: for any turn of admin_orders_get, admin_orders_list, admin_customers_orders, admin_customers_get and admin_customers_list reads (generated records, lists of 0-8, some failing), other reads, proposed and applied commands, the page tool and an unknown tool, the record frames are, in call order, the records of each successful marked read (a list only at five or fewer), de-duplicated by kind and key, the first five only, each exactly { kind, orderNumber } or { kind, id } from the result, right after its call’s frame and before the next call’s frame and done', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const frames = await runPlan(plan)
        const calls = plan.flat()
        const { before, groups, afterDone } = groupsOf(frames)

        expect(frames.at(-1)?.event).toBe('done')
        expect(groups.length).toBe(calls.length)
        expect(groups.map((g) => g.map((f) => f.data))).toEqual(expectedGroups(calls))
        expect(groups.flat().map((f) => Object.keys(f.data).sort())).toEqual(
          expectedGroups(calls)
            .flat()
            .map((r) => Object.keys(r).sort()),
        )
        expect([...before, ...afterDone]).toEqual([])
      }),
      { numRuns: 300 },
    )
  }, 120_000)

  it('AC-10: a turn reading six different orders one at a time emits records for the first five only, each the number the result answered and not the one the call named', async () => {
    const plan: Planned[][] = [
      ['NYM-1001', 'NYM-1002', 'NYM-1003'].map((number) => ({
        kind: 'orderGet' as const,
        arg: 'NYM-9001',
        number,
        fail: false,
      })),
      ['NYM-1004', 'NYM-1005', 'NYM-1006'].map((number) => ({
        kind: 'orderGet' as const,
        arg: 'NYM-9001',
        number,
        fail: false,
      })),
    ]

    const frames = await runPlan(plan)

    expect(frames.filter((f) => f.event === 'record').map((f) => f.data)).toEqual(
      expectedGroups(plan.flat()).flat(),
    )
    expect(expectedGroups(plan.flat()).flat().length).toBe(MAX)
  })
})
