import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema, type NymbalConfig } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// The adapter guard's built-in limits on the order routes, with no `security.rateLimit` configured: reads that carry
// the order's email (the second factor of an expired key) are bounded per IP, the key-only poll of a pending order
// never is; "send me my order link" mails, so it is bounded; every checkout can mint a key row, so it is bounded too.
// Each handler always answers, so a refusal can only be the limiter's.

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

const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'
const KEY = 'k'.repeat(43)

const open: FastifyHttpAdapter[] = []

afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

interface Served {
  port: number
  reached: () => number
}

/** A served adapter on the built-in rules whose handlers always answer, counting the requests that reach them. */
async function orderServer(): Promise<Served> {
  // CSRF off isolates the limiter; the CSRF half of the guard is proven over HTTP in the platform suite.
  const security: NymbalConfig['security'] = securitySchema.parse({
    adapter: 'middleware',
    csrf: false,
  })
  const adapter = new FastifyHttpAdapter({ logger, security })
  let calls = 0
  adapter.registerRoute('GET', '/api/orders/:orderNumber', async (ctx) => {
    calls += 1
    return { status: 200, body: { data: { orderNumber: ctx.params.orderNumber } } }
  })
  adapter.registerRoute('POST', '/api/orders/link', async () => {
    calls += 1
    return { status: 202, body: { data: { sent: 'if-matched' } } }
  })
  adapter.registerRoute('POST', '/api/checkout', async () => {
    calls += 1
    return { status: 200, body: { data: { orderNumber: 'NYM-1' } } }
  })
  await adapter.start(0, '127.0.0.1')
  open.push(adapter)
  return { port: adapter.boundPort, reached: () => calls }
}

interface Answer {
  status: number
  retryAfter: number
}

async function send(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      origin: 'http://localhost:4321',
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  await res.arrayBuffer()
  return { status: res.status, retryAfter: Number(res.headers.get('retry-after') ?? 0) }
}

async function times(n: number, one: (i: number) => Promise<Answer>): Promise<Answer[]> {
  const out: Answer[] = []
  for (let i = 0; i < n; i += 1) out.push(await one(i))
  return out
}

const statuses = (answers: Answer[]) => answers.map((a) => a.status)
/** The index of the first refusal, -1 for none. */
const firstRefused = (answers: Answer[]) => answers.findIndex((a) => a.status === 429)

describe('the order routes’ built-in rate limits in the adapter guard', () => {
  // Kills: no limit on the email factor, so it can be guessed; a limit on the path alone, which throttles the poll.
  it('AC-2: reads carrying x-nymbal-order-email answer 429 past 10 an hour from one IP, retrying after more than 15 minutes and at most an hour; 60 key-only reads before them all reach the handler and leave the email budget whole', async () => {
    const emailBudget = 10
    const polls = 60
    const server = await orderServer()

    const polled = await times(polls, () =>
      send(server.port, 'GET', '/api/orders/NYM-1001', { [ORDER_KEY_HEADER]: KEY }),
    )
    const withEmail = await times(emailBudget + 1, (i) =>
      send(server.port, 'GET', `/api/orders/NYM-${2000 + i}`, {
        [ORDER_KEY_HEADER]: KEY,
        [ORDER_EMAIL_HEADER]: `shopper-${i}@orders.test`,
      }),
    )
    const pollAfter = await send(server.port, 'GET', '/api/orders/NYM-1001', {
      [ORDER_KEY_HEADER]: KEY,
    })

    expect(statuses(polled), 'the key-only poll').toEqual(Array.from({ length: polls }, () => 200))
    expect(firstRefused(withEmail), 'the first 429 among reads carrying the email').toBe(
      emailBudget,
    )
    expect(statuses(withEmail), 'reads carrying the email').toEqual([
      ...Array.from({ length: emailBudget }, () => 200),
      429,
    ])
    expect(withEmail[emailBudget]!.retryAfter).toBeGreaterThan(15 * 60)
    expect(withEmail[emailBudget]!.retryAfter).toBeLessThanOrEqual(60 * 60)
    expect(pollAfter.status, 'the key-only poll once the email budget is spent').toBe(200)
    expect(server.reached()).toBe(polls + emailBudget + 1)
  })

  // Kills: a link route with no limit, so one IP can make the store mail any address without bound.
  it('AC-3: POST /api/orders/link answers 429 past 5 an hour from one IP, retrying after more than 15 minutes and at most an hour, and the refused request never reaches the handler', async () => {
    const budget = 5
    const server = await orderServer()
    const answers = await times(budget + 1, (i) =>
      send(
        server.port,
        'POST',
        '/api/orders/link',
        {},
        { orderNumber: `NYM-${3000 + i}`, email: `link-${i}@orders.test` },
      ),
    )

    expect(firstRefused(answers), 'the first 429').toBe(budget)
    expect(statuses(answers)).toEqual([...Array.from({ length: budget }, () => 202), 429])
    expect(answers[budget]!.retryAfter).toBeGreaterThan(15 * 60)
    expect(answers[budget]!.retryAfter).toBeLessThanOrEqual(60 * 60)
    expect(server.reached()).toBe(budget)
  })

  // Kills: a checkout route with no limit, so a loop of checkouts mints key rows without bound.
  it('AC-5: POST /api/checkout answers 429 past 30 a minute from one IP, retrying after at most a minute, and the refused request never reaches the handler', async () => {
    const budget = 30
    const server = await orderServer()
    const answers = await times(budget + 1, () =>
      send(server.port, 'POST', '/api/checkout', {}, { email: 'loop@orders.test' }),
    )

    expect(firstRefused(answers), 'the first 429').toBe(budget)
    expect(statuses(answers)).toEqual([...Array.from({ length: budget }, () => 200), 429])
    expect(answers[budget]!.retryAfter).toBeGreaterThan(0)
    expect(answers[budget]!.retryAfter).toBeLessThanOrEqual(60)
    expect(server.reached()).toBe(budget)
  })
})
