import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anonymousGet, createPublicBucket, type TestBucket } from '../support/s3'
import { startWooCommerceServer, type WooCommerceServer } from '../support/woocommerce-server'

// AC-5: through the built CLI, a WooCommerce import into a store whose config sets only `media: { provider: 's3' }` serves every
// product image from the bucket. The bucket, endpoint and public URL reach the store through S3_BUCKET, S3_ENDPOINT
// and S3_PUBLIC_URL only, and the credentials through AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the SDK's chain), so
// every fallback is exercised. The public URL names the same MinIO under its other loopback name, so a URL built from
// the endpoint instead of S3_PUBLIC_URL shows. The source is tests/support/woocommerce-server.ts, which serves
// distinct bytes and a distinct content type for each image. The same run with the default local-fs keeps
// /imported-media/... URLs and files under public/imported-media.
// Needs `pnpm build` and MinIO (NYMBAL_TEST_S3_ENDPOINT).

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const CLI = join(REPO, 'packages/cli/bin/nymbal.mjs')
const MIGRATIONS = join(REPO, 'packages/platform/migrations')
const READY_WITHIN_MS = 30_000

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

let woo: WooCommerceServer
let bucket: TestBucket
const dirs: string[] = []
const children: ChildProcess[] = []

beforeAll(async () => {
  bucket = await createPublicBucket('cli')
  woo = await startWooCommerceServer({ imagesPerProduct: 2 })
})

afterAll(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      await gone
    }
  }
  await woo?.close()
  await bucket?.remove()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project with only `infrastructure` set beyond the required blocks; its migrations are the kernel's. */
function project(infrastructure: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 's3-cli-'))
  dirs.push(dir)
  const config = {
    store: { name: 's3-cli', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure,
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  symlinkSync(MIGRATIONS, join(dir, 'migrations'), 'dir')
  return dir
}

/** The parent's environment without any S3 or AWS variable, with the project's own SQLite file, plus `extra`. */
function envFor(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(S3_|AWS_|NYMBAL_S3_)/.test(k) && k !== 'npm_config_user_agent') env[k] = v
  }
  return { ...env, NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'), ...extra }
}

async function nymbal(dir: string, env: NodeJS.ProcessEnv, args: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: dir,
      env,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`,
    }
  }
}

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

/** `nymbal dev --api-only --no-seed` in `dir`, once GET /health answers; resolves with its base URL. */
async function startApi(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [CLI, 'dev', '--api-only', '--no-seed', '--port', String(port)],
    {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + READY_WITHIN_MS
  while (Date.now() < deadline && child.exitCode === null) {
    const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return base
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`nymbal dev --api-only did not answer on :${port}. Output:\n${out.slice(-3000)}`)
}

interface ListedProduct {
  slug: string
  media: Array<{ url: string; position: number }>
}

async function listProducts(base: string): Promise<ListedProduct[]> {
  const res = await fetch(`${base}/api/products?limit=100`)
  const body = (await res.json()) as { data: { items: ListedProduct[] } }
  expect(res.status, JSON.stringify(body)).toBe(200)
  return body.data.items
}

/** Each served product's listed media URLs, in position order. */
function mediaBySlug(listed: ListedProduct[]): Map<string, string[]> {
  return new Map(
    listed.map((p) => [
      p.slug,
      [...p.media].sort((a, b) => a.position - b.position).map((m) => m.url),
    ]),
  )
}

const IMPORT = (url: string) => [
  'import',
  '--source',
  'woocommerce',
  '--url',
  url,
  '--key',
  'k',
  '--secret',
  's',
  '--entities',
  'categories,products',
  '--no-ai',
]

/** The same server under its other loopback name: a URL built from the endpoint cannot pass for this one. */
function otherLoopback(endpoint: string): string {
  const u = new URL(endpoint)
  u.hostname = u.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  return u.origin
}

// Quarantined to the nightly project (vitest.config.ts): the built CLI against MinIO times out under a parallel
// gate:full, red then green with no code change. Gated here, not by a project exclude: one on integration-stores
// would replace the sentinels control run's --exclude list.
describe.runIf(process.env['NYMBAL_NIGHTLY'])(
  "AC-5: nymbal import into a store with media 's3' serves every image from the bucket",
  () => {
    it('AC-5: with the bucket, endpoint, public URL and credentials from the environment only, the import exits 0 and GET /api/products lists every image under the bucket URL, each serving exactly the bytes and content type its source served', async () => {
      const dir = project({
        commandStore: 'sqlite',
        documentStore: { provider: 'in-memory' },
        eventBus: { provider: 'in-process' },
        media: { provider: 's3' },
      })
      const publicUrl = `${otherLoopback(bucket.endpoint)}/${bucket.name}`
      const env = envFor(dir, {
        S3_BUCKET: bucket.name,
        S3_ENDPOINT: bucket.endpoint,
        S3_PUBLIC_URL: publicUrl,
        AWS_ACCESS_KEY_ID: bucket.credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: bucket.credentials.secretAccessKey,
      })

      const migrated = await nymbal(dir, env, ['migrate'])
      expect(migrated.code, migrated.output.slice(-3000)).toBe(0)
      const imported = await nymbal(dir, env, IMPORT(woo.url))
      expect(imported.code, imported.output.slice(-3000)).toBe(0)

      const media = mediaBySlug(await listProducts(await startApi(dir, env)))
      for (const product of woo.products) {
        const urls = media.get(product.slug)
        expect(urls, `${product.slug} is not listed`).toBeDefined()
        expect(urls!.length, product.slug).toBe(product.images.length)
        for (const [i, url] of urls!.entries()) {
          const source = product.images[i]!
          expect(url.startsWith(`${publicUrl}/`), `${url} is not under ${publicUrl}/`).toBe(true)
          const got = await anonymousGet(url)
          expect(got.status, url).toBe(200)
          expect(hex(got.bytes), `${url} vs ${source.src}`).toBe(hex(source.bytes))
          expect(got.contentType, url).toBe(source.contentType)
        }
      }
      expect((await bucket.keys()).length).toBe(woo.images.size)
    }, 180_000)

    it('AC-5: the same import with the default local-fs keeps /imported-media/... URLs, each a file under public/imported-media holding its source image’s bytes', async () => {
      const dir = project({
        commandStore: 'sqlite',
        documentStore: { provider: 'in-memory' },
        eventBus: { provider: 'in-process' },
      })
      const env = envFor(dir)

      const migrated = await nymbal(dir, env, ['migrate'])
      expect(migrated.code, migrated.output.slice(-3000)).toBe(0)
      const imported = await nymbal(dir, env, IMPORT(woo.url))
      expect(imported.code, imported.output.slice(-3000)).toBe(0)

      const media = mediaBySlug(await listProducts(await startApi(dir, env)))
      for (const product of woo.products) {
        const urls = media.get(product.slug) ?? []
        expect(urls.length, product.slug).toBe(product.images.length)
        for (const [i, url] of urls.entries()) {
          expect(url.startsWith('/imported-media/'), url).toBe(true)
          const file = readFileSync(join(dir, 'public', url))
          expect(hex(file), url).toBe(hex(product.images[i]!.bytes))
        }
      }
    }, 180_000)
  },
)
