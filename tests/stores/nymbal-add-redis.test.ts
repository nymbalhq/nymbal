import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  closedPort,
  DEBUG_LINE,
  doctorLines,
  linesNaming,
  startDev,
  type DevRun,
  type DoctorLine,
} from '../support/doctor'
import { deleteUnder, keysUnder, redis, redisServerUrl } from '../support/redis'
import { holdWorkspace } from '../support/workspace-lock'

// A fresh Astro scaffold (made in the checkout as smoke-astro, a workspace member, with
// --no-install, then `pnpm install`), runs on Redis after `nymbal add redis` alone. With REDIS_URL and a prefix of
// this run's own, `nymbal migrate`, `nymbal seed` and `nymbal dev --api-only` start; config:validate reports the Redis
// document store and Redis Streams bus; the seeded products and the order a cart and checkout over the API create are
// documents under the prefix; the prefix is removed afterwards. The order stays `pending`: its receipt email asks the
// native stub to hold the payment (`+stub-pending`, payments/native-stub.ts), and the payment hook is never called.
// The install `pnpm` runs here also rewrites the workspace lockfile and re-links its node_modules; the test puts the
// lockfile back byte for byte and re-installs from it.
// Needs `pnpm build` and Redis (NYMBAL_TEST_REDIS_URL).
//
// AC-7 and AC-5 (a) on the same scaffold, the one place the Redis packages are in a project's own node_modules: after
// `nymbal add redis`, `nymbal doctor` with REDIS_URL at a closed port exits 1, its `primitive document-store` line is
// down naming redis and the host:port, and every other check still runs, with the names of the healthy run; with the
// composed Redis it exits 0. `nymbal dev --api-only` there prints the summary naming the `redis` document store and no
// DEBUG line. The recipe's variable is REDIS_URL.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const NAME = 'smoke-astro'
const DIR = join(REPO, NAME)
const LOCKFILE = join(REPO, 'pnpm-lock.yaml')
const READY_WITHIN_MS = 60_000

const redisUrl = redisServerUrl()
const prefix = `recipes-add-redis-${randomUUID().slice(0, 8)}`

const address = {
  firstName: 'Add',
  lastName: 'Redis',
  addressLine1: '1 Recipe Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

interface ProductDoc {
  slug: string
  variants?: Array<{ id: string; stock: number }>
}

let lockfile: Buffer | null = null
let created = false
let release: (() => void) | null = null
// The other scaffold store tests install into the same workspace: wait for theirs to finish.
const LOCK_WAIT_MS = 1_200_000
let api: ChildProcess | null = null
let base = ''

function storeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REDIS_URL: redisUrl,
    NYMBAL_REDIS_PREFIX: prefix,
  }
  for (const k of Object.keys(env)) if (k.startsWith('VITEST')) delete env[k]
  return env
}

