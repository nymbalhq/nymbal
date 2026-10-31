import { createServer } from 'node:net'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { createHttpServer } from '../../../http/src/index.js'
import { ok } from '../../src/routes/envelope.js'
import { createKernel } from '../support/kernel.js'

// Behind the platform's proxy every connection comes from the proxy, so the per-IP rate limits must key on the
// address the trusted hops report. `http.trustProxy: n` trusts the last n hops of X-Forwarded-For; `true` trusts every
// hop, so a client's own left-most entry wins. NYMBAL_TRUST_PROXY_HOPS fills it at run time when the config leaves the
// default. Every request here reaches the server from 127.0.0.1, the stand-in for the proxy.

const HOST = '127.0.0.1'
const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'
/** /api/checkout's limit on these servers: small, so a bucket empties in a few requests. */
const LIMIT = 3

/** A fresh client address per call, from 198.18.0.0/15 (benchmarking), which no generated spoof uses. */
let clients = 0
function nextClient(): string {
  clients += 1
  return `198.18.${Math.floor(clients / 250)}.${(clients % 250) + 1}`
}
const spoofArb = fc.ipV4().filter((a) => !a.startsWith('198.18.') && !a.startsWith('198.19.'))

/**
 * The kernel config with /api/checkout limited to LIMIT a minute and `http.trustProxy` as given (absent: the
 * default), validated by the schema as a store's config is.
 */
