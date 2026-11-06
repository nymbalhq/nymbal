import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  type PaymentsAdapter,
  type ProposalPage,
  type ProposalView,
  type Refund,
} from '@nymbalhq/types'
import { auditRows, type AuditRow } from '../audit.js'
import { adminSession, customerSession, type AdminSession, type Answer } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, checkoutOf, createKernel, seedVariant, type Kernel } from '../kernel.js'
import {
  AGENT,
  ANONYMOUS,
  adminAccount,
  cartHandleOf,
  contentOf,
  customerAccount,
  productBody,
  toolSurface,
  type Account,
  type ToolSurface,
} from '../mcp.js'
import { storedMoney, storedRefunds } from '../money.js'
import { eventRows, maxSeq, type EventRow } from '../outbox.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { shopper } from '../shopper.js'

// Agent writes as rows a person decides: the `proposals` table, the `proposal.*` events, the admin's approve and reject
// routes, and the policies that approve a command at the call. Each store is a kernel served over HTTP on a database
// of its own, read back on a second connection; agents call through the app's in-process tool surface, admins over
// HTTP. Nothing here knows how the table is written or how an approval runs the command.

type Dialect = Kernel['dialect']

/** A fresh, empty database: its target and how to drop it afterwards. */
export type FreshDatabase = (label: string) => Promise<{ target: string; drop(): Promise<void> }>

type Configure = (config: NymbalConfig) => NymbalConfig

const withWrites =
  (writes: 'proposal' | 'apply'): Configure =>
  (config) => ({ ...config, agents: { ...config.agents, mcp: { ...config.agents.mcp, writes } } })

const withAutoApprove =
  (commands: string[]): Configure =>
  (config) => ({ ...config, agents: { ...config.agents, autoApprove: commands } })

const DECIDED = ['approved', 'rejected', 'applied', 'failed']

interface Store {
  kernel: Kernel
  served: ServedKernel
  baseUrl: string
  raw: RawReader
  tools: ToolSurface
  /** The admin an agent signs in as. */
  proposer: Account
  /** A second admin, over HTTP: the one who approves and rejects. */
  approver: AdminSession
  customer: Account
  /** An active product's one variant, stock 1000. */
  productId: string
  variantId: string
  close(): Promise<void>
}

async function openStore(
  dialect: Dialect,
  fresh: FreshDatabase,
  label: string,
  configure?: Configure,
): Promise<Store> {
  const db = await fresh(label)
  const kernel = await createKernel({
    ...(dialect === 'sqlite'
      ? { dialect: 'sqlite' as const, sqlitePath: db.target }
      : { dialect: 'postgres' as const, postgresUrl: db.target }),
    ...(configure !== undefined && { configure }),
  })
  const served = await serveKernel(kernel)
  const raw = openRaw(dialect, db.target)
  const seeded = await seedVariant(kernel, 1000)
  // The cart reads the product from the read side: it is used once the listing holds it.
  await vi.waitFor(
    async () => {
      const product = await kernel.store.read((tx) =>
        kernel.repos.product.findById(tx, seeded.productId),
      )
      const res = await fetch(`${served.baseUrl}/api/products/${product!.slug}`)
      if (res.status !== 200) throw new Error(`GET /api/products/:slug ${res.status}`)
    },
    { timeout: 10_000, interval: 50 },
  )
  const proposer = await adminAccount(kernel, served.baseUrl)
  const approver = await adminSession(kernel, served.baseUrl)
  const customer = await customerAccount(kernel, served.baseUrl)
  return {
    kernel,
    served,
    baseUrl: served.baseUrl,
    raw,
    tools: toolSurface(kernel.app),
    proposer,
    approver,
    customer,
    productId: seeded.productId,
    variantId: seeded.variantId,
    async close() {
      await raw.close()
      try {
        await served.stop()
      } finally {
        await db.drop()
      }
    },
  }
}

/** Stores opened once per name on first use and closed after the suite. */
function storePool(dialect: Dialect, fresh: FreshDatabase) {
  const open = new Map<string, Promise<Store>>()
  return {
    get(name: string, configure?: Configure): Promise<Store> {
      let store = open.get(name)
      if (store === undefined) {
        store = openStore(dialect, fresh, name, configure)
        open.set(name, store)
      }
      return store
    },
    async closeAll(): Promise<void> {
      for (const store of open.values()) {
        await (await store.catch(() => undefined))?.close()
      }
      open.clear()
    },
  }
}

// --- the table, as a second connection reads it ------------------------------------------------------------------

