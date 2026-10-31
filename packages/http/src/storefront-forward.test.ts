import { createHash } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { Socket } from 'node:net'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'
import { forwardToStorefront } from './storefront-forward.js'

// AC-11: the adapter forwards every path that is not the API's to the storefront on its internal port, unchanged in
// both directions, with the public origin in Host and X-Forwarded-*; a path under /api/ is never forwarded.
// AC-5, the forward's half of the drain: refuse() answers new page requests 503 while forwards in flight finish, and
// drained() says when none is left. The storefront is an upstream this file owns.

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
const security = securitySchema.parse({ adapter: 'middleware' })
const PUBLIC_URL = 'https://shop.example'

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** The bytes the upstream sends for /chunked?n=<n>: a pattern that depends on n, so a truncated or shifted body differs. */
function pattern(n: number): Buffer {
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + n) & 0xff
  return out
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

interface Upstream {
  port: number
  seen: Seen[]
  /** Lets the oldest held request answer. */
  release(): void
  /** Resolves when a held request has arrived. */
  arrived(): Promise<void>
  /** Stops listening and cuts every connection: the port then refuses. */
  stop(): Promise<void>
}

async function startUpstream(): Promise<Upstream> {
  const seen: Seen[] = []
  const held: Array<() => void> = []
  const arrivals: Array<() => void> = []
  let pendingArrivals = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream')
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      switch (url.pathname) {
        case '/cookies':
          res.setHeader('Set-Cookie', ['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
          res.end('cookies')
          return
        case '/missing':
          res.writeHead(404, { 'content-type': 'text/html' }).end('<p>upstream not found</p>')
          return
        case '/moved':
          res.writeHead(302, { location: '/elsewhere?from=moved' }).end()
          return
        case '/chunked': {
          const body = pattern(Number(url.searchParams.get('n')))
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          for (let at = 0; at < body.length; at += 16_384) res.write(body.subarray(at, at + 16_384))
          res.end()
          return
        }
        case '/echo':
          res
            .writeHead(200, { 'content-type': 'application/octet-stream' })
            .end(Buffer.concat(chunks))
          return
        case '/held':
          held.push(() => res.end('held-done'))
          if (arrivals.length > 0) arrivals.shift()!()
          else pendingArrivals += 1
          return
        case '/cut':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' })
          res.write('x'.repeat(100), () => res.socket?.destroy())
          return
        default:
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ path: url.pathname }))
      }
    })
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  cleanup.push(stop)
  return {
    port: (server.address() as { port: number }).port,
    seen,
    release: () => held.shift()?.(),
    arrived: () => {
      if (pendingArrivals > 0) {
        pendingArrivals -= 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => arrivals.push(resolve))
    },
    stop,
  }
}

