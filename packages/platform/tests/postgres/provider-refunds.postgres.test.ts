import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { answerListWith, listed, reconcileOrder } from '../support/provider-refunds.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { storedMoney, storedRefunds, sumOf } from '../support/money.js'
import { providerRefundSuite } from '../support/suites/provider-refunds.js'

// The suite on Postgres (the lock is SELECT … FOR UPDATE), and the lock itself: a transaction of the test's own holds
// the order's row, as a refund's write does, and the pass waits behind it. Postgres says so, nothing waits on the clock.

const serverUrl = postgresServerUrl()

providerRefundSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'provider_refunds')
    return { target: db.url, drop: () => db.drop() }
  },
  6,
)

describe('the pass waits for the order’s row lock (postgres)', () => {
  let db: TestDatabase
  let k: Kernel
  let raw: RawReader

  beforeAll(async () => {
    db = await createDatabase(serverUrl, 'provider_refunds_lock')
    k = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
    raw = openRaw('postgres', db.url)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await k?.close()
    await db?.drop()
  }, 60_000)

  // Defect: the pass reads and writes outside the order's lock, so it misses the row the holder is writing.
  it('AC-12: with a transaction holding the order’s row lock and a pending row written in it, reconcileOrder waits behind it, and once it commits the pass sees that row and settles it', async () => {
    const seeded = await seedVariant(k, 3)
    const order = await checkoutOf(k, seeded, 1, `lock-${randomUUID()}@refunds.test`)
    expect(order.orderStatus).toBe('confirmed')

    const holder = new pg.Client({ connectionString: db.url })
    await holder.connect()
    const rowId = randomUUID()
    const amountMinor = 500
    const listing = answerListWith(k.app.adapters.payments, (paymentId) => [
      listed(paymentId, {
        refundId: `re_${randomUUID()}`,
        amountMinor,
        status: 'succeeded',
        idempotencyKey: rowId,
      }),
    ])
    let pass: Promise<unknown> | undefined
    let committed = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.orderId])
      await holder.query(
        `INSERT INTO order_refunds (id, order_id, amount_minor, currency, status, actor, created_at)
         VALUES ($1, $2, $3, 'GBP', 'pending', 'admin:holder', now())`,
        [rowId, order.orderId, amountMinor],
      )
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const holderPid = rows[0]!.pid

      pass = reconcileOrder(k, order.orderId)

      await vi.waitFor(
        async () => {
          const blocked = await raw.rows<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[?::int]',
            [holderPid],
          )
          expect(blocked.length, 'a backend is blocked on the held row lock').toBe(1)
        },
        { timeout: 15_000, interval: 20 },
      )

      await holder.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await pass
      listing.restore()
    }
    const stored = await storedRefunds(raw, order.orderId)
    expect(stored.map((r) => [r.id, r.status])).toEqual([[rowId, 'succeeded']])
    expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(sumOf(stored, 'succeeded'))
  }, 30_000)
})