interface ProposalRow {
  id: string
  tool: string
  command: string
  args: unknown
  handles: unknown
  idempotencyKey: string | null
  proposerId: string | null
  agentName: string
  agentVersion: string | null
  correlationId: string
  status: string
  decidedByKind: string | null
  decidedBy: string | null
  reason: string | null
  outcomeStatus: number | null
  outcomeCode: string | null
  /** Every column as read, for a search of the whole row. */
  columns: Record<string, unknown>
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

async function proposalRows(raw: RawReader, where?: string, params: unknown[] = []) {
  const rows = await raw.rows<Record<string, unknown>>(
    `SELECT * FROM proposals${where === undefined ? '' : ` WHERE ${where}`}`,
    params,
  )
  return rows.map(
    (r): ProposalRow => ({
      id: String(r['id']),
      tool: String(r['tool']),
      command: String(r['command']),
      args: json(r['args']),
      handles: json(r['handles']),
      idempotencyKey: text(r['idempotency_key']),
      proposerId: text(r['proposer_id']),
      agentName: String(r['agent_name']),
      agentVersion: text(r['agent_version']),
      correlationId: String(r['correlation_id']),
      status: String(r['status']),
      decidedByKind: text(r['decided_by_kind']),
      decidedBy: text(r['decided_by']),
      reason: text(r['reason']),
      outcomeStatus: r['outcome_status'] === null ? null : Number(r['outcome_status']),
      outcomeCode: text(r['outcome_code']),
      columns: r,
    }),
  )
}

async function proposalRow(raw: RawReader, id: string): Promise<ProposalRow> {
  const [row] = await proposalRows(raw, 'id = ?', [id])
  if (row === undefined) throw new Error(`no proposals row ${id}`)
  return row
}

/** The rows written since `before` (a list of rows read earlier). */
async function rowsSince(raw: RawReader, before: ProposalRow[]): Promise<ProposalRow[]> {
  const seen = new Set(before.map((row) => row.id))
  return (await proposalRows(raw)).filter((row) => !seen.has(row.id))
}

function tableCounts(raw: RawReader) {
  return Promise.all([raw.count('products'), raw.count('orders'), raw.count('audit_entries')]).then(
    ([products, orders, audit]) => ({ products, orders, audit }),
  )
}

function proposalEvents(rows: EventRow[]): EventRow[] {
  return rows.filter((row) => row.type.startsWith('proposal.'))
}

// --- agents and admins ---------------------------------------------------------------------------------------------

async function call(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  caller = store.proposer.caller,
) {
  const result = await store.tools.call(name, args, caller)
  return { result, structured: contentOf(result).structured, isError: result.isError ?? false }
}

/** An agent's `admin_products_create`, as the proposer, of a product of its own. */
async function proposeProduct(store: Store, extra: Record<string, unknown> = {}) {
  const body = productBody()
  const answer = await call(store, 'admin_products_create', { ...body, ...extra })
  return { body, ...answer, id: answer.structured['id'] as string }
}

function approve(admin: AdminSession, id: string, headers: Record<string, string> = {}) {
  return admin.send<ProposalView>(
    'POST',
    `/api/admin/proposals/${encodeURIComponent(id)}/approve`,
    undefined,
    headers,
  )
}

function reject(admin: AdminSession, id: string, reason?: string) {
  return admin.send<ProposalView>(
    'POST',
    `/api/admin/proposals/${encodeURIComponent(id)}/reject`,
    reason === undefined ? {} : { reason },
  )
}

function view(admin: AdminSession, id: string) {
  return admin.send<ProposalView>('GET', `/api/admin/proposals/${encodeURIComponent(id)}`)
}

function page(admin: AdminSession, query: Record<string, string>) {
  return admin.send<ProposalPage>('GET', `/api/admin/proposals?${new URLSearchParams(query)}`)
}

function errorOf(answer: Answer<unknown>): {
  status: number
  code: string | undefined
  context: Record<string, unknown> | undefined
} {
  const error = answer.body.error as
    | { code?: string; context?: Record<string, unknown> }
    | undefined
  return { status: answer.status, code: error?.code, context: error?.context }
}

/** A product read with what differs between two stores (ids, times) taken out. */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !(key === 'id' || /Id$/.test(key) || /At$/.test(key)))
      .map(([key, inner]) => [key, comparable(inner)]),
  )
}

async function auditUnder(raw: RawReader, correlationId: string): Promise<AuditRow[]> {
  return auditRows(raw, 'correlation_id = ?', [correlationId])
}

/** The cart handle of a fresh cart holding `qty` of the store's variant, made by an anonymous agent. */
async function cartOf(store: Store, qty: number): Promise<string> {
  const cart = cartHandleOf(await store.tools.call('cart_get', {}, ANONYMOUS))
  if (cart === undefined) throw new Error('cart_get answered no handle')
  const added = await store.tools.call(
    'cart_addItem',
    { cart, variantId: store.variantId, qty },
    ANONYMOUS,
  )
  if (added.isError === true) throw new Error(`cart_addItem: ${JSON.stringify(added)}`)
  return cart
}

const checkoutArgs = (cart: string) => ({
  cart,
  email: `agent-${randomUUID()}@proposals.test`,
  billingAddress: address,
  shippingAddress: address,
})

// --- the suite: one dialect -----------------------------------------------------------------------------------------

