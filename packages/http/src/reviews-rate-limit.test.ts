import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema, type NymbalConfig } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// The adapter's guard bounds review submissions per IP with a built-in rule for `/api/reviews` (10 an hour, block),
// and the product page's review list is no part of it. The handlers here always answer, so a refusal can only be the
// limiter's.

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

const SUBMIT = '/api/reviews'
const open: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

/** A served adapter with the built-in rules, a submit route and a product's review list, counting what reaches each. */
async function reviewsServer(): Promise<{
  port: number
  reached: () => { submits: number; lists: number }
}> {
  // CSRF off isolates the limiter; the route's CSRF is proven over HTTP in the platform suite.
  const security: NymbalConfig['security'] = securitySchema.parse({
    adapter: 'middleware',
    csrf: false,
    rateLimit: {},
  })
  const adapter = new FastifyHttpAdapter({ logger, security })
  let submits = 0
  let lists = 0
  adapter.registerRoute('POST', SUBMIT, async () => {
    submits += 1
    return { status: 200, body: { data: { review: { id: `r${submits}` } } } }
  })
  adapter.registerRoute('GET', '/api/products/:id/reviews', async () => {
    lists += 1
    return { status: 200, body: { data: { items: [], nextCursor: null } } }
  })
  await adapter.start(0, '127.0.0.1')
  open.push(adapter)
  return { port: adapter.boundPort, reached: () => ({ submits, lists }) }
}

async function submit(port: number): Promise<{ status: number; retryAfter: number }> {
  const res = await fetch(`http://127.0.0.1:${port}${SUBMIT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:4321' },
    body: JSON.stringify({ productId: 'p1', rating: 5, title: 'Fine', body: 'Fine.' }),
  })
  await res.arrayBuffer()
  return { status: res.status, retryAfter: Number(res.headers.get('retry-after') ?? 0) }
}

async function list(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/products/p1/reviews`)
  await res.arrayBuffer()
  return res.status
}

describe('the review submission rate limit in the adapter guard', () => {
  // Kills: no built-in rule for /api/reviews, a rule on the wrong path, or one the review list also counts against.
  it('AC-7: from one IP, ten POST /api/reviews within the hour reach the handler and the eleventh answers 429 retrying within the hour; GET /api/products/:id/reviews between and after them is never counted or refused', async () => {
    const allowed = 10
    const server = await reviewsServer()
    const submits: Array<{ status: number; retryAfter: number }> = []
    const lists: number[] = []

    for (let i = 0; i < allowed; i += 1) {
      submits.push(await submit(server.port))
      lists.push(await list(server.port), await list(server.port))
    }
    const eleventh = await submit(server.port)
    for (let i = 0; i < 5; i += 1) lists.push(await list(server.port))

    expect(submits.map((a) => a.status)).toEqual(Array.from({ length: allowed }, () => 200))
    expect(eleventh.status).toBe(429)
    expect(eleventh.retryAfter).toBeGreaterThan(15 * 60)
    expect(eleventh.retryAfter).toBeLessThanOrEqual(60 * 60)
    expect(lists).toEqual(lists.map(() => 200))
    expect(server.reached()).toEqual({ submits: allowed, lists: lists.length })
  })
})
