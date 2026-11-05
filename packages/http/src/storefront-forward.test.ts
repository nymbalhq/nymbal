import { createHash } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { Socket } from 'node:net'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

// AC-2: a client's `Connection` header names hop-by-hop headers for the next hop to drop. Dropping the forward's own
// Host and X-Forwarded-* after it sets them would hand the storefront the internal origin to build its URLs on.
const FORWARDED_HEADERS = [
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
] as const

/** What the storefront saw of the four headers the forward sets. */
function forwardedOf(seen: Seen | undefined): Record<string, string | undefined> {
  const h = seen?.headers ?? {}
  return Object.fromEntries(
    FORWARDED_HEADERS.map((name) => [name, h[name] === undefined ? undefined : String(h[name])]),
  )
}

describe('AC-2: a Connection header naming the forwarded headers does not strip them', () => {
  it('AC-2: for any non-empty subset of Host and X-Forwarded-* named in Connection, the storefront sees the public host, its scheme and the client address, as it does without the header', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    const origin = new URL(PUBLIC_URL)
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([...FORWARDED_HEADERS], { minLength: 1 }),
        async (listed) => {
          run += 1
          const plainUrl = `/page?run=${run}&connection=none`
          const listedUrl = `/page?run=${run}&connection=listed`
          const plain = await call(`${base}${plainUrl}`)
          const withList = await call(`${base}${listedUrl}`, {
            headers: { connection: listed.join(', ') },
          })
          const seenPlain = forwardedOf(up.seen.find((s) => s.url === plainUrl))
          const seenListed = forwardedOf(up.seen.find((s) => s.url === listedUrl))

          expect(plain.status).toBe(200)
          expect(withList.status).toBe(plain.status)
          expect(seenListed).toEqual(seenPlain)
          expect(seenListed['host']).toBe(origin.host)
          expect(seenListed['x-forwarded-host']).toBe(origin.host)
          expect(seenListed['x-forwarded-proto']).toBe(origin.protocol.slice(0, -1))
          expect(seenListed['x-forwarded-for']?.split(',').at(-1)?.trim()).toBe('127.0.0.1')
        },
      ),
      { numRuns: 15 },
    )
  })

  it('AC-2: `Connection: x-forwarded-host, x-forwarded-proto` still reaches the storefront with the public host and scheme', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    const origin = new URL(PUBLIC_URL)

    const res = await call(`${base}/product/linen-shirt`, {
      headers: { connection: 'x-forwarded-host, x-forwarded-proto' },
    })
    const seen = forwardedOf(up.seen.find((s) => s.url === '/product/linen-shirt'))

    expect(res.status).toBe(200)
    expect(seen['host']).toBe(origin.host)
    expect(seen['x-forwarded-host']).toBe(origin.host)
    expect(seen['x-forwarded-proto']).toBe(origin.protocol.slice(0, -1))
  })
})

