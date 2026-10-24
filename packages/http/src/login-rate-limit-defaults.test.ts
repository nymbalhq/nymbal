import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema, type NymbalConfig } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// AC-7: the adapter's guard merges the built-in login rule (10 per 15m, block) under the user's `security.rateLimit`,
// and a user rule for the same pattern replaces it. Failures count; the handler here always answers 401, so every
// request is a failure.

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

const open: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

/** A served adapter whose login handler always refuses, counting the requests that reach it. */
async function loginServer(
  rateLimit: Record<string, { requests: number; window: string; action: 'block' }>,
): Promise<{ port: number; reached: () => number }> {
  // CSRF off isolates the limiter; the CSRF half of the guard is proven over HTTP in the platform suite.
  const security: NymbalConfig['security'] = securitySchema.parse({
    adapter: 'middleware',
    csrf: false,
    rateLimit,
  })
  const adapter = new FastifyHttpAdapter({ logger, security })
  let calls = 0
  adapter.registerRoute('POST', '/api/auth/login', async () => {
    calls += 1
    return { status: 401, body: { error: { code: 'auth.invalid_credentials', message: 'no' } } }
  })
  await adapter.start(0, '127.0.0.1')
  open.push(adapter)
  return { port: adapter.boundPort, reached: () => calls }
}

async function attempts(port: number, n: number): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'same@security.test', password: 'wrong' }),
    })
    await res.arrayBuffer()
    statuses.push(res.status)
  }
  return statuses
}

describe('login rate-limit defaults in the adapter guard', () => {
  it("AC-7: a configured '/api/auth/login' rule of 2 per 15m gives 429 on the 3rd attempt, and the handler runs exactly twice", async () => {
    const rule = { requests: 2, window: '15m', action: 'block' as const }
    const server = await loginServer({ '/api/auth/login': rule })
    const statuses = await attempts(server.port, rule.requests + 1)
    expect(statuses.slice(0, rule.requests)).toEqual([401, 401])
    expect(statuses[rule.requests]).toBe(429)
    expect(server.reached()).toBe(rule.requests)
  })

  it('AC-7: a config with rules for other paths but none for /api/auth/login gets the built-in 10 per 15m: 429 on the 11th attempt', async () => {
    const builtIn = 10
    const server = await loginServer({
      '/api/products': { requests: 1000, window: '1m', action: 'block' },
    })
    const statuses = await attempts(server.port, builtIn + 1)
    expect(statuses.slice(0, builtIn)).toEqual(Array.from({ length: builtIn }, () => 401))
    expect(statuses[builtIn]).toBe(429)
    expect(server.reached()).toBe(builtIn)
  })
})
