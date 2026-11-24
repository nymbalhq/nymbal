import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Address,
  OrderRefundStatus,
  OrderStatus,
  TaxAdapter,
  TaxCapability,
  TaxDocument,
  TaxQuote,
} from '@nymbalhq/types'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createLogger } from '../logger.js'
import { buildRepositories, type Repositories } from '../repositories/index.js'
import { createTaxDocuments } from './tax-documents.js'

// Filing a paid order and its refunds with the store's tax provider: what is never filed, the commit, its failures,
// each refund filed once whatever the provider does between calls, and two filings of one order at once. The store is
// a real SQLite `:memory:` command store with every migration; the provider is a stub the test scripts, and the record
// is read back as its table holds it.

const PROVIDER = 'filing-tax'
const T0 = Date.parse('2026-11-20T09:00:00.000Z')
const MINUTE = 60_000

const addr: Address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

/** The quote checkout stored on the order: what `commit` must be handed back exactly. */
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

type Ref = { orderId: string; orderNumber: string; currency: string }
type RefundRef = { refundId: string; amountMinor: number; currency: string }

interface Env {
  store: CommandStore
  repos: Repositories
  lines: string[]
  clock: { at: number }
  now: () => Date
}

const opened: CommandStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of opened.splice(0)) await store.close()
})

async function open(): Promise<Env> {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  opened.push(store)
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const clock = { at: T0 }
  return { store, repos, lines: [], clock, now: () => new Date(clock.at) }
}

