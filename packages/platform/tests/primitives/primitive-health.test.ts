import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport } from '@nymbalhq/types'
import { createAdapter as createRedisDocStore } from '../../../adapters/document-store/redis/src/index.js'
import { createAdapter as createJsonbDocStore } from '../../../adapters/document-store/postgres-jsonb/src/index.js'
import { createAdapter as createRedisStreamsBus } from '../../../adapters/event-bus/redis-streams/src/index.js'
import { createS3MediaStorage } from '../../../adapters/media/s3/src/index.js'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { createPublicBucket, s3Endpoint, type TestBucket } from '../../../../tests/support/s3'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { createLogger } from '../../src/logger.js'
import { createLocalFsMediaStorage } from '../../src/media/index.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres'

// AC-3: every bundled primitive answers healthCheck(). Against the composed services, the Redis, Postgres and S3
// (MinIO) primitives report `healthy` when up and `down` within 6 s once their host is unreachable, with no credential
// in `detail`. The Redis ones are built through a TCP proxy that is then closed, so their clients retry a closed port
// forever (ioredis), which is the hang the 5 s bound exists for. In-memory, in-process and local-fs report healthy;
// local-fs on a root that is not writable reports `down`, and checking a writable root writes nothing in it.
// Needs `pnpm build` (the stores load their SDKs) and Redis, Postgres and MinIO (NYMBAL_TEST_REDIS_URL,
// NYMBAL_TEST_POSTGRES_URL, NYMBAL_TEST_S3_ENDPOINT).

const DOWN_WITHIN_MS = 6000
/** Past this a check has hung: the race gives up so the test fails on its assertion, not on its timeout. */
const HUNG_AFTER_MS = 12_000

const logger = createLogger({ pretty: false, level: 'silent' })
const redisUrl = redisServerUrl()
const prefix = uniquePrefix('doctor-health')

interface Proxy {
  port: number
  /** Stops listening and cuts every open connection: the port then refuses. */
  close(): Promise<void>
}

/** A TCP proxy on a free port to `target`, so a client connected through it can be cut off and left on a closed port. */
async function tcpProxy(target: URL): Promise<Proxy> {
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname)
    sockets.add(client).add(upstream)
    const end = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', end).on('close', end)
    upstream.on('error', end).on('close', end)
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    port,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const s of sockets) s.destroy()
      await closed
    },
  }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Runs one health check, timed; `hung` when it has not settled after HUNG_AFTER_MS. */
async function timedCheck(
  check: (() => Promise<HealthReport>) | undefined,
): Promise<{ report: HealthReport | 'hung' | undefined; ms: number }> {
  const started = Date.now()
  if (check === undefined) return { report: undefined, ms: 0 }
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), HUNG_AFTER_MS)
  })
  try {
    const report = await Promise.race([check(), hung])
    return { report, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Closes a primitive without letting a close that hangs hold the suite. */
async function closeBounded(close: () => Promise<void>): Promise<void> {
  await Promise.race([close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))])
}

const statusOf = (r: HealthReport | 'hung' | undefined) =>
  r === undefined || r === 'hung' ? r : r.status
const detailOf = (r: HealthReport | 'hung' | undefined) =>
  r === undefined || r === 'hung' ? '' : (r.detail ?? '')

/** A credential no message has a reason to contain by chance. */
const secret = (label: string) => `${label}${randomUUID().replace(/-/g, '')}`

/** The composed Redis, reached through `proxy`, with a password in the URL (a server without one only warns). */
function redisUrlThrough(proxy: Proxy, password: string): string {
  const u = new URL(redisUrl)
  u.hostname = '127.0.0.1'
  u.port = String(proxy.port)
  u.username = ''
  u.password = password
  return u.toString()
}

let bucket: TestBucket
let db: TestDatabase

beforeAll(async () => {
  bucket = await createPublicBucket('doctor-health')
  db = await createDatabase(postgresServerUrl(), 'doctor_health')
})

afterAll(async () => {
  await deleteUnder(redisUrl, prefix)
  await bucket?.remove()
  await db?.drop()
})

