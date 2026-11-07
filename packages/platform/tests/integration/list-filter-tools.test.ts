import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORDER_STATUS_TRANSITIONS, type OrderStatus, type ToolResult } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { insertOrders } from '../support/listed-orders.js'
import {
  adminAccount,
  committedRows,
  contentOf,
  customerAccount,
  type Account,
  type ToolSurface,
} from '../support/mcp.js'
import { productIn, reviewer } from '../support/reviews.js'

// The list and lookup tools as the admin's assistant calls them, in process, on a served SQLite kernel: a wrong filter
// is an error naming what the store has, never an empty page the model reports as "0"; a pending review names its
// product; and the path to a guest's orders is the one the descriptions give.

interface Issue {
  path: Array<string | number>
  message: string
}

type Row = Record<string, unknown>

const ORDER_STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]

/** Whether `text` names `value` as a word of its own: `refunded` is not named by `partially_refunded`. */
const names = (text: string, value: string) =>
  new RegExp(`(^|[^A-Za-z_])${value}([^A-Za-z_]|$)`).test(text)

/** The issues of a refused call whose path ends at `key` (`['query', key]` as the route parses it). */
function issuesAt(result: ToolResult, key: string): Issue[] {
  const issues = (contentOf(result).structured['issues'] ?? []) as Issue[]
  return issues.filter((issue) => issue.path[issue.path.length - 1] === key)
}

function itemsOf(result: ToolResult): Row[] {
  return (contentOf(result).structured['items'] ?? []) as Row[]
}

const idsOf = (rows: Row[]) => rows.map((row) => String(row['id'])).sort()

let kernel: Kernel
let served: ServedKernel
let tools: ToolSurface
let admin: Account

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(kernel)
  tools = kernel.app.assistantTools!
  admin = await adminAccount(kernel, served.baseUrl)
  await insertOrders(
    kernel,
    ORDER_STATUSES.map((status) => ({ status })),
  )
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

describe('a wrong status is an error, not an empty page', () => {
  it("AC-3: admin_orders_list { status: 'awaiting_payment' } answers isError validation.failed with an issue at status naming every order status, and { status: 'pending' } answers exactly the store's pending orders", async () => {
    const wrong = await tools.call(
      'admin_orders_list',
      { status: 'awaiting_payment' },
      admin.caller,
    )
    const pending = await tools.call('admin_orders_list', { status: 'pending' }, admin.caller)
    const stored = committedRows<{ id: string }>(
      kernel.target,
      "SELECT id FROM orders WHERE status = 'pending'",
    ).map((row) => row.id)

    expect([wrong.isError ?? false, contentOf(wrong).structured['code']]).toEqual([
      true,
      'validation.failed',
    ])
    expect(
      issuesAt(wrong, 'status').map((issue) =>
        ORDER_STATUSES.filter((status) => !names(issue.message, status)),
      ),
    ).toEqual([[]])
    expect([pending.isError ?? false, idsOf(itemsOf(pending))]).toEqual([false, [...stored].sort()])
  })
})

describe('a search needs words', () => {
  it('AC-5: products_search with q missing, empty or blank answers isError validation.failed', async () => {
    const calls: Row[] = [{}, { q: '' }, { q: '   ' }, { q: '', category: 'mugs' }]

    const answers = await Promise.all(
      calls.map(async (args) => {
        const result = await tools.call('products_search', args, admin.caller)
        return {
          args,
          isError: result.isError ?? false,
          code: contentOf(result).structured['code'],
        }
      }),
    )

    expect(answers).toEqual(
      calls.map((args) => ({ args, isError: true, code: 'validation.failed' })),
    )
  })
})

describe('a date the store cannot read is an error', () => {
  it('AC-10: admin_orders_list with an unparseable dateFrom or dateTo (last week, 2026-13-40, yesterday) answers isError validation.failed with an issue at that key', async () => {
    const cases = [{ dateFrom: 'last week' }, { dateTo: '2026-13-40' }, { dateFrom: 'yesterday' }]

    const answers = await Promise.all(
      cases.map(async (args) => {
        const key = Object.keys(args)[0]!
        const result = await tools.call('admin_orders_list', args, admin.caller)
        return {
          args,
          isError: result.isError ?? false,
          code: contentOf(result).structured['code'],
          atKey: issuesAt(result, key).length === 1,
        }
      }),
    )

    expect(answers).toEqual(
      cases.map((args) => ({ args, isError: true, code: 'validation.failed', atKey: true })),
    )
  })
})

describe('a pending review names its product', () => {
  it('AC-7: admin_reviews_pending carries the items GET /api/admin/reviews answers, each with its product’s current name and slug', async () => {
    const productId = await productIn(kernel, 'active')
    const who = await reviewer(served.baseUrl)
    const submitted = await who.submit({
      productId,
      rating: 5,
      title: 'Lovely glaze',
      body: 'The blue is deeper than the photos.',
    })
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const reviewId = submitted.body.data!.review.id
    const product = await kernel.services.product.getById(productId)

    const res = await fetch(`${served.baseUrl}/api/admin/reviews`, {
      headers: { authorization: `Bearer ${admin.token}`, accept: 'application/json' },
    })
    const route = ((await res.json()) as { data: Row[] }).data
    const result = await tools.call('admin_reviews_pending', {}, admin.caller)
    const named = (rows: Row[]) =>
      rows
        .filter((row) => row['id'] === reviewId)
        .map((row) => [row['productName'], row['productSlug']])

    expect([res.status, result.isError ?? false]).toEqual([200, false])
    expect(itemsOf(result)).toEqual(route)
    expect(named(itemsOf(result))).toEqual([[product.name, product.slug]])
  })
})

describe("a guest's orders are found by email", () => {
  it("AC-8: a guest order placed with a customer's email is not among admin_customers_orders for that customer but is among admin_orders_list { customer: email }, and admin_customers_orders's description sends the model to admin_orders_list customer=", async () => {
    const customer = await customerAccount(kernel, served.baseUrl)
    const [guest, own] = await insertOrders(kernel, [
      { status: 'confirmed', customerId: null, email: customer.email },
      { status: 'confirmed', customerId: customer.userId, email: customer.email },
    ])

    const byAccount = await tools.call(
      'admin_customers_orders',
      { id: customer.userId },
      admin.caller,
    )
    const byEmail = await tools.call(
      'admin_orders_list',
      { customer: customer.email },
      admin.caller,
    )
    const listed = await Promise.resolve(tools.list(admin.caller))
    const description =
      listed.find((tool) => tool.name === 'admin_customers_orders')?.description ?? ''

    expect(idsOf(itemsOf(byAccount))).toEqual([own!.id])
    expect(idsOf(itemsOf(byEmail))).toEqual([guest!.id, own!.id].sort())
    expect(description).toContain('admin_orders_list customer=')
  })
})
