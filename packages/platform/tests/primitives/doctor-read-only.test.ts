import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { cliEnv, doctorLines, REPO_ROOT, runCli } from '../../../../tests/support/doctor'
import { redis, redisServerUrl } from '../../../../tests/support/redis'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../support/postgres'

// AC-6 (a), Postgres and Redis: doctor is read-only on a store holding the state a write would change (an undelivered
// event, an expired reservation, document-store keys). After diagnose over generated healthy and failing configs, and
// after one CLI `nymbal doctor`, every row, count and key is unchanged, and each run is checked to have reached the
// stores. The SQLite half is packages/cli/src/commands/doctor-read-only.test.ts.
// Needs `pnpm build` (the CLI and the stores' packages), Postgres and Redis (NYMBAL_TEST_POSTGRES_URL,
// NYMBAL_TEST_REDIS_URL).

const WITNESS_KEYS = 7
/** A Redis database no other suite uses, so DBSIZE is this file's alone. */
const REDIS_DB = '11'
const logger = createLogger({ pretty: false, level: 'silent' })
const prefix = `doctor-ro-${randomUUID().slice(0, 8)}`
const EVENT_ID = `evt-doctor-${randomUUID()}`
const RESERVATION_ID = `res-doctor-${randomUUID()}`

let db: TestDatabase
let redisUrl = ''

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Everything a write by doctor would change. */
async function witnessState() {
  const [counts] = await queryOnce<Record<string, number>>(
    db.url,
    `SELECT (SELECT count(*)::int FROM events) AS events,
            (SELECT count(*)::int FROM inventory_reservations) AS reservations,
            (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations`,
  )
  const event = await queryOnce(
    db.url,
    'SELECT delivered_at, attempts, dead_at FROM events WHERE id = $1',
    [EVENT_ID],
  )
  const reservation = await queryOnce(
    db.url,
    'SELECT * FROM inventory_reservations WHERE reservation_id = $1',
    [RESERVATION_ID],
  )
  const [documents] = await queryOnce<{ table: string | null }>(
    db.url,
    `SELECT to_regclass('nymbal_documents')::text AS table`,
  )
  const [dbsize] = await redis(redisUrl, [['DBSIZE']])
  const keys: string[] = []
  let cursor = '0'
  do {
    const [reply] = await redis(redisUrl, [['SCAN', cursor, 'COUNT', '1000']])
    const [next, batch] = reply as [string, string[]]
    keys.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return { counts, event, reservation, documentsTable: documents!.table, dbsize, keys: keys.sort() }
}

beforeAll(async () => {
  const u = new URL(redisServerUrl())
  u.pathname = `/${REDIS_DB}`
  redisUrl = u.toString()
  await redis(redisUrl, [['FLUSHDB']])
  await redis(
    redisUrl,
    Array.from({ length: WITNESS_KEYS }, (_, i) => ['SET', `${prefix}:witness:${i}`, `value-${i}`]),
  )

  db = await createDatabase(postgresServerUrl(), 'doctor_ro')
  const store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
  const envelope = {
    id: EVENT_ID,
    type: 'product.created.v1',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: EVENT_ID,
    data: { productId: 'doctor-witness' },
    metadata: { storeId: 'test-store', environment: 'test' },
  }
  await queryOnce(
    db.url,
    `INSERT INTO events (id, type, envelope, correlation_id, created_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [EVENT_ID, envelope.type, JSON.stringify(envelope), envelope.correlationId],
  )
  await queryOnce(
    db.url,
    `INSERT INTO inventory_reservations (reservation_id, variant_id, qty, order_ref, expires_at, created_at)
     VALUES ($1, 'var-doctor-witness', 2, NULL, now() - interval '1 hour', now() - interval '2 hours')`,
    [RESERVATION_ID],
  )
}, 60_000)

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  if (redisUrl !== '') await redis(redisUrl, [['FLUSHDB']])
  await db?.drop()
})

interface Shape {
  documentStore: 'redis' | 'postgres-jsonb'
  eventBus: 'in-process' | 'redis-streams'
  postgresUp: boolean
  redisUp: boolean
}

async function configFor(shape: Shape): Promise<{ config: NymbalConfig; databaseUrl: string }> {
  const usesRedis = shape.documentStore === 'redis' || shape.eventBus === 'redis-streams'
  const redisAt = shape.redisUp ? redisUrl : `redis://127.0.0.1:${await closedPort()}/${REDIS_DB}`
  const databaseUrl = shape.postgresUp
    ? db.url
    : `postgres://nymbal:nymbal@127.0.0.1:${await closedPort()}/${db.name}`
  const config = {
    ...kernelConfig('postgres'),
    infrastructure: {
      commandStore: 'postgres',
      documentStore: shape.documentStore,
      eventBus: shape.eventBus,
      media: 'local-fs',
      ...(usesRedis && { redis: { url: redisAt, prefix } }),
    },
  } as unknown as NymbalConfig
  return { config, databaseUrl }
}

const shapeArb: fc.Arbitrary<Shape> = fc.record({
  documentStore: fc.constantFrom('redis' as const, 'postgres-jsonb' as const),
  eventBus: fc.constantFrom('in-process' as const, 'redis-streams' as const),
  postgresUp: fc.boolean(),
  redisUp: fc.boolean(),
})

describe('AC-6 (a): doctor writes nothing to Postgres or Redis', () => {
  it('AC-6 (a): diagnose, in-process over generated healthy and failing configs (one on postgres-jsonb), leaves the event, the reservation, the row counts, nymbal_documents and the Redis keys as they were, and reaches the stores it names', async () => {
    const before = await witnessState()
    expect(before.event).toHaveLength(1)
    expect(before.reservation).toHaveLength(1)
    expect(before.dbsize).toBe(WITNESS_KEYS)

    const healthyJsonb: Shape = {
      documentStore: 'postgres-jsonb',
      eventBus: 'in-process',
      postgresUp: true,
      redisUp: true,
    }
    await fc.assert(
      fc.asyncProperty(shapeArb, async (shape) => {
        const { config, databaseUrl } = await configFor(shape)
        vi.stubEnv('DATABASE_URL', databaseUrl)
        const report = await diagnose(config, { logger, timeoutMs: 3000 })
        const check = (name: string) => report.checks.find((c) => c.name === name)

        expect(check('command store')?.status === 'down').toBe(!shape.postgresUp)
        // A Redis store is down exactly when Redis is; postgres-jsonb warns it is not initialized on a live Postgres, and is
        // down (not checked) when the command store it shares is.
        const docStore = check('primitive documentStore')
        const seen =
          docStore?.status === 'down'
            ? 'down'
            : docStore?.status === 'degraded' && /not initialized/.test(docStore.detail)
              ? 'not initialized'
              : 'up'
        const expected =
          shape.documentStore === 'redis'
            ? shape.redisUp
              ? 'up'
              : 'down'
            : shape.postgresUp
              ? 'not initialized'
              : 'down'
        expect(seen, JSON.stringify(report.checks)).toBe(expected)
        expect(await witnessState()).toEqual(before)
      }),
      { numRuns: 10, examples: [[healthyJsonb]] },
    )
  }, 180_000)

  it('AC-6 (a): one CLI `nymbal doctor` on the Postgres command store and Redis stores reaches them and leaves every witness as it was', async () => {
    const before = await witnessState()

    const run = await runCli(['doctor'], {
      cwd: REPO_ROOT,
      env: cliEnv({
        NYMBAL_COMMAND_STORE: 'postgres',
        DATABASE_URL: db.url,
        NYMBAL_DOCUMENT_STORE: 'redis',
        NYMBAL_EVENT_BUS: 'redis-streams',
        REDIS_URL: redisUrl,
        NYMBAL_REDIS_PREFIX: prefix,
      }),
    })
    const lines = doctorLines(run.out)
    const status = (name: string) => lines.find((l) => l.name === name)?.status

    expect(
      [status('command store'), status('primitive documentStore')],
      run.out.slice(-3000),
    ).toEqual(['ok', 'ok'])
    expect(await witnessState()).toEqual(before)
  }, 120_000)
})
