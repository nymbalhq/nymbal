import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runUntilKilled } from '../proof-kit.js'
import { openRaw, type RawReader } from '../raw.js'
import type { Dialect } from '../kernel.js'

// P1-02 AC-7 (SQLite) / AC-8 (Postgres): a child process runs beginCheckout on a real store and is SIGKILLed after
// the order insert and before commit (the fixture wraps orderHistory.append). Reopened, the database holds no order,
// history or reservation row, stock is unchanged and order_sequences is untouched. The control run leaves them all.

export const CHECKOUT_KILL_CHILD = fileURLToPath(
  new URL('../../integration/fixtures/checkout-kill-child.mjs', import.meta.url),
)

/** The seed the child plants: one variant at this stock, one checkout of one unit. */
export const CHILD_STOCK = 3

export interface Footprint {
  orders: number
  history: number
  reservations: number
  stock: number[]
  sequences: number
}

export async function footprint(raw: RawReader): Promise<Footprint> {
  const stock = await raw.rows<{ stock: number }>('SELECT stock FROM variants ORDER BY id')
  return {
    orders: await raw.count('orders'),
    history: await raw.count('order_history'),
    reservations: await raw.count('inventory_reservations'),
    stock: stock.map((row) => Number(row.stock)),
    sequences: await raw.count('order_sequences'),
  }
}

// runUntilKilled arms NYMBAL_CHAOS; this child kills itself from its own hook and never reads the point.
const UNUSED_POINT = { beforePublish: 'p1-02.unused' }

export function checkoutKillSuite(
  ac: string,
  dialect: Dialect,
  /** A fresh, empty database for one child run: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`${ac}: a kill mid-transaction (${dialect})`, () => {
    it(`${ac}: SIGKILL after the order insert, before commit: no order row, no history row, no reservation row, stock unchanged, order_sequences unchanged`, async () => {
      const db = await fresh()
      try {
        const run = await runUntilKilled({
          script: CHECKOUT_KILL_CHILD,
          args: [dialect, db.target, 'kill'],
          point: UNUSED_POINT,
          timeoutMs: 60_000,
        })
        expect(
          { killed: run.killed, signal: run.signal, timedOut: run.timedOut },
          `${run.stdout}\n${run.stderr}`,
        ).toEqual({ killed: true, signal: 'SIGKILL', timedOut: false })

        const raw = openRaw(dialect, db.target)
        try {
          expect(await footprint(raw)).toEqual({
            orders: 0,
            history: 0,
            reservations: 0,
            stock: [CHILD_STOCK],
            sequences: 0,
          })
        } finally {
          await raw.close()
        }
      } finally {
        await db.drop()
      }
    }, 90_000)

    it(`${ac}: control without the kill: the order row, its history row, its reservation, the decrement and the sequence row are all present`, async () => {
      const db = await fresh()
      try {
        const run = await runUntilKilled({
          script: CHECKOUT_KILL_CHILD,
          args: [dialect, db.target, 'control'],
          point: UNUSED_POINT,
          timeoutMs: 60_000,
        })
        expect(
          { killed: run.killed, code: run.code, timedOut: run.timedOut },
          `${run.stdout}\n${run.stderr}`,
        ).toEqual({ killed: false, code: 0, timedOut: false })

        const raw = openRaw(dialect, db.target)
        try {
          const after = await footprint(raw)
          expect(after.stock).toEqual([CHILD_STOCK - 1])
          expect(after).toEqual({
            orders: 1,
            history: 1,
            reservations: 1,
            stock: [CHILD_STOCK - 1],
            sequences: 1,
          })
        } finally {
          await raw.close()
        }
      } finally {
        await db.drop()
      }
    }, 90_000)
  })
}