async function serve(upstreamPort: number, publicUrl = PUBLIC_URL) {
  const adapter = new FastifyHttpAdapter({ logger, security })
  adapter.registerRoute('GET', '/api/ping', async () => ({ status: 200, body: { ok: true } }))
  const forward = forwardToStorefront(adapter, { port: upstreamPort, publicUrl })
  await adapter.start(0, '127.0.0.1')
  cleanup.push(() => adapter.stop())
  return { base: `http://127.0.0.1:${adapter.boundPort}`, forward }
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** One request on its own connection; rejects when the response is cut before its end. */
function call(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
        res.on('close', () => {
          if (!res.complete) reject(new Error('response cut'))
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('AC-11: the forward to the storefront is faithful', () => {
  it('AC-11: two Set-Cookie headers both arrive, a 404 stays a 404 with its body, and a 302 keeps its Location', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)

    const cookies = await call(`${base}/cookies`)
    const missing = await call(`${base}/missing`)
    const moved = await call(`${base}/moved`)

    expect(cookies.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
    expect(missing.status).toBe(404)
    expect(missing.body.toString()).toBe('<p>upstream not found</p>')
    expect(moved.status).toBe(302)
    expect(moved.headers['location']).toBe('/elsewhere?from=moved')
  })

  it('AC-11: a chunked body of any length arrives whole and unchanged', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2_000_000 }), async (n) => {
        const res = await call(`${base}/chunked?n=${n}`)
        expect(res.status).toBe(200)
        expect(res.body.length).toBe(n)
        expect(sha(res.body)).toBe(sha(pattern(n)))
      }),
      { numRuns: 8 },
    )
  })

  it('AC-11: a POST body round-trips byte for byte whatever its content type, so the forward never parses it', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 256 * 1024 }),
        fc.constantFrom(
          'application/octet-stream',
          'application/json',
          'application/x-www-form-urlencoded',
          'multipart/form-data; boundary=----nymbal',
          'text/plain;charset=UTF-8',
        ),
        async (bytes, contentType) => {
          const body = Buffer.from(bytes)
          const res = await call(`${base}/echo?q=1`, {
            method: 'POST',
            headers: { 'content-type': contentType, 'content-length': String(body.length) },
            body,
          })
          expect(res.status).toBe(200)
          expect(sha(res.body)).toBe(sha(body))
        },
      ),
      { numRuns: 25 },
    )
    expect(up.seen.filter((s) => s.method === 'POST').map((s) => s.url)).toEqual(
      up.seen.filter((s) => s.method === 'POST').map(() => '/echo?q=1'),
    )
  })

  for (const publicUrl of ['https://shop.example', 'http://shop.test:8080']) {
    it(`AC-11: with NYMBAL_PUBLIC_URL ${publicUrl} the upstream sees its host in Host and X-Forwarded-Host whatever Host the client sent, its scheme in X-Forwarded-Proto, and the client address appended to X-Forwarded-For`, async () => {
      const up = await startUpstream()
      const { base } = await serve(up.port, publicUrl)
      const origin = new URL(publicUrl)

      const res = await call(`${base}/headers?x=1`, {
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': origin.protocol === 'https:' ? 'http' : 'https',
          'x-forwarded-for': '203.0.113.9',
        },
      })
      const seen = up.seen.find((s) => s.url === '/headers?x=1')

      expect(res.status).toBe(200)
      expect(seen?.headers['host']).toBe(origin.host)
      expect(seen?.headers['x-forwarded-host']).toBe(origin.host)
      expect(seen?.headers['x-forwarded-proto']).toBe(origin.protocol.slice(0, -1))
      expect(
        String(seen?.headers['x-forwarded-for'])
          .split(',')
          .map((s) => s.trim()),
      ).toEqual(['203.0.113.9', '127.0.0.1'])
    })
  }

  it('AC-11: the upstream stopped gives 503', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    const before = await call(`${base}/page`)
    await up.stop()

    const after = await call(`${base}/page`)

    expect(before.status).toBe(200)
    expect(after.status).toBe(503)
  })

  it('AC-11: a forward that fails mid-response is cut, not retried', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)

    const outcome = await call(`${base}/cut`).then(
      (res) => `complete ${res.status} ${res.body.length}`,
      () => 'cut',
    )

    expect(outcome).toBe('cut')
    expect(up.seen.filter((s) => s.url === '/cut')).toHaveLength(1)
  })

  it('AC-11: any GET /api/<unknown> is the API JSON 404 and never reaches the upstream, while /api/ping is the API', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z0-9-]{1,12}(\/[a-z0-9-]{1,12}){0,2}$/).filter((p) => p !== 'ping'),
        async (path) => {
          const res = await call(`${base}/api/${path}`)
          expect(res.status).toBe(404)
          expect(res.headers['content-type']).toMatch(/^application\/json/)
        },
      ),
      { numRuns: 40 },
    )
    const ping = await call(`${base}/api/ping`)

    expect(JSON.parse(ping.body.toString())).toEqual({ ok: true })
    expect(up.seen.filter((s) => s.url.startsWith('/api'))).toEqual([])
  })
})

describe('AC-5: the forward drains', () => {
  it('AC-5: after refuse() a new page request answers 503 and never reaches the upstream, the API still answers, the forward in flight completes, and drained() resolves true only once it has', async () => {
    const up = await startUpstream()
    const { base, forward } = await serve(up.port)
    const idle = forward.inFlight()
    const held = call(`${base}/held`)
    await up.arrived()
    const during = forward.inFlight()

    forward.refuse()
    let drainedAt: number | undefined
    const drained = forward.drained(5000).then((value: boolean) => {
      drainedAt = Date.now()
      return value
    })
    const refused = await call(`${base}/after-refuse`)
    const api = await call(`${base}/api/ping`)
    const drainedBeforeRelease = drainedAt
    up.release()
    const render = await held
    const renderedAt = Date.now()

    expect(during).toBe(idle + 1)
    expect(refused.status).toBe(503)
    expect(up.seen.map((s) => s.url)).not.toContain('/after-refuse')
    expect(api.status).toBe(200)
    expect(drainedBeforeRelease).toBeUndefined()
    expect(render.status).toBe(200)
    expect(render.body.toString()).toBe('held-done')
    expect(await drained).toBe(true)
    expect(drainedAt!).toBeLessThanOrEqual(renderedAt + 1000)
    expect(forward.inFlight()).toBe(idle)
  })

  it('AC-5: drained(bound) resolves false while a forward is still held past the bound, and that forward still completes once released', async () => {
    const up = await startUpstream()
    const { base, forward } = await serve(up.port)
    const held = call(`${base}/held`)
    await up.arrived()
    forward.refuse()

    const started = Date.now()
    const drained = await forward.drained(300)
    const waited = Date.now() - started
    up.release()
    const render = await held

    expect(drained).toBe(false)
    expect(waited).toBeGreaterThanOrEqual(250)
    expect(render.status).toBe(200)
    expect(await forward.drained(1000)).toBe(true)
    expect(forward.inFlight()).toBe(0)
  })
})