function sqlite(env: Env) {
  const clients = rawClients(env.store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  return clients.raw
}

interface DocRow {
  order_id: string
  provider: string
  status: string
  document_id: string | null
  committed_at: unknown
  refunded_minor: number
  filed_refund_ids: string[]
  attempts: number
  last_error: string | null
  due_since: unknown
}

/** The order's filing record as its table holds it, or null. */
function docRow(env: Env, orderId: string): DocRow | null {
  const row = sqlite(env)
    .prepare('SELECT * FROM order_tax_documents WHERE order_id = ?')
    .get(orderId) as (Omit<DocRow, 'filed_refund_ids'> & { filed_refund_ids: string }) | undefined
  if (row === undefined) return null
  return {
    ...row,
    refunded_minor: Number(row.refunded_minor),
    attempts: Number(row.attempts),
    filed_refund_ids: JSON.parse(row.filed_refund_ids) as string[],
  }
}

function docCount(env: Env): number {
  const row = sqlite(env).prepare('SELECT count(*) AS n FROM order_tax_documents').get() as {
    n: number
  }
  return Number(row.n)
}

/** A timestamp column as epoch ms, null when unset. */
const ms = (value: unknown): number | null =>
  value == null ? null : new Date(value as string | number).getTime()

interface Stub {
  adapter: TaxAdapter
  commits: Array<{ quote: TaxQuote; ref: Ref; openTransaction: boolean; row: DocRow | null }>
  refunds: Array<{
    doc: TaxDocument
    refund: RefundRef
    afterCommit: boolean
    openTransaction: boolean
  }>
  accepted: Array<{ doc: TaxDocument; refund: RefundRef }>
  /** What the next commit answers; one document per order while left as it is. */
  commit: (quote: TaxQuote, ref: Ref) => Promise<TaxDocument>
  refund: (doc: TaxDocument, refund: RefundRef) => Promise<void>
}

const documentOf = (orderId: string): TaxDocument => ({
  provider: PROVIDER,
  documentId: `doc-${orderId}`,
})

/**
 * A provider declaring `declares` (commit and refund by default), with both methods unless `methods` is false. Each
 * call is recorded with what the store held when it was made: the record, and whether a transaction was open.
 */
function stubTax(
  env: Env,
  opts: { declares?: TaxCapability[]; methods?: boolean; providerName?: string } = {},
): Stub {
  const committed = new Set<string>()
  const stub: Stub = {
    commits: [],
    refunds: [],
    accepted: [],
    commit: async (_quote, ref) => documentOf(ref.orderId),
    refund: async () => undefined,
    adapter: {
      kind: 'tax',
      providerName: opts.providerName ?? PROVIDER,
      producesEvents: [],
      consumesEvents: [],
      initialize: async () => undefined,
      healthCheck: async () => ({ status: 'healthy' as const }),
      capabilities: () => opts.declares ?? ['quote', 'inclusive', 'commit', 'refund'],
      quote: async () => {
        throw new Error('filing never asks for a quote')
      },
    },
  }
  if (opts.methods !== false) {
    stub.adapter.commit = (quote, ref) => {
      stub.commits.push({
        quote: structuredClone(quote),
        ref: { ...ref },
        openTransaction: sqlite(env).inTransaction,
        row: docRow(env, ref.orderId),
      })
      return stub.commit(quote, ref).then((doc) => {
        committed.add(ref.orderId)
        return doc
      })
    }
    stub.adapter.refund = (doc, refund) => {
      const orderId = doc.documentId.replace(/^doc-/, '')
      stub.refunds.push({
        doc: { ...doc },
        refund: { ...refund },
        afterCommit: committed.has(orderId),
        openTransaction: sqlite(env).inTransaction,
      })
      return stub.refund(doc, refund).then(() => {
        stub.accepted.push({ doc: { ...doc }, refund: { ...refund } })
      })
    }
  }
  return stub
}

function filer(env: Env, stub: Stub, boundMs?: number) {
  const logger = createLogger({
    pretty: false,
    level: 'warn',
    destination: { write: (line: string) => void env.lines.push(line) },
  })
  return createTaxDocuments({
    store: env.store,
    repos: env.repos,
    tax: stub.adapter,
    logger,
    now: env.now,
    ...(boundMs !== undefined && { boundMs }),
  })
}

let sequence = 0

interface SeededOrder {
  id: string
  orderNumber: string
  currency: string
  tax: unknown
}

const ABSENT = Symbol('absent')

/** A paid order whose quote came from the provider: fileable unless one option says otherwise. */
async function seedOrder(
  env: Env,
  over: { status?: OrderStatus; capturedMinor?: number; tax?: unknown } = {},
): Promise<SeededOrder> {
  sequence += 1
  const id = uuidv7()
  const orderNumber = `TD-${sequence}`
  const capturedMinor = over.capturedMinor ?? 10_000
  const tax = 'tax' in over ? over.tax : structuredClone(QUOTE)
  const at = new Date(T0 - 10 * MINUTE)
  await env.store.transaction((tx) =>
    env.repos.order.insert(tx, {
      id,
      orderNumber,
      sequence,
      customerId: null,
      status: over.status ?? 'confirmed',
      email: 'filed@example.com',
      billingAddress: addr,
      shippingAddress: addr,
      lineItems: [],
      subtotalMinor: 10_000,
      taxTotalMinor: 909,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: Math.max(10_000, capturedMinor),
      currency: 'GBP',
      metadata: tax === ABSENT ? {} : { tax },
      ...(capturedMinor > 0 && {
        capture: { amountMinor: capturedMinor, method: 'provider' as const, at, refundedMinor: 0 },
      }),
      pricesIncludeTax: true,
      createdAt: at,
      updatedAt: at,
    }),
  )
  return { id, orderNumber, currency: 'GBP', tax }
}

/** A refund row of the order, with the order's refunded_minor kept to Σ its succeeded refunds. */
async function seedRefund(
  env: Env,
  orderId: string,
  r: { id?: string; amountMinor: number; status: OrderRefundStatus; at: number },
): Promise<string> {
  const id = r.id ?? uuidv7()
  await env.store.transaction(async (tx) => {
    await env.repos.orderRefund.insert(tx, {
      id,
      orderId,
      amountMinor: r.amountMinor,
      currency: 'GBP',
      providerRefundId: null,
      status: r.status,
      reason: null,
      actor: 'admin:test',
      createdAt: new Date(r.at),
    })
    const rows = await env.repos.orderRefund.listByOrder(tx, orderId)
    const refunded = rows
      .filter((row) => row.status === 'succeeded')
      .reduce((sum, row) => sum + row.amountMinor, 0)
    await env.repos.order.setRefunded(tx, orderId, refunded, new Date(r.at))
  })
  return id
}

const refundedOf = async (env: Env, orderId: string): Promise<number> =>
  (await env.store.read((tx) => env.repos.order.findById(tx, orderId)))!.refundedMinor

/** The JSON lines logged at warn (pino level 40) since `from`. */
const warnings = (env: Env, from: number): string[] =>
  env.lines.slice(from).filter((line) => (JSON.parse(line) as { level: number }).level === 40)

describe('AC-1: what is never filed', () => {
  // Kills: a filing for a transaction the provider never quoted, a native-table guess, an unpaid order, or the money of
  // a cancelled order: each case is a fileable order but for its one disqualifier.
  const cases: Array<{
    name: string
    stub?: Parameters<typeof stubTax>[1]
    order: (env: Env) => Promise<string>
  }> = [
    {
      name: 'an adapter that does not declare commit',
      stub: { declares: ['quote', 'inclusive', 'refund'] },
      order: async (env) => (await seedOrder(env)).id,
    },
    {
      name: 'an adapter that declares commit with no method',
      stub: { methods: false },
      order: async (env) => (await seedOrder(env)).id,
    },
    { name: 'a missing order', order: async () => uuidv7() },
    {
      name: 'a cancelled order with captured_minor > 0 and a succeeded refund',
      order: async (env) => {
        const order = await seedOrder(env, { status: 'cancelled' })
        await seedRefund(env, order.id, { amountMinor: 10_000, status: 'succeeded', at: T0 })
        return order.id
      },
    },
    {
      name: 'an order with captured_minor 0',
      order: async (env) => (await seedOrder(env, { capturedMinor: 0 })).id,
    },
    {
      name: 'metadata.tax absent',
      order: async (env) => (await seedOrder(env, { tax: ABSENT })).id,
    },
    {
      name: 'metadata.tax not an object',
      order: async (env) => (await seedOrder(env, { tax: PROVIDER })).id,
    },
    {
      name: 'metadata.tax with no provider',
      order: async (env) => {
        const { provider: _provider, ...rest } = QUOTE
        return (await seedOrder(env, { tax: rest })).id
      },
    },
    {
      name: 'metadata.tax with a provider that is not a string',
      order: async (env) => (await seedOrder(env, { tax: { ...QUOTE, provider: 42 } })).id,
    },
    {
      name: 'metadata.tax.fallback true',
      order: async (env) => (await seedOrder(env, { tax: { ...QUOTE, fallback: true } })).id,
    },
  ]

  it.each(cases)(
    'AC-1: $name answers none, calls no provider and writes no record',
    async ({ stub: opts, order }) => {
      const env = await open()
      const stub = stubTax(env, opts)
      const documents = filer(env, stub)
      const orderId = await order(env)

      const answer = await documents.file(orderId)

      expect(answer).toBe('none')
      expect([stub.commits.length, stub.refunds.length]).toEqual([0, 0])
      expect(docCount(env)).toBe(0)
    },
  )

  it('AC-1: an order quoted by another provider answers none, calls nothing, writes no record and logs one warning naming both providers and the order number', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const order = await seedOrder(env, { tax: { ...QUOTE, provider: 'old-tax' } })
    const from = env.lines.length

    const answer = await documents.file(order.id)

    expect(answer).toBe('none')
    expect([stub.commits.length, stub.refunds.length, docCount(env)]).toEqual([0, 0, 0])
    const warned = warnings(env, from)
    expect(warned).toHaveLength(1)
    expect(
      ['old-tax', PROVIDER, order.orderNumber].filter((word) => !warned[0]!.includes(word)),
    ).toEqual([])
  })
})

