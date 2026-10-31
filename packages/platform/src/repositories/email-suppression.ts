import { eq } from 'drizzle-orm'
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
import { normaliseEmail } from '../email-address.js'

export type EmailSuppressionReason = 'hard_bounce' | 'complaint'

export interface EmailSuppressionInput {
  email: string
  reason: EmailSuppressionReason
  /** The feedback event that suppresses the address. */
  eventId: string
  at: Date
}

/** Addresses that hard-bounced or complained. Each method normalises the address it is given. */
export interface EmailSuppressionRepository extends StoreRepository {
  /** True when this call suppressed the address; false when it already was, whose first reason stays. */
  suppress(tx: Tx, input: EmailSuppressionInput): Promise<boolean>
  isSuppressed(tx: ReadTx, email: string): Promise<boolean>
}

export function createEmailSuppressionRepository(store: CommandStore): EmailSuppressionRepository {
  const s = sqliteSchema.emailSuppressions
  const p = postgresSchema.emailSuppressions
  return {
    store,
    async suppress(tx, { email, reason, eventId, at }) {
      const values = { email: normaliseEmail(email), reason, eventId }
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .insert(s)
          .values({ ...values, createdAt: at.toISOString() })
          .onConflictDoNothing()
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .insert(p)
        .values({ ...values, createdAt: at })
        .onConflictDoNothing()
      return (result.rowCount ?? 0) > 0
    },
    async isSuppressed(tx, email) {
      const key = normaliseEmail(email)
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx).select({ email: s.email }).from(s).where(eq(s.email, key)).get()
        return row !== undefined
      }
      const rows = await postgresDb(tx)
        .select({ email: p.email })
        .from(p)
        .where(eq(p.email, key))
        .limit(1)
      return rows.length > 0
    },
  }
}
