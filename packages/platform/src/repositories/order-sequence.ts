import { sql } from 'drizzle-orm'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'

export interface OrderSequenceRepository extends StoreRepository {
  nextSequence(tx: Tx, startFrom?: number): Promise<number>
}

export function createOrderSequenceRepository(store: CommandStore): OrderSequenceRepository {
  return {
    store,
    // One upsert: on a fresh store a read finds no row to lock, so concurrent first allocations would each insert it.
    // The value handed out is the one the row held before this call (startFrom on the first).
    async nextSequence(tx, startFrom = 1000): Promise<number> {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .insert(sqliteSchema.orderSequences)
          .values({ id: 1, nextValue: startFrom + 1 })
          .onConflictDoUpdate({
            target: sqliteSchema.orderSequences.id,
            set: { nextValue: sql`${sqliteSchema.orderSequences.nextValue} + 1` },
          })
          .returning({ nextValue: sqliteSchema.orderSequences.nextValue })
          .get()
        return row.nextValue - 1
      }
      // Stryker disable all: the Postgres dialect, which the SQLite integration run cannot reach; tests/postgres covers it
      const [row] = await postgresDb(tx)
        .insert(postgresSchema.orderSequences)
        .values({ id: 1, nextValue: startFrom + 1 })
        .onConflictDoUpdate({
          target: postgresSchema.orderSequences.id,
          set: { nextValue: sql`${postgresSchema.orderSequences.nextValue} + 1` },
        })
        .returning({ nextValue: postgresSchema.orderSequences.nextValue })
      return row!.nextValue - 1
      // Stryker restore all
    },
  }
}