describe('AC-2: a paid order is committed once, with the quote it was charged', () => {
  // Kills: an order filed with a quote other than the stored one, under another order's reference, filed with a
  // transaction held across the provider call, or filed again on every call.
  it('AC-2: file makes a pending record, calls commit once with the stored quote and the order reference, then holds it committed with the document and answers filed; a second file calls nothing', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const order = await seedOrder(env)
    const calledAt = env.clock.at

    const first = await documents.file(order.id)
    env.clock.at += MINUTE
    const second = await documents.file(order.id)

    expect([first, second]).toEqual(['filed', 'filed'])
    expect(stub.commits).toHaveLength(1)
    const [call] = stub.commits
    expect(call!.quote).toEqual(order.tax)
    expect(call!.ref).toEqual({
      orderId: order.id,
      orderNumber: order.orderNumber,
      currency: order.currency,
    })
    // While the provider was asked: the record pending under this provider, owed since the call, no transaction open.
    expect({
      status: call!.row?.status,
      provider: call!.row?.provider,
      dueSince: ms(call!.row?.due_since),
      openTransaction: call!.openTransaction,
    }).toEqual({
      status: 'pending',
      provider: PROVIDER,
      dueSince: calledAt,
      openTransaction: false,
    })
    const row = docRow(env, order.id)!
    expect({
      status: row.status,
      provider: row.provider,
      documentId: row.document_id,
      committedAt: ms(row.committed_at),
      attempts: row.attempts,
      lastError: row.last_error,
      dueSince: row.due_since,
    }).toEqual({
      status: 'committed',
      provider: stub.adapter.providerName,
      documentId: documentOf(order.id).documentId,
      committedAt: calledAt,
      attempts: 0,
      lastError: null,
      dueSince: null,
    })
  })
})

