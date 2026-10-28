import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema, type NymbalConfig } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// The adapter's guard bounds back-in-stock subscriptions per IP: a built-in rule for `/api/alerts/subscribe` (10 an
// hour, block) under the user's `security.rateLimit`, which a configured rule for the same path replaces. Every
// request counts; the handler here always accepts, so a refusal can only be the limiter's.

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

const PATH = '/api/alerts/subscribe'
const open: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

type Rules = Record<string, { requests: number; window: string; action: 'block' }>

/** A served adapter whose subscribe handler always answers 202, counting the requests that reach it. */
async function subscribeServer(rateLimit: Rules): Promise<{ port: number; reached: () => number }> {
  // CSRF off isolates the limiter; subscribe's CSRF is proven over HTTP in the platform suite.
  const security: NymbalConfig['security'] = securitySchema.parse({
    adapter: 'middleware',
    csrf: false,
    rateLimit,
  })
  const adapter = new FastifyHttpAdapter({ logger, security })
  let calls = 0
  adapter.registerRoute('POST', PATH, async () => {
    calls += 1
    return { status: 202, body: { data: { status: 'pending' } } }
  })
  await adapter.start(0, '127.0.0.1')
  open.push(adapter)
  return { port: adapter.boundPort, reached: () => calls }
}

async function attempts(
  port: number,
  n: number,
): Promise<Array<{ status: number; retryAfter: number }>> {
  const out: Array<{ status: number; retryAfter: number }> = []
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4321' },
      body: JSON.stringify({ email: 'same@alerts.test', variantId: 'v1', kind: 'back_in_stock' }),
    })
    await res.arrayBuffer()
    out.push({ status: res.status, retryAfter: Number(res.headers.get('retry-after') ?? 0) })
  }
  return out
}

describe('the subscribe rate limit in the adapter guard', () => {
  it('AC-12: with the built-in rules, 10 subscribes from one IP reach the handler and the 11th answers 429, retrying after more than 15 minutes and at most an hour', async () => {
    const builtIn = 10
    const server = await subscribeServer({})
    const answers = await attempts(server.port, builtIn + 1)

    expect(answers.slice(0, builtIn).map((a) => a.status)).toEqual(
      Array.from({ length: builtIn }, () => 202),
    )
    expect(answers[builtIn]!.status).toBe(429)
    expect(answers[builtIn]!.retryAfter).toBeGreaterThan(15 * 60)
    expect(answers[builtIn]!.retryAfter).toBeLessThanOrEqual(60 * 60)
    expect(server.reached()).toBe(builtIn)
  })

  it('AC-12: a configured /api/alerts/subscribe rule of 15 per minute replaces the built-in one, and a config naming only other paths keeps it', async () => {
    const configured = 15
    const replaced = await subscribeServer({
      [PATH]: { requests: configured, window: '1m', action: 'block' },
    })
    const kept = await subscribeServer({
      '/api/products': { requests: 1000, window: '1m', action: 'block' },
    })

    const throughReplaced = await attempts(replaced.port, configured + 1)
    const throughKept = await attempts(kept.port, configured + 1)

    expect(throughReplaced.map((a) => a.status)).toEqual([
      ...Array.from({ length: configured }, () => 202),
      429,
    ])
    expect(throughReplaced[configured]!.retryAfter).toBeLessThanOrEqual(60)
    expect(replaced.reached()).toBe(configured)
    expect(throughKept.findIndex((a) => a.status === 429)).toBe(10)
    expect(kept.reached()).toBe(10)
  })
})
