import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '@nymbalhq/types'
import { routeSchemas } from '../routes/schemas.js'
import { addSecret } from '../settings/secret-set.js'
import {
  address,
  cartWith,
  createKernel,
  seedVariant,
  type Kernel,
} from '../../tests/support/kernel.js'
import { shopper } from '../../tests/support/shopper.js'
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

/** A served store; `agents` replaces those blocks of the kernel config's `agents` after `writes` is applied. */
async function openStore(writes?: 'apply', agents: Record<string, unknown> = {}): Promise<Store> {
  const kernel = await createKernel({
    dialect: 'sqlite',
    ...((writes !== undefined || Object.keys(agents).length > 0) && {
      configure: (config) => ({
        ...config,
        agents: {
          ...config.agents,
          ...(writes !== undefined && { mcp: { enabled: true, writes } }),
          ...agents,
        } as typeof config.agents,
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

  it('AC-3: a route whose data is an array answers structuredContent { items, ...meta }: admin_activity_list carries the entries GET /api/admin/activity answers and its nextCursor, and a text block that parses to the same', async () => {
    const store = proposal
    const route = await httpData(store, '/api/admin/activity', store.admin.token)
    const meta = (JSON.parse(route.text) as { meta?: Record<string, unknown> }).meta
    const listed = await store.tools.call('admin_activity_list', {}, store.admin.caller)

    expect(route.status).toBe(200)
    expect(Array.isArray(route.data)).toBe(true)
    expect(listed.isError ?? false).toBe(false)
    expect(listed.structuredContent).toEqual({
      items: route.data,
      nextCursor: meta?.['nextCursor'],
    })
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

// ─── Customer fields an admin's client never receives ───────────────────────────────────────────────────────────────

// AC-4: under agents.mcp.withhold (its default here: email, phone, address, postcode) every result of an admin-scope
// tool loses those values, whatever the route and however the call ran (a read, an applied command, its keyed replay),
// while a shopper's own tools, the public ones, a proposal's run through the inbox and the routes over HTTP answer as
// they did. Two more stores: one approving order.cancel by policy, one withholding all five fields.

const WITHHELD_BY_DEFAULT = ['email', 'phone', 'address', 'postcode']

interface Contact {
  email: string
  phone: string
  street: string
  postcode: string
}

/** A buyer's contact details, each a value no other record of the store holds. */
function contact(pending = false): Contact {
  const tag = randomUUID()
  return {
    email: `buyer-${tag}${pending ? '+stub-pending' : ''}@mcp.test`,
    phone: `07700 9${String(parseInt(tag.slice(0, 5), 16) % 100_000).padStart(5, '0')}`,
    street: `${tag.slice(0, 8)} Withheld Lane`,
    postcode: `SW${1 + (parseInt(tag.slice(9, 10), 16) % 9)} 1AA`,
  }
}

const values = (c: Contact): string[] => [c.email, c.phone, c.street, c.postcode]

/** An order of one unit placed through checkout with `buyer`'s details on both addresses; pending when its email
 *  says so (the payments stub leaves a `+stub-pending` address unpaid). */
async function placedOrder(
  store: Store,
  buyer: Contact,
  customerId?: string,
): Promise<{ orderId: string; orderNumber: string }> {
  const home = {
    ...address,
    addressLine1: buyer.street,
    postalCode: buyer.postcode,
    phone: buyer.phone,
  }
  const cartToken = await cartWith(
    store.kernel,
    {
      productId: store.productId,
      variantId: store.variantId,
      priceMinor: 1000,
      initialStock: 1000,
    },
    1,
  )
  const placed = await store.kernel.services.checkout.beginCheckout({
    cartToken,
    email: buyer.email,
    billingAddress: home,
    shippingAddress: home,
    ...(customerId !== undefined && { customerId }),
  })
  return { orderId: placed.orderId, orderNumber: placed.orderNumber }
}

/** A customer registered over HTTP who saved an address and set a phone, then changed it. */
async function editedCustomer(
  store: Store,
): Promise<{ account: Account; details: Contact; firstPhone: string }> {
  const account = await customerAccount(store.kernel, store.baseUrl)
  const details = { ...contact(), email: account.email }
  const firstPhone = contact().phone
  const shop = shopper(store.baseUrl)
  const bearer = { headers: { authorization: `Bearer ${account.token}` } }
  for (const phone of [firstPhone, details.phone]) {
    const set = await shop.call('PATCH', '/api/customers/me', { phone }, bearer)
    if (set.status !== 200) throw new Error(`PATCH /api/customers/me: ${set.status}`)
  }
  const saved = await shop.call(
    'POST',
    '/api/customers/me/addresses',
    {
      ...address,
      addressLine1: details.street,
      postalCode: details.postcode,
      phone: details.phone,
    },
    bearer,
  )
  if (saved.status >= 300) throw new Error(`POST /api/customers/me/addresses: ${saved.status}`)
  return { account, details, firstPhone }
}

const withheldOf = (result: ToolResult): unknown => contentOf(result).structured['withheld']

/** Which of `wanted` a result's structured content or text block holds. */
const heldBy = (result: ToolResult, wanted: readonly string[]): string[] =>
  wanted.filter((value) => resultText(result).includes(value))

describe('AC-4: an admin-scope tool’s result withholds customer fields, and nothing else does', () => {
  let approving: Store
  let everything: Store

  beforeAll(async () => {
    approving = await openStore(undefined, { autoApprove: ['order.cancel'] })
    everything = await openStore(undefined, {
      mcp: {
        enabled: true,
        writes: 'proposal',
        withhold: ['email', 'phone', 'address', 'postcode', 'name'],
      },
    })
  }, 60_000)

  afterAll(async () => {
    for (const store of [approving, everything]) await store?.served.stop()
  })

  // Kills: a read that answers the order or the customer whole, and a history change that keeps a phone.
  it('AC-4: under the default withhold, an admin’s admin_orders_get, admin_customers_get and admin_customers_history (after the customer edits their phone) carry none of the email, phones, street line and postcode that the same routes answer over HTTP, and carry withheld', async () => {
    const store = proposal
    const buyer = contact()
    const order = await placedOrder(store, buyer)
    const customer = await editedCustomer(store)
    const id = customer.account.userId
    await vi.waitFor(
      async () => {
        const history = await httpData(
          store,
          `/api/admin/customers/${id}/history`,
          store.admin.token,
        )
        if (!history.text.includes(customer.details.phone)) throw new Error('no phone change yet')
      },
      { timeout: 10_000, interval: 50 },
    )
    const reads: Array<[string, Record<string, unknown>, string, string[]]> = [
      [
        'admin_orders_get',
        { orderNumber: order.orderNumber },
        `/api/admin/orders/${order.orderNumber}`,
        values(buyer),
      ],
      ['admin_customers_get', { id }, `/api/admin/customers/${id}`, values(customer.details)],
      [
        'admin_customers_history',
        { id },
        `/api/admin/customers/${id}/history`,
        [customer.firstPhone, customer.details.phone],
      ],
    ]

    const seen = []
    for (const [name, args, path, wanted] of reads) {
      const route = await httpData(store, path, store.admin.token)
      const result = await store.tools.call(name, args, store.admin.caller)
      seen.push({
        name,
        route: wanted.filter((value) => route.text.includes(value)).length,
        tool: heldBy(result, wanted),
        withheld: withheldOf(result),
      })
    }

    expect(seen).toEqual([
      { name: 'admin_orders_get', route: 4, tool: [], withheld: WITHHELD_BY_DEFAULT },
      { name: 'admin_customers_get', route: 4, tool: [], withheld: WITHHELD_BY_DEFAULT },
      {
        name: 'admin_customers_history',
        route: 2,
        tool: [],
        withheld: expect.arrayContaining(['phone']),
      },
    ])
  })

  // Kills: an applied command or its replay answering the whole order.
  it('AC-4: under writes apply and under autoApprove [order.cancel], admin_orders_cancel’s applied result and its keyed replay cancel the order and carry none of its email, phone, street line and postcode, which GET /api/admin/orders/:orderNumber still answers, and carry withheld', async () => {
    const seen = []
    for (const store of [apply, approving]) {
      const buyer = contact(true)
      const order = await placedOrder(store, buyer)
      const idempotencyKey = `mcp:${randomUUID()}`
      const first = await store.tools.call(
        'admin_orders_cancel',
        { id: order.orderId, idempotencyKey },
        store.admin.caller,
      )
      const replay = await store.tools.call(
        'admin_orders_cancel',
        { id: order.orderId, idempotencyKey },
        store.admin.caller,
      )
      const route = await httpData(
        store,
        `/api/admin/orders/${order.orderNumber}`,
        store.admin.token,
      )
      seen.push(
        ...[first, replay].map((result) => ({
          status: contentOf(result).structured['status'],
          held: heldBy(result, values(buyer)),
          withheld: withheldOf(result),
          route: values(buyer).filter((value) => route.text.includes(value)).length,
        })),
      )
    }

    expect(seen).toEqual(
      seen.map(() => ({ status: 'cancelled', held: [], withheld: WITHHELD_BY_DEFAULT, route: 4 })),
    )
  })

  // Kills: a strip keyed on the route's personal marks, which leaves an unmarked route's note whole, or on the caller's
  // rank, which strips the admin's own profile.
  it('AC-4: the unmarked admin_orders_notes answers a note "ring 07700 900123" with [phone withheld] and withheld [phone]; an unknown order’s refusal answers the route’s error alone; the admin’s own customers_me answers what GET /api/customers/me does, the admin’s email in it', async () => {
    const store = proposal
    const order = await placedOrder(store, contact())
    const noted = await shopper(store.baseUrl).call(
      'POST',
      `/api/admin/orders/${order.orderId}/notes`,
      { body: 'ring 07700 900123' },
      { headers: { authorization: `Bearer ${store.admin.token}` } },
    )
    const missing = `NYM-none-${randomUUID()}`

    const notes = await store.tools.call(
      'admin_orders_notes',
      { id: order.orderId },
      store.admin.caller,
    )
    const notesRoute = await httpData(
      store,
      `/api/admin/orders/${order.orderId}/notes`,
      store.admin.token,
    )
    const refused = await store.tools.call(
      'admin_orders_get',
      { orderNumber: missing },
      store.admin.caller,
    )
    const refusedRoute = await fetch(`${store.baseUrl}/api/admin/orders/${missing}`, {
      headers: { authorization: `Bearer ${store.admin.token}` },
    })
    const error = ((await refusedRoute.json()) as { error: { code: string; message: string } })
      .error
    const me = await store.tools.call('customers_me', {}, store.admin.caller)
    const meRoute = await httpData(store, '/api/customers/me', store.admin.token)
    const bodies = (data: unknown) =>
      ((data ?? []) as Array<{ body: string }>).map((note) => note.body)

    expect(noted.status).toBe(200)
    expect(bodies(contentOf(notes).structured['items'])).toEqual(
      bodies(notesRoute.data).map((body) => body.replaceAll('07700 900123', '[phone withheld]')),
    )
    expect(bodies(notesRoute.data)).toContain('ring 07700 900123')
    expect(withheldOf(notes)).toEqual(['phone'])
    expect([refused.isError, refused.structuredContent]).toEqual([
      true,
      { code: error.code, message: error.message },
    ])
    expect(me.structuredContent).toEqual(meRoute.data)
    expect(contentOf(me).structured['email']).toBe(store.admin.email)
  })

  // Kills: a strip keyed on the caller (a shopper's own data withheld) or on the data (a public result withheld).
  it('AC-4: under the default and under all five fields withheld, a shopper’s own orders_list and customers_me answer what GET /api/orders and GET /api/customers/me answer them, their email and address in it, and capabilities_get what GET /api/capabilities answers, while the admin’s admin_customers_get of that shopper carries neither their email nor their phone', async () => {
    const seen = []
    for (const store of [proposal, everything]) {
      const customer = await editedCustomer(store)
      await placedOrder(store, customer.details, customer.account.userId)
      const own = customer.account
      const orders = await store.tools.call('orders_list', {}, own.caller)
      const me = await store.tools.call('customers_me', {}, own.caller)
      const capabilities = await store.tools.call('capabilities_get', {}, store.admin.caller)
      const admin = await store.tools.call(
        'admin_customers_get',
        { id: own.userId },
        store.admin.caller,
      )
      seen.push({
        orders: orders.structuredContent,
        ordersRoute: structuredOfRoute(await httpData(store, '/api/orders', own.token)),
        ordersHold: heldBy(orders, [own.email, customer.details.street, customer.details.postcode]),
        me: me.structuredContent,
        meRoute: (await httpData(store, '/api/customers/me', own.token)).data,
        meHolds: heldBy(me, [own.email]),
        capabilities: capabilities.structuredContent,
        capabilitiesRoute: (await httpData(store, '/api/capabilities')).data,
        admin: heldBy(admin, [own.email, customer.details.phone]),
      })
    }

    expect(seen).toEqual(
      seen.map((one) => ({
        ...one,
        orders: one.ordersRoute,
        ordersHold: [expect.any(String), expect.any(String), expect.any(String)],
        me: one.meRoute,
        meHolds: [expect.any(String)],
        capabilities: one.capabilitiesRoute,
        admin: [],
      })),
    )
  })

  // Kills: the inbox's run (the invoker's execute()) losing fields an admin approves on.
  it('AC-4: under the default writes, admin_orders_cancel answers status proposed and nothing else; that proposal’s run through the invoker’s execute() returns the cancelled order with its email, phone, street line and postcode, while admin_orders_get of the same order carries none of them', async () => {
    const store = proposal
    const buyer = contact(true)
    const order = await placedOrder(store, buyer)

    const proposed = contentOf(
      await store.tools.call('admin_orders_cancel', { id: order.orderId }, store.admin.caller),
    ).structured
    const executed = await store.kernel.app.services.proposals.run(
      String(proposed['id']),
      { kind: 'admin', id: store.admin.userId },
      { userId: store.admin.userId, roles: ['admin'] },
    )
    const read = await store.tools.call(
      'admin_orders_get',
      { orderNumber: order.orderNumber },
      store.admin.caller,
    )

    expect(proposed).toEqual({
      status: 'proposed',
      id: proposed['id'],
      tool: 'admin_orders_cancel',
      command: 'order.cancel',
    })
    expect({
      status: contentOf(executed.result).structured['status'],
      held: heldBy(executed.result, values(buyer)),
      withheld: withheldOf(executed.result),
    }).toEqual({ status: 'cancelled', held: values(buyer), withheld: undefined })
    expect(heldBy(read, values(buyer))).toEqual([])
  })
})

/** A route's answer as a tool answers it: an array becomes `{ items }`, its meta (a `nextCursor`) beside them. */
function structuredOfRoute(answer: { data: unknown; text: string }): unknown {
  const { meta } = JSON.parse(answer.text) as { meta?: Record<string, unknown> }
  return Array.isArray(answer.data) ? { ...meta, items: answer.data } : answer.data
}
