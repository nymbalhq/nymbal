import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

// AC-6, AC-7 and AC-8 on the built artefact, run by scripts/scaffold-image.sh <astro|nextjs> (and the CI job
// scaffold-image) as the vitest project `scaffold-image`, after it has scaffolded a store from the local registry,
// set it on Postgres, the Redis document store and the Redis Streams bus, built its image with `nymbal build --image`,
// run `nymbal migrate` and `nymbal seed` in it, and started `nymbal start` in a container on PORT=8080 with
// NYMBAL_PUBLIC_URL at the host port it publishes. Left out of `pnpm test`: it throws without these.
//
//   NYMBAL_SCAFFOLD_DIR         the scaffolded project directory
//   NYMBAL_IMAGE                the image `nymbal build --image` built
//   NYMBAL_CONTAINER            the running container (started without --rm, so its exit code can be read)
//   NYMBAL_STORE_URL            the container's published port on the host, http://localhost:<port>
//   NYMBAL_IMAGE_DATABASE_URL   the container's Postgres database, as the host reaches it
//
// The last test stops the container.

const DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const IMAGE = process.env['NYMBAL_IMAGE']
const CONTAINER = process.env['NYMBAL_CONTAINER']
const STORE_URL = process.env['NYMBAL_STORE_URL']
const DATABASE_URL = process.env['NYMBAL_IMAGE_DATABASE_URL']
if (!DIR || !IMAGE || !CONTAINER || !STORE_URL || !DATABASE_URL) {
  throw new Error(
    'The image proof needs NYMBAL_SCAFFOLD_DIR, NYMBAL_IMAGE, NYMBAL_CONTAINER, NYMBAL_STORE_URL and ' +
      'NYMBAL_IMAGE_DATABASE_URL. Run it through scripts/scaffold-image.sh <astro|nextjs>, which scaffolds, builds ' +
      'the image, starts the container and sets them.',
  )
}
const SCAFFOLD: string = DIR
const STORE: string = STORE_URL
const SHUTDOWN_MS = Number(process.env['NYMBAL_SHUTDOWN_MS'] ?? 10_000)

const pg = createRequire(
  fileURLToPath(new URL('../../packages/platform/package.json', import.meta.url)),
)('pg') as {
  Client: new (opts: { connectionString: string }) => {
    connect(): Promise<void>
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
    end(): Promise<void>
  }
}

const address = {
  firstName: 'Image',
  lastName: 'Proof',
  addressLine1: '1 Container Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

interface ProductDoc {
  slug: string
  name: string
  variants?: Array<{ id: string; stock: number }>
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * The scaffold's .env values worth searching for: anything 12 characters or longer. The admin's email is left out: it
 * is an address, not a secret, and the scaffold's is the seed's own default, which the platform's code carries.
 */
function envValues(): string[] {
  const source = readFileSync(join(SCAFFOLD, '.env'), 'utf8')
  return source
    .split('\n')
    .filter((line) => !/^\s*NYMBAL_ADMIN_EMAIL\s*=/.test(line))
    .map((line) =>
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line)?.[1]?.replace(/^(['"])(.*)\1$/, '$2'),
    )
    .filter((v): v is string => v !== undefined && v.length >= 12)
}

/** Streams `docker export` of a container made from the image and reports which `needles` appear in it. */
async function exportedHolds(needles: string[]): Promise<string[]> {
  const cid = docker(['create', IMAGE!]).trim()
  try {
    const found = new Set<string>()
    const longest = Math.max(...needles.map((n) => Buffer.byteLength(n)))
    const wanted = needles.map((n) => Buffer.from(n))
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['export', cid], { stdio: ['ignore', 'pipe', 'inherit'] })
      let tail = Buffer.alloc(0)
      child.stdout.on('data', (chunk: Buffer) => {
        const window = Buffer.concat([tail, chunk])
        wanted.forEach((needle, i) => {
          if (window.includes(needle)) found.add(needles[i]!)
        })
        tail = window.subarray(Math.max(0, window.length - longest))
      })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`docker export exited ${code}`)),
      )
    })
    return [...found]
  } finally {
    docker(['rm', '-f', cid])
  }
}

/** Every path in the image's filesystem. */
function exportedPaths(): string[] {
  const cid = docker(['create', IMAGE!]).trim()
  try {
    return execFileSync('sh', ['-c', 'docker export "$1" | tar -t', 'sh', cid], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
      .split('\n')
      .filter((p) => p !== '')
  } finally {
    docker(['rm', '-f', cid])
  }
}

/** A cookie-carrying API client on the container's one port, with the double-submit CSRF token. */
function apiClient() {
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])
  return async function api<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(new URL(path, STORE), {
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
    return { status: res.status, data: (text ? (JSON.parse(text) as { data?: T }) : {}).data as T }
  }
}

