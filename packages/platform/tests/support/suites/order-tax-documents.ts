import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createCommandStore,
  rawClients,
  type CommandStore,
  type Tx,
} from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { buildRepositories, type Repositories } from '../../../src/repositories/index.js'
import { kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'

// The order tax document record on one dialect: the table the migration makes, and the repository's answers, which
// must be the same on SQLite and Postgres: an insert that leaves an existing record alone, a commit only from pending,
// a refund added once, a failure that keeps when the record became due, a clear, and the two reads the sweep and the
// doctor make. Every write is the repository's, in a transaction of its own; every time is the one the test passes.

type Fresh = () => Promise<{ target: string; drop(): Promise<void> }>

const COLUMNS = [
  'attempts',
  'committed_at',
  'created_at',
  'document_id',
  'due_since',
  'filed_refund_ids',
  'last_error',
  'order_id',
  'provider',
  'refunded_minor',
  'status',
  'updated_at',
]

const T0 = Date.parse('2026-11-20T09:00:00.000Z')
const MINUTE = 60_000
const WAITER_DEADLINE_MS = 5_000
const POLL_MS = 10

/** A timestamp as epoch ms, null when unset, however the dialect hands it back. */
const ms = (value: unknown): number | null =>
  value == null ? null : new Date(value as string | number | Date).getTime()

async function columnsOf(store: CommandStore): Promise<string[]> {
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    const rows = clients.raw.prepare('PRAGMA table_info(order_tax_documents)').all() as Array<{
      name: string
    }>
    return rows.map((r) => r.name).sort()
  }
  const result = await clients.pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'order_tax_documents'",
  )
  return result.rows.map((r) => r.column_name).sort()
}

