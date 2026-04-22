import { and, desc, eq } from 'drizzle-orm'
import type { Review, ReviewModerationStatus } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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

export interface ReviewRepository {
  findById(id: string): Promise<Review | null>
  listByProduct(productId: string, status?: ReviewModerationStatus, limit?: number): Promise<Review[]>
  listByStatus(status: ReviewModerationStatus, limit?: number): Promise<Review[]>
  insert(r: ReviewInsert): Promise<void>
  setModerationStatus(id: string, status: ReviewModerationStatus, moderatedBy: string, moderatedAt: Date): Promise<void>
  aggregateByProduct(productId: string): Promise<{ average: number; count: number; histogram: Record<'1' | '2' | '3' | '4' | '5', number> }>
}

export function createReviewRepository(store: CommandStore): ReviewRepository {
  return {
    async findById(id) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.reviews)
          .where(eq(sqliteSchema.reviews.id, id))
          .get()
        return row ? rowToReview(row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.reviews)
        .where(eq(postgresSchema.reviews.id, id))
      return row ? rowToReview(row as Record<string, unknown>) : null
    },
    async listByProduct(productId, status, limit = 50) {
      if (store.kind === 'sqlite') {
        const cond = status
          ? and(
              eq(sqliteSchema.reviews.productId, productId),
              eq(sqliteSchema.reviews.moderationStatus, status),
            )
          : eq(sqliteSchema.reviews.productId, productId)
        const rows = store.db
          .select()
          .from(sqliteSchema.reviews)
          .where(cond)
          .orderBy(desc(sqliteSchema.reviews.submittedAt))
          .limit(limit)
          .all()
        return rows.map((r) => rowToReview(r as Record<string, unknown>))
      }
      const cond = status
        ? and(
            eq(postgresSchema.reviews.productId, productId),
            eq(postgresSchema.reviews.moderationStatus, status),
          )
        : eq(postgresSchema.reviews.productId, productId)
      const rows = await store.db
        .select()
        .from(postgresSchema.reviews)
        .where(cond)
        .orderBy(desc(postgresSchema.reviews.submittedAt))
        .limit(limit)
      return rows.map((r) => rowToReview(r as Record<string, unknown>))
    },
    async listByStatus(status, limit = 100) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.reviews)
          .where(eq(sqliteSchema.reviews.moderationStatus, status))
          .orderBy(desc(sqliteSchema.reviews.submittedAt))
          .limit(limit)
          .all()
        return rows.map((r) => rowToReview(r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.reviews)
        .where(eq(postgresSchema.reviews.moderationStatus, status))
        .orderBy(desc(postgresSchema.reviews.submittedAt))
        .limit(limit)
      return rows.map((r) => rowToReview(r as Record<string, unknown>))
    },
    async insert(r) {
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
      if (store.kind === 'sqlite') {
        store.db
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
      await store.db.insert(postgresSchema.reviews).values({
        ...common,
        submittedAt: r.submittedAt,
        moderatedAt: null,
        moderatedBy: null,
      })
    },
    async setModerationStatus(id, status, moderatedBy, moderatedAt) {
      if (store.kind === 'sqlite') {
        store.db
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
      await store.db
        .update(postgresSchema.reviews)
        .set({ moderationStatus: status, moderatedBy, moderatedAt })
        .where(eq(postgresSchema.reviews.id, id))
    },
    async aggregateByProduct(productId) {
      const approved = await this.listByProduct(productId, 'approved', 1000)
      const histogram: Record<'1' | '2' | '3' | '4' | '5', number> = {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
      }
      let total = 0
      for (const r of approved) {
        const bucket = String(Math.max(1, Math.min(5, Math.round(r.rating)))) as keyof typeof histogram
        histogram[bucket] += 1
        total += r.rating
      }
      const count = approved.length
      const average = count === 0 ? 0 : total / count
      return { average, count, histogram }
    },
  }
}
