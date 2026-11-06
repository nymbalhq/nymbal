import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, securitySchema } from '@nymbalhq/config'
import type { DocumentStoreAdapter, Logger } from '@nymbalhq/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'
import { createHttpServer } from './server.js'
import { forwardToStorefront } from './storefront-forward.js'

// The adapter's half of the origin lock. A request carrying an exact entry of the secret in the lock header is
// locked; the header is removed once checked, so no handler, log line or storefront upstream sees it, and the first
// refusal logs one warn naming the peer and the header, never the value. Locked or not also decides the CDN's
// client-address header when the adapter asked for the lock (clientIpRequiresLock): the header counts on a locked
// request from any peer and on no other; without the flag a listed peer's header counts as before. Requests are
// injected with the socket peer they name.

const S = 'http-origin-secret-Qm4Xv8Lp2Rt6Zw0KaBcDeFg'
const DIRECT = '198.51.100.7'
const LISTED = '10.0.0.5'
const CHECKOUT_LIMIT = 3

interface Injected {
  statusCode: number
  body: string
}
interface InjectOptions {
  method: string
  url: string
  remoteAddress: string
  headers?: Record<string, string>
  payload?: string
}
type Inject = (options: InjectOptions) => Promise<Injected>

interface Logged {
  level: string
  args: unknown[]
}

function recordingLogger(): { logger: Logger; logged: Logged[] } {
  const logged: Logged[] = []
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      logged.push({ level, args })
    }
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  } as unknown as Logger
  return { logger, logged }
}

const fieldsOf = (entry: Logged): Record<string, unknown> =>
  (entry.args.find((a) => typeof a === 'object' && a !== null) ?? {}) as Record<string, unknown>

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

interface Block {
  trustedProxies?: string[]
  clientIpHeader?: string
  clientIpRequiresLock?: boolean
  originLock?: { header: string; secrets: string[] }
}

function adapterWith(block: Block, logger: Logger = recordingLogger().logger) {
  const adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({
      adapter: 'middleware',
      csrf: false,
      rateLimit: {
        '/api/checkout': { requests: CHECKOUT_LIMIT, window: '1m', action: 'block' },
      },
    }),
    ...block,
  } as ConstructorParameters<typeof FastifyHttpAdapter>[0])
  adapter.registerRoute('GET', '/api/headers', async (ctx) => ({
    status: 200,
    body: { headers: ctx.headers },
  }))
  adapter.registerRoute('GET', '/api/ip', async (ctx) => ({ status: 200, body: { ip: ctx.ip } }))
  adapter.registerRoute('POST', '/api/checkout', async () => ({ status: 200, body: { ok: 1 } }))
  cleanup.push(() => adapter.stop().catch(() => {}))
  const inject: Inject = (o) => (adapter as unknown as { inject: Inject }).inject(o)
  return { adapter, inject }
}

const lock = (header = 'X-Nymbal-Origin') => ({ header, secrets: [S] })

/** A storefront stand-in on 127.0.0.1 that records what reaches it. */
async function upstream(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>page</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { port: (server.address() as { port: number }).port, seen }
}

const codeOf = (res: Injected): string | undefined => {
  try {
    return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code
  } catch {
    return undefined
  }
}

