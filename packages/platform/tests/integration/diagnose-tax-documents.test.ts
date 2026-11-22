import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { TaxAdapter } from '@nymbalhq/types'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories } from '../../src/repositories/index.js'
import { address, kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import { scriptedTax, withTax } from '../support/tax.js'

// `nymbal doctor` says what the store still owes its tax provider: nothing, some but none for over an hour, or some for
// over an hour (the oldest named, with why, and whether the store will retry it). It reads the store and writes
// nothing. Rows are written straight into each store's file; ages are relative to the real clock.

const logger = createLogger({ pretty: false, level: 'silent' })
const FILING = 'filing-tax'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-tax-documents-'))
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

interface Owed {
  /** Null for a record whose order is gone. */
  orderNumber: string | null
  orderId: string
}

interface Seed {
  provider?: string
  /** How long ago the record became due; null for a record that owes nothing. */
  dueAgo: number | null
  lastError?: string | null
  /** False for a record whose order is gone. */
  order?: boolean
}

let sequence = 0

/** A migrated store holding an order and a filing record per seed, in the order given. */
async function storeWith(seeds: Seed[]): Promise<{ path: string; owed: Owed[] }> {
  const path = join(dir, `${randomUUID()}.sqlite`)
  const store = createCommandStore(kernelConfig('sqlite'), { sqlitePath: path })
  const owed: Owed[] = []
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const at = new Date(Date.now() - 5 * HOUR)
    for (const seed of seeds) {
      sequence += 1
      const orderId = randomUUID()
      const orderNumber = seed.order === false ? null : `DOC-${sequence}`
      if (orderNumber !== null) {
        await store.transaction((tx) =>
          repos.order.insert(tx, {
            id: orderId,
            orderNumber,
            sequence,
            customerId: null,
            status: 'confirmed',
            email: 'doctor@example.com',
            billingAddress: address,
            shippingAddress: address,
            lineItems: [],
            subtotalMinor: 5_000,
            taxTotalMinor: 455,
            shippingTotalMinor: 0,
            discountTotalMinor: 0,
            totalMinor: 5_000,
            currency: 'GBP',
            capture: { amountMinor: 5_000, method: 'provider', at, refundedMinor: 0 },
            createdAt: at,
            updatedAt: at,
          }),
        )
      }
      owed.push({ orderId, orderNumber })
    }
  } finally {
    await store.close()
  }
  if (seeds.length === 0) return { path, owed }
  const db = new Database(path)
  try {
    const insert = db.prepare(
      'INSERT INTO order_tax_documents (order_id, provider, status, attempts, last_error, due_since, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const now = Date.now()
    seeds.forEach((seed, i) => {
      const tried = seed.lastError != null
      insert.run(
        owed[i]!.orderId,
        seed.provider ?? FILING,
        'pending',
        tried ? 3 : 0,
        seed.lastError ?? null,
        seed.dueAgo === null ? null : new Date(now - seed.dueAgo).toISOString(),
        new Date(now - 5 * HOUR).toISOString(),
        new Date(now - MINUTE).toISOString(),
      )
    })
  } finally {
    db.close()
  }
  return { path, owed }
}

/** The store's tax set to a scripted provider named `filing-tax`, declaring commit unless `commit` is false. */
function filingStore(commit = true): { config: NymbalConfig; adapters: { tax: TaxAdapter } } {
  const tax = scriptedTax({
    providerName: FILING,
    capabilities: commit ? ['quote', 'inclusive', 'commit', 'refund'] : ['quote', 'inclusive'],
  })
  return {
    config: withTax({ provider: 'custom', pricesIncludeTax: true })(kernelConfig('sqlite')),
    adapters: { tax: tax.adapter },
  }
}

async function lineOf(
  path: string,
  setup: { config: NymbalConfig; adapters?: { tax: TaxAdapter } } = filingStore(),
) {
  const report = await diagnose(setup.config, {
    sqlitePath: path,
    logger,
    ...(setup.adapters !== undefined && { adapters: setup.adapters }),
  })
  return report.checks.find((c) => c.name === 'tax documents')
}

/**
 * Every row of every table in the file, as a second connection reads it, each table's rows in a canonical order (the
 * search index's shadow tables are WITHOUT ROWID, so there is no rowid to order by).
 */
function everyRow(path: string): Record<string, string[]> {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    )
  } finally {
    db.close()
  }
}

const RETRIED = 'the store retries every 5 minutes'
const notRetried = (provider: string) => `not retried: ${provider} is not the store's tax provider`

