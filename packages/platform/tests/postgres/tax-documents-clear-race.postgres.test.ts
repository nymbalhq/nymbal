import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address, OrderRefund, TaxAdapter, TaxQuote } from '@nymbalhq/types'
import { createCommandStore, type CommandStore, type ReadTx } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import { createTaxDocuments } from '../../src/services/tax-documents.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { openRaw, type RawReader } from '../support/raw.js'

// A filing that clears the order's record, racing a refund that settles and whose filing fails, on Postgres. Filing A
// has filed R1 and, in the transaction that clears the record, read the order's refunds; before it gets that answer,
// R2 settles succeeded and its failed filing is recorded, each in a transaction of its own on a second store (a write
// started from inside A's call chain would join A's transaction). A goes on once that failure has committed or is seen
// waiting on a lock. A succeeded refund must end filed or its record due, so the sweep retries it and the doctor
// shows it. SQLite serialises whole transactions, so the interleaving cannot be produced there.

const serverUrl = postgresServerUrl()

const PROVIDER = 'filing-tax'
const PARKED_DEADLINE_MS = 15_000
const POLL_MS = 5

const addr: Address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const QUOTE: TaxQuote = {
  provider: PROVIDER,
  inclusive: true,
  lines: [
    {
      id: 'variant-1',
      taxableMinor: 10_000,
      taxMinor: 909,
      ratePpm: 100_000,
      jurisdictions: [{ name: 'Scripted', level: 'country', ratePpm: 100_000, amountMinor: 909 }],
    },
  ],
  shippingTaxMinor: 0,
  totalTaxMinor: 909,
  quoteId: 'quote-42',
}

/** A provider that is up: every commit and refund is accepted. */
const providerUp: TaxAdapter = {
  kind: 'tax',
  providerName: PROVIDER,
  producesEvents: [],
  consumesEvents: [],
  initialize: async () => undefined,
  healthCheck: async () => ({ status: 'healthy' as const }),
  capabilities: () => ['quote', 'inclusive', 'commit', 'refund'],
  quote: async () => {
    throw new Error('filing never asks for a quote')
  },
  commit: async (_quote, ref) => ({ provider: PROVIDER, documentId: `doc-${ref.orderId}` }),
  refund: async () => undefined,
}

interface RecordRow {
  filed_refund_ids: string[]
  refunded_minor: number | string
  attempts: number | string
  last_error: string | null
  due_since: unknown
}