describe('AC-4: the secret goes nowhere past the check', () => {
  for (const header of ['X-Nymbal-Origin', 'X-Edge-Proof']) {
    it(`AC-4: with the lock header ${header}, a locked request's ctx.headers holds no ${header.toLowerCase()} and the storefront upstream receives none, while an unlocked page request from another machine is 403 and the upstream receives nothing`, async () => {
      const store = await upstream()
      const { adapter, inject } = adapterWith({ originLock: lock(header) })
      forwardToStorefront(adapter, { port: store.port, publicUrl: 'https://shop.example' })
      const name = header.toLowerCase()

      const api = await inject({
        method: 'GET',
        url: '/api/headers',
        remoteAddress: DIRECT,
        headers: { [header]: S },
      })
      const page = await inject({
        method: 'GET',
        url: '/products/locked',
        remoteAddress: DIRECT,
        headers: { [header]: S },
      })
      const fromLoopback = await inject({
        method: 'GET',
        url: '/products/local',
        remoteAddress: '127.0.0.1',
        headers: { [header]: S },
      })
      const forwarded = store.seen.length
      const unlocked = await inject({
        method: 'GET',
        url: '/products/unlocked',
        remoteAddress: DIRECT,
      })

      const handed = (JSON.parse(api.body) as { headers: Record<string, unknown> }).headers
      expect([api.statusCode, page.statusCode, fromLoopback.statusCode]).toEqual([200, 200, 200])
      expect(Object.keys(handed).map((k) => k.toLowerCase())).not.toContain(name)
      expect(store.seen.map((h) => h[name])).toEqual([undefined, undefined])
      expect([unlocked.statusCode, codeOf(unlocked)]).toEqual([403, 'origin_locked'])
      expect(store.seen.length).toBe(forwarded)
    })
  }

  it('AC-4: three refused requests from one peer log exactly one warn, with fields { peer, header }; no logged line from any request, locked or refused, holds the secret', async () => {
    const { logger, logged } = recordingLogger()
    const { inject } = adapterWith({ originLock: lock() }, logger)
    const refused: Injected[] = []
    for (let i = 0; i < 3; i += 1) {
      refused.push(await inject({ method: 'GET', url: '/api/ip', remoteAddress: DIRECT }))
    }
    await inject({
      method: 'GET',
      url: '/api/ip',
      remoteAddress: DIRECT,
      headers: { 'X-Nymbal-Origin': S },
    })
    await inject({
      method: 'GET',
      url: '/api/ip',
      remoteAddress: '203.0.113.20',
      headers: { 'X-Nymbal-Origin': `${S}x` },
    })

    const lockWarns = logged.filter(
      (e) => e.level === 'warn' && Object.keys(fieldsOf(e)).sort().join() === 'header,peer',
    )
    expect(refused.map(codeOf)).toEqual(['origin_locked', 'origin_locked', 'origin_locked'])
    expect(lockWarns.length).toBe(1)
    expect(fieldsOf(lockWarns[0]!)['peer']).toBe(DIRECT)
    expect(String(fieldsOf(lockWarns[0]!)['header']).toLowerCase()).toBe('x-nymbal-origin')
    expect(logged.filter((e) => JSON.stringify(e.args).includes(S))).toEqual([])
  })

  it("AC-4: with the lock off (no NYMBAL_ORIGIN_SECRET on the host), the config's lock header sent by an edge reaches neither ctx.headers nor the storefront upstream, from another machine or this one", async () => {
    const store = await upstream()
    const config = nymbalConfigSchema.parse({
      store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
      template: 'astro',
      infrastructure: {
        commandStore: 'sqlite',
        documentStore: { provider: 'in-memory' },
        eventBus: { provider: 'in-process' },
      },
      security: { adapter: 'middleware', csrf: false, originLock: { header: 'X-Edge-Proof' } },
      commerce: {
        payments: { provider: 'native' },
        email: { provider: 'native' },
        reviews: { provider: 'native' },
        search: { provider: 'native' },
        analytics: { provider: 'native' },
        shipping: { provider: 'native' },
        tax: { provider: 'native' },
        ai: { provider: 'none' },
      },
      http: { adapter: 'fastify' },
      deployment: { strategy: 'standard' },
    })
    const server = createHttpServer({
      config,
      logger: recordingLogger().logger,
      documentStore: {} as DocumentStoreAdapter,
      version: '0.0.0',
      network: {
        trustedProxies: ['loopback'],
        trustedProxiesSource: { kind: 'default', name: 'default' },
        clientIpRequiresLock: false,
      },
    })
    cleanup.push(() => server.stop())
    server.registerRoute('GET', '/api/headers', async (ctx) => ({
      status: 200,
      body: { headers: ctx.headers },
    }))
    forwardToStorefront(server.adapter, { port: store.port, publicUrl: 'https://shop.example' })
    const inject: Inject = (o) => (server.adapter as unknown as { inject: Inject }).inject(o)

    const runs = []
    for (const remoteAddress of [DIRECT, '127.0.0.1']) {
      for (const url of ['/api/headers', '/products/open']) {
        runs.push(
          await inject({ method: 'GET', url, remoteAddress, headers: { 'X-Edge-Proof': S } }),
        )
      }
    }

    const handed = [runs[0]!, runs[2]!].map((res) =>
      Object.keys((JSON.parse(res.body) as { headers: Record<string, unknown> }).headers).map((k) =>
        k.toLowerCase(),
      ),
    )
    expect(runs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200])
    expect(handed.filter((keys) => keys.includes('x-edge-proof'))).toEqual([])
    expect(handed.map((keys) => keys.includes('host'))).toEqual([true, true])
    expect(store.seen.map((h) => h['x-edge-proof'])).toEqual([undefined, undefined])
  })
})

/** The block AC-5 names, with the lock flag and the lock as given. */
function cdnBlock(requiresLock: boolean, withLock = true, trustedProxies = ['uniquelocal']): Block {
  return {
    trustedProxies,
    clientIpHeader: 'CF-Connecting-IP',
    clientIpRequiresLock: requiresLock,
    ...(withLock && { originLock: lock() }),
  }
}

async function ipOf(
  inject: Inject,
  peer: string,
  headers: Record<string, string>,
): Promise<string | number> {
  const res = await inject({ method: 'GET', url: '/api/ip', remoteAddress: peer, headers })
  return res.statusCode === 200 ? (JSON.parse(res.body) as { ip: string }).ip : res.statusCode
}