describe('AC-3: a commit that fails is recorded, never thrown', () => {
  // Kills: an outage thrown into the relay, or lost with no record to retry from; a hung provider holding file for
  // ever; due_since moved by every retry, so the doctor never ages it.
  const failures: Array<{
    name: string
    fail: Stub['commit']
    message: string | RegExp
  }> = [
    {
      name: 'rejects',
      fail: () => Promise.reject(new Error('provider answered 503')),
      message: 'provider answered 503',
    },
    {
      name: 'throws synchronously',
      fail: () => {
        throw new Error('provider client threw')
      },
      message: 'provider client threw',
    },
    { name: 'never answers (past the bound)', fail: () => new Promise(() => {}), message: /\S/ },
    {
      name: 'answers an empty documentId',
      fail: async () => ({ provider: PROVIDER, documentId: '' }),
      message: /\S/,
    },
  ]

  it.each(failures)(
    'AC-3: a commit that $name leaves the record pending, one attempt more per call, due since the first attempt, answers due; the next file with the provider up commits and clears the failure',
    async ({ fail, message }) => {
      const env = await open()
      const stub = stubTax(env)
      const documents = filer(env, stub, 40)
      const order = await seedOrder(env)
      stub.commit = fail
      const firstAt = env.clock.at

      const answers = [await documents.file(order.id)]
      const once = docRow(env, order.id)!
      env.clock.at += 5 * MINUTE
      answers.push(await documents.file(order.id))
      const twice = docRow(env, order.id)!
      stub.commit = async (_quote, ref) => documentOf(ref.orderId)
      env.clock.at += 5 * MINUTE
      answers.push(await documents.file(order.id))
      const filed = docRow(env, order.id)!

      expect(answers).toEqual(['due', 'due', 'filed'])
      expect([once.status, twice.status]).toEqual(['pending', 'pending'])
      expect(once.attempts).toBe(1)
      expect(twice.attempts).toBe(once.attempts + 1)
      expect(ms(once.due_since)).toBe(firstAt)
      expect(ms(twice.due_since)).toBe(ms(once.due_since))
      expect(once.last_error).toMatch(message)
      expect(twice.last_error).toMatch(message)
      expect({
        status: filed.status,
        documentId: filed.document_id,
        attempts: filed.attempts,
        lastError: filed.last_error,
        dueSince: filed.due_since,
      }).toEqual({
        status: 'committed',
        documentId: documentOf(order.id).documentId,
        attempts: 0,
        lastError: null,
        dueSince: null,
      })
      expect(stub.commits).toHaveLength(3)
    },
  )

  it('AC-3: a failure message of 2 000 characters is stored as its first 500', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const order = await seedOrder(env)
    const message = Array.from({ length: 2_000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('')
    stub.commit = () => Promise.reject(new Error(message))

    expect(await documents.file(order.id)).toBe('due')

    expect(docRow(env, order.id)!.last_error).toBe(message.slice(0, 500))
  })

  it('AC-3: a store read that fails rejects file with the store’s error and calls no provider', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const order = await seedOrder(env)
    vi.spyOn(env.store, 'read').mockRejectedValue(new Error('command store offline'))
    vi.spyOn(env.store, 'transaction').mockRejectedValue(new Error('command store offline'))

    await expect(documents.file(order.id)).rejects.toThrow('command store offline')

    expect([stub.commits.length, stub.refunds.length]).toEqual([0, 0])
  })
})

