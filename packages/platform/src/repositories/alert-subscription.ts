import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AlertKind, AlertStatus } from '@nymbalhq/types'
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

/** A row of `alert_subscriptions`: one address's alert of one kind on one variant. */
export interface AlertSubscription {
  id: string
  /** Trimmed and lower-cased. */
  email: string
  kind: AlertKind
  variantId: string
  productId: string
  status: AlertStatus
  confirmToken: string
  unsubscribeToken: string
  /** The storefront origin its links point at. */
  origin: string
  baselinePriceMinor: number | null
  createdAt: Date
  updatedAt: Date
  confirmedAt: Date | null
}

/** A subscribe request: a new row's values, of which a row already there takes only what its status allows. */
export interface AlertSubscriptionRequest {
  id: string
  email: string
  kind: AlertKind
  variantId: string
  productId: string
  confirmToken: string
  unsubscribeToken: string
  origin: string
  at: Date
}

export interface AlertSubscriptionPatch {
  status: AlertStatus
  updatedAt: Date
  confirmedAt?: Date
}

export interface AlertSubscriptionRepository extends StoreRepository {
  /**
   * One write on the unique (email, variant, kind): a new row is `pending`; a `pending` row takes the request's origin;
   * an `unsubscribed` or `fired` row returns to `pending` with the request's origin and confirm token (its unsubscribe
   * token is kept); an `active` row only has `updated_at` touched. Answers the row after the write.
   */
  upsertPending(tx: Tx, request: AlertSubscriptionRequest): Promise<AlertSubscription>
  findById(tx: ReadTx, id: string): Promise<AlertSubscription | null>
  findByConfirmToken(tx: ReadTx, token: string): Promise<AlertSubscription | null>
  findByUnsubscribeToken(tx: ReadTx, token: string): Promise<AlertSubscription | null>
  listActive(tx: ReadTx, variantId: string, kind: AlertKind): Promise<AlertSubscription[]>
  /** Applies `patch` when the row's status is one of `from`; the row after, or null when nothing changed. */
  update(
    tx: Tx,
    id: string,
    patch: AlertSubscriptionPatch,
    from: readonly AlertStatus[],
  ): Promise<AlertSubscription | null>
}

type SqliteRow = typeof sqliteSchema.alertSubscriptions.$inferSelect
type PostgresRow = typeof postgresSchema.alertSubscriptions.$inferSelect

function fromSqlite(row: SqliteRow): AlertSubscription {
  return {
    ...row,
    kind: row.kind as AlertKind,
    status: row.status as AlertStatus,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
  }
}

function fromPostgres(row: PostgresRow): AlertSubscription {
  return { ...row, kind: row.kind as AlertKind, status: row.status as AlertStatus }
}

export function createAlertSubscriptionRepository(
  store: CommandStore,
): AlertSubscriptionRepository {
  const s = sqliteSchema.alertSubscriptions
  const p = postgresSchema.alertSubscriptions

  async function findOne(
    tx: ReadTx,
    where: (t: typeof s | typeof p) => ReturnType<typeof eq>,
  ): Promise<AlertSubscription | null> {
    if (tx.kind === 'sqlite') {
      const row = sqliteDb(tx).select().from(s).where(where(s)).get()
      return row === undefined ? null : fromSqlite(row)
    }
    const [row] = await postgresDb(tx).select().from(p).where(where(p)).limit(1)
    return row === undefined ? null : fromPostgres(row)
  }

  return {
    store,
    async upsertPending(tx, r) {
      const keep = (t: typeof s | typeof p) => sql`${t.status} = 'active'`
      const reissue = (t: typeof s | typeof p) => sql`${t.status} IN ('unsubscribed', 'fired')`
      const set = (t: typeof s | typeof p) => ({
        status: sql`CASE WHEN ${keep(t)} THEN ${t.status} ELSE 'pending' END`,
        origin: sql`CASE WHEN ${keep(t)} THEN ${t.origin} ELSE excluded.origin END`,
        confirmToken: sql`CASE WHEN ${reissue(t)} THEN excluded.confirm_token ELSE ${t.confirmToken} END`,
        confirmedAt: sql`CASE WHEN ${keep(t)} THEN ${t.confirmedAt} ELSE NULL END`,
        updatedAt: sql`excluded.updated_at`,
      })
      const values = {
        id: r.id,
        email: r.email,
        kind: r.kind,
        variantId: r.variantId,
        productId: r.productId,
        status: 'pending' as const,
        confirmToken: r.confirmToken,
        unsubscribeToken: r.unsubscribeToken,
        origin: r.origin,
        baselinePriceMinor: null,
        confirmedAt: null,
      }
      if (tx.kind === 'sqlite') {
        const at = r.at.toISOString()
        const row = sqliteDb(tx)
          .insert(s)
          .values({ ...values, createdAt: at, updatedAt: at })
          .onConflictDoUpdate({ target: [s.email, s.variantId, s.kind], set: set(s) })
          .returning()
          .get()
        return fromSqlite(row)
      }
      const [row] = await postgresDb(tx)
        .insert(p)
        .values({ ...values, createdAt: r.at, updatedAt: r.at })
        .onConflictDoUpdate({ target: [p.email, p.variantId, p.kind], set: set(p) })
        .returning()
      return fromPostgres(row!)
    },
    findById: (tx, id) => findOne(tx, (t) => eq(t.id, id)),
    findByConfirmToken: (tx, token) => findOne(tx, (t) => eq(t.confirmToken, token)),
    findByUnsubscribeToken: (tx, token) => findOne(tx, (t) => eq(t.unsubscribeToken, token)),
    async listActive(tx, variantId, kind) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(s)
          .where(and(eq(s.variantId, variantId), eq(s.kind, kind), eq(s.status, 'active')))
          .orderBy(s.id)
          .all()
          .map(fromSqlite)
      }
      const rows = await postgresDb(tx)
        .select()
        .from(p)
        .where(and(eq(p.variantId, variantId), eq(p.kind, kind), eq(p.status, 'active')))
        .orderBy(p.id)
      return rows.map(fromPostgres)
    },
    async update(tx, id, patch, from) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .update(s)
          .set({
            status: patch.status,
            updatedAt: patch.updatedAt.toISOString(),
            ...(patch.confirmedAt !== undefined && {
              confirmedAt: patch.confirmedAt.toISOString(),
            }),
          })
          .where(and(eq(s.id, id), inArray(s.status, [...from])))
          .returning()
          .get()
        return row === undefined ? null : fromSqlite(row)
      }
      const [row] = await postgresDb(tx)
        .update(p)
        .set({
          status: patch.status,
          updatedAt: patch.updatedAt,
          ...(patch.confirmedAt !== undefined && { confirmedAt: patch.confirmedAt }),
        })
        .where(and(eq(p.id, id), inArray(p.status, [...from])))
        .returning()
      return row === undefined ? null : fromPostgres(row)
    },
  }
}
