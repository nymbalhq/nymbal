import { eq, sql } from 'drizzle-orm'
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
    async nextSequence(tx, startFrom = 1000): Promise<number> {
      if (tx.kind === 'sqlite') {
        const client = sqliteDb(tx)
        const row = client
          .select()
          .from(sqliteSchema.orderSequences)
          .where(eq(sqliteSchema.orderSequences.id, 1))
          .get()
        if (!row) {
          const next = startFrom + 1
          client.insert(sqliteSchema.orderSequences).values({ id: 1, nextValue: next }).run()
          return startFrom
        }
        const current = row.nextValue
        client
          .update(sqliteSchema.orderSequences)
          .set({ nextValue: current + 1 })
          .where(eq(sqliteSchema.orderSequences.id, 1))
          .run()
        return current
      }
      const client = postgresDb(tx)
      const [row] = await client
        .select()
        .from(postgresSchema.orderSequences)
        .where(eq(postgresSchema.orderSequences.id, 1))
        .for('update')
      if (!row) {
        const next = startFrom + 1
        await client.insert(postgresSchema.orderSequences).values({ id: 1, nextValue: next })
        return startFrom
      }
      const current = row.nextValue
      await client
        .update(postgresSchema.orderSequences)
        .set({ nextValue: sql`${postgresSchema.orderSequences.nextValue} + 1` })
        .where(eq(postgresSchema.orderSequences.id, 1))
      return current
    },
  }
}