export function proposalsSuite(dialect: Dialect, fresh: FreshDatabase): void {
  describe(`agent writes wait for a person (${dialect})`, () => {
    const pool = storePool(dialect, fresh)
    const defaults = () => pool.get('defaults')
    const apply = () => pool.get('apply', withWrites('apply'))

    beforeAll(async () => {
      await defaults()
    }, 60_000)

    afterAll(async () => {
      await pool.closeAll()
    })

    describe('AC-1: an admin write is a pending row, and nothing runs', () => {
      it("AC-1: with the agents block at its defaults, admin_products_create answers proposed with the id of the one row it writes: pending, its tool, command, the sent arguments, the admin, the agent and a correlation id the proposal.created.v1 it publishes shares; products, orders and audit are unchanged, and neither the event nor the row holds an argument's value or the bearer", async () => {
        const store = await defaults()
        const before = await proposalRows(store.raw)
        const counts = await tableCounts(store.raw)
        const seq = await maxSeq(store.raw)

        const { body, structured, isError } = await proposeProduct(store)
        const added = await rowsSince(store.raw, before)
        const events = proposalEvents(await eventRows(store.raw, 'seq > ?', [seq]))

        expect(isError).toBe(false)
        expect(added).toHaveLength(1)
        const row = added[0]!
        expect(structured).toMatchObject({ status: 'proposed', id: row.id })
        expect({
          status: row.status,
          tool: row.tool,
          command: row.command,
          args: row.args,
          handles: row.handles,
          idempotencyKey: row.idempotencyKey,
          proposerId: row.proposerId,
          agentName: row.agentName,
          agentVersion: row.agentVersion,
        }).toEqual({
          status: 'pending',
          tool: 'admin_products_create',
          command: 'product.create',
          args: body,
          handles: null,
          idempotencyKey: null,
          proposerId: store.proposer.userId,
          agentName: AGENT.name,
          agentVersion: AGENT.version,
        })
        expect(await tableCounts(store.raw)).toEqual(counts)
        expect(await store.raw.count('products', 'slug = ?', [body.slug])).toBe(0)
        expect(events.map((e) => e.type)).toEqual(['proposal.created.v1'])
        expect(events[0]!.envelope.correlationId).toBe(row.correlationId)
        const payload = JSON.stringify(events[0]!.envelope.payload)
        for (const value of [body.slug, body.name, body.variants[0]!.sku]) {
          expect(payload).not.toContain(value)
        }
        expect(JSON.stringify(row.columns)).not.toContain(store.proposer.token)
      })

      it('AC-1: GET /api/admin/proposals/:id answers the row as a ProposalView: the sent arguments, no handles, the proposer and agent, pending, the row’s correlation id', async () => {
        const store = await defaults()
        const { body, id } = await proposeProduct(store)
        const row = await proposalRow(store.raw, id)

        const read = await view(store.approver, id)

        expect(read.status).toBe(200)
        expect(read.body.data).toMatchObject({
          id,
          tool: 'admin_products_create',
          command: 'product.create',
          args: body,
          handles: [],
          idempotencyKey: null,
          status: 'pending',
          proposer: { userId: store.proposer.userId, agent: AGENT },
          correlationId: row.correlationId,
        })
      })
    })

    describe('AC-3: a public command under a policy keeps its cart handle', () => {
      const autoCheckout = () => pool.get('auto-checkout', withAutoApprove(['checkout.place']))

      it("AC-3: property: with autoApprove ['checkout.place'], an anonymous checkout_begin on a handle places an order whose one line is the cart's variant and quantity, the variant's stock falls by exactly that quantity, and one row is written applied by agents.autoApprove with no proposer", async () => {
        const store = await autoCheckout()
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (qty) => {
            const cart = await cartOf(store, qty)
            const stock = await stockOf(store.raw, store.variantId)
            const before = await proposalRows(store.raw)

            const placed = await call(store, 'checkout_begin', checkoutArgs(cart), ANONYMOUS)
            const order = await call(
              store,
              'admin_orders_get',
              { orderNumber: placed.structured['orderNumber'] },
              store.proposer.caller,
            )
            const lines = (
              (order.structured['lineItems'] ?? []) as Array<{ variantId: string; qty: number }>
            ).map(({ variantId, qty: n }) => ({ variantId, qty: n }))
            const added = await rowsSince(store.raw, before)

            expect(placed.isError, JSON.stringify(placed.structured)).toBe(false)
            expect(lines).toEqual([{ variantId: store.variantId, qty }])
            expect(await stockOf(store.raw, store.variantId)).toBe(stock - qty)
            expect(
              added.map((row) => ({
                tool: row.tool,
                status: row.status,
                decidedByKind: row.decidedByKind,
                decidedBy: row.decidedBy,
                proposerId: row.proposerId,
              })),
            ).toEqual([
              {
                tool: 'checkout_begin',
                status: 'applied',
                decidedByKind: 'policy',
                decidedBy: 'agents.autoApprove',
                proposerId: null,
              },
            ])
          }),
          { numRuns: 4 },
        )
      }, 60_000)

      it("AC-3: the admin reads a policy-applied checkout's row with handles ['cart'], and neither the row nor the listing carries the cart's value", async () => {
        const store = await autoCheckout()
        const cart = await cartOf(store, 1)
        const before = await proposalRows(store.raw)

        await call(store, 'checkout_begin', checkoutArgs(cart), ANONYMOUS)
        const [row] = await rowsSince(store.raw, before)
        const read = await view(store.approver, row!.id)
        const listed = await page(store.approver, { status: 'all', limit: '200' })

        expect(read.status).toBe(200)
        expect(read.body.data?.handles).toEqual(['cart'])
        expect(read.body.data?.status).toBe('applied')
        expect(JSON.stringify(read.body)).not.toContain(cart)
        expect(listed.status).toBe(200)
        expect(listed.body.data?.items.map((item) => item.id)).toContain(row!.id)
        expect(JSON.stringify(listed.body)).not.toContain(cart)
      })

      it('AC-3: two anonymous checkout_begin calls with one idempotencyKey on two carts place two orders and write two rows', async () => {
        const store = await autoCheckout()
        const idempotencyKey = `agent:${randomUUID()}`
        const before = await proposalRows(store.raw)
        const orders = await store.raw.count('orders')

        const first = await call(
          store,
          'checkout_begin',
          { ...checkoutArgs(await cartOf(store, 1)), idempotencyKey },
          ANONYMOUS,
        )
        const second = await call(
          store,
          'checkout_begin',
          { ...checkoutArgs(await cartOf(store, 2)), idempotencyKey },
          ANONYMOUS,
        )
        const added = await rowsSince(store.raw, before)

        expect([first.isError, second.isError]).toEqual([false, false])
        expect(second.structured['orderNumber']).not.toBe(first.structured['orderNumber'])
        expect(await store.raw.count('orders')).toBe(orders + 2)
        expect(added.map((row) => [row.tool, row.status])).toEqual([
          ['checkout_begin', 'applied'],
          ['checkout_begin', 'applied'],
        ])
      })
    })

    describe('AC-4: without a policy a shopper-scope write is not kept', () => {
      it('AC-4: anonymous checkout_begin and alerts_subscribe each answer proposed with id null and leave the proposals table and the event log as they were', async () => {
        const store = await defaults()
        const cart = await cartOf(store, 1)
        const rows = await store.raw.count('proposals')
        const seq = await maxSeq(store.raw)

        const checkout = await call(store, 'checkout_begin', checkoutArgs(cart), ANONYMOUS)
        const alert = await call(
          store,
          'alerts_subscribe',
          {
            email: `agent-${randomUUID()}@proposals.test`,
            variantId: store.variantId,
            kind: 'back_in_stock',
          },
          ANONYMOUS,
        )

        expect([checkout.structured, alert.structured]).toEqual([
          expect.objectContaining({ status: 'proposed', id: null }),
          expect.objectContaining({ status: 'proposed', id: null }),
        ])
        expect(await store.raw.count('proposals')).toBe(rows)
        expect(await maxSeq(store.raw)).toBe(seq)
      })
    })

    describe('AC-5: no agent write reaches a service without a row', () => {
      const CONFIGS: Array<{
        name: string
        configure?: Configure
        approves: (c: string) => boolean
      }> = [
        { name: 'defaults', approves: () => false },
        {
          name: 'auto-update-adjust',
          configure: withAutoApprove(['product.update', 'inventory.adjust']),
          approves: (command) => command === 'product.update' || command === 'inventory.adjust',
        },
        { name: 'apply', configure: withWrites('apply'), approves: () => true },
      ]

      for (const config of CONFIGS) {
        it(`AC-5: property (${config.name}): every applied audit entry a sequence of admin command calls adds has exactly one applied row with its command and correlation id; every row it adds for a command no policy approves is pending, and none for one a policy approves is${config.name === 'defaults' ? '; products, orders and audit are unchanged' : ''}`, async () => {
          const store = await pool.get(config.name, config.configure)
          const commands = (await Promise.resolve(store.tools.list(store.proposer.caller)))
            .filter((tool) => tool.kind === 'command')
            .map((tool) => tool.name)
          const argPool: Array<Record<string, unknown>> = [
            {},
            { id: store.productId },
            { id: store.productId, name: `Renamed by an agent ${randomUUID().slice(0, 8)}` },
            { variantId: store.variantId, delta: 1, reason: 'manual' },
            { variantId: store.variantId, delta: -3, reason: 'manual' },
            { ...productBody() },
            { orderNumber: 'NYM-000001', email: 'agent@proposals.test' },
            { email: 'agent@proposals.test', billingAddress: address, shippingAddress: address },
          ]

          expect(commands).toEqual(
            expect.arrayContaining(['admin_products_create', 'admin_products_update']),
          )
          await fc.assert(
            fc.asyncProperty(
              fc.array(fc.tuple(fc.constantFrom(...commands), fc.constantFrom(...argPool)), {
                minLength: 1,
                maxLength: 6,
              }),
              async (calls) => {
                const counts = await tableCounts(store.raw)
                const rowsBefore = await proposalRows(store.raw)
                const auditBefore = new Set((await auditRows(store.raw)).map((e) => e.id))

                for (const [name, args] of calls) await call(store, name, args)

                const added = await rowsSince(store.raw, rowsBefore)
                const applied = (await auditRows(store.raw)).filter(
                  (e) => !auditBefore.has(e.id) && e.outcome === 'applied',
                )
                for (const entry of applied) {
                  const matching = added.filter(
                    (row) =>
                      row.status === 'applied' &&
                      row.command === entry.command &&
                      row.correlationId === entry.correlationId,
                  )
                  expect(matching, `${entry.command} ${entry.correlationId}`).toHaveLength(1)
                }
                for (const row of added) {
                  if (config.approves(row.command)) {
                    expect(row.status, row.command).not.toBe('pending')
                  } else expect(row.status, row.command).toBe('pending')
                }
                if (config.name === 'defaults') expect(await tableCounts(store.raw)).toEqual(counts)
              },
            ),
            { numRuns: 10 },
          )
        }, 120_000)
      }
    })

    describe('AC-6: approve runs the call as the approving admin', () => {
      it("AC-6: a second admin's approve of an admin_products_create proposal creates the product the same arguments create under apply, audits product.create by the approver under the proposal's correlation id, settles the row applied with the route's status, publishes approved then applied, and answers the row", async () => {
        const store = await defaults()
        const applying = await apply()
        const { body, id } = await proposeProduct(store)
        const row = await proposalRow(store.raw, id)
        const seq = await maxSeq(store.raw)

        const approved = await approve(store.approver, id)
        await call(applying, 'admin_products_create', body, applying.proposer.caller)
        const direct = await store.approver.send('POST', '/api/admin/products', productBody())
        const here = await store.approver.send('GET', `/api/admin/products/${body.slug}`)
        const there = await applying.approver.send('GET', `/api/admin/products/${body.slug}`)
        const created = (await auditUnder(store.raw, row.correlationId)).filter(
          (e) => e.command === 'product.create',
        )
        const own = await auditUnder(store.raw, approved.correlationId ?? '')
        const events = proposalEvents(await eventRows(store.raw, 'seq > ?', [seq])).filter(
          (e) => e.envelope.correlationId === row.correlationId,
        )

        expect(approved.status).toBe(200)
        expect(approved.body.data).toMatchObject({
          id,
          status: 'applied',
          decision: { by: { kind: 'admin', id: store.approver.userId } },
          outcome: { status: direct.status },
        })
        expect([here.status, there.status]).toEqual([200, 200])
        expect(comparable(here.body.data)).toEqual(comparable(there.body.data))
        expect(created.map((e) => [e.actorKind, e.actorId, e.outcome])).toEqual([
          ['admin', store.approver.userId, 'applied'],
        ])
        expect(approved.correlationId).not.toBe(row.correlationId)
        expect(own.map((e) => e.command)).toEqual(['proposal.approve'])
        expect(events.map((e) => e.type)).toEqual(['proposal.approved.v1', 'proposal.applied.v1'])
        expect((await proposalRow(store.raw, id)).status).toBe('applied')
      })
    })

    describe('AC-7: a proposal its route refuses at approval settles failed', () => {
      it("AC-7: an admin_products_update proposal for a product deleted before the approve answers 200 failed with the route's own code and status, leaves the store as it was, publishes proposal.failed.v1, and leaves the refusal in the audit trail as the route over HTTP does", async () => {
        const store = await defaults()
        const made = await store.approver.send<{ id: string }>(
          'POST',
          '/api/admin/products',
          productBody(),
        )
        const productId = made.body.data!.id
        const proposed = await call(store, 'admin_products_update', {
          id: productId,
          name: 'Renamed after it was gone',
        })
        const id = proposed.structured['id'] as string
        const row = await proposalRow(store.raw, id)
        const deleted = await store.approver.send('DELETE', `/api/admin/products/${productId}`)
        const counts = await tableCounts(store.raw)
        const seq = await maxSeq(store.raw)

        const approved = await approve(store.approver, id)
        const after = await tableCounts(store.raw)
        const events = proposalEvents(await eventRows(store.raw, 'seq > ?', [seq])).filter(
          (e) => e.envelope.correlationId === row.correlationId,
        )
        const direct = await store.approver.send('PATCH', `/api/admin/products/${productId}`, {
          name: 'Renamed after it was gone',
        })
        const viaProposal = (await auditUnder(store.raw, row.correlationId)).filter(
          (e) => e.command === 'product.update',
        )
        const viaHttp = (await auditUnder(store.raw, direct.correlationId ?? '')).filter(
          (e) => e.command === 'product.update',
        )

        expect(made.status).toBe(201)
        expect(deleted.status).toBeLessThan(300)
        expect(direct.status).toBeGreaterThanOrEqual(400)
        expect(approved.status).toBe(200)
        expect(approved.body.data).toMatchObject({
          id,
          status: 'failed',
          outcome: { status: direct.status, code: direct.body.error?.code },
        })
        expect({ products: after.products, orders: after.orders }).toEqual({
          products: counts.products,
          orders: counts.orders,
        })
        expect(events.map((e) => e.type)).toEqual(['proposal.approved.v1', 'proposal.failed.v1'])
        expect(viaProposal.map((e) => e.outcome)).toEqual(viaHttp.map((e) => e.outcome))
        expect((await proposalRow(store.raw, id)).status).toBe('failed')
      })
    })

    describe('AC-10: reject', () => {
      it('AC-10: reject with a reason sets the row rejected with that reason and the rejecting admin, publishes proposal.rejected.v1, creates nothing, and an approve after it answers 409 proposal.decided with status rejected', async () => {
        const store = await defaults()
        const { body, id } = await proposeProduct(store)
        const row = await proposalRow(store.raw, id)
        const counts = await tableCounts(store.raw)
        const seq = await maxSeq(store.raw)
        const reason = 'Not this week: the range launches in spring'

        const rejected = await reject(store.approver, id, reason)
        const events = proposalEvents(await eventRows(store.raw, 'seq > ?', [seq]))
        const after = await tableCounts(store.raw)
        const late = await approve(store.approver, id)
        const stored = await proposalRow(store.raw, id)

        expect(rejected.status).toBe(200)
        expect(rejected.body.data).toMatchObject({
          id,
          status: 'rejected',
          decision: { by: { kind: 'admin', id: store.approver.userId }, reason },
        })
        expect([stored.status, stored.reason, stored.decidedByKind, stored.decidedBy]).toEqual([
          'rejected',
          reason,
          'admin',
          store.approver.userId,
        ])
        expect(events.map((e) => [e.type, e.envelope.correlationId])).toEqual([
          ['proposal.rejected.v1', row.correlationId],
        ])
        expect({ products: after.products, orders: after.orders }).toEqual({
          products: counts.products,
          orders: counts.orders,
        })
        expect(await store.raw.count('products', 'slug = ?', [body.slug])).toBe(0)
        expect(errorOf(late)).toEqual({
          status: 409,
          code: 'proposal.decided',
          context: expect.objectContaining({ status: 'rejected' }),
        })
      })

      it('AC-10: a reason of 500 characters is taken and one of 501 answers validation.failed and leaves the row pending', async () => {
        const store = await defaults()
        const long = await proposeProduct(store)
        const fits = await proposeProduct(store)

        const refused = await reject(store.approver, long.id, 'r'.repeat(501))
        const taken = await reject(store.approver, fits.id, 'r'.repeat(500))

        expect(errorOf(refused)).toMatchObject({ status: 400, code: 'validation.failed' })
        expect((await proposalRow(store.raw, long.id)).status).toBe('pending')
        expect(taken.status).toBe(200)
        expect((await proposalRow(store.raw, fits.id)).reason).toBe('r'.repeat(500))
      })

      it('AC-10: an unknown id answers 404 proposal.not_found on read, approve and reject', async () => {
        const store = await defaults()
        const unknown = randomUUID()

        const answers = await Promise.all([
          view(store.approver, unknown),
          approve(store.approver, unknown),
          reject(store.approver, unknown, 'no such proposal'),
        ])

        expect(answers.map((a) => [errorOf(a).status, errorOf(a).code])).toEqual([
          [404, 'proposal.not_found'],
          [404, 'proposal.not_found'],
          [404, 'proposal.not_found'],
        ])
      })

      it('AC-10: on all four proposal routes a customer bearer answers 403 and no bearer 401, and the row stays pending', async () => {
        const store = await defaults()
        const { id } = await proposeProduct(store)
        const customer = await customerSession(store.baseUrl)
        const nobody = shopper(store.baseUrl)
        const routes: Array<[string, string, unknown]> = [
          ['GET', '/api/admin/proposals', undefined],
          ['GET', `/api/admin/proposals/${id}`, undefined],
          ['POST', `/api/admin/proposals/${id}/approve`, undefined],
          ['POST', `/api/admin/proposals/${id}/reject`, { reason: 'not mine to decide' }],
        ]

        const statuses: Array<[string, number, number]> = []
        for (const [method, path, body] of routes) {
          const asCustomer = await customer.send(method, path, body)
          const asNobody = await nobody.call(method, path, body)
          statuses.push([`${method} ${path}`, asCustomer.status, asNobody.status])
        }

        expect(statuses).toEqual(routes.map(([method, path]) => [`${method} ${path}`, 403, 401]))
        expect((await proposalRow(store.raw, id)).status).toBe('pending')
      })
    })

    describe('AC-11: policies at createApp', () => {
      it("AC-11: with autoApprove ['product.update'], admin_products_update applies at the call (the route's answer, a row applied by agents.autoApprove) and admin_products_create waits pending", async () => {
        const store = await pool.get('auto-update', withAutoApprove(['product.update']))
        const name = `Renamed by policy ${randomUUID().slice(0, 8)}`
        const before = await proposalRows(store.raw)

        const updated = await call(store, 'admin_products_update', { id: store.productId, name })
        const created = await proposeProduct(store)
        const added = await rowsSince(store.raw, before)
        const updateRow = added.find((row) => row.command === 'product.update')
        const read = await view(store.approver, updateRow?.id ?? 'none')

        expect(updated.isError).toBe(false)
        expect(updated.structured['name']).toBe(name)
        expect(created.structured['status']).toBe('proposed')
        expect(added.map((row) => [row.command, row.status]).sort()).toEqual([
          ['product.create', 'pending'],
          ['product.update', 'applied'],
        ])
        expect(read.body.data?.decision?.by).toEqual({
          kind: 'policy',
          rule: 'agents.autoApprove',
        })
      })

      it("AC-11: with writes 'apply', admin_products_update and admin_products_create both apply at the call with rows decided by agents.mcp.writes", async () => {
        const store = await apply()
        // A product of its own: AC-5's sequences under apply may have deleted the seeded one.
        const made = await store.approver.send<{ id: string }>(
          'POST',
          '/api/admin/products',
          productBody(),
        )
        const before = await proposalRows(store.raw)

        const updated = await call(store, 'admin_products_update', {
          id: made.body.data?.id,
          name: `Renamed under apply ${randomUUID().slice(0, 8)}`,
        })
        const created = await proposeProduct(store)
        const added = await rowsSince(store.raw, before)
        const decided = await Promise.all(
          added.map(async (row) => (await view(store.approver, row.id)).body.data?.decision?.by),
        )

        expect([updated.isError, created.isError]).toEqual([false, false])
        expect(created.structured['slug']).toBe(created.body.slug)
        expect(added.map((row) => [row.command, row.status]).sort()).toEqual([
          ['product.create', 'applied'],
          ['product.update', 'applied'],
        ])
        expect(decided).toEqual([
          { kind: 'policy', rule: 'agents.mcp.writes' },
          { kind: 'policy', rule: 'agents.mcp.writes' },
        ])
      })

      for (const [list, index] of [
        [['product.frobnicate'], 0],
        [['order.refund'], 0],
        [['product.update', 'order.markPaid'], 1],
      ] as const) {
        it(`AC-11: autoApprove ${JSON.stringify(list)} stops createApp with a ConfigError naming agents.autoApprove[${index}]`, async () => {
          const db = await fresh(`refused-${index}`)
          try {
            const outcome = await createKernel({
              ...(dialect === 'sqlite'
                ? { dialect: 'sqlite' as const, sqlitePath: db.target }
                : { dialect: 'postgres' as const, postgresUrl: db.target }),
              configure: withAutoApprove([...list]),
            }).then(
              async (kernel) => {
                await kernel.close()
                return 'createApp resolved'
              },
              (err: unknown) => err,
            )

            expect(outcome).toBeInstanceOf(ConfigError)
            expect((outcome as ConfigError).message).toContain(`agents.autoApprove[${index}]`)
          } finally {
            await db.drop()
          }
        })
      }
    })

    describe('AC-12: the listing', () => {
      it('AC-12: status=pending answers pending equal to the pending rows, and status=decided holds exactly the decided rows', async () => {
        const store = await defaults()
        const decidedOne = await proposeProduct(store)
        await reject(store.approver, decidedOne.id, 'listing check')
        await proposeProduct(store)

        const pendingPages = await allPages(store.approver, 'pending', 200)
        const decidedPages = await allPages(store.approver, 'decided', 200)
        const rows = await proposalRows(store.raw)

        expect(pendingPages.pending).toBe(rows.filter((row) => row.status === 'pending').length)
        expect(pendingPages.items.map((item) => item.status)).toEqual(
          pendingPages.items.map(() => 'pending'),
        )
        expect(decidedPages.items.every((item) => DECIDED.includes(item.status))).toBe(true)
        expect(decidedPages.items.map((item) => item.id).sort()).toEqual(
          rows
            .filter((row) => row.status !== 'pending')
            .map((row) => row.id)
            .sort(),
        )
      })

      it('AC-12: property: paging pending with limit 1 to 5 while proposals arrive between pages yields every row pending at the start exactly once, newest first by created_at then id, and nothing else', async () => {
        const store = await defaults()
        for (let i = 0; i < 4; i += 1) await proposeProduct(store)

        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 5 }),
            fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 4 }),
            async (limit, inserts) => {
              const start = (await proposalRows(store.raw))
                .filter((row) => row.status === 'pending')
                .map((row) => row.id)
              const items: ProposalView[] = []
              let cursor: string | null = null
              for (let n = 0; n < 1000; n += 1) {
                const res = await page(store.approver, {
                  status: 'pending',
                  limit: String(limit),
                  ...(cursor !== null && { cursor }),
                })
                expect(res.status).toBe(200)
                expect(res.body.data!.items.length).toBeLessThanOrEqual(limit)
                items.push(...res.body.data!.items)
                for (let i = 0; i < (inserts[n] ?? 0); i += 1) await proposeProduct(store)
                cursor = res.body.data!.nextCursor
                if (cursor === null) break
              }
              const ids = items.map((item) => item.id)
              const keys = items.map((item) => `${item.createdAt}|${item.id}`)

              expect(new Set(ids).size).toBe(ids.length)
              expect([...ids].sort()).toEqual([...start].sort())
              expect(keys).toEqual([...keys].sort().reverse())
            },
          ),
          { numRuns: 8 },
        )
      }, 120_000)

      it('AC-12: a cursor this API did not issue answers 400', async () => {
        const store = await defaults()
        const foreign = [
          'not-a-cursor',
          Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z'])).toString('base64url'),
          Buffer.from(JSON.stringify({ at: 1, id: 2 })).toString('base64url'),
        ]

        const statuses = await Promise.all(
          foreign.map(
            async (cursor) => (await page(store.approver, { status: 'all', cursor })).status,
          ),
        )

        expect(statuses).toEqual(foreign.map(() => 400))
      })

      it('AC-12: admin_proposals_get through the tool surface answers the ProposalView the route answers, and admin_proposals_list the page', async () => {
        const store = await defaults()
        const { id } = await proposeProduct(store)

        const route = await view(store.approver, id)
        const tool = await call(store, 'admin_proposals_get', { id })
        const listedRoute = await page(store.approver, { status: 'pending', limit: '5' })
        const listedTool = await call(store, 'admin_proposals_list', {
          status: 'pending',
          limit: '5',
        })

        expect(route.status).toBe(200)
        expect(tool.isError).toBe(false)
        expect(tool.structured).toEqual(route.body.data)
        expect(listedTool.structured).toEqual(listedRoute.body.data)
      })
    })

    describe('AC-14: the admin event stream carries proposals', () => {
      it('AC-14: a stream opened with a ticket receives proposal.created.v1 and proposal.applied.v1 frames for a proposal made and approved after it connected, each { id, type, timestamp, payload } with no argument value in it', async () => {
        const store = await defaults()
        const tab = await openTab(store)
        try {
          await until(
            () => tab.frames.some((f) => f.event === 'connected'),
            'the stream to connect',
          )

          const { body, id } = await proposeProduct(store)
          const approved = await approve(store.approver, id)
          const mine = (type: string) =>
            tab.frames.filter((f) => f.event === type && JSON.stringify(f.data).includes(id))
          await until(
            () => mine('proposal.created.v1').length > 0 && mine('proposal.applied.v1').length > 0,
            'the proposal frames',
          ).catch(() => undefined)
          const frames = [...mine('proposal.created.v1'), ...mine('proposal.applied.v1')]

          expect(approved.status).toBe(200)
          expect(frames.map((f) => f.event)).toEqual(['proposal.created.v1', 'proposal.applied.v1'])
          for (const frame of frames) {
            const data = frame.data as Record<string, unknown>
            expect(Object.keys(data).sort()).toEqual(['id', 'payload', 'timestamp', 'type'])
            expect(data['type']).toBe(frame.event)
            for (const value of [body.slug, body.name, body.variants[0]!.sku]) {
              expect(JSON.stringify(data['payload'])).not.toContain(value)
            }
          }
        } finally {
          tab.close()
        }
      })
    })
  })
}

