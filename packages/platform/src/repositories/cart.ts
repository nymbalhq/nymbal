import { and, asc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm'
import type { Cart, CartItem } from '@nymbalhq/types'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { fromTimestamp, parseJson } from './json.js'

/** What makes a cart due an abandonment notice at `at`: live, holding items, unwritten since `cutoff`, not yet
 *  notified in this inactivity period. */
export interface AbandonedWindow {
  cutoff: Date
  at: Date
}

export interface AbandonedCart {
  token: string
  /** The cart's last write. */
  lastActivityAt: string
}

export interface CartRepository extends StoreRepository {
  findByToken(tx: ReadTx, token: string): Promise<Cart | null>
  /** `findByToken`, holding the row for the rest of the transaction so concurrent commands on the cart queue behind
   *  this one (Postgres `FOR UPDATE`; SQLite's `BEGIN IMMEDIATE` already holds the database). */
  lock(tx: Tx, token: string): Promise<Cart | null>
  /** Inserts the cart, or replaces an expired row on its token. A live row on the token is left as it is and
   *  returned with `created: false`. */
  create(tx: Tx, cart: Cart): Promise<{ cart: Cart; created: boolean }>
  /** Writes the cart whole and starts a new inactivity period (clears the abandonment claim). */
  put(tx: Tx, cart: Cart): Promise<void>
  remove(tx: Tx, token: string): Promise<void>
  /** Empties the cart if it is still live at `at`, in one conditional write; false when there was no live row to
   *  empty (expired, or deleted by a sweep or a merge). Starts a new inactivity period; the expiry stays as it was. */
  clearIfLive(tx: Tx, token: string, at: Date): Promise<boolean>
  /** Deletes every cart whose expiry is at or before `at`; returns how many. */
  deleteExpired(tx: Tx, at: Date): Promise<number>
  /** Up to `limit` tokens due a notice, in token order after `after`; claims nothing. */
  listAbandoned(
    tx: ReadTx,
    window: AbandonedWindow,
    page: { after: string | undefined; limit: number },
  ): Promise<string[]>
  /** Marks the cart notified if it is still due a notice; null when it is not (another sweeper claimed it, or a
   *  write, expiry or delete came first). */
  claimAbandoned(tx: Tx, token: string, window: AbandonedWindow): Promise<AbandonedCart | null>
}

function rowToCart(store: 'sqlite' | 'postgres', row: Record<string, unknown>): Cart {
  return {
    token: String(row.token),
    customerId: (row.customerId as string | null) ?? null,
    items: parseJson<CartItem[]>(store, row.items, []),
    subtotalMinor: Number(row.subtotalMinor),
    currency: String(row.currency),
    expiresAt: fromTimestamp(row.expiresAt),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

function sqliteValues(cart: Cart) {
  return {
    token: cart.token,
    customerId: cart.customerId,
    currency: cart.currency,
    items: JSON.stringify(cart.items),
    lineCount: cart.items.length,
    subtotalMinor: cart.subtotalMinor,
    expiresAt: cart.expiresAt,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    abandonedNotifiedAt: null,
  }
}

function postgresValues(cart: Cart) {
  return {
    token: cart.token,
    customerId: cart.customerId,
    currency: cart.currency,
    items: cart.items,
    lineCount: cart.items.length,
    subtotalMinor: cart.subtotalMinor,
    expiresAt: new Date(cart.expiresAt),
    createdAt: new Date(cart.createdAt),
    updatedAt: new Date(cart.updatedAt),
    abandonedNotifiedAt: null,
  }
}

/** Every column but the key, taken from the row being inserted (`excluded` in both dialects' upsert). */
const fromExcluded = {
  customerId: sql`excluded.customer_id`,
  currency: sql`excluded.currency`,
  items: sql`excluded.items`,
  lineCount: sql`excluded.line_count`,
  subtotalMinor: sql`excluded.subtotal_minor`,
  expiresAt: sql`excluded.expires_at`,
  createdAt: sql`excluded.created_at`,
  updatedAt: sql`excluded.updated_at`,
  abandonedNotifiedAt: sql`excluded.abandoned_notified_at`,
}

function sqliteDue(window: AbandonedWindow) {
  const t = sqliteSchema.carts
  return and(
    isNull(t.abandonedNotifiedAt),
    gt(t.lineCount, 0),
    lt(t.updatedAt, window.cutoff.toISOString()),
    gt(t.expiresAt, window.at.toISOString()),
  )
}

function postgresDue(window: AbandonedWindow) {
  const t = postgresSchema.carts
  return and(
    isNull(t.abandonedNotifiedAt),
    gt(t.lineCount, 0),
    lt(t.updatedAt, window.cutoff),
    gt(t.expiresAt, window.at),
  )
}

export function createCartRepository(store: CommandStore): CartRepository {
  async function findByToken(tx: ReadTx, token: string): Promise<Cart | null> {
    if (tx.kind === 'sqlite') {
      const row = sqliteDb(tx)
        .select()
        .from(sqliteSchema.carts)
        .where(eq(sqliteSchema.carts.token, token))
        .get()
      return row ? rowToCart('sqlite', row as Record<string, unknown>) : null
    }
    const [row] = await postgresDb(tx)
      .select()
      .from(postgresSchema.carts)
      .where(eq(postgresSchema.carts.token, token))
    return row ? rowToCart('postgres', row as Record<string, unknown>) : null
  }

  async function lock(tx: Tx, token: string): Promise<Cart | null> {
    if (tx.kind === 'sqlite') return findByToken(tx, token)
    const [row] = await postgresDb(tx)
      .select()
      .from(postgresSchema.carts)
      .where(eq(postgresSchema.carts.token, token))
      .for('update')
    return row ? rowToCart('postgres', row as Record<string, unknown>) : null
  }

  return {
    store,
    findByToken,
    lock,
    async create(tx, cart) {
      let inserted: Record<string, unknown> | undefined
      if (tx.kind === 'sqlite') {
        inserted = sqliteDb(tx)
          .insert(sqliteSchema.carts)
          .values(sqliteValues(cart))
          .onConflictDoUpdate({
            target: sqliteSchema.carts.token,
            set: fromExcluded,
            setWhere: lte(sqliteSchema.carts.expiresAt, sql`excluded.updated_at`),
          })
          .returning()
          .get() as Record<string, unknown> | undefined
      } else {
        // A live row on the token makes the update a no-op, and `ON CONFLICT` waits for an insert in flight, so the
        // row read below is committed.
        ;[inserted] = await postgresDb(tx)
          .insert(postgresSchema.carts)
          .values(postgresValues(cart))
          .onConflictDoUpdate({
            target: postgresSchema.carts.token,
            set: fromExcluded,
            setWhere: lte(postgresSchema.carts.expiresAt, sql`excluded.updated_at`),
          })
          .returning()
      }
      if (inserted !== undefined) return { cart: rowToCart(tx.kind, inserted), created: true }
      const live = await lock(tx, cart.token)
      if (live === null) throw new Error(`cart ${cart.token} vanished while it was being created`)
      return { cart: live, created: false }
    },
    async put(tx, cart) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.carts)
          .values(sqliteValues(cart))
          .onConflictDoUpdate({ target: sqliteSchema.carts.token, set: fromExcluded })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.carts)
        .values(postgresValues(cart))
        .onConflictDoUpdate({ target: postgresSchema.carts.token, set: fromExcluded })
    },
    async remove(tx, token) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.carts).where(eq(sqliteSchema.carts.token, token)).run()
        return
      }
      await postgresDb(tx).delete(postgresSchema.carts).where(eq(postgresSchema.carts.token, token))
    },
    async clearIfLive(tx, token, at) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.carts
        const result = sqliteDb(tx)
          .update(t)
          .set({
            items: '[]',
            lineCount: 0,
            subtotalMinor: 0,
            updatedAt: at.toISOString(),
            abandonedNotifiedAt: null,
          })
          .where(and(eq(t.token, token), gt(t.expiresAt, at.toISOString())))
          .run()
        return result.changes > 0
      }
      // Under READ COMMITTED the update waits for a concurrent delete or write on the row and re-checks the condition
      // against what that one committed, so a row swept in between is skipped rather than reported missing.
      const t = postgresSchema.carts
      const rows = await postgresDb(tx)
        .update(t)
        .set({
          items: [],
          lineCount: 0,
          subtotalMinor: 0,
          updatedAt: at,
          abandonedNotifiedAt: null,
        })
        .where(and(eq(t.token, token), gt(t.expiresAt, at)))
        .returning({ token: t.token })
      return rows.length > 0
    },
    async deleteExpired(tx, at) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .delete(sqliteSchema.carts)
          .where(lte(sqliteSchema.carts.expiresAt, at.toISOString()))
          .run()
        return result.changes
      }
      const rows = await postgresDb(tx)
        .delete(postgresSchema.carts)
        .where(lte(postgresSchema.carts.expiresAt, at))
        .returning({ token: postgresSchema.carts.token })
      return rows.length
    },
    async listAbandoned(tx, window, page) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.carts
        const rows = sqliteDb(tx)
          .select({ token: t.token })
          .from(t)
          .where(
            and(sqliteDue(window), page.after === undefined ? undefined : gt(t.token, page.after)),
          )
          .orderBy(asc(t.token))
          .limit(page.limit)
          .all()
        return rows.map((r) => r.token)
      }
      const t = postgresSchema.carts
      const rows = await postgresDb(tx)
        .select({ token: t.token })
        .from(t)
        .where(
          and(postgresDue(window), page.after === undefined ? undefined : gt(t.token, page.after)),
        )
        .orderBy(asc(t.token))
        .limit(page.limit)
      return rows.map((r) => r.token)
    },
    async claimAbandoned(tx, token, window) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.carts
        const row = sqliteDb(tx)
          .update(t)
          .set({ abandonedNotifiedAt: window.at.toISOString() })
          .where(and(eq(t.token, token), sqliteDue(window)))
          .returning({ token: t.token, updatedAt: t.updatedAt })
          .get()
        return row ? { token: row.token, lastActivityAt: fromTimestamp(row.updatedAt) } : null
      }
      // Under READ COMMITTED the update waits for a concurrent claim or write on the row and re-checks the condition
      // against what that one committed, so of two sweepers only one gets the row back.
      const t = postgresSchema.carts
      const [row] = await postgresDb(tx)
        .update(t)
        .set({ abandonedNotifiedAt: window.at })
        .where(and(eq(t.token, token), postgresDue(window)))
        .returning({ token: t.token, updatedAt: t.updatedAt })
      return row ? { token: row.token, lastActivityAt: fromTimestamp(row.updatedAt) } : null
    },
  }
}
