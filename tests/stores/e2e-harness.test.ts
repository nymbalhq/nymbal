import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { postgresServerUrl, queryOnce } from '../../packages/platform/tests/support/postgres'
import { deleteUnder, keysUnder, redisServerUrl } from '../support/redis'

// Acceptance test for P2-02 AC-7 (spec P2-02-primitives-are-protocols, decision 7), the harness half: the E2E harness
// (scripts/e2e-server.mjs, tests/e2e/playwright.config.ts) gives each run its own stores, as it gives each run a
// fresh SQLite file. On the postgres-redis set the API server it starts sees a DATABASE_URL naming a database
// nymbal_e2e_<stamp> that exists, and NYMBAL_REDIS_PREFIX=e2e-<stamp>; no two runs share either; once the run is over
// the database is dropped and the prefix's keys are deleted. The API server is a probe (fixtures/api-probe.ts) run
// under the real wrapper with the API server's environment as the Playwright config builds it.
// Kills: one run reading another's data, and runs that leave databases and keys behind.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const PROBE = fileURLToPath(new URL('./fixtures/api-probe.ts', import.meta.url))

const serverUrl = postgresServerUrl()
const redisUrl = redisServerUrl()

/** The store set's variables, and the servers under both names a harness might read them from. */
const SET_ENV = {
  NYMBAL_COMMAND_STORE: 'postgres',
  NYMBAL_DOCUMENT_STORE: 'redis',
  NYMBAL_EVENT_BUS: 'redis-streams',
  DATABASE_URL: serverUrl,
  NYMBAL_TEST_POSTGRES_URL: serverUrl,
  REDIS_URL: redisUrl,
  NYMBAL_TEST_REDIS_URL: redisUrl,
}

const PICK = ['DATABASE_URL', 'NYMBAL_REDIS_PREFIX', 'REDIS_URL'] as const
const PRINT = `import(process.env.P2_02_PW_URL).then((m) => {
  const env = {}
  for (const k of ${JSON.stringify(PICK)}) if (process.env[k] !== undefined) env[k] = process.env[k]
  process.stdout.write('\\n' + JSON.stringify({ webServer: m.default.webServer ?? null, env }) + '\\n')
})`

type Server = { command: string; env?: Record<string, string> }

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...SET_ENV, CI: '1', NYMBAL_E2E_TARGET: 'admin' }
  for (const key of ['NYMBAL_E2E_ADMIN', 'NYMBAL_REDIS_PREFIX', 'NYMBAL_E2E_SQLITE_PATH']) {
    delete env[key]
  }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

/** The API server's environment for one run, as the Playwright config builds it (its process.env, then its env). */
async function apiServerEnv(): Promise<Record<string, string>> {
  const { stdout } = await exec(TSX, ['--eval', PRINT], {
    cwd: join(REPO, 'tests/e2e'),
    env: {
      ...baseEnv(),
      P2_02_PW_URL: pathToFileURL(join(REPO, 'tests/e2e/playwright.config.ts')).href,
    },
  })
  const printed = JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as {
    webServer: Server | Server[] | null
    env: Record<string, string>
  }
  const servers =
    printed.webServer === null
      ? []
      : Array.isArray(printed.webServer)
        ? printed.webServer
        : [printed.webServer]
  const api = servers.find((s) => /--api-only/.test(s.command))
  return { ...printed.env, ...(api?.env ?? {}) }
}

interface Probe {
  database?: string
  wroteDatabase?: boolean
  prefix?: string | null
  wroteRedis?: boolean
}

/** One E2E run's server lifetime: the real wrapper around the probe, with the API server's environment. */
async function runOnce(): Promise<Probe> {
  const env = { ...baseEnv(), ...(await apiServerEnv()) }
  const { stdout } = await exec(
    process.execPath,
    [join(REPO, 'scripts/e2e-server.mjs'), '--', TSX, PROBE],
    { cwd: REPO, env, timeout: 60_000 },
  )
  const line = stdout.split('\n').find((l) => l.startsWith('P2-02-PROBE '))
  if (line === undefined) throw new Error(`the probe printed nothing:\n${stdout}`)
  return JSON.parse(line.slice('P2-02-PROBE '.length)) as Probe
}

const seen: Probe[] = []
afterAll(async () => {
  // A harness that fails this test may leave its stores: remove what the probe saw, and only that.
  for (const probe of seen) {
    if (probe.database !== undefined && /^nymbal_e2e_/.test(probe.database)) {
      await queryOnce(serverUrl, `DROP DATABASE IF EXISTS "${probe.database}" WITH (FORCE)`)
    }
    if (typeof probe.prefix === 'string' && /^e2e-/.test(probe.prefix)) {
      await deleteUnder(redisUrl, probe.prefix)
    }
  }
})

async function databaseExists(name: string): Promise<boolean> {
  const rows = await queryOnce<{ n: number }>(
    serverUrl,
    'SELECT count(*)::int AS n FROM pg_database WHERE datname = $1',
    [name],
  )
  return rows[0]!.n > 0
}

describe('P2-02 AC-7: each E2E run gets a database and a prefix of its own, gone afterwards', () => {
  it('AC-7: two postgres-redis runs: each API server sees its own nymbal_e2e_ database and e2e- prefix, and writes to them; after each run both are gone', async () => {
    const first = await runOnce()
    seen.push(first)
    const second = await runOnce()
    seen.push(second)

    for (const probe of [first, second]) {
      const label = JSON.stringify(probe)
      expect(probe.database ?? '', label).toMatch(/^nymbal_e2e_/)
      expect(probe.wroteDatabase, label).toBe(true)
      expect(probe.prefix ?? '', label).toMatch(/^e2e-/)
      expect(probe.wroteRedis, label).toBe(true)
      expect(await databaseExists(probe.database!), `${probe.database} left behind`).toBe(false)
      expect(await keysUnder(redisUrl, probe.prefix!), `keys left under ${probe.prefix}`).toEqual(
        [],
      )
    }
    expect(second.database).not.toBe(first.database)
    expect(second.prefix).not.toBe(first.prefix)
    expect(new Set([first.database, second.database]).size).toBeGreaterThan(1)
  }, 120_000)
})