describe('AC-4: each refund is filed once', () => {
  const arbRun = fc.record({
    capturedMinor: fc.integer({ min: 600, max: 100_000 }),
    refunds: fc.array(
      fc.record({
        status: fc.constantFrom<OrderRefundStatus>('succeeded', 'failed', 'pending'),
        // A share of a sixth of the capture: six refunds never pass it.
        share: fc.integer({ min: 1, max: 100 }),
        filesAfter: fc.integer({ min: 0, max: 2 }),
      }),
      { maxLength: 6 },
    ),
    filesBefore: fc.integer({ min: 0, max: 2 }),
    /** One entry per provider call, commit or refund, in order: true fails that call; the provider is up after. */
    failures: fc.array(fc.boolean(), { maxLength: 12 }),
    declaresRefund: fc.boolean(),
  })

  // Kills: a refund filed twice on a retry, a refund settled before the commit dropped, a failed or pending refund
  // filed, a refund filed before the order, or the record's sum drifting from the order's.
  it('AC-4: property: at every step the record’s refunded_minor is Σ its filed refunds and at most the order’s, nothing is filed before the commit and only succeeded refunds are; once the provider is up the provider holds exactly the succeeded refunds, each once, oldest first, and nothing is owed; with refund undeclared no refund is filed and nothing is owed', async () => {
    const env = await open()
    const withRefund = stubTax(env)
    const commitOnly = stubTax(env, { declares: ['quote', 'inclusive', 'commit'] })
    const filers = new Map([
      [withRefund, filer(env, withRefund)],
      [commitOnly, filer(env, commitOnly)],
    ])
    let script: boolean[] = []
    for (const stub of [withRefund, commitOnly]) {
      stub.commit = async (_quote, ref) => {
        if (script.shift() === true) throw new Error('commit refused')
        return documentOf(ref.orderId)
      }
      stub.refund = async () => {
        if (script.shift() === true) throw new Error('refund refused')
      }
    }

    await fc.assert(
      fc.asyncProperty(arbRun, async (run) => {
        const stub = run.declaresRefund ? withRefund : commitOnly
        const documents = filers.get(stub)!
        stub.commits.length = 0
        stub.refunds.length = 0
        stub.accepted.length = 0
        script = [...run.failures]
        const order = await seedOrder(env, { capturedMinor: run.capturedMinor })
        const amounts = new Map<string, number>()
        const statuses = new Map<string, OrderRefundStatus>()

        const check = async () => {
          const row = docRow(env, order.id)
          if (row === null) return
          const filed = row.filed_refund_ids
          expect(new Set(filed).size, JSON.stringify(filed)).toBe(filed.length)
          expect(row.refunded_minor).toBe(filed.reduce((sum, id) => sum + amounts.get(id)!, 0))
          expect(row.refunded_minor).toBeLessThanOrEqual(await refundedOf(env, order.id))
          expect(filed.filter((id) => statuses.get(id) !== 'succeeded')).toEqual([])
          // Nothing is filed before the commit.
          expect(row.status === 'committed' ? [] : filed).toEqual([])
          const ours = stub.refunds.filter(
            (c) => c.doc.documentId === documentOf(order.id).documentId,
          )
          expect(
            ours.filter((c) => !c.afterCommit || statuses.get(c.refund.refundId) !== 'succeeded'),
          ).toEqual([])
          // The provider is never asked to file a refund while a transaction is open.
          expect(ours.filter((c) => c.openTransaction)).toEqual([])
        }

        for (let i = 0; i < run.filesBefore; i += 1) {
          await documents.file(order.id)
          await check()
        }
        for (const [i, r] of run.refunds.entries()) {
          const amountMinor = Math.max(1, Math.floor((run.capturedMinor * r.share) / 600))
          const id = await seedRefund(env, order.id, {
            amountMinor,
            status: r.status,
            at: T0 + (i + 1) * 1_000,
          })
          amounts.set(id, amountMinor)
          statuses.set(id, r.status)
          for (let j = 0; j < r.filesAfter; j += 1) {
            await documents.file(order.id)
            await check()
          }
        }
        script = []
        const answer = await documents.file(order.id)
        await check()

        const row = docRow(env, order.id)!
        const succeeded = [...statuses].filter(([, s]) => s === 'succeeded').map(([id]) => id)
        const expected = run.declaresRefund ? succeeded : []
        const doc = { provider: row.provider, documentId: row.document_id }
        expect(answer).toBe('filed')
        expect([row.status, ms(row.due_since)]).toEqual(['committed', null])
        expect(stub.accepted.map((c) => c.refund.refundId)).toEqual(expected)
        expect(
          stub.accepted.filter(
            (c) =>
              c.refund.amountMinor !== amounts.get(c.refund.refundId) ||
              c.refund.currency !== 'GBP' ||
              c.doc.provider !== doc.provider ||
              c.doc.documentId !== doc.documentId,
          ),
        ).toEqual([])
        expect(row.filed_refund_ids).toEqual(expected)
        expect(row.refunded_minor).toBe(run.declaresRefund ? await refundedOf(env, order.id) : 0)
        // With refund undeclared, the provider is never asked to file one.
        expect(run.declaresRefund ? [] : stub.refunds).toEqual([])
      }),
      { numRuns: 60 },
    )
  }, 60_000)
})

