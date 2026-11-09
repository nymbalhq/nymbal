import { randomUUID } from 'node:crypto'
import { createCommandStore, rawClients } from '@nymbalhq/platform'
import { apiStoreEnv } from './order-keys'

// Rows in the end state a crash leaves after the sweep has settled them: no product surface yields a row stuck after a
// crash, so this end state is written directly into the command store of the running API (its own connection, as
// order-keys.ts writes a key's expiry). A row carries only what the card and the API read.

export const OUTCOME_UNKNOWN_CODE = 'proposal.outcome_unknown'
export const INTERRUPTED_CODE = 'proposal.interrupted'
export const OUTCOME_UNKNOWN_TEXT =
  'The server stopped while this was running, so it may or may not have gone through. Check the order or record before doing this again.'
export const INTERRUPTED_TEXT =
  'The server stopped and this did not go through. Nothing was changed; ask the agent again if you still want it.'

export interface SettledRow {
  id: string
  correlationId: string
}

type StoreConfig = Parameters<typeof createCommandStore>[0]
const configFor = (commandStore: 'sqlite' | 'postgres'): StoreConfig =>
  ({ infrastructure: { commandStore } }) as unknown as StoreConfig

const INSERT_COLUMNS = `id, tool, command, args, idempotency_key, proposer_id, agent_name, correlation_id, status,
  decided_by_kind, decided_by, decided_at, outcome_status, outcome_code, outcome_message, created_at, settled_at`

/** A row already settled `failed` with this code and message, newest in the Decided listing. */
export async function seedSettledProposal(
  command: string,
  code: string,
  message: string,
): Promise<SettledRow> {
  const env = apiStoreEnv()
  const id = randomUUID()
  const correlationId = randomUUID()
  const now = new Date()
  const earlier = new Date(now.getTime() - 60_000)
  const row = [
    id,
    command.replace('.', '_'),
    command,
    '{}',
    null,
    'admin-e2e',
    'e2e-sweep-agent',
    correlationId,
    'failed',
    'admin',
    'admin-e2e',
    earlier,
    500,
    code,
    message,
    earlier,
    now,
  ]
  const store =
    env.NYMBAL_COMMAND_STORE === 'postgres'
      ? createCommandStore(configFor('postgres'), { postgresUrl: env.DATABASE_URL ?? '' })
      : createCommandStore(configFor('sqlite'), { sqlitePath: env.NYMBAL_SQLITE_PATH ?? '' })
  try {
    const clients = rawClients(store)
    if (clients.kind === 'postgres') {
      const placeholders = row.map((_, i) => `$${i + 1}`).join(', ')
      await clients.pool.query(`INSERT INTO proposals (${INSERT_COLUMNS}) VALUES (${placeholders})`, row)
    } else {
      const placeholders = row.map(() => '?').join(', ')
      clients.raw
        .prepare(`INSERT INTO proposals (${INSERT_COLUMNS}) VALUES (${placeholders})`)
        .run(...row.map((value) => (value instanceof Date ? value.toISOString() : value)))
    }
  } finally {
    await store.close()
  }
  return { id, correlationId }
}
