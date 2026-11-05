import { createServer } from 'node:net'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type ResolvedNetwork } from '@nymbalhq/types'
import { createHttpServer } from '../../../http/src/index.js'
import { ok } from '../../src/routes/envelope.js'
import { createKernel, type Kernel } from '../support/kernel.js'

// The rate limiter keys on the address a request resolves to, and only a listed proxy may say what that is. Every
// request here reaches the server from 127.0.0.1, so whether the peer is a proxy or a client is set by listing it
// (loopback, the default) or not (192.0.2.1 only). The kernel resolves the list once, in createApp, as app.network;
// the HTTP server reads that block and nothing from the environment.

const HOST = '127.0.0.1'
const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'
const HEADER_VAR = 'NYMBAL_CLIENT_IP_HEADER'
const HOPS_VAR = 'NYMBAL_TRUST_PROXY_HOPS'
const NETWORK_VARS = [LIST_VAR, HEADER_VAR, HOPS_VAR]
/** /api/checkout's limit on these servers: small, so a bucket empties in a few requests. */
const LIMIT = 3

/** A fresh client address per call, from 198.18.0.0/15 (benchmarking). */
let clients = 0
function nextClient(): string {
  clients += 1
  return `198.18.${Math.floor(clients / 250)}.${(clients % 250) + 1}`
}

/** The kernel config with /api/checkout limited to LIMIT a minute and `http.trustedProxies` as given (absent: unset). */
function listed(trustedProxies?: string[]): (c: NymbalConfig) => NymbalConfig {
  return (c) =>
    nymbalConfigSchema.parse({
      ...c,
      security: {
        ...c.security,
        rateLimit: {
          ...c.security.rateLimit,
          '/api/checkout': { requests: LIMIT, window: '1m', action: 'block' },
        },
      },
      http: trustedProxies === undefined ? c.http : { ...c.http, trustedProxies },
    })
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

/** Runs `fn` with the network variables replaced by `vars` (a missing one unset), then puts them back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(NETWORK_VARS.map((name) => [name, process.env[name]]))
  for (const name of NETWORK_VARS) delete process.env[name]
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const open: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of open.splice(0)) await stop()
})

async function kernelWith(
  configure: (c: NymbalConfig) => NymbalConfig,
  vars: Record<string, string> = {},
): Promise<Kernel> {
  const kernel = await withEnv(vars, () => createKernel({ dialect: 'sqlite', configure }))
  open.push(() => kernel.close())
  return kernel
}

interface Served {
  /** The request context's client IP for a request with these headers. */
  ipOf(headers: Record<string, string>): Promise<string>
  /** The status of a POST /api/checkout with this X-Forwarded-For. */
  checkout(forwardedFor: string): Promise<number>
}

/**
 * The kernel served over HTTP with `network` (app.network unless given), every network variable set to `vars` while
 * the server is created and started, and one more route that answers the request context's client IP.
 */
