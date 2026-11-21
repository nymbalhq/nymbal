import fc from 'fast-check'
import { describe, it, expect, afterEach } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

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

let openAdapters: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const a of openAdapters) {
    await a.stop().catch(() => {})
  }
  openAdapters = []
})

async function startAdapter(
  cors: {
    allowedOrigins: string[]
    kitOrigins?: string[]
    credentials: boolean
  },
  paths: string[] = [],
): Promise<{ adapter: FastifyHttpAdapter; port: number }> {
  const a = new FastifyHttpAdapter({ logger, cors, security })
  a.registerRoute('GET', '/api/test', async () => ({ status: 200, body: { ok: true } }))
  for (const path of paths) {
    a.registerRoute('GET', path, async () => ({ status: 200, body: { ok: true } }))
    a.registerRoute('POST', path, async () => ({ status: 200, body: { ok: true } }))
  }
  await a.start(0)
  openAdapters.push(a)
  return { adapter: a, port: a.boundPort }
}

describe('FastifyHttpAdapter CORS', () => {
  it('sets Access-Control-Allow-Origin for a matching origin', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:4321'],
      credentials: true,
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4321')
  })

  it('sets Access-Control-Allow-Credentials: true when credentials is true', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:4321'],
      credentials: true,
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('does not set CORS headers for an origin not in the allowlist', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:4321'],
      credentials: true,
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('responds 204 to an OPTIONS preflight for an allowed origin', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:3000'],
      credentials: true,
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(res.headers.get('access-control-allow-methods')).toBeTruthy()
  })

  it('AC-4: a preflight from an allowed origin asking for PATCH, PUT or DELETE answers 204 with that method allowed', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:4321'],
      credentials: true,
    })
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('PATCH', 'PUT', 'DELETE'), async (method) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:4321',
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': 'content-type',
          },
        })
        const allowed = (res.headers.get('access-control-allow-methods') ?? '')
          .split(',')
          .map((m) => m.trim().toUpperCase())

        expect(res.status).toBe(204)
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4321')
        expect(allowed).toContain(method)
        expect(allowed).toEqual(expect.arrayContaining(['PATCH', 'PUT', 'DELETE']))
      }),
      { numRuns: 9 },
    )
  })

  it('does not add CORS headers when allowedOrigins is empty', async () => {
    const { port } = await startAdapter({ allowedOrigins: [], credentials: true })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not add CORS headers when cors option is omitted', async () => {
    const a = new FastifyHttpAdapter({ logger, security })
    a.registerRoute('GET', '/api/test', async () => ({ status: 200, body: { ok: true } }))
    await a.start(0)
    openAdapters.push(a)
    const res = await fetch(`http://127.0.0.1:${a.boundPort}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows both localhost:3000 and localhost:4321 with default dev config', async () => {
    const { port } = await startAdapter({
      allowedOrigins: ['http://localhost:3000', 'http://localhost:4321'],
      credentials: true,
    })
    for (const origin of ['http://localhost:3000', 'http://localhost:4321']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, { headers: { Origin: origin } })
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    }
  })

  describe('kitOrigins', () => {
    const KIT = 'https://www.example.com'
    const STORE = 'https://shop.example.com'
    const OUTSIDER = 'https://evil.example.com'
    const KIT_PATHS = ['/api/cart', '/api/cart/items', '/api/capabilities', '/api/alerts/subscribe']
    const OTHER_PATHS = ['/api/auth/refresh', '/api/admin/orders', '/api/cartel', '/api/test']
    const CORS_HEADERS = [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-expose-headers',
      'access-control-allow-methods',
    ]

    async function store(credentials = true): Promise<number> {
      const { port } = await startAdapter(
        { allowedOrigins: [STORE], kitOrigins: [KIT], credentials },
        [...KIT_PATHS, ...OTHER_PATHS.filter((path) => path !== '/api/test')],
      )
      return port
    }

    const present = (res: Response): string[] => CORS_HEADERS.filter((h) => res.headers.has(h))

    const preflight = (port: number, path: string, origin: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      })

    it('a kit origin is answered, with credentials, on every kit route and its preflight; csrf and a query string included', async () => {
      const port = await store()
      for (const path of [...KIT_PATHS, '/api/csrf', '/api/cart?expand=items']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Origin: KIT } })
        expect(res.status, path).toBe(200)
        expect(res.headers.get('access-control-allow-origin'), path).toBe(KIT)
        expect(res.headers.get('access-control-allow-credentials'), path).toBe('true')

        const pre = await preflight(port, path, KIT)
        expect(pre.status, path).toBe(204)
        expect(pre.headers.get('access-control-allow-origin'), path).toBe(KIT)
        expect(pre.headers.get('access-control-allow-credentials'), path).toBe('true')
      }
    })

    it('a kit origin gets credentials on a kit route even where the store turned them off for its own origins', async () => {
      const port = await store(false)
      const kit = await fetch(`http://127.0.0.1:${port}/api/cart`, { headers: { Origin: KIT } })
      expect(kit.headers.get('access-control-allow-credentials')).toBe('true')
      const own = await fetch(`http://127.0.0.1:${port}/api/cart`, { headers: { Origin: STORE } })
      expect(own.headers.get('access-control-allow-origin')).toBe(STORE)
      expect(own.headers.get('access-control-allow-credentials')).toBeNull()
    })

    it('a kit origin gets no CORS header on any other route, the refresh route and an admin route among them, nor a preflight', async () => {
      const port = await store()
      for (const path of OTHER_PATHS) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Origin: KIT } })
        expect(res.status, path).toBe(200)
        expect(present(res), path).toEqual([])

        const pre = await preflight(port, path, KIT)
        expect(pre.status, path).toBe(404)
        expect(present(pre), path).toEqual([])
      }
    })

    it('an origin on allowedOrigins is answered on every route, as without kitOrigins; on both lists it stays the store’s', async () => {
      const port = await store()
      for (const path of [...KIT_PATHS, ...OTHER_PATHS]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Origin: STORE } })
        expect(res.headers.get('access-control-allow-origin'), path).toBe(STORE)
        expect(res.headers.get('access-control-allow-credentials'), path).toBe('true')
      }
      const { port: both } = await startAdapter(
        { allowedOrigins: [KIT], kitOrigins: [KIT], credentials: true },
        ['/api/auth/refresh'],
      )
      const res = await fetch(`http://127.0.0.1:${both}/api/auth/refresh`, {
        method: 'POST',
        headers: { Origin: KIT },
      })
      expect(res.headers.get('access-control-allow-origin')).toBe(KIT)
    })

    it('an origin on neither list gets no Allow-Origin on a kit route', async () => {
      const port = await store()
      const res = await fetch(`http://127.0.0.1:${port}/api/cart`, {
        headers: { Origin: OUTSIDER },
      })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('with allowedOrigins empty a kit origin still works on the cart, and any other origin gets no CORS header', async () => {
      const { port } = await startAdapter(
        { allowedOrigins: [], kitOrigins: [KIT], credentials: true },
        ['/api/cart'],
      )
      const kit = await fetch(`http://127.0.0.1:${port}/api/cart`, { headers: { Origin: KIT } })
      expect(kit.headers.get('access-control-allow-origin')).toBe(KIT)
      const other = await fetch(`http://127.0.0.1:${port}/api/cart`, {
        headers: { Origin: OUTSIDER },
      })
      expect(present(other)).toEqual([])
    })
  })
})
