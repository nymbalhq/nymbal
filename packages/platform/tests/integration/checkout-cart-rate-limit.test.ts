import { createServer } from 'node:net'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { createHttpServer } from '../../../http/src/index.js'
import { createKernel } from '../support/kernel.js'

// POST /api/checkout on a served kernel with the built-in rule (30 a minute): each cart from one address has its own
// 30, the address has ten times that, and cartless requests share one empty-cart bucket. A request the limiter refuses
// never reaches the route, which here always answers 400 (the empty body fails the route's input validation), so any
// other status is the limiter's.

const HOST = '127.0.0.1'
const REQUESTS = 30
const CEILING = 10 * REQUESTS
const CART_COOKIE = 'nymbal.cart'
const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'

/** The kernel config with the built-in checkout rule, CSRF off (the limiter alone), and `trustProxy` as given. */
function builtInCheckout(trustProxy: number | undefined): (c: NymbalConfig) => NymbalConfig {
  return (c) => {
    const rateLimit = { ...c.security.rateLimit }
    delete rateLimit['/api/checkout']
    const { trustProxy: _default, ...http } = c.http
    return nymbalConfigSchema.parse({
      ...c,
      security: { ...c.security, csrf: false, rateLimit },
      http: trustProxy === undefined ? http : { ...http, trustProxy },
    })
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

interface Answer {
  status: number
  code: string | undefined
  retryAfter: number
}

interface Served {
  /** POST /api/checkout with this cart cookie (none when undefined) and X-Forwarded-For. */
  checkout(cart: string | undefined, forwardedFor: string): Promise<Answer>
  /** The checkouts that have passed the limiter so far. */
  reached(): number
}

const open: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of open.splice(0)) await stop()
})

async function serve(trustProxy: number | undefined): Promise<Served> {
  const kernel = await createKernel({ dialect: 'sqlite', configure: builtInCheckout(trustProxy) })
  const port = await freePort()
  const saved = process.env[VARIABLE]
  delete process.env[VARIABLE]
  let reached = 0
  try {
    const http = createHttpServer({
      config: { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } },
      logger: kernel.logger,
      documentStore: kernel.documentStore,
      version: '0.0.0',
    })
    // Middlewares run after the limiter and before the handler: this one counts what the limiter let through.
    http.registerMiddleware((ctx) => {
      if (ctx.method === 'POST' && ctx.path === '/api/checkout') reached += 1
    })
    await kernel.app.attachHttp(http.adapter)
    await http.start()
    open.push(async () => {
      await http.stop()
      await kernel.close()
    })
  } catch (error) {
    await kernel.close()
    throw error
  } finally {
    if (saved !== undefined) process.env[VARIABLE] = saved
  }
  const base = `http://${HOST}:${port}`
  return {
    async checkout(cart, forwardedFor) {
      const res = await fetch(`${base}/api/checkout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor,
          ...(cart !== undefined && { cookie: `${CART_COOKIE}=${cart}` }),
        },
        body: '{}',
      })
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      return {
        status: res.status,
        code: body.error?.code,
        retryAfter: Number(res.headers.get('retry-after') ?? 0),
      }
    },
    reached: () => reached,
  }
}

let clients = 0
/** A fresh client address per call, from 198.18.0.0/15 (benchmarking). */
function nextClient(): string {
  clients += 1
  return `198.18.${Math.floor(clients / 250)}.${(clients % 250) + 1}`
}
let carts = 0
const nextCart = () => `cart-${(carts += 1)}-${'k'.repeat(24)}`

/**
 * Which of a sequence of checkouts from one address the limiter refuses: the address is counted first, and a request
 * past its ceiling opens no cart count; otherwise the cart's count decides.
 */
function refusedBy(sequence: Array<string | undefined>): boolean[] {
  let address = 0
  const perCart = new Map<string, number>()
  return sequence.map((cart) => {
    address += 1
    if (address > CEILING) return true
    const key = cart ?? ''
    const count = (perCart.get(key) ?? 0) + 1
    perCart.set(key, count)
    return count > REQUESTS
  })
}

describe('AC-3: checkout limits by cart behind one address', () => {
  it("AC-3: from one address, cart A's 31st checkout in a minute answers 429 with retry-after of at most 60 s and never reaches the handler; cart B's first then reaches it; cartless checkouts share one bucket and 429 on their own 31st", async () => {
    const s = await serve(1)
    const client = nextClient()
    const [a, b] = [nextCart(), nextCart()]

    const cartA: Answer[] = []
    for (let i = 0; i <= REQUESTS; i += 1) cartA.push(await s.checkout(a, client))
    const reachedAfterA = s.reached()
    const cartB = await s.checkout(b, client)
    const cartless: Answer[] = []
    for (let i = 0; i <= REQUESTS; i += 1) cartless.push(await s.checkout(undefined, client))

    expect(cartA.slice(0, REQUESTS).map((x) => x.status)).toEqual(
      Array.from({ length: REQUESTS }, () => 400),
    )
    expect(cartA[REQUESTS]).toMatchObject({ status: 429, code: 'rate_limit.block' })
    expect(cartA[REQUESTS]!.retryAfter).toBeGreaterThanOrEqual(1)
    expect(cartA[REQUESTS]!.retryAfter).toBeLessThanOrEqual(60)
    expect(reachedAfterA).toBe(REQUESTS)
    expect(cartB).toMatchObject({ status: 400, code: 'validation.failed' })
    expect(cartless.slice(0, REQUESTS).map((x) => x.code)).toEqual(
      Array.from({ length: REQUESTS }, () => 'validation.failed'),
    )
    expect(cartless[REQUESTS]!.status).toBe(429)
    expect(s.reached()).toBe(2 * REQUESTS + 1)
  })

  it('AC-3: over 2 to 12 carts checking out 31 times each, interleaved, from one address, exactly the checkouts past a cart’s 30 or past the address’s 300 are refused, and every other one reaches the handler', async () => {
    const s = await serve(1)
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async (cartCount) => {
        const client = nextClient()
        const cartIds = Array.from({ length: cartCount }, () => nextCart())
        const sequence: string[] = []
        for (let round = 0; round <= REQUESTS; round += 1) sequence.push(...cartIds)
        const reachedBefore = s.reached()

        const refused: boolean[] = []
        for (const cart of sequence) refused.push((await s.checkout(cart, client)).status === 429)
        const expected = refusedBy(sequence)

        expect(refused).toEqual(expected)
        expect(s.reached() - reachedBefore).toBe(expected.filter((r) => !r).length)
      }),
      { numRuns: 4, examples: [[2], [11], [12]] },
    )
  }, 120_000)

  it('AC-3: with trustProxy at its default, every checkout through one loopback peer with differing X-Forwarded-For, cart A’s 31st is refused and cart B’s first still reaches the handler', async () => {
    const s = await serve(undefined)
    const [a, b] = [nextCart(), nextCart()]

    const cartA: number[] = []
    for (let i = 0; i <= REQUESTS; i += 1) cartA.push((await s.checkout(a, nextClient())).status)
    const cartB = await s.checkout(b, nextClient())

    expect(cartA.slice(0, REQUESTS)).not.toContain(429)
    expect(cartA[REQUESTS]).toBe(429)
    expect(cartB.status).toBe(cartA[0])
    expect(s.reached()).toBe(REQUESTS + 1)
  })
})
