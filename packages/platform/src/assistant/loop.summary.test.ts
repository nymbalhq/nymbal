import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Caller,
  ChatMessage,
  Logger,
  ProductSnapshot,
  ToolDefinition,
  ToolResult,
  ToolSurface,
} from '@nymbalhq/types'
import {
  scriptedAi,
  toolMessagesOf,
  type ScriptedRequest,
} from '../../tests/support/scripted-ai.js'
import {
  adminOrderArb,
  adminOrdersArb,
  expectedOrderSummary,
  expectedProductSummary,
  productArb,
  type AdminOrder,
} from '../../tests/support/summaries.js'
import { runAssistantTurn } from './loop.js'

// AC-7: what the model reads of a list. The loop is the real one; the model is scripted and the tool surface answers
// generated orders and products. The orders list, a customer's orders and the products list reach the model as
// summaries (then masked), with the list's other keys kept; any other tool's result reaches it as the surface answered;
// each call's log line counts the customer fields of the whole result.

const DEFAULT_MASK = ['email', 'phone', 'address', 'postcode'] as const

const tool = (name: string, path: string): ToolDefinition => ({
  name,
  title: name.replaceAll('_', '.'),
  description: name,
  inputSchema: { type: 'object', properties: {} },
  scope: 'admin',
  kind: 'read',
  route: { method: 'GET', path, command: null },
})

const ORDERS = tool('admin_orders_list', '/api/admin/orders')
const CUSTOMER_ORDERS = tool('admin_customers_orders', '/api/admin/customers/:id/orders')
const PRODUCTS = tool('admin_products_list', '/api/admin/products')
const SEARCH = tool('admin_search', '/api/admin/search')
const ORDER = tool('admin_orders_get', '/api/admin/orders/:orderNumber')
const TOOLS = [ORDERS, CUSTOMER_ORDERS, PRODUCTS, SEARCH, ORDER]

const caller: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

interface LogLine {
  obj: Record<string, unknown>
  msg: string | undefined
}

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const at = (obj: unknown, msg?: string) =>
    void lines.push({ obj: (obj ?? {}) as Record<string, unknown>, msg })
  const logger: Logger = {
    trace: at,
    debug: at,
    info: at,
    warn: at,
    error: at,
    child: () => logger,
  }
  return { logger, lines }
}

interface Scenario {
  listed: AdminOrder[]
  /** The store's count of the orders the list's filter matched: more than one page may hold. */
  total: number
  customerOrders: AdminOrder[]
  products: ProductSnapshot[]
  searched: AdminOrder[]
  single: AdminOrder
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    listed: adminOrdersArb(1, 6),
    more: fc.nat(100),
    customerOrders: adminOrdersArb(0, 4),
    products: fc.array(productArb, { minLength: 0, maxLength: 4 }),
    searched: adminOrdersArb(1, 3),
    single: adminOrderArb,
  })
  .map(({ more, listed, ...rest }) => ({ ...rest, listed, total: listed.length + more }))

const resultOf = (structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
})

/** What the surface answers each tool, as a tool result's structured content. */
function answers(s: Scenario): Record<string, Record<string, unknown>> {
  return {
    [ORDERS.name]: { items: s.listed, total: s.total },
    [CUSTOMER_ORDERS.name]: { items: s.customerOrders },
    [PRODUCTS.name]: { items: s.products },
    [SEARCH.name]: { items: s.searched, total: s.searched.length },
    [ORDER.name]: { ...s.single },
  }
}

const CALLS = (s: Scenario) => [
  { name: ORDERS.name, args: { limit: '50' } },
  { name: CUSTOMER_ORDERS.name, args: { id: 'cus_1' } },
  { name: PRODUCTS.name, args: { limit: '50' } },
  { name: SEARCH.name, args: { q: 'order' } },
  { name: ORDER.name, args: { orderNumber: s.single.orderNumber } },
]

