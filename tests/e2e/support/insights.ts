import { randomUUID } from 'node:crypto'
import { createCommandStore, rawClients } from '@nymbalhq/platform'
import { apiStoreEnv } from './order-keys'

// Open insights as a night of the store would leave them: the store runs its own night only on a timer from store time,
// so a journey that needs several at once writes them into the command store of the running API (its own connection,
// as stuck-proposals.ts writes a settled proposal). A row carries only what the brief and the API read.

export type Severity = 'critical' | 'warning' | 'info'

export interface InsightSeed {
  severity: Severity
  summary: string
  /** The store day the night ran for, `YYYY-MM-DD`. */
  day: string
  job?: string
  subject?: string
  /** The AI guidance on the row and its status, as a night's guidance pass leaves them; neither column when absent. */
  guidance?: string | null
  guidanceStatus?: 'pending' | 'written' | 'withheld' | 'failed'
}

type StoreConfig = Parameters<typeof createCommandStore>[0]
const configFor = (commandStore: 'sqlite' | 'postgres'): StoreConfig =>
  ({ infrastructure: { commandStore } }) as unknown as StoreConfig

const COLUMNS =
  'id, job, subject, run_day, data_day, status, severity, summary, facts, created_at, dismissed_at'
const GUIDANCE_COLUMNS = ', guidance, guidance_status'

function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** One open insight row; its id. A subject of its own unless the seed names one, so no row stands in its way. */
export async function seedInsight(seed: InsightSeed): Promise<string> {
  const env = apiStoreEnv()
  const id = randomUUID()
  const guided = seed.guidance !== undefined || seed.guidanceStatus !== undefined
  const columns = guided ? `${COLUMNS}${GUIDANCE_COLUMNS}` : COLUMNS
  const row: unknown[] = [
    id,
    seed.job ?? 'zero-result-term',
    seed.subject ?? `term:e2e-${id}`,
    seed.day,
    dayBefore(seed.day),
    'open',
    seed.severity,
    seed.summary,
    '{}',
    new Date(),
    null,
    ...(guided ? [seed.guidance ?? null, seed.guidanceStatus ?? null] : []),
  ]
  const store =
    env.NYMBAL_COMMAND_STORE === 'postgres'
      ? createCommandStore(configFor('postgres'), { postgresUrl: env.DATABASE_URL ?? '' })
      : createCommandStore(configFor('sqlite'), { sqlitePath: env.NYMBAL_SQLITE_PATH ?? '' })
  try {
    const clients = rawClients(store)
    if (clients.kind === 'postgres') {
      const placeholders = row.map((_, i) => `$${i + 1}`).join(', ')
      await clients.pool.query(`INSERT INTO insights (${columns}) VALUES (${placeholders})`, row)
    } else {
      const placeholders = row.map(() => '?').join(', ')
      clients.raw
        .prepare(`INSERT INTO insights (${columns}) VALUES (${placeholders})`)
        .run(...row.map((value) => (value instanceof Date ? value.toISOString() : value)))
    }
  } finally {
    await store.close()
  }
  return id
}
