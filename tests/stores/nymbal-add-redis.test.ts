import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deleteUnder, keysUnder, redis, redisServerUrl } from '../support/redis'

// Acceptance test for P2-03 AC-5, the roadmap proof as scoped (spec P2-03-nymbal-add-recipe): a fresh Astro scaffold,
// made the scaffold-smoke way (in the checkout as smoke-astro, a workspace member, with --no-install, then
// `pnpm install`), runs on Redis after `nymbal add redis` alone. With REDIS_URL and a prefix of this run's own,
// `nymbal migrate`, `nymbal seed` and `nymbal dev --api-only` start; config:validate reports the Redis document store
// and Redis Streams bus; the seeded products and the order a cart and checkout over the API create are documents
// under the prefix; the prefix is removed afterwards. The order stays `pending`: its receipt email asks the native
// stub to hold the payment (`+stub-pending`, payments/native-stub.ts), and the payment hook is never called.
// The install `pnpm` runs here also rewrites the workspace lockfile; the test puts it back byte for byte.
// Needs `pnpm build` and Redis (NYMBAL_TEST_REDIS_URL). Kills: `nymbal add redis` leaving a project that does not run
// on Redis.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const NAME = 'smoke-astro'
const DIR = join(REPO, NAME)
const LOCKFILE = join(REPO, 'pnpm-lock.yaml')
const READY_WITHIN_MS = 60_000

const redisUrl = redisServerUrl()
const prefix = `p2-03-add-redis-${randomUUID().slice(0, 8)}`

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
  return async function call<T>(method: string, path: string, body?: unknown) {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
        ...(body !== undefined && { 'content-type': 'application/json' }),
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
}, 600_000)

afterAll(async () => {
  await stopApi()
  await deleteUnder(redisUrl, prefix)
  if (created) rmSync(DIR, { recursive: true, force: true })
  if (lockfile !== null && !readFileSync(LOCKFILE).equals(lockfile))
    writeFileSync(LOCKFILE, lockfile)
}, 60_000)

describe('P2-03 AC-5: a fresh scaffold runs on Redis after `nymbal add redis`', () => {
  it('AC-5: `nymbal add redis` exits 0', async () => {
    const added = await nymbal('add', 'redis')
    expect(added.code, added.output.slice(-4000)).toBe(0)
  }, 300_000)

  it('AC-5: config:validate reports documentStore: redis and eventBus: redis-streams', async () => {
    const validated = await nymbal('config:validate')
    expect(validated.code, validated.output).toBe(0)
    expect(validated.output).toContain('documentStore: redis')
    expect(validated.output).toContain('eventBus: redis-streams')
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
    const checkout = await call<{ orderNumber: string; orderStatus: string }>(
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