async function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = storeEnv(),
  timeout = 300_000,
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`,
    }
  }
}

// Through pnpm, as a developer runs it: its user agent is how `nymbal add` picks `pnpm add` in a workspace member.
const nymbal = (...args: string[]) => sh('pnpm', ['exec', 'nymbal', ...args], DIR)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

/** The API's cookie-carrying client: the cart cookie, and the double-submit CSRF token the scaffold config demands. */
function apiClient() {
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])
  return async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';')
      const eq = pair!.indexOf('=')
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim())
    }
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as { data?: T }) : {}
    return { status: res.status, data: parsed.data as T }
  }
}

/** Every hash field under the prefix, with its value: the documents the store holds there, whatever its key layout. */
async function documentsUnderPrefix(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const key of await keysUnder(redisUrl, prefix)) {
    const [type] = await redis(redisUrl, [['TYPE', key]])
    if (type !== 'hash') continue
    const [flat] = (await redis(redisUrl, [['HGETALL', key]])) as [string[]]
    for (let i = 0; i < flat.length; i += 2) out.set(flat[i]!, flat[i + 1]!)
  }
  return out
}

async function stopApi(): Promise<void> {
  const child = api
  api = null
  if (child === null || child.exitCode !== null || child.signalCode !== null) return
  const gone = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await gone
  clearTimeout(killer)
}

beforeAll(async () => {
  release = await holdWorkspace(LOCK_WAIT_MS)
  if (existsSync(DIR)) {
    throw new Error(
      `${DIR} exists: remove it first (this test scaffolds it and deletes it afterwards)`,
    )
  }
  lockfile = readFileSync(LOCKFILE)
  created = true
  const made = await sh(
    process.execPath,
    [
      join(REPO, 'packages/create-app/bin/create-nymbal-app.mjs'),
      NAME,
      '--template',
      'astro',
      '--yes',
      '--no-install',
    ],
    REPO,
  )
  if (made.code !== 0) throw new Error(`create-nymbal-app failed:\n${made.output}`)
  const installed = await sh('pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline'], DIR)
  if (installed.code !== 0)
    throw new Error(`pnpm install failed:\n${installed.output.slice(-4000)}`)
}, LOCK_WAIT_MS + 600_000)

afterAll(async () => {
  try {
    await stopApi()
    await deleteUnder(redisUrl, prefix)
    if (created) rmSync(DIR, { recursive: true, force: true })
    if (lockfile !== null && !readFileSync(LOCKFILE).equals(lockfile))
      writeFileSync(LOCKFILE, lockfile)
    // The install also re-linked the workspace's node_modules for the scaffold; put them back to the lockfile.
    if (created) {
      const synced = await sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], REPO)
      if (synced.code !== 0)
        throw new Error(`pnpm install --frozen-lockfile failed:\n${synced.output.slice(-4000)}`)
    }
  } finally {
    release?.()
  }
}, 360_000)

describe('AC-5: a fresh scaffold runs on Redis after `nymbal add redis`', () => {
  it('AC-5: `nymbal add redis` exits 0', async () => {
    const added = await nymbal('add', 'redis')
    expect(added.code, added.output.slice(-4000)).toBe(0)
  }, 300_000)

  it('AC-5: config:validate reports document-store: redis and event-bus: redis-streams', async () => {
    const validated = await nymbal('config:validate')
    expect(validated.code, validated.output).toBe(0)
    expect(validated.output).toContain('document-store: redis')
    expect(validated.output).toContain('event-bus: redis-streams')
  }, 60_000)

  it('AC-5: migrate, seed and dev --api-only start, and every listed product is a document under the prefix', async () => {
    const migrated = await nymbal('migrate')
    expect(migrated.code, migrated.output.slice(-4000)).toBe(0)
    const seeded = await nymbal('seed')
    expect(seeded.code, seeded.output.slice(-4000)).toBe(0)

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    let out = ''
    // The project's own bin under plain node, so stopping it stops the server and not a pnpm wrapper around it.
    const bin = join(DIR, 'node_modules/nymbal/bin/nymbal.mjs')
    api = spawn(process.execPath, [bin, 'dev', '--api-only', '--port', String(port)], {
      cwd: DIR,
      env: storeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    api.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    api.stderr?.on('data', (b: Buffer) => (out += b.toString()))
    await vi.waitFor(
      async () => {
        if (api?.exitCode !== null) throw new Error(`the API exited:\n${out.slice(-4000)}`)
        const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
        expect(up.status, out.slice(-2000)).toBe(200)
      },
      { timeout: READY_WITHIN_MS, interval: 250 },
    )

    const call = apiClient()
    const listing = await call<{ items: ProductDoc[] }>('GET', '/api/products?limit=100')
    expect(listing.status).toBe(200)
    const slugs = listing.data.items.map((p) => p.slug)
    expect(slugs.length).toBeGreaterThan(0)
    const docs = await documentsUnderPrefix()
    expect(slugs.filter((s) => docs.has(s)).length, `listed slugs held under ${prefix}`).toBe(
      slugs.length,
    )
  }, 180_000)

  it('AC-5: cart and checkout over the API create a pending order whose document is under the prefix', async () => {
    expect(base, 'the API from the previous test').not.toBe('')
    const call = apiClient()
    const listing = await call<{ items: ProductDoc[] }>('GET', '/api/products?limit=100')
    const product = listing.data.items.find((p) => (p.variants?.[0]?.stock ?? 0) >= 1)
    expect(product, 'a seeded product with stock').toBeDefined()

    const added = await call('POST', '/api/cart/items', {
      variantId: product!.variants![0]!.id,
      qty: 1,
    })
    expect(added.status, JSON.stringify(added.data)).toBe(200)
    const checkout = await call<{ orderNumber: string; orderStatus: string; orderKey: string }>(
      'POST',
      '/api/checkout',
      {
        email: `add-redis-${randomBytes(4).toString('hex')}+stub-pending@nymbal.dev`,
        billingAddress: address,
        shippingAddress: address,
      },
    )
    expect(checkout.status, JSON.stringify(checkout.data)).toBe(200)
    expect(checkout.data.orderStatus).toBe('pending')

    // Projections are asynchronous: poll the read side until it settles, bounded.
    await vi.waitFor(
      async () => {
        const order = await call<{ status: string }>(
          'GET',
          `/api/orders/${checkout.data.orderNumber}`,
          undefined,
          { 'x-nymbal-order-key': checkout.data.orderKey },
        )
        expect(order.data?.status).toBe(checkout.data.orderStatus)
        const doc = (await documentsUnderPrefix()).get(checkout.data.orderNumber) ?? ''
        expect(doc, `order ${checkout.data.orderNumber} under ${prefix}`).toContain(
          `"status":"${checkout.data.orderStatus}"`,
        )
      },
      { timeout: 20_000, interval: 250 },
    )
  }, 60_000)

  it('AC-5: once the API stops, removing the prefix leaves no key under it', async () => {
    const before = (await keysUnder(redisUrl, prefix)).length
    expect(before, 'the run wrote under its prefix').toBeGreaterThan(0)
    await stopApi()
    const deleted = await deleteUnder(redisUrl, prefix)
    expect(deleted).toBeGreaterThanOrEqual(before)
    expect(await keysUnder(redisUrl, prefix)).toHaveLength(0)
  }, 60_000)
})

describe('AC-7: nymbal doctor and the dev summary on the scaffold after `nymbal add redis`', () => {
  const bin = () => join(DIR, 'node_modules/nymbal/bin/nymbal.mjs')
  let closed: { code: number; output: string; port: number } | null = null
  let dev: DevRun | null = null

  afterAll(async () => {
    await dev?.stop()
  })

  const names = (lines: DoctorLine[]) => lines.map((l) => l.name)

  it('AC-7, AC-5 (a): with REDIS_URL at a closed port, doctor exits 1 and `primitive document-store` is down naming redis and the host:port', async () => {
    const port = await closedPort()
    const run = await sh(process.execPath, [bin(), 'doctor'], DIR, {
      ...storeEnv(),
      REDIS_URL: `redis://127.0.0.1:${port}`,
    })
    closed = { ...run, port }
    const documentStore = doctorLines(run.output).find((l) => l.name === 'primitive document-store')

    expect(run.code, run.output.slice(-4000)).toBe(1)
    expect(documentStore?.status).toBe('down')
    expect(documentStore?.detail).toMatch(/redis/i)
    expect(documentStore?.detail).toContain(`127.0.0.1:${port}`)
  }, 120_000)

  it('AC-7, AC-5 (a): with the composed Redis, doctor exits 0 with no down line, and lists the same checks as the closed-port run', async () => {
    const run = await sh(process.execPath, [bin(), 'doctor'], DIR, storeEnv())
    const lines = doctorLines(run.output)

    expect(run.code, run.output.slice(-4000)).toBe(0)
    expect(lines.filter((l) => l.status === 'down')).toEqual([])
    expect(closed, 'the closed-port run above').not.toBeNull()
    expect(names(lines)).toEqual(names(doctorLines(closed!.output)))
    expect(lines.length).toBeGreaterThan(0)
  }, 120_000)

  it('AC-7: dev --api-only prints the summary naming the redis document store, and no DEBUG line up to 2 s after a GET /api/products', async () => {
    const env = storeEnv()
    delete env['LOG_LEVEL']
    dev = await startDev([], { cwd: DIR, env, bin: bin(), readyWithinMs: READY_WITHIN_MS })
    const res = await fetch(`${dev.base}/api/products`, { signal: AbortSignal.timeout(10_000) })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 2000))
    const out = dev.output()

    expect(
      out.split('\n').filter((l) => DEBUG_LINE.test(l)),
      out.slice(-4000),
    ).toEqual([])
    expect(
      linesNaming(out, 'document-store', 'redis').length,
      out.slice(-4000),
    ).toBeGreaterThanOrEqual(1)
  }, 180_000)
})
