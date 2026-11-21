import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, doctorLines, REPO_ROOT, runCli } from '../../../../tests/support/doctor'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../support/postgres'

// The retry on Postgres through the built CLI: a command that opened the store read-only as `events query` does would
// fail its write only here. Needs `pnpm build` and Postgres (NYMBAL_TEST_POSTGRES_URL).

const DEAD_ROWS = 3

let db: TestDatabase

beforeAll(async () => {
  db = await createDatabase(postgresServerUrl(), 'events_retry_cli')
  const store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
  for (let i = 0; i < DEAD_ROWS; i += 1) {
    const id = randomUUID()
    const envelope = {
      id,
      type: 'category.created.v1',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: id,
      payload: {},
      metadata: { storeId: 'test-store', environment: 'test' },
    }
    await queryOnce(
      db.url,
      `INSERT INTO events (id, type, envelope, correlation_id, created_at, attempts, dead_at, retry_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour', 5, now(), now() + interval '160 seconds')`,
      [id, envelope.type, JSON.stringify(envelope), envelope.correlationId],
    )
  }
}, 60_000)

afterAll(async () => {
  await db?.drop()
})

describe('nymbal events retry on Postgres', () => {
  it('AC-16: the built CLI moves the dead rows on Postgres and exits 0, and doctor then reports none dead', async () => {
    const env = cliEnv({ NYMBAL_COMMAND_STORE: 'postgres', DATABASE_URL: db.url })
    const countDead = async () => {
      const [row] = await queryOnce<{ n: number }>(
        db.url,
        'SELECT count(*)::int AS n FROM events WHERE dead_at IS NOT NULL',
      )
      return row!.n
    }
    const deadBefore = await countDead()
    expect(deadBefore, 'the fixture: dead rows').toBe(DEAD_ROWS)

    const run = await runCli(['events', 'retry', '--all'], { cwd: REPO_ROOT, env })
    const doctor = await runCli(['doctor'], { cwd: REPO_ROOT, env })

    expect(await countDead(), `dead rows after the retry\n${run.out.slice(-2000)}`).toBe(
      deadBefore - DEAD_ROWS,
    )
    expect(run.code, run.out.slice(-2000)).toBe(0)
    const line = doctorLines(doctor.out).find((l) => l.name === 'events')
    expect(line?.detail, doctor.out.slice(-2000)).toMatch(/\bnone dead\b/)
    expect(line?.status).toBe('ok')
  }, 120_000)
})
