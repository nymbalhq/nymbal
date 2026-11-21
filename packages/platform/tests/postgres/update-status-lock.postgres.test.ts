import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { eventRows } from '../support/outbox.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { openRaw, type RawReader } from '../support/raw.js'

// A move racing a refund on Postgres, the lock held by a transaction of the test's own: a connection takes the order's
// row lock and writes a full refund in it as settlement does, the move is sent while that transaction is open and
// waits behind it (Postgres says so: pg_blocking_pids), and only the commit lets the move answer. Nothing here waits
// on the clock.

const serverUrl = postgresServerUrl()

let db: TestDatabase
let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'update_status_lock')
  k = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
  served = await serveKernel(k)
  raw = openRaw('postgres', db.url)
  admin = await adminClient(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
  await db?.drop()
}, 60_000)

async function written(orderId: string) {
  const [order] = await raw.rows<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
    orderId,
  ])
  const history = await raw.rows<{ from_status: string | null; to_status: string; note: string }>(
    'SELECT from_status, to_status, note FROM order_history WHERE order_id = ? ORDER BY timestamp, id',
    [orderId],
  )
  const events = (await eventRows(raw)).filter((r) => {
    const p = r.envelope.payload as { orderId?: unknown; order?: { id?: unknown } }
    return p.orderId === orderId || p.order?.id === orderId
  })
  return { status: order!.status, history, events: events.map((e) => e.id) }
}

describe('a move waits for the money a refund is settling', () => {
  // Defect: updateStatus reads the money outside the lock, so the move decided on stale amounts and writes processing
  // on an order the waiting transaction refunded in full.
  it('AC-20: with a transaction holding the order’s row lock and a full refund written in it, POST …/process waits behind it; once it commits the move answers 409 order.refunded, and status, history and events are as the refund left them', async () => {
    const seeded = await seedVariant(k, 5)
    const order = await checkoutOf(k, seeded, 1, `lock-${randomUUID()}@update-status.test`)
    expect(order.orderStatus).toBe('confirmed')
    const before = await written(order.orderId)

    const holder = new pg.Client({ connectionString: db.url })
    await holder.connect()
    let settled = false
    let answer: Promise<Awaited<ReturnType<AdminClient['call']>>> | undefined
    const refundNote = 'refund of £25.00'
    let holderCommitted = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.orderId])
      await holder.query('UPDATE orders SET refunded_minor = captured_minor WHERE id = $1', [
        order.orderId,
      ])
      await holder.query(
        `INSERT INTO order_history (id, order_id, from_status, to_status, actor, note, timestamp)
         VALUES ($1, $2, 'confirmed', 'confirmed', 'admin:test', $3, now())`,
        [randomUUID(), order.orderId, refundNote],
      )
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const holderPid = rows[0]!.pid

      answer = admin
        .call('POST', `/api/admin/orders/${order.orderId}/process`, {})
        .finally(() => {
          settled = true
        })

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
      expect(settled, 'the move has not answered while the lock is held').toBe(false)

      await holder.query('COMMIT')
      holderCommitted = true
    } finally {
      if (!holderCommitted) await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }

    const res = await answer!
    expect([res.status, res.body.error?.code], JSON.stringify(res.body)).toEqual([
      409,
      'order.refunded',
    ])
    const after = await written(order.orderId)
    expect(after.status).toBe(before.status)
    expect(after.events, 'the refused move publishes nothing').toEqual(before.events)
    expect(after.history.map((h) => [h.from_status, h.to_status])).toEqual([
      ...before.history.map((h) => [h.from_status, h.to_status]),
      ['confirmed', 'confirmed'],
    ])
    expect(after.history.at(-1)!.note).toBe(refundNote)
  }, 30_000)
})