function hops(trustProxy?: unknown): (c: NymbalConfig) => NymbalConfig {
  return (c) => {
    const { trustProxy: _default, ...http } = c.http
    return nymbalConfigSchema.parse({
      ...c,
      security: {
        ...c.security,
        rateLimit: {
          ...c.security.rateLimit,
          '/api/checkout': { requests: LIMIT, window: '1m', action: 'block' },
        },
      },
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

interface Served {
  /** The client IP the server's request context holds for a request with this X-Forwarded-For. */
  ipOf(forwardedFor: string): Promise<string>
  /** The status of a POST /api/checkout with this X-Forwarded-For. */
  checkout(forwardedFor: string): Promise<number>
}

const open: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of open.splice(0)) await stop()
})

/**
 * A kernel served over HTTP with `configure`, NYMBAL_TRUST_PROXY_HOPS set to `variable` (or unset) while the server
 * is created and started, and one more route that answers the request context's client IP.
 */
async function serve(
  configure: (c: NymbalConfig) => NymbalConfig,
  variable?: string,
): Promise<Served> {
  const kernel = await createKernel({ dialect: 'sqlite', configure })
  const port = await freePort()
  const saved = process.env[VARIABLE]
  if (variable === undefined) delete process.env[VARIABLE]
  else process.env[VARIABLE] = variable
  try {
    const http = createHttpServer({
      config: { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } },
      logger: kernel.logger,
      documentStore: kernel.documentStore,
      version: '0.0.0',
    })
    http.registerRoute('GET', '/test/client-ip', async (ctx) => ok({ ip: ctx.ip }))
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
    if (saved === undefined) delete process.env[VARIABLE]
    else process.env[VARIABLE] = saved
  }
  const base = `http://${HOST}:${port}`
  return {
    async ipOf(forwardedFor) {
      const res = await fetch(`${base}/test/client-ip`, {
        headers: { 'x-forwarded-for': forwardedFor },
      })
      return ((await res.json()) as { data: { ip: string } }).data.ip
    },
    async checkout(forwardedFor) {
      const res = await fetch(`${base}/api/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
        body: '{}',
      })
      await res.arrayBuffer()
      return res.status
    },
  }
}

/** Shopper A spends LIMIT + 1 checkouts, then shopper B tries one: every status, in order. */
async function exhaustThenOther(s: Served): Promise<{ a: number[]; b: number }> {
  const [a, b] = [nextClient(), nextClient()]
  const statuses: number[] = []
  for (let i = 0; i <= LIMIT; i += 1) statuses.push(await s.checkout(a))
  return { a: statuses, b: await s.checkout(b) }
}

describe('AC-7: two shoppers behind one proxy hop', () => {
  it('AC-7: with trustProxy 1, shopper A exhausting /api/checkout’s limit through the proxy leaves shopper B allowed; with the default they share the proxy’s bucket', async () => {
    const oneHop = await exhaustThenOther(await serve(hops(1)))
    const byDefault = await exhaustThenOther(await serve(hops()))

    expect(oneHop.a.slice(0, LIMIT)).not.toContain(429)
    expect(oneHop.a[LIMIT]).toBe(429)
    expect(oneHop.b).toBe(oneHop.a[0])
    expect(byDefault.a[LIMIT]).toBe(429)
    expect(byDefault.b).toBe(byDefault.a[LIMIT])
  })
})

describe('AC-8: a spoofed X-Forwarded-For does not change the key', () => {
  it('AC-8: with trustProxy 1, for any addresses a client prepends before the proxy’s entry, the client IP is the real client and the checkout bucket is the one it has with no spoof; with true the left-most entry wins instead', async () => {
    const oneHop = await serve(hops(1))
    const everyHop = await serve(hops(true))

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(spoofArb, { minLength: 1, maxLength: 4 }), {
          minLength: LIMIT,
          maxLength: LIMIT,
        }),
        async (spoofs) => {
          const real = nextClient()
          const header = (list: string[]) => [...list, real].join(', ')
          const plain = await oneHop.ipOf(real)
          const spoofed = await Promise.all(spoofs.map((list) => oneHop.ipOf(header(list))))
          const leftMost = await everyHop.ipOf(header(spoofs[0]!))
          const statuses: number[] = []
          for (const list of spoofs) statuses.push(await oneHop.checkout(header(list)))
          const unspoofed = await oneHop.checkout(real)

          expect(plain).toBe(real)
          expect(spoofed).toEqual(spoofs.map(() => plain))
          expect(statuses).not.toContain(429)
          expect(unspoofed).toBe(429)
          expect(leftMost).toBe(spoofs[0]![0])
          expect(leftMost).not.toBe(plain)
        },
      ),
      { numRuns: 25 },
    )
  })
})

describe('AC-9: NYMBAL_TRUST_PROXY_HOPS', () => {
  it('AC-9: with the config at the default, or trustProxy false set explicitly, NYMBAL_TRUST_PROXY_HOPS=1 limits two shoppers behind one proxy apart', async () => {
    const results = [
      await exhaustThenOther(await serve(hops(), '1')),
      await exhaustThenOther(await serve(hops(false), '1')),
    ]

    expect(results.map((r) => r.a[LIMIT])).toEqual([429, 429])
    expect(results.map((r) => r.b)).toEqual(results.map((r) => r.a[0]))
  })

  it('AC-9: a config trustProxy 2 wins over NYMBAL_TRUST_PROXY_HOPS=1, and an explicit 0 wins too, trusting no hop', async () => {
    const [proxied, client] = [nextClient(), nextClient()]
    const header = `${proxied}, ${client}`
    const noVariable = await serve(hops())
    const variableOnly = await serve(hops(), '1')
    const two = await serve(hops(2), '1')
    const zero = await serve(hops(0), '1')

    const proxyAddress = await noVariable.ipOf(header)
    expect(await variableOnly.ipOf(header)).toBe(client)
    expect(await two.ipOf(header)).toBe(proxied)
    expect(await zero.ipOf(header)).toBe(proxyAddress)
    expect(proxyAddress).not.toBe(client)
  })

  it('AC-9: a NYMBAL_TRUST_PROXY_HOPS that is not an integer ≥ 0 (1.5, -1, x) fails the boot with a ConfigError naming the variable', async () => {
    const values = ['1.5', '-1', 'x']
    const outcomes: unknown[] = []
    for (const value of values) {
      outcomes.push(
        await serve(hops(), value).then(
          () => null,
          (error: unknown) => error,
        ),
      )
    }

    expect(
      outcomes.map((e) => (e instanceof ConfigError ? e.message.includes(VARIABLE) : String(e))),
    ).toEqual(values.map(() => true))
  })
})