describe('AC-10: doctor’s tax documents line', () => {
  // Kills: the line missing, or placed where the CLI's own order lists do not expect it.
  it('AC-10: the line sits between legacy passwords and agents', async () => {
    const { path } = await storeWith([])
    const setup = filingStore()

    const names = (
      await diagnose(setup.config, { sqlitePath: path, logger, adapters: setup.adapters })
    ).checks.map((c) => c.name)

    expect(names.slice(names.indexOf('legacy passwords'), names.indexOf('agents') + 1)).toEqual([
      'legacy passwords',
      'tax documents',
      'agents',
    ])
  })

  // Kills: a record that owes nothing counted as owed, or rows owed for minutes reported as a problem.
  it('AC-10: ok "none due" when no record is due, and ok with the count when records are due but none for over an hour', async () => {
    const empty = await storeWith([])
    const settled = await storeWith([{ dueAgo: null }, { dueAgo: null, provider: 'old-tax' }])
    const recent = await storeWith([
      { dueAgo: 10 * MINUTE },
      { dueAgo: 50 * MINUTE, lastError: 'provider answered 503' },
      { dueAgo: null },
    ])

    expect([
      await lineOf(empty.path),
      await lineOf(settled.path),
      await lineOf(recent.path),
    ]).toEqual([
      { name: 'tax documents', status: 'ok', detail: 'none due' },
      { name: 'tax documents', status: 'ok', detail: 'none due' },
      { name: 'tax documents', status: 'ok', detail: '2 due, none for over an hour' },
    ])
  })

  // Kills: a merchant's unfiled transactions invisible until the provider's filing deadline; the oldest picked by
  // last write rather than by how long it has been owed.
  it('AC-10: degraded when a record has been due for over an hour, with the count over the hour, the oldest’s order number, provider and last error, and the retry', async () => {
    const { path, owed } = await storeWith([
      { dueAgo: 2 * HOUR, lastError: null },
      { dueAgo: 3 * HOUR, lastError: 'provider answered 503' },
      { dueAgo: 10 * MINUTE, lastError: 'later failure' },
    ])
    const untried = await storeWith([{ dueAgo: 90 * MINUTE, lastError: null }])

    expect(await lineOf(path)).toEqual({
      name: 'tax documents',
      status: 'degraded',
      detail: `2 due for over an hour; oldest ${owed[1]!.orderNumber} (${FILING}): provider answered 503; ${RETRIED}`,
    })
    expect(await lineOf(untried.path)).toEqual({
      name: 'tax documents',
      status: 'degraded',
      detail: `1 due for over an hour; oldest ${untried.owed[0]!.orderNumber} (${FILING}): not yet tried; ${RETRIED}`,
    })
  })

  // Kills: "the store retries every 5 minutes" said of a record the sweep never takes.
  it('AC-10: the hint says the record is not retried when its provider is not the configured one, or the configured one does not declare commit', async () => {
    const { path, owed } = await storeWith([
      { dueAgo: 2 * HOUR, lastError: 'provider answered 503' },
    ])
    const head = `1 due for over an hour; oldest ${owed[0]!.orderNumber} (${FILING}): provider answered 503`

    const lines = [
      await lineOf(path, { config: kernelConfig('sqlite') }),
      await lineOf(path, filingStore(false)),
    ]

    expect(lines).toEqual([
      { name: 'tax documents', status: 'degraded', detail: `${head}; ${notRetried(FILING)}` },
      {
        name: 'tax documents',
        status: 'degraded',
        detail: `${head}; not retried: ${FILING} does not file documents`,
      },
    ])
  })

  // Kills: the line failing, or naming nothing, when the record's order has been deleted.
  it('AC-10: the order id stands in for the number when the order is gone', async () => {
    const { path, owed } = await storeWith([{ dueAgo: 2 * HOUR, lastError: 'gone', order: false }])

    expect(await lineOf(path)).toEqual({
      name: 'tax documents',
      status: 'degraded',
      detail: `1 due for over an hour; oldest ${owed[0]!.orderId} (${FILING}): gone; ${RETRIED}`,
    })
  })

  // Kills: a read against a store that is not there, or not migrated, reported as nothing due.
  it('AC-10: down "not checked" when the command store or its migrations are down', async () => {
    const unmigrated = join(dir, `${randomUUID()}.sqlite`)
    new Database(unmigrated).close()

    expect([await lineOf(join(dir, 'missing', 'absent.sqlite')), await lineOf(unmigrated)]).toEqual(
      [
        { name: 'tax documents', status: 'down', detail: 'not checked: command store down' },
        { name: 'tax documents', status: 'down', detail: 'not checked: migrations down' },
      ],
    )
  })

  // Kills: a doctor that moves a record (clears it, bumps it) while reporting it.
  it('AC-10: the check writes nothing: every table’s rows are unchanged', async () => {
    const { path } = await storeWith([
      { dueAgo: 3 * HOUR, lastError: 'provider answered 503' },
      { dueAgo: 10 * MINUTE },
      { dueAgo: null },
    ])
    const before = everyRow(path)

    const line = await lineOf(path)

    expect(line?.status).toBe('degraded')
    expect(everyRow(path)).toEqual(before)
    expect(before['order_tax_documents']).toHaveLength(3)
  })
})