describe('AC-3: primitives against the composed services report healthy when up and down within 6 s when unreachable', () => {
  it('AC-3: document-store-redis: healthy through a live connection; down within 6 s once its port refuses; no password in detail', async () => {
    const password = secret('redispw')
    const proxy = await tcpProxy(new URL(redisUrl))
    const store = await createRedisDocStore({
      slot: 'documentStore',
      config: { url: redisUrlThrough(proxy, password), prefix },
      logger,
      env: {},
    })
    try {
      const up = await timedCheck(store.healthCheck?.bind(store))
      expect(statusOf(up.report)).toBe('healthy')

      await proxy.close()
      const down = await timedCheck(store.healthCheck?.bind(store))
      expect(statusOf(down.report)).toBe('down')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)
      expect(detailOf(down.report)).not.toContain(password)
    } finally {
      await proxy.close()
      await closeBounded(() => store.close())
    }
  }, 60_000)

  it('AC-3: event-bus-redis-streams: healthy through a live connection; down within 6 s once its port refuses; no password in detail', async () => {
    const password = secret('buspw')
    const proxy = await tcpProxy(new URL(redisUrl))
    const bus = await createRedisStreamsBus({
      slot: 'eventBus',
      config: { url: redisUrlThrough(proxy, password), prefix },
      logger,
      env: {},
    })
    try {
      const up = await timedCheck(bus.healthCheck?.bind(bus))
      expect(statusOf(up.report)).toBe('healthy')

      await proxy.close()
      const down = await timedCheck(bus.healthCheck?.bind(bus))
      expect(statusOf(down.report)).toBe('down')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)
      expect(detailOf(down.report)).not.toContain(password)
    } finally {
      await proxy.close()
      await closeBounded(() => bus.close())
    }
  }, 60_000)

  it('AC-3: document-store-postgres-jsonb: healthy on an initialized database; down within 6 s on a closed port; no user, password or query value in detail', async () => {
    const store = createJsonbDocStore({
      slot: 'documentStore',
      config: { postgresUrl: db.url, prefix: 'nymbal' },
      logger,
      env: {},
    })
    try {
      await store.initialize()
      const up = await timedCheck(store.healthCheck?.bind(store))
      expect(statusOf(up.report)).toBe('healthy')
    } finally {
      await closeBounded(() => store.close())
    }

    const user = secret('pguser')
    const password = secret('pgpw')
    const queryValue = secret('pgq')
    const port = await closedPort()
    const unreachable = createJsonbDocStore({
      slot: 'documentStore',
      config: {
        postgresUrl: `postgres://${user}:${password}@127.0.0.1:${port}/shop?application_name=${queryValue}`,
        prefix: 'nymbal',
      },
      logger,
      env: {},
    })
    try {
      const down = await timedCheck(unreachable.healthCheck?.bind(unreachable))
      expect(statusOf(down.report)).toBe('down')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)
      for (const value of [user, password, queryValue]) {
        expect(detailOf(down.report)).not.toContain(value)
      }
    } finally {
      await closeBounded(() => unreachable.close())
    }
  }, 60_000)

  it('AC-3: media-s3: healthy on the MinIO bucket; down within 6 s on a closed endpoint; neither key in detail', async () => {
    const live = createS3MediaStorage({
      bucket: bucket.name,
      endpoint: s3Endpoint(),
      region: bucket.region,
      credentials: bucket.credentials,
    })
    const up = await timedCheck(live.healthCheck?.bind(live))
    expect(statusOf(up.report)).toBe('healthy')

    const accessKeyId = secret('AKIA')
    const secretAccessKey = secret('s3secret')
    const unreachable = createS3MediaStorage({
      bucket: bucket.name,
      endpoint: `http://127.0.0.1:${await closedPort()}`,
      region: bucket.region,
      credentials: { accessKeyId, secretAccessKey },
    })
    const down = await timedCheck(unreachable.healthCheck?.bind(unreachable))
    expect(statusOf(down.report)).toBe('down')
    expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)
    expect(detailOf(down.report)).not.toContain(accessKeyId)
    expect(detailOf(down.report)).not.toContain(secretAccessKey)
  }, 60_000)
})

describe('AC-3: the platform built-ins report their health', () => {
  it('AC-3: the in-memory document store and the in-process event bus report healthy', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const bus = new InProcessEventBus({ logger })
    try {
      const reports = [await store.healthCheck?.(), await bus.healthCheck?.()]
      expect(reports.map((r) => r?.status)).toEqual(['healthy', 'healthy'])
    } finally {
      await store.close()
      await bus.close()
    }
  })

  it('AC-3: local-fs media on a writable root reports healthy and leaves the root as it was (no probe write)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nymbal-doctor-media-'))
    try {
      const before = { entries: readdirSync(root), mtimeMs: statSync(root).mtimeMs }
      const media = createLocalFsMediaStorage({ root })
      const report = await media.healthCheck?.()

      expect(report?.status).toBe('healthy')
      expect({ entries: readdirSync(root), mtimeMs: statSync(root).mtimeMs }).toEqual(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('AC-3: local-fs media on a root that is not writable reports down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nymbal-doctor-media-ro-'))
    const writableRoot = mkdtempSync(join(tmpdir(), 'nymbal-doctor-media-rw-'))
    chmodSync(root, 0o555)
    try {
      const writable = createLocalFsMediaStorage({ root: writableRoot })
      const readOnly = createLocalFsMediaStorage({ root })
      const [ok, down] = [await writable.healthCheck?.(), await readOnly.healthCheck?.()]

      expect(ok?.status).toBe('healthy')
      expect(down?.status).toBe('down')
    } finally {
      chmodSync(root, 0o755)
      rmSync(root, { recursive: true, force: true })
      rmSync(writableRoot, { recursive: true, force: true })
    }
  })
})
