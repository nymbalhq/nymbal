import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '@nymbalhq/types'
import { routeSchemas } from '../routes/schemas.js'
import { addSecret } from '../settings/secret-set.js'
import { address, createKernel, seedVariant, type Kernel } from '../../tests/support/kernel.js'
import { serveKernel, type ServedKernel } from '../../tests/support/http.js'
import {
  AGENT,
  ANONYMOUS,
  adminAccount,
  cartHandleOf,
  committedAudit,
  committedCount,
  committedRows,
  committedStock,
  contentOf,
  customerAccount,
  productBody,
  resultText,
  toolSurface,
  type Account,
  type ToolSurface,
} from '../../tests/support/mcp.js'

// AC-3 to AC-8: a tool call is the route's own request, run in process through the handler the HTTP adapter runs.
// Two stores, each a SQLite kernel served over HTTP so a tool's answer can be held against the route's: one on the
// default writes (proposal), one with `agents.mcp.writes: 'apply'`. A proposal is a row of the store's `proposals`
// table, read on a connection of its own.

interface Store {
  served: ServedKernel
  kernel: Kernel
  baseUrl: string
  /** The SQLite file, read on connections of its own. */
  file: string
  tools: ToolSurface
  admin: Account
  customer: Account
  /** An active product's one variant, stock 1000. */
  productId: string
  variantId: string
}

async function openStore(writes?: 'apply'): Promise<Store> {
  const kernel = await createKernel({
    dialect: 'sqlite',
    ...(writes !== undefined && {
      configure: (config) => ({
        ...config,
        agents: { ...config.agents, mcp: { enabled: true, writes } },
      }),
    }),
  })
  const served = await serveKernel(kernel)
  const seeded = await seedVariant(kernel, 1000)
  // The public listing is a projection: it is read once it holds the seeded product.
  await vi.waitFor(
    async () => {
      const res = await fetch(
        `${served.baseUrl}/api/products/${await slugOf(kernel, seeded.productId)}`,
      )
      if (res.status !== 200) throw new Error(`GET /api/products/:slug ${res.status}`)
    },
    { timeout: 10_000, interval: 50 },
  )
  const admin = await adminAccount(kernel, served.baseUrl)
  const customer = await customerAccount(kernel, served.baseUrl)
  return {
    served,
    kernel,
    baseUrl: served.baseUrl,
    file: kernel.target,
    tools: toolSurface(kernel.app),
    admin,
    customer,
    productId: seeded.productId,
    variantId: seeded.variantId,
  }
}

async function slugOf(kernel: Kernel, productId: string): Promise<string> {
  const product = await kernel.store.read((tx) => kernel.repos.product.findById(tx, productId))
  return product!.slug
}

