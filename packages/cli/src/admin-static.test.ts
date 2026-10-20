import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { createHttpServer, type HttpServer } from '@nymbalhq/http'
import { registerAdminStaticRoute } from '@nymbalhq/platform'
import type { DocumentStoreAdapter } from '@nymbalhq/types'

// P1-08 AC-9, AC-10, AC-11: the admin's dist served at /admin/ by `registerAdminStaticRoute` on a real
// `createHttpServer` (the server `nymbal dev` builds), against a fixture dist. AC-9 kills: no route; an SPA fallback
// that swallows missing assets; a wrong MIME (module scripts refuse anything but a JavaScript type); binaries sent as
// base64 text. AC-10 kills: a naive `join(root, url)` that reads outside the root. AC-11 kills: a crash or a silent 200
// when no dist is installed.

const HOST = '127.0.0.1'
const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}

// The schema rejects port 0, so a free port is found by binding one and releasing it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

function config(port: number) {
  return nymbalConfigSchema.parse({
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      cloud: 'local',
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
      compute: 'in-process',
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port, host: HOST },
    deployment: { strategy: 'standard' },
  })
}

interface Served {
  base: string
  stop(): Promise<void>
}

/** A real HTTP server with the admin route over `root` and one `/api` probe route beside it. */
async function serve(root: string | null): Promise<Served> {
  const port = await freePort()
  const http: HttpServer = createHttpServer({
    config: config(port),
    logger,
    documentStore: {} as DocumentStoreAdapter,
    version: '0.0.0',
  })
  http.registerRoute('GET', '/api/probe', async () => ({
    status: 200,
    body: { data: { ok: true } },
  }))
  registerAdminStaticRoute(http.adapter, root)
  await http.start()
  return { base: `http://${HOST}:${port}`, stop: () => http.stop() }
}

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** A GET with the path sent as written: fetch would normalise `..` and `\` before they reach the server. */
function rawGet(base: string, path: string): Promise<Answer> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const header = (a: Answer, name: string): string => String(a.headers[name] ?? '')

// ─── the fixture dist, and a sentinel beside (outside) it ─────────────────────────────────────────────────────────

const SENTINEL = `sentinel-${randomBytes(12).toString('hex')}`
let scratch: string
let root: string
let files: Record<string, Buffer>

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'p1-08-admin-static-')))
  root = join(scratch, 'dist')
  files = {
    'index.html': Buffer.from(
      '<!doctype html><html><head><script type="module" src="/admin/assets/app.js"></script></head><body><div id="root"></div></body></html>',
    ),
    'assets/app.js': Buffer.from('export const app = "nymbal-admin"\n'),
    'assets/app.css': Buffer.from('body{margin:0}\n'),
    'assets/logo.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'assets/pixel.png': Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x01,
    ]),
    'assets/inter.woff2': Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xfe, 0xff, 0x00]),
    'favicon.ico': Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff, 0xfe]),
    'manifest.json': Buffer.from('{"name":"Nymbal admin"}'),
  }
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  writeFileSync(join(scratch, 'secret.txt'), SENTINEL)
  mkdirSync(join(scratch, 'dist-evil'), { recursive: true })
  writeFileSync(join(scratch, 'dist-evil', 'index.html'), SENTINEL)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// ─── AC-9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('P1-08 AC-9: the admin is served at /admin/', () => {
  let server: Served
  beforeAll(async () => {
    server = await serve(root)
  })
  afterAll(async () => {
    await server?.stop()
  })

  it('AC-9: /admin redirects (301/308) to /admin/', async () => {
    const answer = await rawGet(server.base, '/admin')
    expect([301, 308]).toContain(answer.status)
    expect(new URL(header(answer, 'location'), server.base).pathname).toBe('/admin/')
  })

  it('AC-9: /admin/ answers the index as text/html with no-cache', async () => {
    const answer = await rawGet(server.base, '/admin/')
    expect(answer.status).toBe(200)
    expect(header(answer, 'content-type')).toMatch(/^text\/html/)
    expect(header(answer, 'cache-control')).toMatch(/no-cache/)
    expect(answer.body.equals(files['index.html']!)).toBe(true)
  })

  it('AC-9: every file answers its bytes with its content type; assets/* are immutable', async () => {
    const types: Record<string, RegExp> = {
      'assets/app.js': /^text\/javascript/,
      'assets/app.css': /^text\/css/,
      'assets/logo.svg': /^image\/svg\+xml/,
      'assets/pixel.png': /^image\/png/,
      'assets/inter.woff2': /^font\/woff2/,
      'favicon.ico': /^image\/(x-icon|vnd\.microsoft\.icon)/,
      'manifest.json': /^application\/json/,
    }
    for (const [path, type] of Object.entries(types)) {
      const answer = await rawGet(server.base, `/admin/${path}`)
      expect(answer.status, path).toBe(200)
      expect(header(answer, 'content-type'), path).toMatch(type)
      expect(answer.body.equals(files[path]!), `${path}: body differs from the file's bytes`).toBe(
        true,
      )
    }
    for (const path of Object.keys(types).filter((p) => p.startsWith('assets/'))) {
      const answer = await rawGet(server.base, `/admin/${path}`)
      expect(header(answer, 'cache-control'), path).toMatch(/immutable/)
    }
  })

  it('AC-9: an SPA route (no extension, or a dotted segment outside the MIME table) answers index.html', async () => {
    for (const path of [
      '/admin/orders/NYM-1',
      '/admin/orders',
      '/admin/customers/avery.quinn@example.com',
    ]) {
      const answer = await rawGet(server.base, path)
      expect(answer.status, path).toBe(200)
      expect(header(answer, 'content-type'), path).toMatch(/^text\/html/)
      expect(answer.body.equals(files['index.html']!), path).toBe(true)
    }
  })

  it('AC-9: a missing path whose extension is in the MIME table is 404, not the index', async () => {
    for (const path of [
      '/admin/assets/missing.js',
      '/admin/assets/missing.css',
      '/admin/missing.png',
    ]) {
      const answer = await rawGet(server.base, path)
      expect(answer.status, path).toBe(404)
      expect(answer.body.equals(files['index.html']!), path).toBe(false)
    }
  })

  it('AC-9: every answer under /admin carries the security headers an /api answer carries', async () => {
    const api = await rawGet(server.base, '/api/probe')
    const csp = header(api, 'content-security-policy')
    expect(csp.length).toBeGreaterThan(0)
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/assets/app.js',
      '/admin/orders/NYM-1',
      '/admin/assets/missing.js',
    ]) {
      const answer = await rawGet(server.base, path)
      expect(header(answer, 'content-security-policy'), path).toBe(csp)
      expect(header(answer, 'x-content-type-options'), path).toBe(
        header(api, 'x-content-type-options'),
      )
    }
  })
})

