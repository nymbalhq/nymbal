import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HEALTH_CHECK_TIMEOUT_MS } from '../../packages/types/src/adapters/adapter-base.js'
import {
  createDatabase,
  postgresServerUrl,
  type TestDatabase,
} from '../../packages/platform/tests/support/postgres.js'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../support/redis.js'
import { workspace } from '../support/project.js'
import {
  readiness,
  spawnStart,
  startEnv,
  storeConfig,
  storeProject,
  untilServing,
  upstream,
  type StartRun,
  type StoreProject,
} from '../support/start.js'
import { tcpProxy, type TcpProxy } from '../support/tcp-proxy.js'

// AC-4: `nymbal start`'s GET /ready on Postgres, the Redis document store and the Redis Streams bus. Redis is reached
// through a TCP proxy the test owns, which then refuses ("stopped") or accepts and never answers ("hangs"): /ready is
// 503 naming the Redis primitive, with no URL, port or password, within HEALTH_CHECK_TIMEOUT_MS + 1 s, while /health
// stays 200. Needs Postgres and Redis (NYMBAL_TEST_POSTGRES_URL, NYMBAL_TEST_REDIS_URL) and the built CLI.

const ANSWER_WITHIN_MS = HEALTH_CHECK_TIMEOUT_MS + 1000
const PRIMITIVES = ['command-store', 'document-store', 'event-bus']
const ON_REDIS = ['document-store', 'event-bus']

const redisUrl = redisServerUrl()
const prefix = uniquePrefix('start-ready')
let db: TestDatabase
let project: StoreProject
let cleanup: Array<() => void | Promise<void>> = []

beforeAll(async () => {
  db = await createDatabase(postgresServerUrl(), 'start_ready')
  project = storeProject(
    storeConfig({
      commandStore: 'postgres',
      documentStore: { provider: 'redis' },
      eventBus: { provider: 'redis-streams' },
      redis: { prefix },
    }),
    workspace('@nymbalhq/document-store-redis', '@nymbalhq/event-bus-redis-streams'),
  )
})

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

afterAll(async () => {
  await deleteUnder(redisUrl, prefix)
  project?.remove()
  await db?.drop()
})

/** `start --migrate` with Redis through a fresh proxy whose URL carries `password`. */
async function startThroughProxy(password: string): Promise<{ run: StartRun; proxy: TcpProxy }> {
  const proxy = await tcpProxy(new URL(redisUrl))
  cleanup.push(() => proxy.close())
  const through = new URL(proxy.url(redisUrl))
  through.username = ''
  through.password = password
  const stand = await upstream(project.dir)
  cleanup.push(() => stand.close())
  const run = await spawnStart(['start', '--migrate'], {
    cwd: project.dir,
    env: startEnv({
      DATABASE_URL: db.url,
      REDIS_URL: through.toString(),
      NYMBAL_STOREFRONT_ENTRY: stand.entry,
    }),
  })
  cleanup.push(() => run.kill())
  await untilServing(run)
  return { run, proxy }
}

async function timed<T>(call: Promise<T>): Promise<T & { ms: number }> {
  const started = Date.now()
  const value = await call
  return { ...value, ms: Date.now() - started }
}

async function healthStatus(base: string): Promise<number> {
  return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).status
}

describe('AC-4: GET /ready reports the stores and the bus', () => {
  for (const mode of ['stopped', 'hangs'] as const) {
    it(`AC-4: /ready is 200 with every store up; with Redis ${mode === 'stopped' ? 'refusing' : 'accepting and never answering'} it is 503 naming the Redis primitive and no URL within HEALTH_CHECK_TIMEOUT_MS + 1 s, and /health stays 200`, async () => {
      const password = `redispw${randomBytes(12).toString('hex')}`
      const { run, proxy } = await startThroughProxy(password)

      const up = await readiness(run.base)
      expect(up.status, up.text).toBe(200)
      expect(up.body.status).toBe('ready')
      expect(await healthStatus(run.base)).toBe(200)

      if (mode === 'stopped') await proxy.close()
      else proxy.hold()
      const [ready, health] = await Promise.all([
        timed(readiness(run.base, ANSWER_WITHIN_MS * 3)),
        healthStatus(run.base),
      ])

      expect(ready.ms, run.output().slice(-2000)).toBeLessThanOrEqual(ANSWER_WITHIN_MS)
      expect(ready.status, ready.text).toBe(503)
      expect(ready.body.status).toBe('not-ready')
      const failing = ready.body.failing ?? []
      expect(
        failing.some((name) => ON_REDIS.includes(name)),
        ready.text,
      ).toBe(true)
      expect(failing.filter((name) => !PRIMITIVES.includes(name))).toEqual([])
      expect(failing).not.toContain('command-store')
      expect(
        [password, '://', `:${proxy.port}`, db.name].filter((s) => ready.text.includes(s)),
      ).toEqual([])
      expect(health).toBe(200)
      expect(await healthStatus(run.base)).toBe(200)
    }, 90_000)
  }
})
