import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import type { Review, ReviewModerationStatus } from '@nymbalhq/types'
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

export interface ReviewInsert {
  id: string
  productId: string
  customerId: string | null
  orderId: string | null
  rating: number
  title: string
  body: string
  moderationStatus?: ReviewModerationStatus
  submittedAt: Date
}

function rowToReview(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    productId: String(row.productId),
    customerId: (row.customerId as string | null) ?? null,
    orderId: (row.orderId as string | null) ?? null,
    rating: Number(row.rating),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    moderationStatus: row.moderationStatus as ReviewModerationStatus,
    submittedAt: fromTimestamp(row.submittedAt),
    moderatedAt: row.moderatedAt == null ? null : fromTimestamp(row.moderatedAt),
    moderatedBy: (row.moderatedBy as string | null) ?? null,
  }
}

/** Where a page of a product's reviews starts: after this review, in the newest-first, then id-descending order. */
export interface ReviewKey {
  submittedAt: string
  id: string
}

export interface ReviewRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<Review | null>
  /** Newest first, ties by id descending; `after` is the last review of the previous page. */
  listByProduct(
    tx: ReadTx,
    productId: string,
    status?: ReviewModerationStatus,
    limit?: number,
    after?: ReviewKey,
  ): Promise<Review[]>
  listByStatus(tx: ReadTx, status: ReviewModerationStatus, limit?: number): Promise<Review[]>
  insert(tx: Tx, r: ReviewInsert): Promise<void>
  setModerationStatus(
    tx: Tx,
    id: string,
    status: ReviewModerationStatus,
    moderatedBy: string,
    moderatedAt: Date,
  ): Promise<void>
  aggregateByProduct(
    tx: ReadTx,
    productId: string,
  ): Promise<{
    average: number
    count: number
    histogram: Record<'1' | '2' | '3' | '4' | '5', number>
  }>
}

export function createReviewRepository(store: CommandStore): ReviewRepository {
  return {
    store,
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.reviews)
          .where(eq(sqliteSchema.reviews.id, id))
          .get()
        return row ? rowToReview(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.reviews)
        .where(eq(postgresSchema.reviews.id, id))
      return row ? rowToReview(row as Record<string, unknown>) : null
    },
    async listByProduct(tx, productId, status, limit = 50, after) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.reviews
        const conds: SQL[] = [eq(t.productId, productId)]
        if (status) conds.push(eq(t.moderationStatus, status))
        if (after) {
          const at = new Date(after.submittedAt).toISOString()
          conds.push(or(lt(t.submittedAt, at), and(eq(t.submittedAt, at), lt(t.id, after.id)))!)
        }
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .where(and(...conds))
          .orderBy(desc(t.submittedAt), desc(t.id))
          .limit(limit)
          .all()
        return rows.map((r) => rowToReview(r as Record<string, unknown>))
      }
      const t = postgresSchema.reviews
      const conds: SQL[] = [eq(t.productId, productId)]
      if (status) conds.push(eq(t.moderationStatus, status))
      if (after) {
        const at = new Date(after.submittedAt)
        conds.push(or(lt(t.submittedAt, at), and(eq(t.submittedAt, at), lt(t.id, after.id)))!)
      }
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(desc(t.submittedAt), desc(t.id))
        .limit(limit)
      return rows.map((r) => rowToReview(r as Record<string, unknown>))
    },
    async listByStatus(tx, status, limit = 100) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.reviews)
          .where(eq(sqliteSchema.reviews.moderationStatus, status))
          .orderBy(desc(sqliteSchema.reviews.submittedAt))
          .limit(limit)
          .all()
        return rows.map((r) => rowToReview(r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.reviews)
        .where(eq(postgresSchema.reviews.moderationStatus, status))
        .orderBy(desc(postgresSchema.reviews.submittedAt))
        .limit(limit)
      return rows.map((r) => rowToReview(r as Record<string, unknown>))
    },
    async insert(tx, r) {
      const common = {
        id: r.id,
        productId: r.productId,
        customerId: r.customerId,
        orderId: r.orderId,
        rating: r.rating,
        title: r.title,
        body: r.body,
        moderationStatus: r.moderationStatus ?? 'pending',
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.reviews)
          .values({
            ...common,
            submittedAt: r.submittedAt.toISOString(),
            moderatedAt: null,
            moderatedBy: null,
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.reviews)
        .values({
          ...common,
          submittedAt: r.submittedAt,
          moderatedAt: null,
          moderatedBy: null,
        })
    },
    async setModerationStatus(tx, id, status, moderatedBy, moderatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.reviews)
          .set({
            moderationStatus: status,
            moderatedBy,
            moderatedAt: moderatedAt.toISOString(),
          })
          .where(eq(sqliteSchema.reviews.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.reviews)
        .set({ moderationStatus: status, moderatedBy, moderatedAt })
        .where(eq(postgresSchema.reviews.id, id))
    },
    async aggregateByProduct(tx, productId) {
      const approved = await this.listByProduct(tx, productId, 'approved', 1000)
      const histogram: Record<'1' | '2' | '3' | '4' | '5', number> = {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
      }
      let total = 0
      for (const r of approved) {
        const bucket = String(
          Math.max(1, Math.min(5, Math.round(r.rating))),
        ) as keyof typeof histogram
        histogram[bucket] += 1
        total += r.rating
      }
      const count = approved.length
      const average = count === 0 ? 0 : total / count
      return { average, count, histogram }
    },
  }
}