async function runScenario(s: Scenario, mask: readonly string[] | undefined) {
  const answered = answers(s)
  const tools: ToolSurface = {
    list: () => TOOLS,
    call: async (name) => resultOf(structuredClone(answered[name]!)),
  }
  const model = scriptedAi((request) =>
    request.index === 0 ? { calls: CALLS(s) } : { text: 'Done.' },
  )
  const logs = recordingLogger()
  await runAssistantTurn(
    {
      ai: model.ai,
      tools,
      proposals: { get: async () => null },
      logger: logs.logger,
      limits: { resultChars: 200_000 },
      ...(mask !== undefined && { mask: [...mask] }),
    } as Parameters<typeof runAssistantTurn>[0],
    { caller, messages: [{ role: 'user', content: 'Show me the orders and products.' }] },
    () => undefined,
  )
  return { model, logs, answered }
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The tool messages answering the first reply's calls, their content parsed, in call order. */
const readOf = (requests: ScriptedRequest[]): Array<Record<string, unknown>> =>
  toolMessagesOf(requests[1]!).map((m) => JSON.parse(m.content) as Record<string, unknown>)

/** Every key at any depth. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysIn(child)])
}

/** Every string at any depth. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(stringsIn)
}

/** Every string a request carries, a JSON content's strings read unescaped. */
const textsOf = (request: ScriptedRequest): string[] =>
  request.messages.flatMap((m: ChatMessage) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(m.content)
    } catch {
      parsed = undefined
    }
    return [m.content, ...stringsIn(parsed)]
  })

/** The customer fields of a result as the log counts them: strings under a key ending email or phone, address objects. */
function fieldsOf(value: unknown): { email: number; phone: number; address: number } {
  const counts = { email: 0, phone: 0, address: 0 }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== 'object' || node === null) return
    if (Object.hasOwn(node, 'addressLine1')) counts.address += 1
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' && /email$/i.test(key)) counts.email += 1
      else if (typeof child === 'string' && /phone$/i.test(key)) counts.phone += 1
      visit(child)
    }
  }
  visit(value)
  return counts
}

const ordersOf = (s: Scenario) => [...s.listed, ...s.customerOrders, ...s.searched, s.single]

const SUMMARISED_NEVER = ['shippingAddress', 'billingAddress', 'lineItems', 'description']

describe('AC-7: list results reach the model as summaries, then masked', () => {
  it('AC-7: property: with no mask, the request after admin_orders_list, admin_customers_orders and admin_products_list holds items equal to the surface’s items through the order and product summaries, admin_orders_list keeping total, none holding shippingAddress, billingAddress, lineItems or description; admin_search and admin_orders_get reach it as the surface answered; each call’s log line counts fields over the whole result', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const { model, logs, answered } = await runScenario(s, undefined)
        const read = readOf(model.requests)

        expect(read).toEqual([
          json({ items: s.listed.map(expectedOrderSummary), total: s.total }),
          json({ items: s.customerOrders.map(expectedOrderSummary) }),
          json({ items: s.products.map(expectedProductSummary) }),
          json(answered[SEARCH.name]),
          json(answered[ORDER.name]),
        ])
        expect(keysIn(read.slice(0, 3)).filter((key) => SUMMARISED_NEVER.includes(key))).toEqual([])
        const lines = logs.lines.filter((l) => l.msg === 'assistant tool call')
        expect(lines.map((l) => l.obj['fields'])).toEqual(
          CALLS(s).map((call) => fieldsOf(answered[call.name])),
        )
      }),
      { numRuns: 30 },
    )
  }, 60_000)

  it('AC-7: property: under the default mask no request holds any order’s email or postcode, and the listed orders reach the model as their summaries with email and postalCode placeholders, total kept; with mask holding name too, no request holds any order’s first or last name and each summary’s firstName and lastName are name placeholders', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const orders = ordersOf(s)
        const names = orders.flatMap((o) => [
          o.shippingAddress.firstName,
          o.shippingAddress.lastName,
          o.billingAddress.firstName,
          o.billingAddress.lastName,
        ])
        // A name that is also another value of the results (a city, a product's name) is not the name's alone.
        const nameless = orders.map((o) => ({
          ...o,
          shippingAddress: { ...o.shippingAddress, firstName: '', lastName: '' },
          billingAddress: { ...o.billingAddress, firstName: '', lastName: '' },
        }))
        const otherText = new Set([...stringsIn(nameless), ...stringsIn(s.products), 'Done.'])
        fc.pre(names.every((n) => n.length >= 3 && !otherText.has(n)))

        const masked = await runScenario(s, DEFAULT_MASK)
        const held = orders.flatMap((o) => [
          o.email,
          o.shippingAddress.postalCode,
          o.billingAddress.postalCode,
        ])
        const sent = masked.model.requests.flatMap(textsOf)
        expect(held.filter((value) => sent.some((text) => text.includes(value)))).toEqual([])

        const listed = readOf(masked.model.requests)[0]!
        const items = listed['items'] as Array<Record<string, unknown>>
        expect(listed['total']).toBe(s.total)
        expect(
          items.map((item) => ({
            ...item,
            email: /^\[email-\d+\]$/.test(String(item['email'])),
            postalCode: /^\[postcode-\d+\]$/.test(String(item['postalCode'])),
          })),
        ).toEqual(
          s.listed.map((o) => ({
            ...json(expectedOrderSummary(o)),
            email: true,
            postalCode: true,
          })),
        )

        const withNames = await runScenario(s, [...DEFAULT_MASK, 'name'])
        const sentNamed = new Set(withNames.model.requests.flatMap(textsOf).flatMap((t) => [t]))
        expect(names.filter((n) => sentNamed.has(n))).toEqual([])
        const named = readOf(withNames.model.requests)[0]!['items'] as Array<
          Record<string, unknown>
        >
        expect(
          named.map((item) =>
            [item['firstName'], item['lastName']].map((v) => /^\[name-\d+\]$/.test(String(v))),
          ),
        ).toEqual(s.listed.map(() => [true, true]))
      }),
      { numRuns: 25 },
    )
  }, 90_000)
})