describe('a filing that clears the record, racing a refund whose filing failed (postgres)', () => {
  let db: TestDatabase
  let store: CommandStore
  let other: CommandStore
  let raw: RawReader
  let repos: Repositories
  let otherRepos: Repositories

  beforeAll(async () => {
    db = await createDatabase(serverUrl, 'tax_clear_race')
    store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    other = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
    raw = openRaw('postgres', db.url)
    repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    otherRepos = buildRepositories(other, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await other?.close()
    await store?.close()
    await db?.drop()
  })

  const record = (orderId: string) =>
    raw.one<RecordRow>('SELECT * FROM order_tax_documents WHERE order_id = ?', [orderId])

  const succeededRefunds = (orderId: string) =>
    raw.rows<{ id: string; amount_minor: number | string }>(
      "SELECT id, amount_minor FROM order_refunds WHERE order_id = ? AND status = 'succeeded' ORDER BY created_at",
      [orderId],
    )

  async function lockWaiters(): Promise<number> {
    const row = await raw.one<{ n: number | string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    return Number(row.n)
  }

  async function seedOrder(): Promise<string> {
    const id = uuidv7()
    const at = new Date(Date.now() - 60_000)
    await store.transaction((tx) =>
      repos.order.insert(tx, {
        id,
        orderNumber: 'TCR-1',
        sequence: 1,
        customerId: null,
        status: 'confirmed',
        email: 'filed@example.com',
        billingAddress: addr,
        shippingAddress: addr,
        lineItems: [],
        subtotalMinor: 10_000,
        taxTotalMinor: 909,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: 10_000,
        currency: 'GBP',
        metadata: { tax: structuredClone(QUOTE) },
        capture: { amountMinor: 10_000, method: 'provider' as const, at, refundedMinor: 0 },
        pricesIncludeTax: true,
        createdAt: at,
        updatedAt: at,
      }),
    )
    return id
  }

  async function seedRefund(
    orderId: string,
    r: { amountMinor: number; status: 'pending' | 'succeeded'; at: Date },
  ): Promise<string> {
    const id = uuidv7()
    await store.transaction((tx) =>
      repos.orderRefund.insert(tx, {
        id,
        orderId,
        amountMinor: r.amountMinor,
        currency: 'GBP',
        providerRefundId: null,
        status: r.status,
        reason: null,
        actor: 'admin:test',
        createdAt: r.at,
      }),
    )
    return id
  }

  // Kills: the clearing transaction reads the record without a lock, so the failure commits between its refunds read
  // and its clear, and the clear wipes due_since: R2 is never swept and the doctor says none due.
  it('AC-1: a succeeded refund is filed or its record is due: a refund whose filing failed while another filing was clearing the record stays due, and the next filing files it and clears the record', async () => {
    const orderId = await seedOrder()
    const logger = createLogger({ pretty: false, level: 'silent' })

    let armed = false
    let r1 = ''
    let reached!: () => void
    const atRefundsRead = new Promise<void>((resolve) => (reached = resolve))
    let goOn!: () => void
    const letGo = new Promise<void>((resolve) => (goOn = resolve))
    const filedIds = async () => (await record(orderId)).filed_refund_ids

    // A's refunds read once R1 is filed: the read in the transaction that clears the record. Its answer is computed
    // first, then held until the test body lets A go on.
    const listByOrder = repos.orderRefund.listByOrder
    const orderRefund: Repositories['orderRefund'] = {
      ...repos.orderRefund,
      async listByOrder(tx: ReadTx, id: string): Promise<OrderRefund[]> {
        const answer = await listByOrder(tx, id)
        if (armed && id === orderId && (await filedIds()).includes(r1)) {
          armed = false
          reached()
          await letGo
        }
        return answer
      },
    }
    const documents = createTaxDocuments({
      store,
      repos: { ...repos, orderRefund },
      tax: providerUp,
      logger,
    })

    expect(await documents.file(orderId), 'the order is committed first').toBe('filed')
    r1 = await seedRefund(orderId, {
      amountMinor: 300,
      status: 'succeeded',
      at: new Date(Date.now() - 2_000),
    })
    const r2 = await seedRefund(orderId, {
      amountMinor: 200,
      status: 'pending',
      at: new Date(Date.now() - 1_000),
    })

    armed = true
    const filingA = documents.file(orderId)
    // A failure before A reaches its clearing read fails the test here.
    await Promise.race([atRefundsRead, filingA])

    await other.transaction((tx) =>
      otherRepos.orderRefund.settle(tx, r2, { status: 'succeeded', providerRefundId: 're_2' }),
    )
    let failureLanded = false
    const failure = other
      .transaction((tx) =>
        otherRepos.orderTaxDocument.recordFailure(tx, orderId, 'provider flapped', new Date()),
      )
      .finally(() => {
        failureLanded = true
      })
    const deadline = Date.now() + PARKED_DEADLINE_MS
    while (!failureLanded && (await lockWaiters()) < 1) {
      if (Date.now() > deadline) {
        throw new Error('the recorded failure neither committed nor waited on a lock')
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    goOn()
    await Promise.all([filingA, failure])

    const raced = await record(orderId)
    expect(raced.filed_refund_ids, 'R1 filed by A, R2 not filed').toEqual([r1])
    expect(
      raced.due_since,
      'a succeeded refund left unfiled must keep its record due',
    ).not.toBeNull()
    expect(Number(raced.attempts)).toBeGreaterThanOrEqual(1)
    expect(raced.last_error).toBe('provider flapped')

    expect(await documents.file(orderId)).toBe('filed')
    const after = await record(orderId)
    const succeeded = await succeededRefunds(orderId)
    expect(succeeded.map((r) => r.id)).toEqual([r1, r2])
    expect(after.filed_refund_ids).toEqual(succeeded.map((r) => r.id))
    expect(Number(after.refunded_minor)).toBe(
      succeeded.reduce((sum, r) => sum + Number(r.amount_minor), 0),
    )
    expect([Number(after.attempts), after.last_error, after.due_since]).toEqual([0, null, null])
  })
})
