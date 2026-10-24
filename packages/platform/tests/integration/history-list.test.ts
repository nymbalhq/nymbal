import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, auditRows, CORRELATION, type AdminSession } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import type { LoggedEvent } from '../../src/repositories/event-log.js'
import {
  asJson,
  dataOf,
  productView,
  readHistory,
  type HistoryEntry,
  type HistoryKind,
} from '../support/history.js'

// AC-3 on SQLite: `GET …/:id/history` for a product, an order and a customer, each made and changed over HTTP by an
// admin, a guest and the customer. Each lists the base entry and one entry per event that changes the view, newest
// first; each entry's `changes` equal `diffViews` of the fold before and after its event, and its `actor` and
// `command` equal the `applied` audit entry with its correlation id. The cursor at limit 1 walks every entry exactly
// once, and no customer entry holds a password hash.

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminSession

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw('sqlite', k.target)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

interface ListBySubjects {
  listBySubjects(
    tx: unknown,
    subjects: Array<{ type: string; id: string }>,
    page: { until?: Date; afterSeq?: number; limit: number },
  ): Promise<LoggedEvent[]>
}

const BASE_TYPES: Record<HistoryKind, string[]> = {
  product: ['product.created', 'product.updated'],
  order: ['order.placed'],
  customer: ['customer.created', 'customer.updated'],
}

function correlationOf(res: { headers: Headers } | { correlationId: string | null }): string {
  const id = 'headers' in res ? res.headers.get(CORRELATION) : res.correlationId
  if (id === null) throw new Error('the response carried no x-correlation-id')
  return id
}

async function allEntries(kind: HistoryKind, id: string): Promise<HistoryEntry[]> {
  const res = await readHistory(admin, kind, id, { limit: 200 })
  expect(res.status, `GET ${kind} history: ${JSON.stringify(res.body)}`).toBe(200)
  expect(res.body.data!.nextCursor).toBeNull()
  return res.body.data!.entries
}

/**
 * The entries `…/history` must list, from the subject's rows: the base, then every later event whose fold changes the
 * view, with `diffViews` of the views either side as its changes; newest first. Then each entry's time, type and
 * correlation id are its row's, and its actor and command the applied audit entry's.
 */
async function expectConsistent(
  kind: HistoryKind,
  subjects: Array<{ type: string; id: string }>,
  entries: HistoryEntry[],
): Promise<void> {
  const log = k.repos.eventLog as unknown as ListBySubjects
  const rows = await k.store.read((tx) => log.listBySubjects(tx, subjects, { limit: 10_000 }))
  const history = await import('../../src/history/index.js')
  const baseAt = rows.findIndex((row) =>
    BASE_TYPES[kind].some((type) => row.event.type.startsWith(type)),
  )
  expect(baseAt, `${kind}: a base row in the log`).toBeGreaterThanOrEqual(0)
  const expected: Array<{ seq: number; base: boolean; changes: unknown[] }> = [
    { seq: rows[baseAt]!.seq, base: true, changes: [] },
  ]
  for (let i = baseAt + 1; i < rows.length; i += 1) {
    const changes = history.diffViews(
      history.foldHistory(kind, rows.slice(0, i)),
      history.foldHistory(kind, rows.slice(0, i + 1)),
    ) as unknown[]
    if (changes.length > 0) expected.push({ seq: rows[i]!.seq, base: false, changes })
  }
  expected.reverse()
  expect(
    entries.map((e) => ({ seq: e.seq, base: e.base, changes: e.changes })),
    `${kind}: one entry per view-changing event plus the base, newest first`,
  ).toEqual(expected)

  const bySeq = new Map(rows.map((row) => [row.seq, row]))
  for (const entry of entries) {
    const row = bySeq.get(entry.seq)!
    expect(
      [new Date(entry.at).getTime(), entry.type, entry.correlationId],
      `${kind} entry ${entry.seq}`,
    ).toEqual([row.createdAt.getTime(), row.event.type, row.event.correlationId])
    const [applied] = await auditRows(raw, "correlation_id = ? AND outcome = 'applied'", [
      entry.correlationId,
    ])
    expect(
      { actor: entry.actor, command: entry.command },
      `${kind} entry ${entry.seq}: actor and command`,
    ).toEqual(
      applied === undefined
        ? { actor: null, command: null }
        : { actor: { kind: applied.actorKind, id: applied.actorId }, command: applied.command },
    )
  }
}

