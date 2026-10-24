import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redis } from '../../support/redis'

// Stands in for the E2E API server under scripts/e2e-server.mjs (tests/stores/e2e-harness.test.ts): it reads the
// stores the harness gave this run, writes to each so their teardown has something to remove, and prints one line,
// `API-PROBE <json>`. It writes only to a database named nymbal_e2e_* and a prefix e2e-*: a harness that gave it the
// shared server database or no prefix is reported, never written to.

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const pg = createRequire(join(REPO, 'packages/platform/package.json'))('pg') as {
  Client: new (opts: { connectionString: string }) => {
    connect(): Promise<void>
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
    end(): Promise<void>
  }
}

const result: Record<string, unknown> = {}
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl !== undefined) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const database = String((await client.query('SELECT current_database() AS d')).rows[0]!['d'])
    result['database'] = database
    if (/^nymbal_e2e_/.test(database)) {
      await client.query('CREATE TABLE primitives_probe (x int)')
      await client.query('INSERT INTO primitives_probe VALUES (1)')
      result['wroteDatabase'] = true
    }
  } finally {
    await client.end()
  }
}
const prefix = process.env.NYMBAL_REDIS_PREFIX
const redisUrl = process.env.REDIS_URL
result['prefix'] = prefix ?? null
if (prefix !== undefined && /^e2e-/.test(prefix) && redisUrl !== undefined) {
  await redis(redisUrl, [
    ['SET', `${prefix}:primitives-probe`, '1'],
    ['XADD', `${prefix}:primitives-probe-stream`, '*', 'k', 'v'],
  ])
  result['wroteRedis'] = true
}
process.stdout.write(`API-PROBE ${JSON.stringify(result)}\n`)