describe('AC-3: the model reads each listed order’s kept money and each listed product’s type and options', () => {
  it('AC-3: property: under the default mask, and with name masked too, the request after admin_orders_list and admin_customers_orders holds each order’s keptMinor equal to its capturedMinor less refundedMinor on the surface, emails still placeholders, and the request after admin_products_list holds each product’s type and its variants’ options as the surface answered them', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const orders = ordersOf(s)
        // The mask matches a known value of three characters or more wherever it sits.
        const customerValues = orders
          .flatMap((o) =>
            [o.shippingAddress, o.billingAddress].flatMap((a) => [
              a.firstName,
              a.lastName,
              a.postalCode,
              a.addressLine1,
              o.email,
            ]),
          )
          .filter((value) => value.length >= 3)
        const optionTexts = s.products.flatMap((p) =>
          p.variants.flatMap((v) => v.options.flatMap((o) => [o.name, o.value])),
        )
        fc.pre(
          optionTexts.every((text) =>
            customerValues.every((value) => !text.toLowerCase().includes(value.toLowerCase())),
          ),
        )
        const keptOf = (list: AdminOrder[]) =>
          list.map((o) => [o.orderNumber, o.capturedMinor - o.refundedMinor])

        for (const mask of [DEFAULT_MASK, [...DEFAULT_MASK, 'name']]) {
          const read = readOf((await runScenario(s, mask)).model.requests)
          const listed = read[0]!['items'] as Array<Record<string, unknown>>
          const customers = read[1]!['items'] as Array<Record<string, unknown>>
          const products = read[2]!['items'] as Array<Record<string, unknown>>
          const label = `mask ${JSON.stringify(mask)}`

          expect(
            [...listed, ...customers].map((item) => [item['orderNumber'], item['keptMinor']]),
            label,
          ).toEqual(keptOf([...s.listed, ...s.customerOrders]))
          expect(
            [...listed, ...customers].map((item) => /^\[email-\d+\]$/.test(String(item['email']))),
            label,
          ).toEqual([...s.listed, ...s.customerOrders].map(() => true))
          expect(
            products.map((item) => [
              item['type'],
              (item['variants'] as Array<Record<string, unknown>>).map((v) => v['options']),
            ]),
            label,
          ).toEqual(s.products.map((p) => [p.type, json(p.variants.map((v) => v.options))]))
        }
      }),
      { numRuns: 25 },
    )
  }, 90_000)
})