/** Every entry at limit 1, following nextCursor: each page one entry, and the walk equal to the full list. */
async function expectCursorWalk(kind: HistoryKind, id: string, full: HistoryEntry[]) {
  const walked: number[] = []
  let cursor: string | undefined
  for (let page = 0; page <= full.length; page += 1) {
    const res = await readHistory(admin, kind, id, {
      limit: 1,
      ...(cursor !== undefined && { cursor }),
    })
    const data = dataOf(res, `${kind} history page ${page}`)
    expect(data.entries.length, `${kind} page ${page}`).toBeLessThanOrEqual(1)
    walked.push(...data.entries.map((e) => e.seq))
    if (data.nextCursor === null) break
    cursor = data.nextCursor
  }
  expect(walked, `${kind}: the cursor walk at limit 1`).toEqual(full.map((e) => e.seq))
}

function change(entry: HistoryEntry | undefined, path: string) {
  return entry?.changes.find((c) => c.path === path)
}

describe('AC-3: …/:id/history lists the changes', () => {
  it('AC-3: a product’s history lists the base, the admin’s edit, the adjust and the checkout’s stock move, newest first, each with its row’s seq, time, type, correlation, actor and command', async () => {
    const tag = randomUUID().slice(0, 8)
    const created = await admin.send<{
      id: string
      variants: Array<{ id: string; stock: number }>
    }>('POST', '/api/admin/products', {
      slug: `history-ac3-${tag}`,
      name: `Listed ${tag}`,
      description: '',
      shortDescription: 'Short before',
      status: 'active',
      variants: [{ sku: `AC3-${tag}`, name: 'Default', priceMinor: 1200, stock: 10, options: [] }],
    })
    expect(created.status).toBe(201)
    const productId = created.body.data!.id
    const variantId = created.body.data!.variants[0]!.id
    const before = productView(asJson(await k.services.product.getById(productId)))

    const edited = await admin.send('PATCH', `/api/admin/products/${productId}`, {
      name: `Listed after ${tag}`,
      shortDescription: 'Short after',
    })
    expect(edited.status).toBe(200)
    const adjusted = await admin.send('POST', `/api/admin/inventory/${variantId}/adjust`, {
      delta: 3,
      reason: 'manual',
    })
    expect(adjusted.status).toBe(200)
    const guest = await primedShopper(served.baseUrl)
    expect((await guest.call('POST', '/api/cart/items', { variantId, qty: 2 })).status).toBe(200)
    const checkout = await guest.call('POST', '/api/checkout', {
      email: `guest-${randomUUID()}+stub-pending@history.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200)

    const entries = await allEntries('product', productId)
    expect(
      entries.map((e) => [e.type.split('.v')[0], e.correlationId]),
      'newest first: the checkout’s stock move, the adjust, the edit, the base',
    ).toEqual([
      ['inventory.changed', correlationOf(checkout)],
      ['inventory.changed', correlationOf(adjusted)],
      ['product.updated', correlationOf(edited)],
      ['product.created', correlationOf(created)],
    ])
    const [sold, restocked, edit, base] = entries
    const stock = `variants.${variantId}.stock`
    expect(sold!.changes).toEqual([{ path: stock, from: 13, to: 11 }])
    expect(restocked!.changes).toEqual([{ path: stock, from: 10, to: 13 }])
    expect(change(edit, 'name')).toEqual({
      path: 'name',
      from: before['name'],
      to: `Listed after ${tag}`,
    })
    expect(change(edit, 'shortDescription')).toEqual({
      path: 'shortDescription',
      from: 'Short before',
      to: 'Short after',
    })
    expect([edit!.actor, edit!.command]).toEqual([
      { kind: 'admin', id: admin.userId },
      'product.update',
    ])
    expect([base!.base, base!.changes]).toEqual([true, []])

    await expectConsistent(
      'product',
      [
        { type: 'product', id: productId },
        { type: 'variant', id: variantId },
      ],
      entries,
    )
    await expectCursorWalk('product', productId, entries)
  })

  it('AC-3: an order’s history lists the base and each change of checkout, process, ship and a partial refund, newest first, the admin’s moves under the admin', async () => {
    const tag = randomUUID().slice(0, 8)
    const created = await admin.send<{ id: string; variants: Array<{ id: string }> }>(
      'POST',
      '/api/admin/products',
      {
        slug: `history-ac3o-${tag}`,
        name: `Ordered ${tag}`,
        description: '',
        status: 'active',
        variants: [
          { sku: `AC3O-${tag}`, name: 'Default', priceMinor: 2500, stock: 5, options: [] },
        ],
      },
    )
    const variantId = created.body.data!.variants[0]!.id
    const guest = await primedShopper(served.baseUrl)
    expect((await guest.call('POST', '/api/cart/items', { variantId, qty: 1 })).status).toBe(200)
    const checkout = await guest.call<{ orderId: string }>('POST', '/api/checkout', {
      email: `paid-${randomUUID()}@history.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200)
    const orderId = checkout.body.data!.orderId
    const moves = {
      process: await admin.send('POST', `/api/admin/orders/${orderId}/process`, {}),
      ship: await admin.send('POST', `/api/admin/orders/${orderId}/ship`, {
        trackingNumber: 'TRK-AC3',
        carrier: 'Royal Mail',
      }),
      refund: await admin.send('POST', `/api/admin/orders/${orderId}/refund`, {
        amountMinor: 300,
        reason: 'AC-3',
      }),
    }
    expect(Object.values(moves).map((m) => m.status)).toEqual([200, 200, 200])

    const entries = await allEntries('order', orderId)
    expect(
      entries.slice(0, 3).map((e) => [e.type.split('.v')[0], e.correlationId]),
      'newest first: the refund, the ship, the process',
    ).toEqual([
      ['order.partially_refunded', moves.refund.correlationId],
      ['order.shipped', moves.ship.correlationId],
      ['order.status_changed', moves.process.correlationId],
    ])
    const [refunded, shipped, processed] = entries
    expect(change(shipped, 'status')).toEqual({ path: 'status', from: 'processing', to: 'shipped' })
    expect(change(processed, 'status')).toEqual({
      path: 'status',
      from: 'confirmed',
      to: 'processing',
    })
    expect(change(refunded, 'refundedMinor')).toEqual({ path: 'refundedMinor', from: 0, to: 300 })
    for (const entry of [refunded, shipped, processed]) {
      expect(entry!.actor, entry!.type).toEqual({ kind: 'admin', id: admin.userId })
    }
    expect(
      entries.filter((e) => e.correlationId === correlationOf(checkout)).length,
      'the checkout’s own entries (the base, the intent, the payment)',
    ).toBeGreaterThanOrEqual(2)
    expect(entries.at(-1)!.base).toBe(true)

    await expectConsistent('order', [{ type: 'order', id: orderId }], entries)
    await expectCursorWalk('order', orderId, entries)
  })

  it('AC-3: a customer’s history lists the registration, the profile edit and the added address, newest first, under the customer, and no entry holds a password hash', async () => {
    const shop = await primedShopper(served.baseUrl)
    const registered = await shop.call<{ customer: { id: string }; accessToken: string }>(
      'POST',
      '/api/auth/register',
      { email: `ac3-${randomUUID()}@history.test`, password: 'history-correct-horse' },
    )
    expect(registered.status, JSON.stringify(registered.body)).toBe(201)
    const customerId = registered.body.data!.customer.id
    const bearer = { headers: { authorization: `Bearer ${registered.body.data!.accessToken}` } }
    const profile = await shop.call('PATCH', '/api/customers/me', { firstName: 'Grace' }, bearer)
    expect(profile.status).toBe(200)
    const added = await shop.call<{ id: string }>(
      'POST',
      '/api/customers/me/addresses',
      { ...address, isDefaultBilling: true, isDefaultShipping: true },
      bearer,
    )
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    const addressId = added.body.data!.id

    const res = await readHistory(admin, 'customer', customerId, { limit: 200 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const text = JSON.stringify(res.body)
    expect(text.includes('passwordHash'), 'a passwordHash key').toBe(false)
    expect(/\$2[aby]\$\d\d\$/.test(text), 'a bcrypt hash').toBe(false)
    const entries = res.body.data!.entries
    expect(
      entries.map((e) => [e.type.split('.v')[0], e.correlationId]),
      'newest first: the address, the profile, the registration',
    ).toEqual([
      ['customer.updated', correlationOf(added)],
      ['customer.updated', correlationOf(profile)],
      ['customer.created', correlationOf(registered)],
    ])
    const [address_, profile_] = entries
    expect(change(profile_, 'firstName')?.to).toBe('Grace')
    expect(
      address_!.changes.filter((c) => c.path.startsWith(`addresses.${addressId}`)).length,
      `changes under addresses.${addressId}: ${JSON.stringify(address_!.changes)}`,
    ).toBeGreaterThan(0)
    expect(profile_!.actor).toEqual({ kind: 'customer', id: customerId })

    await expectConsistent('customer', [{ type: 'customer', id: customerId }], entries)
    await expectCursorWalk('customer', customerId, entries)
  })
})