export function orderTaxDocumentsSuite(dialect: Kernel['dialect'], fresh: Fresh): void {
  describe(`AC-11: the order tax document record (${dialect})`, () => {
    let db: Awaited<ReturnType<Fresh>>
    let storage: { sqlitePath: string } | { postgresUrl: string }
    let store: CommandStore
    let repo: Repositories['orderTaxDocument']

    beforeAll(async () => {
      db = await fresh()
      storage = dialect === 'sqlite' ? { sqlitePath: db.target } : { postgresUrl: db.target }
      store = createCommandStore(kernelConfig(dialect), storage)
      await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
      repo = buildRepositories(
        store,
        new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
      ).orderTaxDocument
    }, 60_000)

    afterAll(async () => {
      await store?.close()
      await db?.drop()
    })

    const write = <T>(fn: (tx: Tx) => Promise<T>) => store.transaction(fn)
    const find = (orderId: string) => store.read((tx) => repo.find(tx, orderId))

    async function pending(provider: string, at: number): Promise<string> {
      const orderId = randomUUID()
      await write((tx) => repo.insertPending(tx, { orderId, provider, at: new Date(at) }))
      return orderId
    }

    // Kills: the table missing, or shaped differently, on one dialect.
    it(`AC-11: migration 0031 creates order_tax_documents with the record's columns (${dialect})`, async () => {
      expect(await columnsOf(store)).toEqual(COLUMNS)
    })

    // Kills: a second insert that resets a record (its document or its refunds), or a JSON column that reads back as text.
    it(`AC-11: insertPending makes a pending record with nothing filed and nothing owed, and leaves an existing one alone (${dialect})`, async () => {
      const orderId = await pending('filing-tax', T0)

      const first = await find(orderId)
      await write((tx) =>
        repo.insertPending(tx, { orderId, provider: 'other-tax', at: new Date(T0 + MINUTE) }),
      )
      const second = await find(orderId)

      expect({
        provider: first!.provider,
        status: first!.status,
        documentId: first!.documentId,
        refundedMinor: Number(first!.refundedMinor),
        filedRefundIds: first!.filedRefundIds,
        attempts: Number(first!.attempts),
        lastError: first!.lastError,
        dueSince: first!.dueSince,
      }).toEqual({
        provider: 'filing-tax',
        status: 'pending',
        documentId: null,
        refundedMinor: 0,
        filedRefundIds: [],
        attempts: 0,
        lastError: null,
        dueSince: null,
      })
      expect(second).toEqual(first)
    })

    // Kills: an unconditional commit, so a second filing overwrites the document.
    it(`AC-11: commit succeeds only from pending: the second commit is refused and the first document stays (${dialect})`, async () => {
      const orderId = await pending('filing-tax', T0)

      const answers = [
        await write((tx) => repo.commit(tx, orderId, 'doc-first', new Date(T0 + MINUTE))),
        await write((tx) => repo.commit(tx, orderId, 'doc-second', new Date(T0 + 2 * MINUTE))),
      ]
      const row = await find(orderId)

      expect(answers).toEqual([true, false])
      expect([row!.status, row!.documentId, ms(row!.committedAt)]).toEqual([
        'committed',
        'doc-first',
        T0 + MINUTE,
      ])
    })

    // Kills: an addRefund that adds a filed refund again, or whose amount and id are written apart.
    it(`AC-11: property: addRefund files each refund id once, in filing order, refunded_minor the sum of the first filing of each, and filed_refund_ids reads back as the array written (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.constantFrom('re-1', 're-2', 're-3', 're-4'),
              amountMinor: fc.integer({ min: 1, max: 50_000 }),
            }),
            { maxLength: 8 },
          ),
          async (filings) => {
            const orderId = await pending('filing-tax', T0)
            await write((tx) => repo.commit(tx, orderId, `doc-${orderId}`, new Date(T0)))
            const answers: boolean[] = []
            for (const [i, f] of filings.entries()) {
              answers.push(
                await write((tx) =>
                  repo.addRefund(tx, orderId, f.id, f.amountMinor, new Date(T0 + i)),
                ),
              )
            }
            const firsts = filings.filter((f, i) => filings.findIndex((g) => g.id === f.id) === i)
            const row = await find(orderId)

            expect(answers).toEqual(
              filings.map((f, i) => filings.findIndex((g) => g.id === f.id) === i),
            )
            expect(row!.filedRefundIds).toEqual(firsts.map((f) => f.id))
            expect(Number(row!.refundedMinor)).toBe(
              firsts.reduce((sum, f) => sum + f.amountMinor, 0),
            )
          },
        ),
        { numRuns: dialect === 'postgres' ? 15 : 40 },
      )
    })

    // Kills: a retry that moves due_since (the doctor never ages the record), a clear that leaves it owed, or an error
    // page stored whole.
    it(`AC-11: markDue sets due_since only when unset; recordFailure counts the attempt, keeps the first 500 characters and due_since, or sets it when unset; clear empties all three (${dialect})`, async () => {
      const orderId = await pending('filing-tax', T0)
      const long = Array.from({ length: 600 }, (_, i) => String.fromCharCode(65 + (i % 26))).join(
        '',
      )

      await write((tx) => repo.markDue(tx, orderId, new Date(T0 + MINUTE)))
      await write((tx) => repo.markDue(tx, orderId, new Date(T0 + 2 * MINUTE)))
      const marked = await find(orderId)
      await write((tx) => repo.recordFailure(tx, orderId, long, new Date(T0 + 3 * MINUTE)))
      await write((tx) => repo.recordFailure(tx, orderId, 'second', new Date(T0 + 4 * MINUTE)))
      const failed = await find(orderId)
      await write((tx) => repo.clear(tx, orderId, new Date(T0 + 5 * MINUTE)))
      const cleared = await find(orderId)
      await write((tx) => repo.recordFailure(tx, orderId, long, new Date(T0 + 6 * MINUTE)))
      const again = await find(orderId)

      expect(ms(marked!.dueSince)).toBe(T0 + MINUTE)
      expect([Number(failed!.attempts), failed!.lastError, ms(failed!.dueSince)]).toEqual([
        2,
        'second',
        ms(marked!.dueSince),
      ])
      expect([Number(cleared!.attempts), cleared!.lastError, cleared!.dueSince]).toEqual([
        0,
        null,
        null,
      ])
      expect([Number(again!.attempts), again!.lastError, ms(again!.dueSince)]).toEqual([
        1,
        long.slice(0, 500),
        T0 + 6 * MINUTE,
      ])
      expect(ms(again!.updatedAt)).toBe(T0 + 6 * MINUTE)
    })

    // Kills: a lock that reads another record, or reads it differently, than find on one dialect.
    it(`AC-2: lock answers what find answers: the record as written, and null for an unknown order (${dialect})`, async () => {
      const orderId = await pending('filing-tax', T0)
      await write((tx) => repo.commit(tx, orderId, 'doc-locked', new Date(T0 + MINUTE)))
      await write((tx) => repo.addRefund(tx, orderId, 're-locked', 1_250, new Date(T0 + 2 * MINUTE)))
      await write((tx) => repo.recordFailure(tx, orderId, 'busy', new Date(T0 + 3 * MINUTE)))

      const found = await find(orderId)
      const locked = await write((tx) => repo.lock(tx, orderId))
      const unknown = await write((tx) => repo.lock(tx, randomUUID()))

      expect(locked).toEqual(found)
      expect([locked!.documentId, locked!.filedRefundIds, Number(locked!.attempts)]).toEqual([
        'doc-locked',
        ['re-locked'],
        1,
      ])
      expect(unknown).toBeNull()
    })

    /** Backends of this database waiting on a lock another transaction holds. */
    async function lockWaiters(): Promise<number> {
      const clients = rawClients(store)
      if (clients.kind !== 'postgres') return 0
      const result = await clients.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      return Number(result.rows[0]?.n ?? 0)
    }

    /**
     * Resolves once the other write is queued behind the held transaction: on Postgres when a backend of this database
     * waits on a lock, or the write has already landed (nothing held it), or the deadline passes, and the outcomes
     * decide; on SQLite after a macrotask, by which time its BEGIN IMMEDIATE waits for the holder's COMMIT.
     */
    async function otherIsWaiting(landed: () => boolean): Promise<void> {
      if (dialect === 'sqlite') {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return
      }
      const deadline = Date.now() + WAITER_DEADLINE_MS
      while (!landed() && (await lockWaiters()) < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    }

    // Kills: a lock that takes no row lock on Postgres (a plain select), so a failure recorded meanwhile lands before
    // the holder's clear and the clear wipes it.
    it(`AC-2: lock holds the record until its transaction ends: a failure recorded on a second store meanwhile lands after the holder's clear, so the record ends with one attempt, that failure's error and due since it (${dialect})`, async () => {
      const orderId = await pending('filing-tax', T0)
      await write((tx) => repo.recordFailure(tx, orderId, 'earlier', new Date(T0 + MINUTE)))
      await write((tx) => repo.recordFailure(tx, orderId, 'earlier', new Date(T0 + 2 * MINUTE)))

      const second = createCommandStore(kernelConfig(dialect), storage)
      try {
        const secondRepo = buildRepositories(
          second,
          new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
        ).orderTaxDocument

        let locked!: () => void
        const isLocked = new Promise<void>((resolve) => (locked = resolve))
        let release!: () => void
        const released = new Promise<void>((resolve) => (release = resolve))
        const holder = write(async (tx) => {
          await repo.lock(tx, orderId)
          locked()
          await released
          await repo.clear(tx, orderId, new Date(T0 + 3 * MINUTE))
        })
        // Held: the record is locked and not yet cleared. A failure before that fails the test here.
        await Promise.race([isLocked, holder])

        let landed = false
        const failure = second
          .transaction((tx) =>
            secondRepo.recordFailure(tx, orderId, 'while held', new Date(T0 + 4 * MINUTE)),
          )
          .finally(() => {
            landed = true
          })
        await otherIsWaiting(() => landed)
        release()
        await Promise.all([holder, failure])
      } finally {
        await second.close()
      }
      const after = await find(orderId)

      expect(Number(after!.attempts), 'one attempt after the clear, not the earlier ones plus it').toBe(1)
      expect([after!.lastError, ms(after!.dueSince)]).toEqual(['while held', T0 + 4 * MINUTE])
    })

    // Kills: a sweep ordered by due_since (rows that always fail starve the rest), one that takes another provider's
    // rows or rows due too recently, or a doctor that counts or ages records differently on one dialect.
    it(`AC-11: listDue answers the provider's records due before the cut-off, least recently written first, up to the limit; dueSummary counts every record due before its cut-off and names the longest owed (${dialect})`, async () => {
      // Far before every other test's times, so no other record is due before these cut-offs.
      const T = Date.parse('2001-01-01T12:00:00.000Z')
      const provider = `list-${randomUUID().slice(0, 8)}`
      const at = (minutesAgo: number) => new Date(T - minutesAgo * MINUTE)
      const tried = await pending(provider, T - 90 * MINUTE)
      await write((tx) => repo.markDue(tx, tried, at(50)))
      await write((tx) => repo.recordFailure(tx, tried, 'busy', at(2)))
      const waiting = await pending(provider, T - 90 * MINUTE)
      await write((tx) => repo.markDue(tx, waiting, at(30)))
      const between = await pending(provider, T - 90 * MINUTE)
      await write((tx) => repo.markDue(tx, between, at(20)))
      await write((tx) => repo.recordFailure(tx, between, 'busy', at(10)))
      const recent = await pending(provider, T - 90 * MINUTE)
      await write((tx) => repo.markDue(tx, recent, new Date(T - 10_000)))
      await pending(provider, T - 90 * MINUTE)
      const other = await pending('old-tax', T - 90 * MINUTE)
      await write((tx) => repo.markDue(tx, other, at(60)))
      await write((tx) => repo.recordFailure(tx, other, 'old provider gone', at(55)))

      const due = await store.read((tx) => repo.listDue(tx, { provider, before: at(1), limit: 10 }))
      const capped = await store.read((tx) =>
        repo.listDue(tx, { provider, before: at(1), limit: 2 }),
      )
      const all = await store.read((tx) => repo.dueSummary(tx, new Date(T)))
      const overForty = await store.read((tx) => repo.dueSummary(tx, at(40)))
      const none = await store.read((tx) => repo.dueSummary(tx, at(120)))

      expect(due.map((r) => r.orderId)).toEqual([waiting, between, tried])
      expect(capped.map((r) => r.orderId)).toEqual([waiting, between])
      expect(all).toEqual({
        count: 5,
        oldest: { orderId: other, provider: 'old-tax', lastError: 'old provider gone' },
      })
      expect(overForty).toEqual({
        count: 2,
        oldest: { orderId: other, provider: 'old-tax', lastError: 'old provider gone' },
      })
      expect(none).toEqual({ count: 0, oldest: null })
    })
  })
}