describe('AC-5: the CDN header counts on locked requests when the adapter asked for the lock', () => {
  it('AC-5: with clientIpRequiresLock true, a locked request with CF-Connecting-IP 203.0.113.9 resolves to it from a listed peer, an unlisted one and loopback; an unlocked one from loopback with X-Forwarded-For beside it does not', async () => {
    const { inject } = adapterWith(cdnBlock(true))
    const cf = { 'CF-Connecting-IP': '203.0.113.9' }
    const locked = { ...cf, 'X-Nymbal-Origin': S }

    const ips = [
      await ipOf(inject, LISTED, locked),
      await ipOf(inject, DIRECT, locked),
      await ipOf(inject, '127.0.0.1', locked),
    ]
    const unlocked = await ipOf(inject, '127.0.0.1', { ...cf, 'X-Forwarded-For': '198.51.100.1' })

    expect(ips).toEqual(['203.0.113.9', '203.0.113.9', '203.0.113.9'])
    expect(unlocked).not.toBe('203.0.113.9')
  })

  it("AC-5: with clientIpRequiresLock false the store's rule stands: a locked request from unlisted 198.51.100.7 resolves to the peer, and a request from listed 10.0.0.5 on a block without the lock resolves to the header", async () => {
    const withLock = adapterWith(cdnBlock(false)).inject
    const noLock = adapterWith(cdnBlock(false, false)).inject
    const cf = { 'CF-Connecting-IP': '203.0.113.9' }

    const lockedUnlisted = await ipOf(withLock, DIRECT, { ...cf, 'X-Nymbal-Origin': S })
    const unlockedListed = await ipOf(noLock, LISTED, cf)

    expect([lockedUnlisted, unlockedListed]).toEqual([DIRECT, '203.0.113.9'])
  })

  it('AC-5: property: over (requiresLock, locked, peer listed, header valid), the address is the header’s exactly when the header is valid and (requiresLock ? locked : listed)', async () => {
    // Locked requests come from generated peers in 10.0.0.0/8 (listed) or 198.51.100.0/24 (not); an unlocked request
    // from another machine is refused by the lock, so unlocked ones come from loopback, listed or not by the block.
    const servers = new Map<string, Inject>()
    const serverFor = (requiresLock: boolean, loopbackListed: boolean): Inject => {
      const key = `${requiresLock}/${loopbackListed}`
      if (!servers.has(key)) {
        const list = loopbackListed ? ['loopback', 'uniquelocal'] : ['uniquelocal']
        servers.set(key, adapterWith(cdnBlock(requiresLock, true, list)).inject)
      }
      return servers.get(key)!
    }
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.oneof(
          fc
            .ipV4()
            .filter((value) => !/^(10|127)\.|^198\.51\.100\./.test(value))
            .map((value) => ({ value, valid: true })),
          fc
            .constantFrom('not-an-ip', '203.0.113.9, 203.0.113.10', '203.0.113.9:443')
            .map((value) => ({ value, valid: false })),
        ),
        fc.nat(255),
        async (requiresLock, locked, listed, header, n) => {
          const peer = locked ? (listed ? `10.1.2.${n}` : `198.51.100.${n}`) : '127.0.0.1'
          const inject = serverFor(requiresLock, !locked && listed)
          const headers: Record<string, string> = { 'CF-Connecting-IP': header.value }
          if (locked) headers['X-Nymbal-Origin'] = S

          const ip = await ipOf(inject, peer, headers)
          const honoured = header.valid && (requiresLock ? locked : listed)

          expect(typeof ip, `the request from ${peer} was refused`).toBe('string')
          expect(ip === header.value).toBe(honoured)
        },
      ),
      { numRuns: 150 },
    )
  })

  it("AC-5: two shoppers' checkouts (limit 3 a minute) locked from one peer with CF-Connecting-IP 203.0.113.1 and .2 keep their own buckets; with the lock absent and requiresLock still true, the same from unlisted 127.0.0.1 share the peer's", async () => {
    const run = async (inject: Inject, peer: string, extra: Record<string, string>) => {
      const checkout = (client: string) =>
        inject({
          method: 'POST',
          url: '/api/checkout',
          remoteAddress: peer,
          headers: { 'content-type': 'application/json', 'CF-Connecting-IP': client, ...extra },
          payload: '{}',
        }).then((r) => r.statusCode)
      const a: number[] = []
      for (let i = 0; i <= CHECKOUT_LIMIT; i += 1) a.push(await checkout('203.0.113.1'))
      return { a, b: await checkout('203.0.113.2') }
    }

    const locked = await run(adapterWith(cdnBlock(true)).inject, DIRECT, { 'X-Nymbal-Origin': S })
    const shared = await run(adapterWith(cdnBlock(true, false)).inject, '127.0.0.1', {})

    expect(locked.a.slice(0, CHECKOUT_LIMIT)).not.toContain(429)
    expect(locked.a[CHECKOUT_LIMIT]).toBe(429)
    expect(locked.b).toBe(locked.a[0])
    expect(shared.a[CHECKOUT_LIMIT]).toBe(429)
    expect(shared.b).toBe(429)
  })
})