// ─── AC-10 ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('P1-08 AC-10: no path escapes the admin root', () => {
  let server: Served
  beforeAll(async () => {
    server = await serve(root)
  })
  afterAll(async () => {
    await server?.stop()
  })

  /** What a request path got: a 5xx, or the sentinel's content (read from outside the root). */
  const probe = async (path: string) => {
    const answer = await rawGet(server.base, path)
    return {
      path,
      serverError: answer.status >= 500,
      readSentinel: answer.body.toString('latin1').includes(SENTINEL),
    }
  }
  const contained = (path: string) => ({ path, serverError: false, readSentinel: false })

  it('AC-10: the known escapes (dot segments, encoded slashes and backslashes, NUL, doubled slashes, absolute paths) never read the sentinel and never 5xx', async () => {
    const abs = join(scratch, 'secret.txt')
    const known = [
      '/admin/../secret.txt',
      '/admin/%2e%2e/secret.txt',
      '/admin/%2E%2E/secret.txt',
      '/admin/..%2fsecret.txt',
      '/admin/%2e%2e%2fsecret.txt',
      '/admin/assets/..%2f..%2fsecret.txt',
      '/admin/..\\secret.txt',
      '/admin/..%5csecret.txt',
      '/admin/%00/../secret.txt',
      '/admin/..%00/secret.txt',
      '/admin//../secret.txt',
      `/admin/${abs}`,
      `/admin//${abs}`,
      `/admin/${encodeURIComponent(abs)}`,
      '/admin/../dist-evil/index.html',
      '/admin/..%2fdist-evil/',
      '/admin/%2e%2e%2fdist-evil%2findex.html',
    ]
    const answers = []
    for (const path of known) answers.push(await probe(path))
    expect(answers).toEqual(known.map(contained))
  })

  it('AC-10: request paths built from .., %2e%2e, %2f, %5c, \\, %00, doubled slashes and absolute paths never read the sentinel and never 5xx (property)', async () => {
    const segment = fc.constantFrom(
      '..',
      '%2e%2e',
      '%2E%2e',
      '.%2e',
      '%2f',
      '%5c',
      '\\',
      '%00',
      '',
      '/',
      'assets',
      '..%2f',
      '..%5c',
      '..\\',
      scratch.slice(1),
      'dist-evil',
    )
    const target = fc.constantFrom(
      'secret.txt',
      'dist-evil/index.html',
      'dist-evil%2findex.html',
      'dist-evil/',
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(segment, { minLength: 1, maxLength: 6 }),
        target,
        async (segments, last) => {
          const path = `/admin/${[...segments, last].join('/')}`
          expect(await probe(path)).toEqual(contained(path))
        },
      ),
      { numRuns: 300 },
    )
  })
})

// ─── AC-11 ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('P1-08 AC-11: no dist installed', () => {
  let server: Served
  beforeAll(async () => {
    server = await serve(null)
  })
  afterAll(async () => {
    await server?.stop()
  })

  it('AC-11: /admin/ and an SPA route answer 404 naming the build command; /api routes are unaffected', async () => {
    for (const path of ['/admin/', '/admin/orders']) {
      const answer = await rawGet(server.base, path)
      expect(answer.status, path).toBe(404)
      expect(answer.body.toString('utf8'), path).toMatch(
        /@nymbalhq\/admin[\s\S]*\bbuild\b|\bbuild\b[\s\S]*@nymbalhq\/admin/,
      )
    }
    const api = await rawGet(server.base, '/api/probe')
    expect(api.status).toBe(200)
    expect(JSON.parse(api.body.toString('utf8'))).toEqual({ data: { ok: true } })
  })
})
