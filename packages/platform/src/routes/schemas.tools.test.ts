import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORDER_STATUS_TRANSITIONS, type ToolDefinition } from '@nymbalhq/types'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import { jsonSchemaOf, toolsOf } from '../mcp/registry.js'
import { RouteTable, recordingAdapter } from '../mcp/route-table.js'
import { routeSchemas } from './schemas.js'

// What the model reads of the list and lookup tools: the inputSchema and description the registry derives from
// routeSchemas, over a route table filled the way attachHttp fills the app's own.

/** A branch of a property that takes strings it does not name. */
const FREE = '<any string>'

/** Every status a row of each list can have: the filter must offer exactly these. */
const STATUSES: Record<string, string[]> = {
  admin_orders_list: Object.keys(ORDER_STATUS_TRANSITIONS),
  admin_products_list: ['draft', 'active', 'archived'],
  admin_inventory_list: ['in_stock', 'low_stock', 'out_of_stock'],
}

const DESCRIBED = [...Object.keys(STATUSES), 'products_search']

type Json = Record<string, unknown>

/** The values a JSON Schema property accepts: an enum's values, or FREE for a branch with no enum. */
function accepted(property: unknown): string[] {
  const p = (property ?? {}) as Json
  const branches = (p['anyOf'] ?? p['oneOf']) as unknown[] | undefined
  if (Array.isArray(branches)) return branches.flatMap(accepted)
  if (Array.isArray(p['enum'])) return (p['enum'] as unknown[]).map(String)
  return [FREE]
}

/** Whether `text` names `value` as a word of its own: `refunded` is not named by `partially_refunded`. */
function names(text: string, value: string): boolean {
  return new RegExp(`(^|[^A-Za-z_])${value}([^A-Za-z_]|$)`).test(text)
}

/** Every `description` string anywhere in a JSON Schema. */
function descriptionsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptionsIn)
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : descriptionsIn(value),
  )
}

const TOOL_SHAPED = /\b[a-z]+(?:_[a-zA-Z]+)+\b/g

/** Where a description sends the model elsewhere: the entry, and the tool it names. */
const REFERENCES: Array<[string, string]> = [
  ['admin.products.get', 'admin_products_list'],
  ['admin.customers.orders', 'admin_orders_list'],
  ['products.search', 'products_list'],
]

let kernel: Kernel
let tools: ToolDefinition[]

function tool(name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

function properties(name: string): Record<string, Json> {
  return ((tool(name).inputSchema as { properties?: Record<string, Json> }).properties ??
    {}) as Record<string, Json>
}

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  const table = new RouteTable()
  const nothing = {
    registerRoute() {},
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  await kernel.app.attachHttp(recordingAdapter(table, nothing), { adminRoot: null })
  tools = toolsOf(table)
}, 30_000)

afterAll(async () => {
  await kernel?.close()
})

describe('a status filter offers exactly the statuses the store has', () => {
  it("AC-1: the status property of admin_orders_list, admin_products_list and admin_inventory_list accepts exactly the store's statuses (the order transitions' keys, draft/active/archived, in_stock/low_stock/out_of_stock) and no string outside them", () => {
    const offered = Object.fromEntries(
      Object.keys(STATUSES).map((name) => [
        name,
        [...new Set(accepted(properties(name)['status']))].sort(),
      ]),
    )
    expect(offered).toEqual(
      Object.fromEntries(
        Object.entries(STATUSES).map(([name, values]) => [name, [...values].sort()]),
      ),
    )
  })
})

describe('every filter says what it matches', () => {
  it('AC-4: every property of admin_orders_list, admin_products_list, admin_inventory_list and products_search carries a non-empty description, and each status description names every status its filter offers', () => {
    const undescribed = DESCRIBED.flatMap((name) =>
      Object.entries(properties(name))
        .filter(([, p]) => typeof p['description'] !== 'string' || p['description'].trim() === '')
        .map(([key]) => `${name}.${key}`),
    )
    const unnamed = Object.entries(STATUSES).flatMap(([name, values]) => {
      const text = String(properties(name)['status']?.['description'] ?? '')
      return values
        .filter((value) => !names(text, value))
        .map((value) => `${name}.status: ${value}`)
    })

    expect({ undescribed, unnamed }).toEqual({ undescribed: [], unnamed: [] })
  })
})

describe('a search needs words', () => {
  it("AC-5: products_search's inputSchema requires q, and the route's query schema refuses a missing, empty or blank q at q while a q with words parses", () => {
    const query = routeSchemas['GET /api/products/search']!.query!
    const refusedAt = (input: unknown): string[] => {
      const parsed = query.safeParse(input)
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))
    }
    const required = (tool('products_search').inputSchema as { required?: string[] }).required ?? []

    expect({
      requiresQ: required.includes('q'),
      missing: refusedAt({}),
      empty: refusedAt({ q: '' }),
      blank: refusedAt({ q: '   ', category: 'mugs' }),
      words: refusedAt({ q: 'ceramic mug' }),
    }).toEqual({ requiresQ: true, missing: ['q'], empty: ['q'], blank: ['q'], words: [] })
  })
})

describe('descriptions send the model to tools that exist', () => {
  it('AC-9: every tool-shaped token in any route description or filter description names a tool the registry lists, and the get, customer-orders and search descriptions name admin_products_list, admin_orders_list and products_list', () => {
    const listed = new Set(tools.map((t) => t.name))
    const prefixes = new Set(tools.map((t) => t.name.split('_')[0]!))
    const texts = Object.values(routeSchemas).flatMap((entry) => [
      { where: entry.name, text: entry.description },
      ...descriptionsIn(jsonSchemaOf(entry)).map((text) => ({
        where: `${entry.name} (input)`,
        text,
      })),
    ])
    const tokens = texts.flatMap(({ where, text }) =>
      [...text.matchAll(TOOL_SHAPED)]
        .map((match) => match[0])
        .filter((token) => prefixes.has(token.split('_')[0]!))
        .map((token) => ({ where, token })),
    )
    const sends = (where: string, to: string) =>
      tokens.some((t) => t.where === where && t.token === to)
    const unsent = REFERENCES.filter(([where, to]) => !sends(where, to)).map(
      ([where, to]) => `${where} → ${to}`,
    )

    expect(tokens.filter((t) => !listed.has(t.token))).toEqual([])
    expect(unsent).toEqual([])
  })

  it("AC-9: admin_products_get's description takes the id or slug from a tool result, says never guess, and names admin_products_list to find a product by name", () => {
    const text = tool('admin_products_get').description

    expect({
      fromToolResult: /tool result/i.test(text),
      neverGuess: /never guess/i.test(text),
      findsByName: names(text, 'admin_products_list'),
    }).toEqual({ fromToolResult: true, neverGuess: true, findsByName: true })
  })
})