describe('AC-5: two filings of one order at once', () => {
  /**
   * A provider that answers only once both filings are inside a call, or once one of them has finished: the two
   * overlap as far as they can.
   */
  function overlapping(stub: Stub) {
    let waiting: Array<() => void> = []
    let finished = false
    // A filing that never reaches the provider while the other waits there (one serialised behind the other) is let
    // through after a bound, so the test fails on the record rather than hanging.
    let fallback: NodeJS.Timeout | undefined
    const flush = () => {
      clearTimeout(fallback)
      const ready = waiting
      waiting = []
      for (const go of ready) go()
    }
    const barrier = () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
        clearTimeout(fallback)
        if (finished || waiting.length >= 2) flush()
        else fallback = setTimeout(flush, 1_000)
      })
    stub.commit = async (_quote, ref) => {
      await barrier()
      return documentOf(ref.orderId)
    }
    stub.refund = async () => {
      await barrier()
    }
    return {
      /** Starts a round; `alone` lets every call through, for one filing on its own. */
      reset(alone = false) {
        waiting = []
        finished = alone
      },
      settle<T>(p: Promise<T>): Promise<T> {
        return p.finally(() => {
          finished = true
          flush()
        })
      },
    }
  }

  // Kills: the handler and the sweeper (or two replicas) filing one order together doubling a refund in the record,
  // overwriting the document, or making two records.
  it('AC-5: property: two concurrent file calls leave one record, committed with the one document, each succeeded refund once in filed_refund_ids and once in refunded_minor', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const gate = overlapping(stub)

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 2_000 }), { maxLength: 4 }),
        fc.boolean(),
        async (refundAmounts, committedFirst) => {
          gate.reset()
          const order = await seedOrder(env)
          gate.reset(true)
          const alone = committedFirst ? await documents.file(order.id) : 'filed'
          gate.reset()
          expect(alone).toBe('filed')
          const ids: string[] = []
          for (const [i, amountMinor] of refundAmounts.entries()) {
            ids.push(
              await seedRefund(env, order.id, {
                amountMinor,
                status: 'succeeded',
                at: T0 + i * 1_000,
              }),
            )
          }

          await Promise.all([
            gate.settle(documents.file(order.id)),
            gate.settle(documents.file(order.id)),
          ])

          const count = sqlite(env)
            .prepare('SELECT count(*) AS n FROM order_tax_documents WHERE order_id = ?')
            .get(order.id) as { n: number }
          const row = docRow(env, order.id)!
          expect(Number(count.n)).toBe(1)
          expect([row.status, row.document_id]).toEqual([
            'committed',
            documentOf(order.id).documentId,
          ])
          expect([...row.filed_refund_ids].sort()).toEqual([...ids].sort())
          expect(row.refunded_minor).toBe(await refundedOf(env, order.id))
          expect(ms(row.due_since)).toBeNull()
        },
      ),
      { numRuns: 15 },
    )
  }, 60_000)

  // Kills: a clear that does not re-read the order's refunds. One filing files R1 and clears while the other's attempt,
  // which also saw R2, failed and was recorded first: R2 is succeeded, unfiled and no longer due, so no sweep takes it.
  it('AC-5: a filing that clears after a concurrent filing failed leaves every succeeded refund filed or the record still due; the next file files the rest', async () => {
    const env = await open()
    const stub = stubTax(env)
    const documents = filer(env, stub)
    const order = await seedOrder(env)
    expect(await documents.file(order.id)).toBe('filed')
    const r1 = await seedRefund(env, order.id, {
      amountMinor: 300,
      status: 'succeeded',
      at: T0 + 1_000,
    })

    let entered!: () => void
    let release!: () => void
    const inFirst = new Promise<void>((resolve) => (entered = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    stub.refund = async () => {
      calls += 1
      if (calls === 1) {
        entered()
        await held
        return
      }
      if (calls === 2) throw new Error('provider flapped')
    }

    const first = documents.file(order.id)
    await inFirst
    const r2 = await seedRefund(env, order.id, {
      amountMinor: 200,
      status: 'succeeded',
      at: T0 + 2_000,
    })
    const second = documents.file(order.id)
    const secondSettled = second.then(
      () => undefined,
      () => undefined,
    )
    // The first is let go once the second has failed and recorded it; if the second cannot reach the provider while
    // the first is held (one serialised behind the other), after a bound instead of never.
    await Promise.race([
      secondSettled,
      vi
        .waitFor(() => expect(calls).toBe(2), { timeout: 2_000, interval: 5 })
        .then(
          () => secondSettled,
          () => undefined,
        ),
    ])
    release()
    const answers = [await second, await first]

    const row = docRow(env, order.id)!
    const unfiled = [r1, r2].filter((id) => !row.filed_refund_ids.includes(id))
    expect(answers[0]).toBe('due')
    expect(
      { unfiled, due: ms(row.due_since) !== null },
      'a succeeded refund left unfiled must stay due',
    ).toEqual({ unfiled, due: unfiled.length > 0 })

    stub.refund = async () => undefined
    expect(await documents.file(order.id)).toBe('filed')
    const after = docRow(env, order.id)!
    expect(after.filed_refund_ids).toEqual([r1, r2])
    expect(after.refunded_minor).toBe(await refundedOf(env, order.id))
    expect(ms(after.due_since)).toBeNull()
  })
})
