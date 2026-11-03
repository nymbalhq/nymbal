import { createServer } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { createHttpServer, type FastifyHttpAdapter } from '../../../http/src/index.js'
import { createKernel } from '../support/kernel.js'

// The storefront's server sends a no-JS shopper's order-link and order-read requests from one loopback address. With
// the attestation the API minted for that shopper's address on the page request, each counts against the shopper's
// own address; with a forged token, or none, they share the server's bucket as before, and the token alone never
// refuses a request. Every request here reaches the API from 127.0.0.1, with no X-Forwarded-For.

const HOST = '127.0.0.1'
const SHOPPER_HEADER = 'x-nymbal-shopper'
const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'
const LINK_LIMIT = 5
const READ_LIMIT = 10

/** The kernel config with the built-in order rules (link 5 an hour, read with the email 10 an hour) and CSRF off. */
function builtInOrderRules(c: NymbalConfig): NymbalConfig {
  const rateLimit = { ...c.security.rateLimit }
  delete rateLimit['/api/orders/link']
  delete rateLimit['/api/orders/*']
  return nymbalConfigSchema.parse({ ...c, security: { ...c.security, csrf: false, rateLimit } })
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
  /** The served adapter's attestation of `ip`, as its storefront forward sends it. */
  attest(ip: string): string
  link(shopper: string | undefined, i: number): Promise<number>
  read(shopper: string | undefined, i: number): Promise<number>
}

const open: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of open.splice(0)) await stop()
})

async function serve(): Promise<Served> {
  const kernel = await createKernel({ dialect: 'sqlite', configure: builtInOrderRules })
  const port = await freePort()
  const saved = process.env[VARIABLE]
  delete process.env[VARIABLE]
  let adapter: FastifyHttpAdapter
  try {
    const http = createHttpServer({
      config: { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } },
      logger: kernel.logger,
      documentStore: kernel.documentStore,
      version: '0.0.0',
    })
    adapter = http.adapter as FastifyHttpAdapter
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
  const shopperHeader = (token: string | undefined) =>
    token === undefined ? {} : { [SHOPPER_HEADER]: token }
  return {
    attest: (ip) => adapter.attestShopper(ip),
    async link(token, i) {
      const res = await fetch(`${base}/api/orders/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...shopperHeader(token) },
        body: JSON.stringify({ orderNumber: `NYM-${9000 + i}`, email: `link-${i}@attested.test` }),
      })
      await res.arrayBuffer()
      return res.status
    },
    async read(token, i) {
      const res = await fetch(`${base}/api/orders/NYM-${8000 + i}`, {
        headers: {
          [ORDER_KEY_HEADER]: 'k'.repeat(43),
          [ORDER_EMAIL_HEADER]: `read-${i}@attested.test`,
          ...shopperHeader(token),
        },
      })
      await res.arrayBuffer()
      return res.status
    },
  }
}

/** A token of the right shape for `ip` whose mac this server never made. */
const forged = (ip: string) => `${ip}~${Date.now() + 60_000}~${'A'.repeat(43)}`

const A = '203.0.113.41'
const B = '203.0.113.42'

for (const [route, limit, handled] of [
  ['POST /api/orders/link', LINK_LIMIT, 202],
  ['GET /api/orders/<n> with the email header', READ_LIMIT, 404],
] as const) {
  const send = (s: Served, token: string | undefined, i: number) =>
    route.startsWith('POST') ? s.link(token, i) : s.read(token, i)

  describe(`AC-9: ${route} counts against the attested shopper`, () => {
    it(`AC-9: from one loopback peer, shopper A's request ${limit + 1} in an hour with A's attestation answers 429 while shopper B's first, with B's, reaches the handler (${handled})`, async () => {
      const s = await serve()
      const [tokenA, tokenB] = [s.attest(A), s.attest(B)]

      const fromA: number[] = []
      for (let i = 0; i <= limit; i += 1) fromA.push(await send(s, tokenA, i))
      const fromB = await send(s, tokenB, limit + 1)

      expect(fromA).toEqual([...Array.from({ length: limit }, () => handled), 429])
      expect(fromB).toBe(handled)
    })

    it(`AC-9: with a forged token or none, A's and B's requests share the peer's bucket and request ${limit + 1} answers 429; a forged token alone is never refused`, async () => {
      const s = await serve()
      const tokens = [forged(A), undefined, forged(B), `${A}~garbage`, '']

      const shared: number[] = []
      for (let i = 0; i <= limit; i += 1) shared.push(await send(s, tokens[i % tokens.length], i))
      // A fresh server: the forged token's first request is answered by the handler, as one with no token is.
      const fresh = await serve()
      const forgedFirst = await send(fresh, forged(A), 0)
      const plainFirst = await send(fresh, undefined, 1)

      expect(shared).toEqual([...Array.from({ length: limit }, () => handled), 429])
      expect(forgedFirst).toBe(handled)
      expect(plainFirst).toBe(forgedFirst)
    })
  })
}