async function allPages(
  admin: AdminSession,
  status: 'pending' | 'decided' | 'all',
  limit: number,
): Promise<{ items: ProposalView[]; pending: number }> {
  const items: ProposalView[] = []
  let cursor: string | null = null
  let pending = -1
  for (let n = 0; n < 1000; n += 1) {
    const res = await page(admin, {
      status,
      limit: String(limit),
      ...(cursor !== null && { cursor }),
    })
    if (res.status !== 200) {
      throw new Error(`GET /api/admin/proposals: ${res.status} ${JSON.stringify(res.body)}`)
    }
    items.push(...res.body.data!.items)
    if (n === 0) pending = res.body.data!.pending
    cursor = res.body.data!.nextCursor
    if (cursor === null) break
  }
  return { items, pending }
}

interface Tab {
  frames: Array<{ event: string; data: unknown }>
  close(): void
}

/** An admin SSE connection, as the admin app opens one: a ticket, then GET /api/admin/events?ticket=. */
async function openTab(store: Store): Promise<Tab> {
  const ticket = await store.approver.send<{ ticket: string }>('POST', '/api/admin/events/ticket')
  if (ticket.status !== 200) throw new Error(`ticket: ${JSON.stringify(ticket.body)}`)
  const abort = new AbortController()
  const res = await fetch(
    `${store.baseUrl}/api/admin/events?ticket=${encodeURIComponent(ticket.body.data!.ticket)}`,
    { signal: abort.signal, headers: { accept: 'text/event-stream' } },
  )
  const tab: Tab = { frames: [], close: () => abort.abort() }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message'
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data: ?/, ''))
            .join('\n')
          tab.frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })()
  return tab
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// --- the races: one dialect -----------------------------------------------------------------------------------------