async function httpData(
  store: Store,
  path: string,
  token?: string,
): Promise<{ status: number; data: unknown; text: string }> {
  const res = await fetch(`${store.baseUrl}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, data: (JSON.parse(text) as { data?: unknown }).data, text }
}

function lines(result: ToolResult): Array<{ variantId: string; qty: number }> {
  const items = (contentOf(result).structured['items'] ?? []) as Array<{
    variantId: string
    qty: number
  }>
  return items.map(({ variantId, qty }) => ({ variantId, qty }))
}

interface StoredProposal {
  id: string
  tool: string
  command: string
  args: string
  proposer_id: string | null
  agent_name: string
  agent_version: string | null
  status: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The `proposals` rows as committed, by id. */
function storedProposals(file: string): Map<string, StoredProposal> {
  const rows = committedRows<StoredProposal>(
    file,
    'SELECT id, tool, command, args, proposer_id, agent_name, agent_version, status FROM proposals',
  )
  return new Map(rows.map((row) => [row.id, row]))
}

function tableCounts(file: string): Record<string, number> {
  return {
    products: committedCount(file, 'products'),
    orders: committedCount(file, 'orders'),
    audit_entries: committedCount(file, 'audit_entries'),
  }
}

let proposal: Store
let apply: Store

beforeAll(async () => {
  proposal = await openStore()
  apply = await openStore('apply')
}, 60_000)

afterAll(async () => {
  for (const store of [proposal, apply]) {
    if (store === undefined) continue
    await store.served.stop()
  }
})

describe('AC-3: a read tool answers what its route answers', () => {
  it('AC-3: products_list and admin_products_get carry as structuredContent, and as a text block that parses to it, the data GET /api/products and GET /api/admin/products/:id answer', async () => {
    const store = proposal
    const listing = await httpData(store, '/api/products')
    const listed = await store.tools.call('products_list', {}, ANONYMOUS)
    const detail = await httpData(
      store,
      `/api/admin/products/${store.productId}`,
      store.admin.token,
    )
    const got = await store.tools.call(
      'admin_products_get',
      { id: store.productId },
      store.admin.caller,
    )

    expect([listing.status, detail.status]).toEqual([200, 200])
    expect([listed.isError ?? false, got.isError ?? false]).toEqual([false, false])
    expect(listed.structuredContent).toEqual(listing.data)
    expect(contentOf(listed).text).toEqual(listing.data)
    expect(got.structuredContent).toEqual(detail.data)
    expect(contentOf(got).text).toEqual(detail.data)
  })

  it('AC-3: a route whose data is an array answers structuredContent { items }: admin_activity_list carries the entries GET /api/admin/activity answers, and a text block that parses to the same', async () => {
    const store = proposal
    const route = await httpData(store, '/api/admin/activity', store.admin.token)
    const listed = await store.tools.call('admin_activity_list', {}, store.admin.caller)

    expect(route.status).toBe(200)
    expect(Array.isArray(route.data)).toBe(true)
    expect(listed.isError ?? false).toBe(false)
    expect(listed.structuredContent).toEqual({ items: route.data })
    expect(contentOf(listed).text).toEqual(listed.structuredContent)
  })

  it("AC-3: admin_products_get with at: 42 answers isError, validation.failed, with the issues the route's own query schema gives", async () => {
    const store = proposal
    const parsed = routeSchemas['GET /api/admin/products/:id']!.query!.safeParse({ at: 42 })
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: ['query', ...issue.path],
          message: issue.message,
        }))

    const bad = await store.tools.call(
      'admin_products_get',
      { id: store.productId, at: 42 },
      store.admin.caller,
    )

    expect(issues).not.toEqual([])
    expect(bad.isError).toBe(true)
    expect(contentOf(bad).structured).toMatchObject({ code: 'validation.failed', issues })
    expect(contentOf(bad).text).toEqual(bad.structuredContent)
  })

  it("AC-3: cart_addItem with an argument its route does not declare (quantity) answers validation.failed with the issue the route's strict body gives, and adds no line", async () => {
    const store = proposal
    const cart = cartHandleOf(await store.tools.call('cart_get', {}, ANONYMOUS))
    const parsed = routeSchemas['POST /api/cart/items']!.body!.safeParse({
      variantId: store.variantId,
      quantity: 2,
    })
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: ['body', ...issue.path],
          message: issue.message,
        }))

    const bad = await store.tools.call(
      'cart_addItem',
      { cart, variantId: store.variantId, quantity: 2 },
      ANONYMOUS,
    )

    expect(issues).not.toEqual([])
    expect(bad.isError).toBe(true)
    expect(contentOf(bad).structured).toMatchObject({ code: 'validation.failed', issues })
    expect(lines(await store.tools.call('cart_get', { cart }, ANONYMOUS))).toEqual([])
  })
})

describe('AC-4: the route gate refuses a call outside the caller', () => {
  it('AC-4: under apply, admin_products_create is refused auth.unauthorized for an anonymous caller and auth.forbidden for a customer, and neither creates the product or writes an audit entry', async () => {
    const store = apply
    const before = tableCounts(store.file)
    const outcomes: Array<{ isError: boolean; code: unknown; created: number }> = []
    for (const caller of [ANONYMOUS, store.customer.caller]) {
      const body = productBody()
      const result = await store.tools.call('admin_products_create', body, caller)
      outcomes.push({
        isError: result.isError ?? false,
        code: contentOf(result).structured['code'],
        created: committedCount(store.file, 'products', 'slug = ?', [body.slug]),
      })
    }

    expect(outcomes).toEqual([
      { isError: true, code: 'auth.unauthorized', created: 0 },
      { isError: true, code: 'auth.forbidden', created: 0 },
    ])
    expect(tableCounts(store.file)).toEqual(before)
  })
})

describe('AC-5: writes are proposals by default', () => {
  it('AC-5: with writes unset, admin_products_create with a valid body answers proposed with the id of the one proposals row it writes, runs nothing, and the row holds the sent arguments, the command, the admin and the agent, pending', async () => {
    const store = proposal
    const body = productBody()
    const before = tableCounts(store.file)
    const held = storedProposals(store.file)

    const result = await store.tools.call('admin_products_create', body, store.admin.caller)
    const answer = contentOf(result).structured
    const added = [...storedProposals(store.file).values()].filter((row) => !held.has(row.id))

    expect(result.isError ?? false).toBe(false)
    expect(added).toHaveLength(1)
    expect(answer).toMatchObject({
      status: 'proposed',
      id: added[0]!.id,
      tool: 'admin_products_create',
      command: 'product.create',
    })
    expect(answer['id']).toMatch(UUID)
    expect(tableCounts(store.file)).toEqual(before)
    expect(committedCount(store.file, 'products', 'slug = ?', [body.slug])).toBe(0)
    expect({ ...added[0]!, args: JSON.parse(added[0]!.args) as unknown }).toEqual({
      id: answer['id'],
      tool: 'admin_products_create',
      command: 'product.create',
      args: body,
      proposer_id: store.admin.userId,
      agent_name: AGENT.name,
      agent_version: AGENT.version,
      status: 'pending',
    })
  })

  it('AC-5: an invalid proposal answers validation.failed and an anonymous one auth.unauthorized, and neither writes a proposals row', async () => {
    const store = proposal
    const held = storedProposals(store.file).size
    const { slug: _dropped, ...noSlug } = productBody()

    const invalid = await store.tools.call('admin_products_create', noSlug, store.admin.caller)
    const anonymous = await store.tools.call('admin_products_create', productBody(), ANONYMOUS)

    expect([invalid.isError, anonymous.isError]).toEqual([true, true])
    expect(contentOf(invalid).structured['code']).toBe('validation.failed')
    expect(contentOf(anonymous).structured['code']).toBe('auth.unauthorized')
    expect(storedProposals(store.file).size).toBe(held)
  })

  it('AC-5: property: under the default writes, any sequence of command tool calls by an admin leaves the product, order and audit tables as they were', async () => {
    const store = proposal
    const commands = (await Promise.resolve(store.tools.list(store.admin.caller)))
      .filter((tool) => tool.kind === 'command')
      .map((tool) => tool.name)
    const argPool: Array<Record<string, unknown>> = [
      {},
      { id: store.productId },
      { id: store.productId, name: 'Renamed by an agent' },
      { variantId: store.variantId, delta: -3, reason: 'manual' },
      { ...productBody() },
      { orderNumber: 'NYM-000001', email: 'agent@mcp.test' },
      { email: 'agent@mcp.test', billingAddress: address, shippingAddress: address },
    ]

    expect(commands).toEqual(expect.arrayContaining(['admin_products_create', 'checkout_begin']))
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(...commands), fc.constantFrom(...argPool)), {
          minLength: 1,
          maxLength: 6,
        }),
        async (calls) => {
          const before = tableCounts(store.file)
          for (const [name, args] of calls) await store.tools.call(name, args, store.admin.caller)

          expect(tableCounts(store.file)).toEqual(before)
        },
      ),
      { numRuns: 12 },
    )
  }, 30_000)
})

describe('AC-6: under apply a write runs as the route runs it', () => {
  it("AC-6: admin_products_create creates the product, and the newest audit entry is product.create by the bearer's admin, applied", async () => {
    const store = apply
    const body = productBody()

    const result = await store.tools.call('admin_products_create', body, store.admin.caller)
    const created = contentOf(result).structured
    const newest = committedAudit(store.file).at(-1)

    expect(result.isError ?? false).toBe(false)
    expect(created['slug']).toBe(body.slug)
    expect(committedCount(store.file, 'products', 'slug = ?', [body.slug])).toBe(1)
    expect(newest).toMatchObject({
      command: 'product.create',
      actorKind: 'admin',
      actorId: store.admin.userId,
      outcome: 'applied',
    })
    expect(newest!.subjectIds).toContain(created['id'])
  })

  it('AC-6: two admin_products_create calls with one idempotencyKey leave one product, answer the same product, and audit applied then replayed', async () => {
    const store = apply
    const body = productBody()
    const idempotencyKey = `mcp:${randomUUID()}`

    const first = await store.tools.call(
      'admin_products_create',
      { ...body, idempotencyKey },
      store.admin.caller,
    )
    const second = await store.tools.call(
      'admin_products_create',
      { ...body, idempotencyKey },
      store.admin.caller,
    )
    const keyed = committedAudit(store.file, idempotencyKey)

    expect([first.isError ?? false, second.isError ?? false]).toEqual([false, false])
    expect(contentOf(second).structured['id']).toBe(contentOf(first).structured['id'])
    expect(committedCount(store.file, 'products', 'slug = ?', [body.slug])).toBe(1)
    expect(keyed.map((entry) => entry.outcome).sort()).toEqual(['applied', 'replayed'])
  })

  it('AC-6: cart_addItem, a session tool, runs under the default writes and under apply alike: the line it adds is in the cart it names', async () => {
    const seen: Array<{ isError: boolean; lines: Array<{ variantId: string; qty: number }> }> = []
    for (const store of [proposal, apply]) {
      const cart = cartHandleOf(await store.tools.call('cart_get', {}, ANONYMOUS))
      const added = await store.tools.call(
        'cart_addItem',
        { cart, variantId: store.variantId, qty: 1 },
        ANONYMOUS,
      )
      seen.push({
        isError: added.isError ?? false,
        lines: lines(await store.tools.call('cart_get', { cart }, ANONYMOUS)),
      })
    }

    expect(seen).toEqual([
      { isError: false, lines: [{ variantId: proposal.variantId, qty: 1 }] },
      { isError: false, lines: [{ variantId: apply.variantId, qty: 1 }] },
    ])
  })
})

describe('AC-7: the cart travels as a handle', () => {
  it('AC-7: cart_get with no cart answers a handle; the line cart_addItem adds under it is read back under it, and a fresh handle holds none', async () => {
    const store = apply
    const opened = await store.tools.call('cart_get', {}, ANONYMOUS)
    const cart = cartHandleOf(opened)
    const fresh = cartHandleOf(await store.tools.call('cart_get', {}, ANONYMOUS))

    await store.tools.call('cart_addItem', { cart, variantId: store.variantId, qty: 2 }, ANONYMOUS)

    expect(typeof cart === 'string' && typeof fresh === 'string' && cart !== fresh).toBe(true)
    expect(lines(await store.tools.call('cart_get', { cart }, ANONYMOUS))).toEqual([
      { variantId: store.variantId, qty: 2 },
    ])
    expect(lines(await store.tools.call('cart_get', { cart: fresh }, ANONYMOUS))).toEqual([])
  })

  it("AC-7: property: under apply, checkout_begin on a handle places an order whose one line is the handle's variant and quantity, and the variant's stock falls by exactly that quantity", async () => {
    const store = apply
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (qty) => {
        const cart = cartHandleOf(await store.tools.call('cart_get', {}, ANONYMOUS))
        await store.tools.call('cart_addItem', { cart, variantId: store.variantId, qty }, ANONYMOUS)
        const before = committedStock(store.file, store.variantId)

        const placed = await store.tools.call(
          'checkout_begin',
          {
            cart,
            email: `agent-${randomUUID()}@mcp.test`,
            billingAddress: address,
            shippingAddress: address,
          },
          ANONYMOUS,
        )
        const orderNumber = contentOf(placed).structured['orderNumber']
        const order = await store.tools.call(
          'admin_orders_get',
          { orderNumber },
          store.admin.caller,
        )
        const lineItems = (contentOf(order).structured['lineItems'] ?? []) as Array<{
          variantId: string
          qty: number
        }>

        expect(placed.isError ?? false).toBe(false)
        expect(lineItems.map(({ variantId, qty: n }) => ({ variantId, qty: n }))).toEqual([
          { variantId: store.variantId, qty },
        ])
        expect(committedStock(store.file, store.variantId)).toBe(before - qty)
      }),
      { numRuns: 4 },
    )
  }, 30_000)
})

describe('AC-8: no result carries a secret or the bearer', () => {
  it("AC-8: a registered secret in a product's description reaches neither the text block nor the structuredContent of products_get, though the route itself answers it", async () => {
    const store = apply
    const secret = `mcp-secret-${randomUUID()}`
    addSecret(secret)
    const body = productBody()
    await store.kernel.services.product.create({
      ...body,
      description: `Care instructions: ${secret}`,
    })
    const route = await vi.waitFor(
      async () => {
        const answer = await httpData(store, `/api/products/${body.slug}`)
        if (answer.status !== 200)
          throw new Error(`GET /api/products/${body.slug} ${answer.status}`)
        return answer
      },
      { timeout: 10_000, interval: 50 },
    )

    const result = await store.tools.call('products_get', { slug: body.slug }, ANONYMOUS)

    expect(route.text).toContain(secret)
    expect(result.isError ?? false).toBe(false)
    expect(contentOf(result).structured['slug']).toBe(body.slug)
    expect(result.content[0]!.text).not.toContain(secret)
    expect(JSON.stringify(result.structuredContent)).not.toContain(secret)
  })

  it("AC-8: no result, answered or refused, carries the caller's bearer token", async () => {
    const store = apply
    const calls: Array<[string, Record<string, unknown>, Account]> = [
      ['admin_me', {}, store.admin],
      ['products_list', {}, store.admin],
      ['admin_products_get', { id: store.productId }, store.admin],
      ['admin_orders_get', { orderNumber: 'NYM-none' }, store.admin],
      ['cart_get', {}, store.admin],
      ['customers_me', {}, store.customer],
      ['admin_products_list', {}, store.customer],
    ]
    const leaks: string[] = []
    for (const [name, args, account] of calls) {
      const result = await store.tools.call(name, args, account.caller)
      if (resultText(result).includes(account.token)) leaks.push(name)
    }

    expect(leaks).toEqual([])
  })
})

describe('AC-13: a tool listed for nobody does not run', () => {
  it('AC-13: orders_get, listed for nobody, answers isError tool.unknown in process for every caller, as a name no tool has does, and writes no audit entry', async () => {
    const store = apply
    const audit = committedCount(store.file, 'audit_entries')
    const answers: Array<[unknown, unknown, unknown]> = []
    for (const caller of [ANONYMOUS, store.customer.caller, store.admin.caller]) {
      const unlisted = await store.tools.call('orders_get', { orderNumber: 'NYM-000001' }, caller)
      const unknown = await store.tools.call(
        'orders_nonexistent',
        { orderNumber: 'NYM-000001' },
        caller,
      )
      answers.push([
        contentOf(unlisted).structured['code'],
        contentOf(unknown).structured['code'],
        unlisted.isError,
      ])
    }

    expect(answers).toEqual(answers.map(() => ['tool.unknown', 'tool.unknown', true]))
    expect(committedCount(store.file, 'audit_entries')).toBe(audit)
  })
})
