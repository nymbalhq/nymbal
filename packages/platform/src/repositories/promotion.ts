import { and, desc, eq, inArray, isNull, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
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
import { fromTimestamp } from './json.js'

export type PromotionKind = 'percent' | 'fixed'

export interface Promotion {
  id: string
  code: string
  kind: PromotionKind
  percentBps: number | null
  amountOffMinor: number | null
  currency: string | null
  minimumSubtotalMinor: number | null
  expiresAt: string | null
  usageCap: number | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface PromotionInsert {
  id: string
  code: string
  kind: PromotionKind
  percentBps: number | null
  amountOffMinor: number | null
  currency: string | null
  minimumSubtotalMinor: number | null
  expiresAt: Date | null
  usageCap: number | null
  active: boolean
  createdAt: Date
}

/** Fields a promotion may change; an absent field is left as it is. */
export type PromotionPatch = Partial<
  Pick<
    PromotionInsert,
    | 'code'
    | 'kind'
    | 'percentBps'
    | 'amountOffMinor'
    | 'currency'
    | 'minimumSubtotalMinor'
    | 'expiresAt'
    | 'usageCap'
    | 'active'
  >
>

export interface PromotionRedemptionInsert {
  promotionId: string
  orderId: string
  sessionId: string
  createdAt: Date
}

export interface PromotionRepository extends StoreRepository {
  /** The promotions whose code equals one of `codes`, any case. */
  findByCodes(tx: ReadTx, codes: readonly string[]): Promise<Promotion[]>
  findById(tx: ReadTx, id: string): Promise<Promotion | null>
  /** The row held for the rest of the transaction, so counting its redemptions cannot race another checkout's. */
  lock(tx: Tx, id: string): Promise<Promotion | null>
  /** Inserts the promotion; false when a code equal in any case already exists. */
  insert(tx: Tx, promotion: PromotionInsert): Promise<boolean>
  update(tx: Tx, id: string, patch: PromotionPatch, at: Date): Promise<Promotion | null>
  delete(tx: Tx, id: string): Promise<void>
  /** Newest first, each with its count of redemptions whose order is not cancelled. */
  list(tx: ReadTx, limit: number): Promise<(Promotion & { usedCount: number })[]>
  /** True once any order has redeemed the promotion, even a cancelled one: the code's history stays. */
  redeemed(tx: ReadTx, id: string): Promise<boolean>
  /** Redemptions counting against the cap for `sessionId`: every order's but a cancelled one's or this session's pending one's. */
  usesAgainstCap(tx: ReadTx, id: string, sessionId: string): Promise<number>
  /** Records a use; the same order redeeming again changes nothing. */
  addRedemption(tx: Tx, redemption: PromotionRedemptionInsert): Promise<void>
}

function rowToPromotion(row: Record<string, unknown>): Promotion {
  return {
    id: String(row.id),
    code: String(row.code),
    kind: row.kind as PromotionKind,
    percentBps: (row.percentBps as number | null) ?? null,
    amountOffMinor: (row.amountOffMinor as number | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    minimumSubtotalMinor: (row.minimumSubtotalMinor as number | null) ?? null,
    expiresAt: row.expiresAt == null ? null : fromTimestamp(row.expiresAt),
    usageCap: (row.usageCap as number | null) ?? null,
    active: Boolean(row.active),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

interface RedemptionColumns {
  promotionId: AnyColumn
  sessionId: AnyColumn
}

interface OrderColumns {
  status: AnyColumn
}

/** A redemption still spent: its order is not cancelled; with `sessionId`, nor pending under that session. */
function liveUse(
  r: RedemptionColumns,
  o: OrderColumns,
  sessionId: string | undefined,
): SQL<unknown> | undefined {
  const notCancelled = or(isNull(o.status), ne(o.status, 'cancelled'))
  if (sessionId === undefined) return notCancelled
  return and(
    notCancelled,
    or(isNull(o.status), ne(o.status, 'pending'), ne(r.sessionId, sessionId)),
  )
}

const lowerIn = (column: AnyColumn, codes: readonly string[]) =>
  inArray(
    sql`lower(${column})`,
    codes.map((c) => c.toLowerCase()),
  )

function sqliteInsert(p: PromotionInsert) {
  return {
    ...p,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.createdAt.toISOString(),
  }
}

function postgresInsert(p: PromotionInsert) {
  return { ...p, updatedAt: p.createdAt }
}

/** The patch's fields only: drizzle treats an undefined value as absent, a null as a column set to null. */
function sqlitePatch({ expiresAt, ...rest }: PromotionPatch, at: Date) {
  return {
    ...rest,
    ...(expiresAt !== undefined && { expiresAt: expiresAt?.toISOString() ?? null }),
    updatedAt: at.toISOString(),
  }
}

export function createPromotionRepository(store: CommandStore): PromotionRepository {
  async function findById(tx: ReadTx, id: string): Promise<Promotion | null> {
    if (tx.kind === 'sqlite') {
      const t = sqliteSchema.promotions
      const row = sqliteDb(tx).select().from(t).where(eq(t.id, id)).get()
      return row ? rowToPromotion(row as Record<string, unknown>) : null
    }
    const t = postgresSchema.promotions
    const [row] = await postgresDb(tx).select().from(t).where(eq(t.id, id))
    return row ? rowToPromotion(row as Record<string, unknown>) : null
  }

  return {
    store,
    findById,
    async findByCodes(tx, codes) {
      if (codes.length === 0) return []
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.promotions
        const rows = sqliteDb(tx).select().from(t).where(lowerIn(t.code, codes)).all()
        return rows.map((r) => rowToPromotion(r as Record<string, unknown>))
      }
      const t = postgresSchema.promotions
      const rows = await postgresDb(tx).select().from(t).where(lowerIn(t.code, codes))
      return rows.map((r) => rowToPromotion(r as Record<string, unknown>))
    },
    async lock(tx, id) {
      if (tx.kind === 'sqlite') return findById(tx, id)
      const t = postgresSchema.promotions
      const [row] = await postgresDb(tx).select().from(t).where(eq(t.id, id)).for('update')
      return row ? rowToPromotion(row as Record<string, unknown>) : null
    },
    async insert(tx, promotion) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .insert(sqliteSchema.promotions)
          .values(sqliteInsert(promotion))
          .onConflictDoNothing()
          .returning({ id: sqliteSchema.promotions.id })
          .get()
        return row !== undefined
      }
      const rows = await postgresDb(tx)
        .insert(postgresSchema.promotions)
        .values(postgresInsert(promotion))
        .onConflictDoNothing()
        .returning({ id: postgresSchema.promotions.id })
      return rows.length > 0
    },
    async update(tx, id, patch, at) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.promotions
        const row = sqliteDb(tx)
          .update(t)
          .set(sqlitePatch(patch, at))
          .where(eq(t.id, id))
          .returning()
          .get()
        return row ? rowToPromotion(row as Record<string, unknown>) : null
      }
      const t = postgresSchema.promotions
      const [row] = await postgresDb(tx)
        .update(t)
        .set({ ...patch, updatedAt: at })
        .where(eq(t.id, id))
        .returning()
      return row ? rowToPromotion(row as Record<string, unknown>) : null
    },
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.promotions
        sqliteDb(tx).delete(t).where(eq(t.id, id)).run()
        return
      }
      const t = postgresSchema.promotions
      await postgresDb(tx).delete(t).where(eq(t.id, id))
    },
    async list(tx, limit) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.promotions
        const r = sqliteSchema.promotionRedemptions
        const o = sqliteSchema.orders
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(limit)
          .all()
        const counts = sqliteDb(tx)
          .select({ id: r.promotionId, count: sql<number>`count(*)` })
          .from(r)
          .leftJoin(o, eq(o.id, r.orderId))
          .where(
            and(
              inArray(
                r.promotionId,
                rows.map((p) => p.id),
              ),
              liveUse(r, o, undefined),
            ),
          )
          .groupBy(r.promotionId)
          .all()
        const used = new Map(counts.map((c) => [c.id, Number(c.count)]))
        return rows.map((p) => ({
          ...rowToPromotion(p as Record<string, unknown>),
          usedCount: used.get(p.id) ?? 0,
        }))
      }
      const t = postgresSchema.promotions
      const r = postgresSchema.promotionRedemptions
      const o = postgresSchema.orders
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit)
      const counts = await postgresDb(tx)
        .select({ id: r.promotionId, count: sql<number>`count(*)` })
        .from(r)
        .leftJoin(o, eq(o.id, r.orderId))
        .where(
          and(
            inArray(
              r.promotionId,
              rows.map((p) => p.id),
            ),
            liveUse(r, o, undefined),
          ),
        )
        .groupBy(r.promotionId)
      const used = new Map(counts.map((c) => [c.id, Number(c.count)]))
      return rows.map((p) => ({
        ...rowToPromotion(p as Record<string, unknown>),
        usedCount: used.get(p.id) ?? 0,
      }))
    },
    async redeemed(tx, id) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.promotionRedemptions
        const row = sqliteDb(tx)
          .select({ id: t.promotionId })
          .from(t)
          .where(eq(t.promotionId, id))
          .limit(1)
          .get()
        return row !== undefined
      }
      const t = postgresSchema.promotionRedemptions
      const rows = await postgresDb(tx)
        .select({ id: t.promotionId })
        .from(t)
        .where(eq(t.promotionId, id))
        .limit(1)
      return rows.length > 0
    },
    async usesAgainstCap(tx, id, sessionId) {
      if (tx.kind === 'sqlite') {
        const r = sqliteSchema.promotionRedemptions
        const o = sqliteSchema.orders
        const row = sqliteDb(tx)
          .select({ count: sql<number>`count(*)` })
          .from(r)
          .leftJoin(o, eq(o.id, r.orderId))
          .where(and(eq(r.promotionId, id), liveUse(r, o, sessionId)))
          .get()
        return Number(row?.count ?? 0)
      }
      const r = postgresSchema.promotionRedemptions
      const o = postgresSchema.orders
      const [row] = await postgresDb(tx)
        .select({ count: sql<number>`count(*)` })
        .from(r)
        .leftJoin(o, eq(o.id, r.orderId))
        .where(and(eq(r.promotionId, id), liveUse(r, o, sessionId)))
      return Number(row?.count ?? 0)
    },
    async addRedemption(tx, redemption) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.promotionRedemptions)
          .values({ ...redemption, createdAt: redemption.createdAt.toISOString() })
          .onConflictDoNothing()
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.promotionRedemptions)
        .values(redemption)
        .onConflictDoNothing()
    },
  }
}