type RefundImpl = (...args: unknown[]) => Promise<Refund>

export function proposalRacesSuite(dialect: Dialect, fresh: FreshDatabase): void {
  describe(`one row, one decision, one run (${dialect})`, () => {
    let store: Store
    let payments: PaymentsAdapter
    let stubRefund: RefundImpl

    beforeAll(async () => {
      store = await openStore(dialect, fresh, 'races')
      payments = store.kernel.app.adapters.payments
      stubRefund = payments.refund.bind(payments) as RefundImpl
    }, 60_000)

    afterAll(async () => {
      await store?.close()
    })

    it('AC-2: property: k in 2..6 simultaneous admin_products_create calls by one admin with one idempotencyKey leave one row whose id every answer carries; the same arguments under another key make a second row', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
          const body = productBody()
          const key = `agent:${randomUUID()}`
          const before = await proposalRows(store.raw)

          const answers = await Promise.all(
            Array.from({ length: k }, () =>
              call(store, 'admin_products_create', { ...body, idempotencyKey: key }),
            ),
          )
          const keyed = await rowsSince(store.raw, before)
          const again = await call(store, 'admin_products_create', {
            ...body,
            idempotencyKey: `agent:${randomUUID()}`,
          })
          const all = await rowsSince(store.raw, before)

          expect(answers.map((a) => a.isError)).toEqual(answers.map(() => false))
          expect(keyed.map((row) => [row.idempotencyKey, row.args])).toEqual([[key, body]])
          expect(answers.map((a) => a.structured['id'])).toEqual(answers.map(() => keyed[0]!.id))
          expect(all).toHaveLength(2)
          expect(again.structured['id']).toBe(all.find((row) => row.id !== keyed[0]!.id)!.id)
        }),
        { numRuns: 8 },
      )
    }, 120_000)

    it('AC-2: an idempotencyKey of "bad key!" answers validation.failed and writes no row and no event', async () => {
      const rows = await store.raw.count('proposals')
      const seq = await maxSeq(store.raw)

      const bad = await call(store, 'admin_products_create', {
        ...productBody(),
        idempotencyKey: 'bad key!',
      })

      expect([bad.isError, bad.structured['code']]).toEqual([true, 'validation.failed'])
      expect(await store.raw.count('proposals')).toBe(rows)
      expect(proposalEvents(await eventRows(store.raw, 'seq > ?', [seq]))).toEqual([])
    })

    it('AC-8: property: k in 2..6 simultaneous approves of one proposal: one answers 200 applied, every other 409 proposal.decided with status approved or applied, the product is created once, and a later approve answers 409', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
          const { body, id } = await proposeProduct(store)
          const row = await proposalRow(store.raw, id)

          const answers = await Promise.all(
            Array.from({ length: k }, () => approve(store.approver, id)),
          )
          const won = answers.filter((a) => a.status === 200)
          const lost = answers.filter((a) => a.status !== 200).map(errorOf)
          const created = (await auditUnder(store.raw, row.correlationId)).filter(
            (e) => e.command === 'product.create' && e.outcome === 'applied',
          )
          const late = errorOf(await approve(store.approver, id))

          expect(won.map((a) => a.body.data?.status)).toEqual(['applied'])
          expect(lost).toHaveLength(k - 1)
          for (const loser of lost) {
            expect([loser.status, loser.code]).toEqual([409, 'proposal.decided'])
            expect(['approved', 'applied']).toContain(loser.context?.['status'])
          }
          expect(await store.raw.count('products', 'slug = ?', [body.slug])).toBe(1)
          expect(created).toHaveLength(1)
          expect([late.status, late.code, late.context?.['status']]).toEqual([
            409,
            'proposal.decided',
            'applied',
          ])
        }),
        { numRuns: 6 },
      )
    }, 120_000)

    it("AC-8: property: k in 2..6 simultaneous approves carrying one Idempotency-Key run the command once; every other answers 409 or the winner's answer as a replay", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
          const { body, id } = await proposeProduct(store)
          const row = await proposalRow(store.raw, id)
          const key = `approve:${randomUUID()}`

          const answers = await Promise.all(
            Array.from({ length: k }, () =>
              approve(store.approver, id, { 'Idempotency-Key': key }),
            ),
          )
          const ran = answers.filter((a) => a.status === 200 && a.replayed === null)
          const others = answers.filter((a) => !ran.includes(a))
          const created = (await auditUnder(store.raw, row.correlationId)).filter(
            (e) => e.command === 'product.create' && e.outcome === 'applied',
          )

          expect(ran.map((a) => a.body.data?.status)).toEqual(['applied'])
          for (const other of others) {
            if (other.status === 200) expect(other.body.data).toEqual(ran[0]!.body.data)
            else expect(other.status).toBe(409)
          }
          expect(await store.raw.count('products', 'slug = ?', [body.slug])).toBe(1)
          expect(created).toHaveLength(1)
        }),
        { numRuns: 6 },
      )
    }, 120_000)

    it("AC-8: property: an approve racing a reject: exactly one decides; the other answers 409 proposal.decided with the winner's status, and the product exists exactly when the approve won", async () => {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (approveFirst) => {
          const { body, id } = await proposeProduct(store)
          const sends = [
            () => approve(store.approver, id),
            () => reject(store.approver, id, 'raced'),
          ]
          if (!approveFirst) sends.reverse()

          const answers = await Promise.all(sends.map((send) => send()))
          const [approved, rejected] = approveFirst ? answers : [answers[1]!, answers[0]!]
          const approveWon = approved!.status === 200
          const winner = approveWon ? approved! : rejected!
          const loser = errorOf(approveWon ? rejected! : approved!)
          const stored = await proposalRow(store.raw, id)

          expect(winner.status).toBe(200)
          expect([loser.status, loser.code]).toEqual([409, 'proposal.decided'])
          expect(approveWon ? ['approved', 'applied'] : ['rejected']).toContain(
            loser.context?.['status'],
          )
          expect(stored.status).toBe(approveWon ? 'applied' : 'rejected')
          expect(await store.raw.count('products', 'slug = ?', [body.slug])).toBe(
            approveWon ? 1 : 0,
          )
        }),
        { numRuns: 8 },
      )
    }, 120_000)

    it('AC-9: property, money: an admin_orders_refund proposal for a captured order, approved by k in 1..4 simultaneous requests, refunds exactly the amount once: refunded total up by it, one refund row, one payment.refunded.v1, one provider call made with the approval and the held refund committed, and the row applied', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            priceMinor: fc.integer({ min: 2, max: 20_000 }),
            qty: fc.integer({ min: 1, max: 3 }),
            percent: fc.integer({ min: 1, max: 100 }),
            k: fc.integer({ min: 1, max: 4 }),
          }),
          async ({ priceMinor, qty, percent, k }) => {
            const seeded = await seedVariant(store.kernel, qty + 1, { priceMinor })
            const order = await checkoutOf(
              store.kernel,
              seeded,
              qty,
              `refund-${randomUUID()}@proposals.test`,
            )
            const amountMinor = Math.ceil((order.totalMinor * percent) / 100)
            const proposed = await call(store, 'admin_orders_refund', {
              id: order.orderId,
              amountMinor,
            })
            const id = proposed.structured['id'] as string
            const money = await storedMoney(store.raw, order.orderId)
            const refundsBefore = await storedRefunds(store.raw, order.orderId)
            const refundEvents = await store.raw.count('events', 'type = ?', [
              'payment.refunded.v1',
            ])

            const during: Array<{ heldRefunds: number; proposal: string }> = []
            payments.refund = async (...args: unknown[]) => {
              during.push({
                heldRefunds: await store.raw.count('order_refunds', 'order_id = ? AND status = ?', [
                  order.orderId,
                  'pending',
                ]),
                proposal: (await proposalRow(store.raw, id)).status,
              })
              return stubRefund(...args)
            }
            let answers: Array<Answer<ProposalView>>
            try {
              answers = await Promise.all(
                Array.from({ length: k }, () => approve(store.approver, id)),
              )
            } finally {
              payments.refund = stubRefund as PaymentsAdapter['refund']
            }
            const after = await storedMoney(store.raw, order.orderId)
            const refunds = await storedRefunds(store.raw, order.orderId)

            expect(order.orderStatus).toBe('confirmed')
            expect(money.capturedMinor).toBe(order.totalMinor)
            expect(answers.filter((a) => a.status === 200).map((a) => a.body.data?.status)).toEqual(
              ['applied'],
            )
            expect(answers.filter((a) => a.status !== 200).map((a) => a.status)).toEqual(
              Array.from({ length: k - 1 }, () => 409),
            )
            expect(after.refundedMinor).toBe(money.refundedMinor + amountMinor)
            expect(refunds.length).toBe(refundsBefore.length + 1)
            expect(refunds.at(-1)!.amountMinor).toBe(amountMinor)
            expect(await store.raw.count('events', 'type = ?', ['payment.refunded.v1'])).toBe(
              refundEvents + 1,
            )
            expect(during).toEqual([{ heldRefunds: 1, proposal: 'approved' }])
            expect((await proposalRow(store.raw, id)).status).toBe('applied')
          },
        ),
        { numRuns: 6 },
      )
    }, 180_000)
  })
}
