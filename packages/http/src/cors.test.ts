import { describe, it, expect, afterEach } from 'vitest'
import { FastifyHttpAdapter } from './fastify-adapter.js'

const logger = {
  trace() {}, debug() {}, info() {}, warn() {},
  error() {}, child() { return this },
}

let openAdapters: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const a of openAdapters) {
    await a.stop().catch(() => {})
  }
  openAdapters = []
})

async function startAdapter(cors: { allowedOrigins: string[]; credentials: boolean }): Promise<{ adapter: FastifyHttpAdapter; port: number }> {
  const a = new FastifyHttpAdapter({ logger, cors })
  a.registerRoute('GET', '/api/test', async () => ({ status: 200, body: { ok: true } }))
  await a.start(0)
  openAdapters.push(a)
  return { adapter: a, port: a.boundPort }
}

describe('FastifyHttpAdapter CORS', () => {
  it('sets Access-Control-Allow-Origin for a matching origin', async () => {
    const { port } = await startAdapter({ allowedOrigins: ['http://localhost:4321'], credentials: true })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4321')
  })

  it('sets Access-Control-Allow-Credentials: true when credentials is true', async () => {
    const { port } = await startAdapter({ allowedOrigins: ['http://localhost:4321'], credentials: true })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('does not set CORS headers for an origin not in the allowlist', async () => {
    const { port } = await startAdapter({ allowedOrigins: ['http://localhost:4321'], credentials: true })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('responds 204 to an OPTIONS preflight for an allowed origin', async () => {
    const { port } = await startAdapter({ allowedOrigins: ['http://localhost:3000'], credentials: true })
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

  it('does not add CORS headers when allowedOrigins is empty', async () => {
    const { port } = await startAdapter({ allowedOrigins: [], credentials: true })
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
      headers: { Origin: 'http://localhost:4321' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not add CORS headers when cors option is omitted', async () => {
    const a = new FastifyHttpAdapter({ logger })
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
})