async function serve(
  kernel: Kernel,
  network: ResolvedNetwork = kernel.app.network,
  vars: Record<string, string> = {},
): Promise<Served> {
  const port = await freePort()
  await withEnv(vars, async () => {
    const http = createHttpServer({
      config: { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } },
      logger: kernel.logger,
      documentStore: kernel.documentStore,
      version: '0.0.0',
      network,
    })
    http.registerRoute('GET', '/test/client-ip', async (ctx) => ok({ ip: ctx.ip }))
    await kernel.app.attachHttp(http.adapter)
    await http.start()
    open.unshift(() => http.stop())
  })
  const base = `http://${HOST}:${port}`
  return {
    async ipOf(headers) {
      const res = await fetch(`${base}/test/client-ip`, { headers })
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

/**
 * Shopper A's LIMIT + 1 checkouts, then shopper B's one, each with its own X-Forwarded-For; and the context IP each
 * forwarded address resolved to.
 */
async function sequence(
  s: Served,
): Promise<{ a: number[]; b: number; forwarded: string[]; ips: string[] }> {
  const [a, b] = [nextClient(), nextClient()]
  const statuses: number[] = []
  for (let i = 0; i <= LIMIT; i += 1) statuses.push(await s.checkout(a))
  const bStatus = await s.checkout(b)
  const ips = [await s.ipOf({ 'x-forwarded-for': a }), await s.ipOf({ 'x-forwarded-for': b })]
  return { a: statuses, b: bStatus, forwarded: [a, b], ips }
}

describe('AC-1: an unlisted peer cannot choose its address; a listed one can', () => {
  it("AC-1: with trustedProxies ['192.0.2.1'] (peer unlisted) A's 4th and B's 1st checkout both answer 429 and the IP is 127.0.0.1 for every X-Forwarded-For; with the list unset and with ['loopback'] A's 4th answers 429, B's 1st does not, and the IP is the forwarded address", async () => {
    const unlisted = await sequence(await serve(await kernelWith(listed(['192.0.2.1']))))
    const byDefault = await sequence(await serve(await kernelWith(listed())))
    const loopback = await sequence(await serve(await kernelWith(listed(['loopback']))))

    expect(unlisted.a.slice(0, LIMIT)).not.toContain(429)
    expect(unlisted.a[LIMIT]).toBe(429)
    expect(unlisted.b).toBe(429)
    expect(unlisted.ips).toEqual([HOST, HOST])
    for (const run of [byDefault, loopback]) {
      expect(run.a.slice(0, LIMIT)).not.toContain(429)
      expect(run.a[LIMIT]).toBe(429)
      expect(run.b).toBe(run.a[0])
      expect(run.ips).toEqual(run.forwarded)
    }
  })

  it('AC-1: property: with the peer unlisted, the IP is the peer for any X-Forwarded-For chain of 1 to 31 IPv4 and IPv6 entries', async () => {
    const unlisted = await serve(await kernelWith(listed(['192.0.2.1'])))
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.ipV4(), fc.ipV6()), { minLength: 1, maxLength: 31 }),
        async (chain) => {
          expect(await unlisted.ipOf({ 'x-forwarded-for': chain.join(', ') })).toBe(HOST)
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('AC-4: the removed hop count refuses the app', () => {
  it('AC-4: NYMBAL_TRUST_PROXY_HOPS of 0, 1 or x makes createApp throw config.trust_proxy_hops_removed naming NYMBAL_TRUSTED_PROXIES; a blank one builds the app', async () => {
    const outcomes: unknown[] = []
    for (const hops of ['0', '1', 'x']) {
      outcomes.push(
        await kernelWith(listed(), { [HOPS_VAR]: hops }).then(
          () => 'built',
          (error: unknown) =>
            error instanceof ConfigError
              ? { code: error.code, names: error.message.includes(LIST_VAR) }
              : String(error),
        ),
      )
    }
    const blank = await kernelWith(listed(), { [HOPS_VAR]: '' })

    expect(outcomes).toEqual(
      ['0', '1', 'x'].map(() => ({ code: 'config.trust_proxy_hops_removed', names: true })),
    )
    expect(blank.app.network.trustedProxies).toEqual(['loopback'])
  })
})

describe('AC-15: a security adapter that contributes nothing changes nothing; the server reads the block', () => {
  it('AC-15: a kernel built by createApp on the default config (the built-in middleware adapter) has app.network equal to resolveTrustedProxies(config, env), no source the adapter, and its server resolves a loopback X-Forwarded-For as the default does', async () => {
    const kernel = await kernelWith(listed())
    const expected = resolveTrustedProxies(kernel.config, {})
    const s = await serve(kernel)
    const client = nextClient()

    expect(kernel.app.network).toEqual(expected)
    expect(kernel.app.network.trustedProxiesSource.kind).toBe('default')
    expect(kernel.app.network.clientIpHeaderSource).toBeUndefined()
    expect(await s.ipOf({ 'x-forwarded-for': client })).toBe(client)
  })

  it('AC-15: a server given a block whose clientIpHeader came from an adapter honours it from a listed peer, while the same config and env with no contribution do not, and the environment at server creation changes neither', async () => {
    const kernel = await kernelWith(listed())
    const contributed = resolveTrustedProxies(
      kernel.config,
      {},
      {
        adapter: 'fixture',
        network: { clientIpHeader: 'X-Edge-Client' },
      },
    )
    const plain = resolveTrustedProxies(kernel.config, {})
    // Variables that would list no proxy and name another header, were the server to read them.
    const poison = { [LIST_VAR]: '192.0.2.1', [HEADER_VAR]: 'X-Other-Client' }
    const withBlock = await serve(kernel, contributed, poison)
    const withoutContribution = await serve(await kernelWith(listed()), plain, poison)
    const headers = { 'x-edge-client': '203.0.113.9', 'x-other-client': '203.0.113.10' }

    expect(contributed.clientIpHeaderSource).toEqual({ kind: 'adapter', name: 'fixture' })
    expect(await withBlock.ipOf(headers)).toBe('203.0.113.9')
    expect(await withoutContribution.ipOf(headers)).toBe(HOST)
  })
})
