import pg from 'pg'

// A fresh Postgres database per test file on the server NYMBAL_TEST_POSTGRES_URL names. A missing variable throws at
// import time so the integration-postgres project fails, never skips (P0-02 AC-9).

export const URL_VAR = 'NYMBAL_TEST_POSTGRES_URL'

export function postgresServerUrl(): string {
  const serverUrl = process.env[URL_VAR]
  if (serverUrl === undefined || serverUrl.trim() === '') {
    throw new Error(
      `${URL_VAR} is not set: the integration-postgres project needs a Postgres server ` +
        `(pnpm gate:full starts one with docker compose; e.g. ${URL_VAR}=postgres://postgres:nymbal@localhost:54329/nymbal)`,
    )
  }
  return serverUrl
}

const CONNECTIONS_GONE_TIMEOUT_MS = 10_000
const CONNECTIONS_POLL_MS = 25

/** Resolves once no backend is connected to `database`; throws, naming the count, if that takes too long. */
async function untilNoConnections(admin: pg.Pool, database: string): Promise<void> {
  const deadline = Date.now() + CONNECTIONS_GONE_TIMEOUT_MS
  for (;;) {
    const result = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [database],
    )
    if (result.rows[0]!.n === 0) return
    if (Date.now() > deadline) {
      throw new Error(
        `${database}: ${result.rows[0]!.n} connection(s) still open ${CONNECTIONS_GONE_TIMEOUT_MS} ms after close`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECTIONS_POLL_MS))
  }
}

export interface TestDatabase {
  url: string
  name: string
  /** Waits for every connection to the database to be gone, then drops it. */
  drop(): Promise<void>
}

let counter = 0

export async function createDatabase(serverUrl: string, prefix: string): Promise<TestDatabase> {
  counter += 1
  const name = `p102_${prefix}_${process.pid}_${Date.now()}_${counter}`.toLowerCase()
  const admin = new pg.Pool({ connectionString: serverUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(serverUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    name,
    async drop() {
      try {
        await untilNoConnections(admin, name)
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    },
  }
}