// AC-3: a request line under /api/ whose percent-encoding does not decode is the API's to refuse; it must not fall
// through to the storefront's wildcard.
describe('AC-3: a malformed /api/ URL is refused by the API', () => {
  it('AC-3: /api/ targets with a bad percent-encoding answer 400 JSON FST_ERR_BAD_URL and never reach the storefront', async () => {
    const up = await startUpstream()
    const { base } = await serve(up.port)
    const malformed = fc.oneof(
      fc.constantFrom('/api/%E0%A4%A', '/api/%zz'),
      fc
        .tuple(
          fc.stringMatching(/^[a-z0-9-]{0,8}(\/[a-z0-9-]{1,8}){0,2}$/),
          fc.constantFrom('%zz', '%g1', '%E0%A4%A', '%C3', '%FF', '%E0%A4', '%'),
        )
        .map(([path, bad]) => `/api/${path}${bad}`),
    )
    await fc.assert(
      fc.asyncProperty(malformed, async (target) => {
        const res = await call(`${base}${target}`)

        expect(res.status).toBe(400)
        expect(res.headers['content-type']).toMatch(/^application\/json/)
        expect((JSON.parse(res.body.toString()) as { code?: string }).code).toBe('FST_ERR_BAD_URL')
      }),
      { numRuns: 30 },
    )

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

// AC-7: the forward tells the storefront who the shopper is in a form only this API can have made: the client address
// the API resolved (the peer, a listed proxy's X-Forwarded-For client, or a listed proxy's client-address header),
// attested under the adapter's own key. Whatever a client sends in that header is replaced. The clock is pinned so the
// adapter's own attestation of an address, made by the test, is the token the forward sent.
const SHOPPER_HEADER = 'x-nymbal-shopper'
const CLIENT = '203.0.113.9'
const EDGE_CLIENT = '198.51.100.44'

async function serveAttested(
  upstreamPort: number,
  network: { trustedProxies: string[]; clientIpHeader?: string },
) {
  const adapter = new FastifyHttpAdapter({ logger, security, ...network })
  adapter.registerRoute('GET', '/api/ip', async (ctx) => ({ status: 200, body: { ip: ctx.ip } }))
  forwardToStorefront(adapter, { port: upstreamPort, publicUrl: PUBLIC_URL })
  await adapter.start(0, '127.0.0.1')
  cleanup.push(() => adapter.stop())
  return { base: `http://127.0.0.1:${adapter.boundPort}`, adapter }
}

describe('AC-7: the forward attests the address the API resolved', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const cases = [
    { label: 'trustedProxies []', network: { trustedProxies: [] }, resolved: '127.0.0.1' },
    {
      label: "trustedProxies ['loopback']",
      network: { trustedProxies: ['loopback'] },
      resolved: CLIENT,
    },
    {
      label: 'clientIpHeader True-Client-IP from a listed peer',
      network: { trustedProxies: ['loopback'], clientIpHeader: 'True-Client-IP' },
      resolved: EDGE_CLIENT,
    },
  ] as const
  for (const [i, c] of cases.entries()) {
    it(`AC-7: with ${c.label} the storefront receives x-nymbal-shopper equal to the adapter's attestation of ${c.resolved}, the address the API's own context resolves, and of no other`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
      const up = await startUpstream()
      const { base, adapter } = await serveAttested(up.port, {
        ...c.network,
        trustedProxies: [...c.network.trustedProxies],
      })
      const headers = { 'x-forwarded-for': CLIENT, 'true-client-ip': EDGE_CLIENT }

      const res = await call(`${base}/attested?case=${i}`, { headers })
      const api = JSON.parse((await call(`${base}/api/ip`, { headers })).body.toString()) as {
        ip: string
      }
      const seen = up.seen.find((s) => s.url === `/attested?case=${i}`)
      const others = ['127.0.0.1', CLIENT, EDGE_CLIENT].filter((ip) => ip !== c.resolved)

      expect(res.status).toBe(200)
      expect(api.ip).toBe(c.resolved)
      // `<ip>~<expiresMs>~<mac>`: the address the token is for, before the adapter confirms it is its own.
      expect(String(seen?.headers[SHOPPER_HEADER]).split('~')[0]).toBe(api.ip)
      expect(seen?.headers[SHOPPER_HEADER]).toBe(adapter.attestShopper(api.ip))
      expect(
        others.map((ip) => seen?.headers[SHOPPER_HEADER] === adapter.attestShopper(ip)),
      ).toEqual(others.map(() => false))
    })
  }

  it("AC-7: an inbound x-nymbal-shopper on the page request, the adapter's own token for another address included, is replaced by the attestation of the client's address", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'))
    const up = await startUpstream()
    const { base, adapter } = await serveAttested(up.port, { trustedProxies: ['loopback'] })
    const forgedFor = '198.51.100.7'
    const inbound = [
      adapter.attestShopper(forgedFor),
      `${forgedFor}~${Date.now() + 60_000}~${'A'.repeat(43)}`,
      'not-a-token',
    ]

    const received: unknown[] = []
    for (const [i, value] of inbound.entries()) {
      const url = `/replaced?i=${i}`
      const res = await call(`${base}${url}`, {
        headers: { 'x-forwarded-for': CLIENT, [SHOPPER_HEADER]: value },
      })
      expect(res.status).toBe(200)
      received.push(up.seen.find((s) => s.url === url)?.headers[SHOPPER_HEADER])
    }

    expect(received).toEqual(inbound.map(() => adapter.attestShopper(CLIENT)))
  })
})
