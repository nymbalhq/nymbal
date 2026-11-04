import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { OrderLineItem } from '@nymbalhq/types'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { createCartRepository } from '../../../src/repositories/cart.js'
import { createOrderRepository } from '../../../src/repositories/order.js'
import { address, createKernel, kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { openRaw } from '../raw.js'
import { unaudited } from '../write-audit.js'

// AC-5 on one dialect: where a cart or an order came from is a column every row has. A database one migration before
// the source columns, holding carts, orders and events, reads `storefront` on every cart and order once migrated to the
// head, with no row or event added or lost; an imported order is `import`; an order inserted with no source is
// `storefront`.

type Fresh = () => Promise<{ target: string; drop(): Promise<void> }>

/** A copy of the migrations folder for `dialect` holding every migration before the one adding the source columns. */
function migrationsBeforeOrderSource(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'source-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  const source = journal.entries.find((entry) => entry.tag.endsWith('_order_source'))
  if (!source) {
    throw new Error(`expected an _order_source migration in ${from}`)
  }
  journal.entries = journal.entries.filter((entry) => entry.idx < source.idx)
  if (journal.entries.length !== source.idx) {
    throw new Error(
      `expected migrations 0000-${String(source.idx - 1).padStart(4, '0')} in ${from}`,
    )
  }
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

function storage(dialect: Kernel['dialect'], target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

async function migrate(dialect: Kernel['dialect'], target: string, root: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storage(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

const line: OrderLineItem = {
  variantId: 'source-variant',
  productId: 'source-product',
  productName: 'Source Widget',
  variantName: 'Default',
  sku: 'SOURCE-1',
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 0,
  lineTotalMinor: 2500,
  imageUrl: '',
}

interface Rows {
  carts: Array<{ token: string; customerId: string | null; expiresAt: string }>
  orders: Array<{
    id: string
    number: string
    sequence: number
    status: string
    cartToken: string | null
    captured: number
    method: string | null
  }>
  events: Array<{ id: string; type: string; subject: string }>
}

/** Carts (a guest's, a customer's, an expired one), orders (checkout ones and an imported one) and their events. */
function rowsBeforeSource(): Rows {
  const at = Date.now()
  const carts = [
    { token: randomUUID(), customerId: null, expiresAt: new Date(at + 86_400_000).toISOString() },
    {
      token: randomUUID(),
      customerId: randomUUID(),
      expiresAt: new Date(at + 86_400_000).toISOString(),
    },
    { token: randomUUID(), customerId: null, expiresAt: new Date(at - 86_400_000).toISOString() },
  ]
  const orders = [
    { status: 'pending', cartToken: carts[0]!.token, captured: 0, method: null },
    { status: 'confirmed', cartToken: carts[1]!.token, captured: 2500, method: 'provider' },
    { status: 'cancelled', cartToken: carts[2]!.token, captured: 0, method: null },
    { status: 'delivered', cartToken: null, captured: 2500, method: 'import' },
  ].map((o, i) => ({
    ...o,
    id: randomUUID(),
    number: `SRC-${randomUUID().slice(0, 8)}`,
    sequence: 700_000 + i,
  }))
  const events = orders.map((o) => ({ id: randomUUID(), type: 'order.placed.v1', subject: o.id }))
  return { carts, orders, events }
}

async function insertBeforeSource(dialect: Kernel['dialect'], target: string, rows: Rows) {
  const now = new Date().toISOString()
  const addressJson = JSON.stringify(address)
  const linesJson = JSON.stringify([line])
  const itemsJson = JSON.stringify([
    {
      variantId: line.variantId,
      productId: line.productId,
      productName: line.productName,
      variantName: line.variantName,
      priceMinor: 2500,
      imageUrl: '',
      qty: 1,
    },
  ])
  const cartSql =
    'INSERT INTO carts (token, customer_id, currency, items, line_count, subtotal_minor, expires_at, created_at, updated_at) ' +
    "VALUES (?, ?, 'GBP', ?, 1, 2500, ?, ?, ?)"
  const orderSql =
    'INSERT INTO orders (id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, ' +
    'line_items, subtotal_minor, total_minor, currency, metadata, cart_token, captured_minor, capture_method, ' +
    "created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 2500, 2500, 'GBP', ?, ?, ?, ?, ?, ?)"
  const eventSql =
    'INSERT INTO events (id, type, envelope, correlation_id, created_at, subject_type, subject_id, delivered_at) ' +
    "VALUES (?, ?, ?, ?, ?, 'order', ?, ?)"
  const cartParams = rows.carts.map((c) => [
    c.token,
    c.customerId,
    itemsJson,
    c.expiresAt,
    now,
    now,
  ])
  const orderParams = rows.orders.map((o) => [
    o.id,
    o.number,
    o.sequence,
    o.status,
    `${o.number.toLowerCase()}@source.test`,
    addressJson,
    addressJson,
    linesJson,
    JSON.stringify(o.cartToken === null ? {} : { cartToken: o.cartToken }),
    o.cartToken,
    o.captured,
    o.method,
    now,
    now,
  ])
  const eventParams = rows.events.map((e) => [
    e.id,
    e.type,
    JSON.stringify({ id: e.id, type: e.type, payload: { orderId: e.subject } }),
    e.id,
    now,
    e.subject,
    now,
  ])

  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      for (const p of cartParams) db.prepare(cartSql).run(...p)
      for (const p of orderParams) db.prepare(orderSql).run(...p)
      for (const p of eventParams) db.prepare(eventSql).run(...p)
    } finally {
      db.close()
    }
    return
  }
  let n = 0
  const positional = (sql: string) => sql.replace(/\?/g, () => `$${(n += 1)}`)
  const numbered = (sql: string) => {
    n = 0
    return positional(sql)
  }
  const pool = new pg.Pool({ connectionString: target, max: 1 })
  try {
    for (const p of cartParams) await pool.query(numbered(cartSql), p)
    for (const p of orderParams) await pool.query(numbered(orderSql), p)
    for (const p of eventParams) await pool.query(numbered(eventSql), p)
  } finally {
    await pool.end()
  }
}

async function counts(dialect: Kernel['dialect'], target: string) {
  const raw = openRaw(dialect, target)
  try {
    return {
      carts: await raw.count('carts'),
      orders: await raw.count('orders'),
      events: await raw.count('events'),
    }
  } finally {
    await raw.close()
  }
}

export function sourceMigrationSuite(dialect: Kernel['dialect'], fresh: Fresh): void {
  describe(`AC-5: the source columns (${dialect})`, () => {
    // Kills: a migration that leaves existing rows null or another value, adds no default, or touches other rows.
    it(`AC-5: a database before the source migration holding carts, orders and events, migrated to the head, reads source storefront on every cart and order through the repositories, with the cart, order and event counts unchanged (${dialect})`, async () => {
      const db = await fresh()
      const before = migrationsBeforeOrderSource(dialect)
      try {
        await migrate(dialect, db.target, before.root)
        const rows = rowsBeforeSource()
        await insertBeforeSource(dialect, db.target, rows)
        const countsBeforeSource = await counts(dialect, db.target)

        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const store = createCommandStore(kernelConfig(dialect), storage(dialect, db.target))
        try {
          const carts = createCartRepository(store)
          const orders = createOrderRepository(store)
          const read = await store.read(async (tx) => {
            const out: Array<{ row: string; source: string | undefined }> = []
            for (const c of rows.carts) {
              const cart = await carts.findByToken(tx, c.token)
              out.push({ row: `cart ${cart?.token}`, source: cart?.source })
            }
            for (const o of rows.orders) {
              const order = await orders.findById(tx, o.id)
              out.push({ row: `order ${order?.id}`, source: order?.source })
            }
            return out
          })

          expect(await counts(dialect, db.target)).toEqual(countsBeforeSource)
          expect(read).toEqual([
            ...rows.carts.map((c) => ({ row: `cart ${c.token}`, source: 'storefront' })),
            ...rows.orders.map((o) => ({ row: `order ${o.id}`, source: 'storefront' })),
          ])
        } finally {
          await store.close()
        }
      } finally {
        before.drop()
        await db.drop()
      }
    }, 60_000)

    // Kills: an imported order read as a storefront sale, and an insert with no source left without the default.
    it(`AC-5: importOrder, given what the WooCommerce importer maps, inserts source import, and an order inserted with no source reads storefront (${dialect})`, async () => {
      const db = await fresh()
      let k: Kernel | undefined
      try {
        k = await createKernel(
          dialect === 'sqlite'
            ? { dialect, sqlitePath: db.target }
            : { dialect, postgresUrl: db.target },
        )
        const kernel = k
        const money = {
          lineItems: [line],
          subtotalMinor: 2500,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor: 2500,
          currency: 'GBP',
        }
        const imported = await kernel.services.order.importOrder({
          orderId: randomUUID(),
          orderNumber: `WC-${Math.floor(Math.random() * 1e9)}`,
          status: 'confirmed',
          createdAt: new Date('2025-01-02T10:00:00Z'),
          customerId: null,
          email: 'imported@source.test',
          billingAddress: address,
          shippingAddress: address,
          ...money,
          metadata: { woocommerce: { orderId: 41, paymentMethod: 'cod' } },
          capturedMinor: 2500,
          refundedMinor: 0,
          captureMethod: 'import',
        })
        const insertedId = randomUUID()
        await unaudited(() =>
          kernel.store.transaction(async (tx) => {
            const now = new Date()
            await kernel.repos.order.insert(tx, {
              id: insertedId,
              orderNumber: `SRC-${randomUUID().slice(0, 8)}`,
              sequence: await kernel.repos.orderSequence.nextSequence(tx),
              customerId: null,
              status: 'pending',
              email: 'inserted@source.test',
              billingAddress: address,
              shippingAddress: address,
              ...money,
              metadata: {},
              cartToken: randomUUID(),
              createdAt: now,
              updatedAt: now,
            })
          }),
        )
        const read = await kernel.store.read(async (tx) => ({
          imported: (await kernel.repos.order.findById(tx, imported.id))?.source,
          inserted: (await kernel.repos.order.findById(tx, insertedId))?.source,
        }))

        expect({ answered: imported.source, ...read }).toEqual({
          answered: 'import',
          imported: 'import',
          inserted: 'storefront',
        })
      } finally {
        await k?.close()
        await db.drop()
      }
    }, 60_000)
  })
}