async function products(): Promise<ProductDoc[]> {
  const res = await fetch(new URL('/api/products?limit=100', STORE))
  return ((await res.json()) as { data: { items: ProductDoc[] } }).data.items
}

describe('AC-7: the image', () => {
  it('AC-7: build --image left a Dockerfile and a .dockerignore in the scaffold that keeps .env*, *.db and node_modules out', () => {
    const ignore = existsSync(join(SCAFFOLD, '.dockerignore'))
      ? readFileSync(join(SCAFFOLD, '.dockerignore'), 'utf8')
          .split('\n')
          .map((l) => l.trim().replace(/^\//, ''))
          .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
      : []
    const kept = ['.env', '.env.local', '.env.production', 'nymbal.db', 'node_modules'].filter(
      (path) =>
        !ignore.some((pattern) => matchesGlob(path, pattern) || matchesGlob(path, `${pattern}/**`)),
    )

    expect(existsSync(join(SCAFFOLD, 'Dockerfile'))).toBe(true)
    expect(kept).toEqual([])
  })

  it('AC-7: the image runs as a non-root user, and PID 1 in the container is node node_modules/nymbal/bin/nymbal.mjs start', () => {
    const config = JSON.parse(docker(['image', 'inspect', '-f', '{{json .Config}}', IMAGE!])) as {
      User?: string
    }
    const uid = docker(['exec', CONTAINER!, 'id', '-u']).trim()
    const pid1 = docker(['exec', CONTAINER!, 'cat', '/proc/1/cmdline'])
      .split('\0')
      .filter((part) => part !== '')

    expect(['', 'root', '0', '0:0', 'root:root']).not.toContain(config.User ?? '')
    expect(uid).not.toBe('0')
    expect(pid1).toEqual(['node', 'node_modules/nymbal/bin/nymbal.mjs', 'start'])
  })

  it("AC-7: no layer's history, no image config and no file in the image holds a value from the scaffold's .env, and no .env file or *.db is in the app directory", async () => {
    const values = envValues()
    const key = /^\s*NYMBAL_SECRETS_KEY\s*=\s*(\S+)/m.exec(
      readFileSync(join(SCAFFOLD, '.env'), 'utf8'),
    )?.[1]
    const history = docker(['history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE!])
    const inspect = docker(['image', 'inspect', IMAGE!])
    const workdir = (
      JSON.parse(
        docker(['image', 'inspect', '-f', '{{json .Config.WorkingDir}}', IMAGE!]),
      ) as string
    )
      .replace(/^\//, '')
      .replace(/\/?$/, '/')
    const appFiles = exportedPaths().filter((p) => p.startsWith(workdir))
    const inFiles = await exportedHolds(values)

    expect(values).toContain(key)
    expect(values.filter((v) => history.includes(v) || inspect.includes(v))).toEqual([])
    expect(inFiles).toEqual([])
    expect(appFiles.filter((p) => /(^|\/)\.env[^/]*$/.test(p) || /\.db$/.test(p))).toEqual([])
    expect(appFiles.filter((p) => p.endsWith('node_modules/nymbal/bin/nymbal.mjs')).length).toBe(1)
  }, 600_000)
})

describe('AC-8: a checkout through the container', () => {
  it("AC-8: on PORT=8080 behind the container's one port, a shopper adds a product and checks out: one order row in Postgres, stock down by the quantity, the cart empty, and the order page rendered in the container shows the order number", async () => {
    const api = apiClient()
    const qty = 2
    const listing = await products()
    const product = listing.find((p) => (p.variants?.[0]?.stock ?? 0) >= qty)!
    const variantId = product.variants![0]!.id
    const stockOf = async (): Promise<number> =>
      (await api<ProductDoc>('GET', `/api/products/${product.slug}`)).data.variants!.find(
        (v) => v.id === variantId,
      )!.stock
    const before = await stockOf()

    const added = await api('POST', '/api/cart/items', { variantId, qty })
    const cartBefore = await api<{ items: unknown[] }>('GET', '/api/cart')
    const checkout = await api<{ orderNumber: string; orderKey: string }>('POST', '/api/checkout', {
      email: `image-${randomBytes(4).toString('hex')}@nymbal.dev`,
      billingAddress: address,
      shippingAddress: address,
    })
    await vi.waitFor(
      async () => {
        expect(await stockOf()).toBe(before - qty)
      },
      { timeout: 15_000, interval: 250 },
    )
    const cartAfter = await api<{ items: unknown[] }>('GET', '/api/cart')
    const client = new pg.Client({ connectionString: DATABASE_URL! })
    await client.connect()
    const rows = await client
      .query('SELECT count(*)::int AS n FROM orders WHERE order_number = $1', [
        checkout.data.orderNumber,
      ])
      .finally(() => client.end())
    const page = await fetch(
      new URL(
        `/order/${checkout.data.orderNumber}?key=${encodeURIComponent(checkout.data.orderKey)}`,
        STORE,
      ),
    )
    const html = await page.text()

    expect(added.status).toBe(200)
    expect(cartBefore.data.items.length).toBe(1)
    expect(checkout.status, JSON.stringify(checkout.data)).toBe(200)
    expect(rows.rows[0]!['n']).toBe(1)
    expect(cartAfter.data?.items?.length ?? 0).toBe(cartBefore.data.items.length - 1)
    expect(page.status, html.slice(0, 500)).toBe(200)
    expect(html).toContain(checkout.data.orderNumber)
  }, 60_000)

  it('AC-6: no script the image serves on the home and product pages names localhost:3001', async () => {
    const listing = await products()
    const pages = await Promise.all(
      ['/', `/product/${listing[0]!.slug}`].map(async (path) =>
        (await fetch(new URL(path, STORE))).text(),
      ),
    )
    const srcs = [
      ...new Set(
        pages.flatMap((html) => [
          ...[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!),
          ...[...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)].map(
            (m) => m[1]!,
          ),
          ...[...html.matchAll(/\b(?:component|renderer)-url="([^"]+)"/g)].map((m) => m[1]!),
        ]),
      ),
    ]
    const scripts = await Promise.all(
      srcs.map(async (src) => (await fetch(new URL(src, STORE))).text()),
    )

    expect(srcs.length, 'the pages load scripts').toBeGreaterThan(0)
    expect([...pages, ...scripts].filter((text) => text.includes('localhost:3001'))).toEqual([])
  })
})

interface Render {
  startedAt: number
  endedAt: number
  status?: number
  complete: boolean
  whole: boolean
  error?: string
}

/** GET `path` on a connection of its own, recorded: when it started, its status, and whether its body ended whole. */
function render(path: string): Promise<Render> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const req = request(new URL(path, STORE), { agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('close', () =>
        resolve({
          startedAt,
          endedAt: Date.now(),
          status: res.statusCode ?? 0,
          complete: res.complete,
          // Astro emits a page's own <script> after </html>, so the document's end is in the body, not at its end.
          whole: res.complete && /<\/html>/i.test(body),
        }),
      )
    })
    req.on('error', (error) =>
      resolve({
        startedAt,
        endedAt: Date.now(),
        complete: false,
        whole: false,
        error: error.message,
      }),
    )
    req.end()
  })
}

describe('AC-8: the container stops cleanly', () => {
  it('AC-8: docker stop -t 15 while product pages render: every render started before the stop completes 200 and whole, none is cut once begun, the container exits 0, and the stop takes less than NYMBAL_SHUTDOWN_MS', async () => {
    const slug = (await products())[0]!.slug
    const renders: Render[] = []
    let stopping = false
    const load = async () => {
      while (!stopping) renders.push(await render(`/product/${slug}`))
    }
    const loops = Array.from({ length: 4 }, load)
    await vi.waitFor(
      () => expect(renders.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(8),
      {
        timeout: 30_000,
        interval: 50,
      },
    )

    const stopAt = Date.now()
    await promisify(execFile)('docker', ['stop', '-t', '15', CONTAINER!])
    const stopTook = Date.now() - stopAt
    stopping = true
    await Promise.all(loops)
    const exitCode = Number(docker(['inspect', '-f', '{{.State.ExitCode}}', CONTAINER!]).trim())
    const beforeStop = renders.filter((r) => r.startedAt < stopAt)
    const inFlightAtStop = beforeStop.filter((r) => r.endedAt > stopAt)

    expect(inFlightAtStop.length, 'renders in flight when docker stop was sent').toBeGreaterThan(0)
    expect(beforeStop.filter((r) => r.status !== 200 || !r.whole)).toEqual([])
    expect(renders.filter((r) => r.status !== undefined && !r.complete)).toEqual([])
    expect(exitCode).toBe(0)
    expect(stopTook).toBeLessThan(SHUTDOWN_MS)
  }, 120_000)
})
