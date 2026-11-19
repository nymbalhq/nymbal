import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { OrderLineItem } from '@nymbalhq/types'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { buildRepositories } from '../../../src/repositories/index.js'
import { address, createKernel, kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { unaudited } from '../write-audit.js'

// AC-23 on one dialect: the tax columns. A product and a variant written with a tax code through their repositories
// read back with it, and an order written with pricesIncludeTax reads back with it; a database one migration before
// the columns, holding a product, a variant and an order, reads null codes and false once migrated to the head.

type Fresh = () => Promise<{ target: string; drop(): Promise<void> }>

const COLUMNS = /\b(tax_code|prices_include_tax)\b/

/** A copy of the migrations folder for `dialect` holding every migration before the first that adds a tax column. */
function migrationsBeforeTaxColumns(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const from = join(MIGRATIONS_ROOT, dialect)
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  const adding = journal.entries.find((entry) =>
    COLUMNS.test(readFileSync(join(from, `${entry.tag}.sql`), 'utf8')),
  )
  if (adding === undefined) {
    throw new Error(
      `expected a migration in ${from} adding products.tax_code, variants.tax_code and orders.prices_include_tax`,
    )
  }
  const root = mkdtempSync(join(tmpdir(), 'tax-columns-migrations-'))
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  journal.entries = journal.entries.filter((entry) => entry.idx < adding.idx)
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
  variantId: 'tax-variant',
  productId: 'tax-product',
  productName: 'Tax Widget',
  variantName: 'Default',
  sku: 'TAX-1',
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 417,
  lineTotalMinor: 2500,
  imageUrl: '',
}

interface Before {
  productId: string
  variantId: string
  orderId: string
}

/** A product, its variant and an order, written as the schema stood before the tax columns. */
async function insertBeforeTaxColumns(dialect: Kernel['dialect'], target: string): Promise<Before> {
  const now = new Date().toISOString()
  const ids: Before = { productId: randomUUID(), variantId: randomUUID(), orderId: randomUUID() }
  const statements: Array<[string, unknown[]]> = [
    [
      'INSERT INTO products (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ids.productId, `tax-${ids.productId}`, 'Tax Widget', 'active', now, now],
    ],
    [
      'INSERT INTO variants (id, product_id, sku, name, price_minor, stock, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ids.variantId, ids.productId, `TAX-${ids.variantId}`, 'Default', 2500, 5, now, now],
    ],
    [
      'INSERT INTO orders (id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, ' +
        'line_items, subtotal_minor, tax_total_minor, total_minor, currency, metadata, created_at, updated_at) ' +
        "VALUES (?, ?, ?, NULL, 'pending', ?, ?, ?, ?, 2500, 417, 2917, 'GBP', '{}', ?, ?)",
      [
        ids.orderId,
        `TAXCOL-${ids.orderId.slice(0, 8)}`,
        900_000,
        'before@tax-columns.test',
        JSON.stringify(address),
        JSON.stringify(address),
        JSON.stringify([line]),
        now,
        now,
      ],
    ],
  ]
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      for (const [sql, params] of statements) db.prepare(sql).run(...params)
    } finally {
      db.close()
    }
    return ids
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    for (const [sql, params] of statements) {
      let n = 0
      await client.query(
        sql.replace(/\?/g, () => `$${(n += 1)}`),
        params,
      )
    }
  } finally {
    await client.end()
  }
  return ids
}

const arbCode = fc.option(fc.stringMatching(/^[a-z][a-z0-9_-]{0,23}$/), { nil: null })

export function taxColumnsSuite(dialect: Kernel['dialect'], fresh: Fresh): void {
  describe(`AC-23: the tax columns (${dialect})`, () => {
    // Kills: a column written and not read, or read and never written, on either dialect.
    it(`AC-23: property: a product and a variant written with a taxCode through their repositories read back with it, null included, and an order written with pricesIncludeTax reads back with it (${dialect})`, async () => {
      const db = await fresh()
      let k: Kernel | undefined
      try {
        k = await createKernel(
          dialect === 'sqlite'
            ? { dialect, sqlitePath: db.target }
            : { dialect, postgresUrl: db.target },
        )
        const kernel = k
        await fc.assert(
          fc.asyncProperty(
            arbCode,
            arbCode,
            fc.boolean(),
            async (productCode, variantCode, inclusive) => {
              const productId = randomUUID()
              const variantId = randomUUID()
              const orderId = randomUUID()
              const now = new Date()
              await unaudited(() =>
                kernel.store.transaction(async (tx) => {
                  await kernel.repos.product.insert(tx, {
                    id: productId,
                    slug: `tax-${productId}`,
                    name: 'Tax Widget',
                    taxCode: productCode,
                    createdAt: now,
                    updatedAt: now,
                  })
                  await kernel.repos.variant.insert(tx, {
                    id: variantId,
                    productId,
                    sku: `TAX-${variantId}`,
                    name: 'Default',
                    priceMinor: 2500,
                    stock: 5,
                    options: [],
                    taxCode: variantCode,
                    createdAt: now,
                    updatedAt: now,
                  })
                  await kernel.repos.order.insert(tx, {
                    id: orderId,
                    orderNumber: `TAXCOL-${orderId.slice(0, 8)}`,
                    sequence: await kernel.repos.orderSequence.nextSequence(tx),
                    customerId: null,
                    status: 'pending',
                    email: 'written@tax-columns.test',
                    billingAddress: address,
                    shippingAddress: address,
                    lineItems: [line],
                    subtotalMinor: 2500,
                    taxTotalMinor: 417,
                    shippingTotalMinor: 0,
                    discountTotalMinor: 0,
                    totalMinor: inclusive ? 2500 : 2917,
                    currency: 'GBP',
                    pricesIncludeTax: inclusive,
                    createdAt: now,
                    updatedAt: now,
                  })
                }),
              )

              const read = await kernel.store.read(async (tx) => ({
                product: (await kernel.repos.product.findById(tx, productId))?.taxCode,
                variant: (await kernel.repos.variant.findById(tx, variantId))?.taxCode,
                order: (await kernel.repos.order.findById(tx, orderId))?.pricesIncludeTax,
              }))

              expect(read).toEqual({ product: productCode, variant: variantCode, order: inclusive })
            },
          ),
          { numRuns: 15 },
        )
      } finally {
        await k?.close()
        await db.drop()
      }
    }, 60_000)

    // Kills: a migration that leaves existing rows null where false is meant, or invents a code for them.
    it(`AC-23: a product, a variant and an order written before the tax columns, migrated to the head, read taxCode null and pricesIncludeTax false (${dialect})`, async () => {
      const db = await fresh()
      const before = migrationsBeforeTaxColumns(dialect)
      try {
        await migrate(dialect, db.target, before.root)
        const ids = await insertBeforeTaxColumns(dialect, db.target)

        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const store = createCommandStore(kernelConfig(dialect), storage(dialect, db.target))
        const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
        const read = await store
          .read(async (tx) => ({
            product: (await repos.product.findById(tx, ids.productId))?.taxCode,
            variant: (await repos.variant.findById(tx, ids.variantId))?.taxCode,
            order: (await repos.order.findById(tx, ids.orderId))?.pricesIncludeTax,
            total: (await repos.order.findById(tx, ids.orderId))?.totalMinor,
          }))
          .finally(() => store.close())

        expect(read).toEqual({ product: null, variant: null, order: false, total: 2917 })
      } finally {
        before.drop()
        await db.drop()
      }
    }, 60_000)
  })
}
