import { request } from 'node:http'
import { BlockList, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveOriginLock, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type ResolvedNetwork } from '@nymbalhq/types'
import { createHttpServer, type HttpServer } from '../../../http/src/index.js'
import { ok } from '../../src/routes/envelope.js'
import { createKernel, type Kernel } from '../support/kernel.js'

// With NYMBAL_ORIGIN_SECRET set, a request from another machine is answered only when it carries the secret in
// X-Nymbal-Origin: anything else is 403 origin_locked, before the rate limiter, the router's 404 or any handler. The
// same machine (a socket peer on loopback) and the platform's /health and /ready checks are exempt; the peer is the
// socket's, never an address a proxy forwarded. The kernel resolves the secret once, in createApp, onto app.network,
// and the HTTP server reads that block, not the environment. Requests are injected with the socket peer they name.

const VAR = 'NYMBAL_ORIGIN_SECRET'
const HEADER = 'x-nymbal-origin'
const S = 'kernel-origin-secret-Qm4Xv8Lp2Rt6Zw0KaBcDeFg'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.~-'
const DIRECT = '198.51.100.7'
const LOGIN_LIMIT = 3

interface Injected {
  statusCode: number
  body: string
}
interface InjectOptions {
  method: string
  url: string
  remoteAddress: string
  headers?: Record<string, string | string[]>
  payload?: string
}
type Inject = (options: InjectOptions) => Promise<Injected>

/** Runs `fn` with NYMBAL_ORIGIN_SECRET set to `value` (unset when undefined), then puts it back. */
async function withSecret<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env[VAR]
  if (value === undefined) delete process.env[VAR]
  else process.env[VAR] = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[VAR]
    else process.env[VAR] = saved
  }
}

const open: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of open.splice(0)) await stop().catch(() => {})
})

/** No limit /api/auth/login could reach in these runs, unless `loginLimit` is given. */
function configured(opts: { loginLimit?: number; trustedProxies?: string[] } = {}) {
  return (c: NymbalConfig): NymbalConfig =>
    nymbalConfigSchema.parse({
      ...c,
      security: {
        ...c.security,
        rateLimit: {
          ...c.security.rateLimit,
          '/api/auth/login': {
            requests: opts.loginLimit ?? 100_000,
            window: '1m',
            action: 'block',
          },
        },
      },
      http:
        opts.trustedProxies === undefined
          ? c.http
          : { ...c.http, trustedProxies: opts.trustedProxies },
    })
}

async function kernelWith(
  secret: string | undefined,
  opts: Parameters<typeof configured>[0] = {},
): Promise<Kernel> {
  const kernel = await withSecret(secret, () =>
    createKernel({ dialect: 'sqlite', configure: configured(opts) }),
  )
  open.push(() => kernel.close())
  return kernel
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

/** The kernel's HTTP server, as `nymbal start` builds it (with its /ready route), from `network` (app.network). */
async function serverOf(
  kernel: Kernel,
  network: ResolvedNetwork = kernel.app.network,
  http: Partial<NymbalConfig['http']> = {},
): Promise<HttpServer & { inject: Inject }> {
  const server = createHttpServer({
    config: { ...kernel.config, http: { ...kernel.config.http, ...http } },
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
    network,
  })
  server.registerRoute('GET', '/ready', async () => ok({ ready: true }))
  await kernel.app.attachHttp(server.adapter)
  open.unshift(() => server.stop())
  const adapter = server.adapter as unknown as { inject: Inject }
  return Object.assign(server, { inject: (o: InjectOptions) => adapter.inject(o) })
}

/** The status and the error code (null when none) of an answer. */
function summary(res: Injected): { status: number; code: string | null } {
  let code: string | null = null
  try {
    code = (JSON.parse(res.body) as { error?: { code?: string } }).error?.code ?? null
  } catch {
    code = null
  }
  return { status: res.statusCode, code }
}

const isLocked = (res: Injected): boolean => {
  const s = summary(res)
  return s.status === 403 && s.code === 'origin_locked'
}

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')
loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
const isLoopback = (address: string): boolean =>
  loopback.check(address, address.includes(':') ? 'ipv6' : 'ipv4')

const peerArb = fc.oneof(
  fc.ipV4().filter((a) => !isLoopback(a)),
  fc.ipV6().filter((a) => !isLoopback(a)),
  fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)).map(([a, b, c]) => `127.${a}.${b}.${c}`),
  fc.constantFrom('::1', '::ffff:127.0.0.1'),
)

/** A different character at `at`. */
function changedAt(secret: string, at: number): string {
  const i = at % secret.length
  const next = ALPHABET[(ALPHABET.indexOf(secret[i]!) + 1) % ALPHABET.length]!
  return `${secret.slice(0, i)}${next}${secret.slice(i + 1)}`
}

type Sent = { kind: 'absent' } | { kind: 'exact' } | { kind: 'other'; value: string | string[] }
const headerArb: fc.Arbitrary<Sent> = fc.oneof(
  fc.constant({ kind: 'absent' as const }),
  fc.constant({ kind: 'exact' as const }),
  fc.nat().map((at) => ({ kind: 'other' as const, value: changedAt(S, at) })),
  fc.constant({ kind: 'other' as const, value: `${S}x` }),
  fc.constant<Sent>({ kind: 'other', value: [S, S] }),
  fc.integer({ min: 1, max: S.length - 1 }).map((n) => ({
    kind: 'other' as const,
    value: S.slice(0, n),
  })),
)

const TARGETS: Array<{ method: string; url: string; payload?: string; exempt: boolean }> = [
  { method: 'GET', url: '/api/products', exempt: false },
  {
    method: 'POST',
    url: '/api/auth/login',
    payload: JSON.stringify({ email: 'nobody@shop.example', password: 'not-the-password' }),
    exempt: false,
  },
  { method: 'GET', url: '/nope', exempt: false },
  { method: 'GET', url: '/health', exempt: true },
  { method: 'GET', url: '/ready', exempt: true },
  { method: 'GET', url: '/healthz', exempt: false },
  { method: 'GET', url: '/ready/x', exempt: false },
]

function requestOf(
  target: (typeof TARGETS)[number],
  peer: string,
  sent: Sent,
  extra: Record<string, string> = {},
): InjectOptions {
  const headers: Record<string, string | string[]> = { ...extra }
  if (target.payload !== undefined) headers['content-type'] = 'application/json'
  if (sent.kind === 'exact') headers[HEADER] = S
  if (sent.kind === 'other') headers[HEADER] = sent.value
  return {
    method: target.method,
    url: target.url,
    remoteAddress: peer,
    headers,
    ...(target.payload !== undefined && { payload: target.payload }),
  }
}

/** The machine's first non-internal IPv4 address. */
function externalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** A GET over a real socket from `from` to `host:port`: the status and the error code. */
function getFrom(
  from: string,
  host: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string | null }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, headers, localAddress: from, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve(
          summary({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        ),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('AC-2: the lock answers 403 origin_locked to every other machine without the secret', () => {
  it('AC-2: property: over peers (non-loopback IPv4 and IPv6; 127.x.y.z, ::1, ::ffff:127.0.0.1), the header (absent, S, S with one character changed, S + x, S sent twice, a prefix of S) and targets (an API route, login, an unknown path, /health, /ready, /healthz, /ready/x), the answer is 403 origin_locked exactly when the peer is not loopback, the header is not exactly S and the target is not /health or /ready, and otherwise it is the answer the same request gets with the variable unset, where nothing is 403 origin_locked', async () => {
    const locked = await serverOf(await kernelWith(S))
    const unset = await serverOf(await kernelWith(undefined))

    await fc.assert(
      fc.asyncProperty(
        peerArb,
        headerArb,
        fc.constantFrom(...TARGETS),
        async (peer, sent, target) => {
          const req = requestOf(target, peer, sent)
          const withLock = await locked.inject(req)
          const without = await unset.inject(req)
          const refused = !isLoopback(peer) && sent.kind !== 'exact' && !target.exempt

          expect(isLocked(without)).toBe(false)
          expect(isLocked(withLock)).toBe(refused)
          expect(refused ? null : summary(withLock)).toEqual(refused ? null : summary(without))
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-2: with NYMBAL_ORIGIN_SECRET "S1,S2" a request from another machine carrying S1 or S2 is answered and one carrying a third value is refused', async () => {
    const [s1, s2, s3] = [`${S}-one`, `${S}-two`, `${S}-three`]
    const rotating = await serverOf(await kernelWith(`${s1},${s2}`))
    const unset = await serverOf(await kernelWith(undefined))
    const products = (value: string) => ({
      method: 'GET',
      url: '/api/products',
      remoteAddress: DIRECT,
      headers: { [HEADER]: value },
    })

    const answers = await Promise.all([s1, s2, s3].map((v) => rotating.inject(products(v))))
    const baseline = summary(await unset.inject(products(s1)))

    expect(answers.map(isLocked)).toEqual([false, false, true])
    expect(answers.slice(0, 2).map(summary)).toEqual([baseline, baseline])
  })

  it('AC-2: over a real socket from this machine’s first non-internal IPv4 address to a server on 0.0.0.0, a request without the header is 403 origin_locked and one with S is answered as a loopback request is', async () => {
    const from = externalIpv4()
    expect(from, 'this machine has no non-internal IPv4 address to send from').toBeTypeOf('string')
    const kernel = await kernelWith(S)
    const port = await freePort('0.0.0.0')
    const server = await serverOf(kernel, kernel.app.network, { host: '0.0.0.0', port })
    await server.start()

    const bare = await getFrom(from!, from!, port, '/api/products')
    const carrying = await getFrom(from!, from!, port, '/api/products', { [HEADER]: S })
    const local = await getFrom('127.0.0.1', '127.0.0.1', port, '/api/products')

    expect(bare).toEqual({ status: 403, code: 'origin_locked' })
    expect(carrying).toEqual(local)
  })
})

describe('AC-3: the lock is before the limiter and judges the socket peer', () => {
  it(`AC-3: with /api/auth/login limited to ${LOGIN_LIMIT} a minute, 10 logins from ${DIRECT} without the header all answer 403 origin_locked and leave the guard's bucket count unchanged, and a login from that peer carrying S is then not 429`, async () => {
    const server = await serverOf(await kernelWith(S, { loginLimit: LOGIN_LIMIT }))
    const guard = (server.adapter as unknown as { guard: { bucketCount(): number } }).guard
    const login = TARGETS[1]!
    const buckets = guard.bucketCount()

    const refused: Injected[] = []
    for (let i = 0; i < 10; i += 1) {
      refused.push(await server.inject(requestOf(login, DIRECT, { kind: 'absent' })))
    }
    const after = guard.bucketCount()
    const carrying = await server.inject(requestOf(login, DIRECT, { kind: 'exact' }))

    expect(refused.map(isLocked)).toEqual(refused.map(() => true))
    expect(after).toBe(buckets)
    expect(carrying.statusCode).not.toBe(429)
    expect(isLocked(carrying)).toBe(false)
  })

  it(`AC-3: with trustedProxies ['198.51.100.0/24'], a request from ${DIRECT} forwarding X-Forwarded-For 127.0.0.1 without the header is 403 origin_locked; one from 127.0.0.1 forwarding 203.0.113.5 without the header is answered`, async () => {
    const server = await serverOf(await kernelWith(S, { trustedProxies: ['198.51.100.0/24'] }))
    const products = TARGETS[0]!

    const forwardedLoopback = await server.inject(
      requestOf(products, DIRECT, { kind: 'absent' }, { 'x-forwarded-for': '127.0.0.1' }),
    )
    const fromLoopback = await server.inject(
      requestOf(products, '127.0.0.1', { kind: 'absent' }, { 'x-forwarded-for': '203.0.113.5' }),
    )
    const carrying = await server.inject(
      requestOf(products, DIRECT, { kind: 'exact' }, { 'x-forwarded-for': '127.0.0.1' }),
    )

    expect([isLocked(forwardedLoopback), isLocked(fromLoopback)]).toEqual([true, false])
    expect(summary(fromLoopback)).toEqual(summary(carrying))
  })
})

describe('AC-6: the kernel resolves the lock once, and the server reads the block', () => {
  it('AC-6: createApp with NYMBAL_ORIGIN_SECRET=S has app.network.originLock equal to resolveOriginLock(config, env); a malformed value makes createApp throw config.origin_secret_invalid', async () => {
    const kernel = await kernelWith(S)
    const malformed = await kernelWith('too-short').then(
      () => 'built',
      (error: unknown) => (error instanceof ConfigError ? error.code : String(error)),
    )
    const network = kernel.app.network as ResolvedNetwork & { originLock?: unknown }

    expect(network.originLock).toEqual(resolveOriginLock(kernel.config, { [VAR]: S }))
    expect(network.originLock).toEqual({ header: 'X-Nymbal-Origin', secrets: [S] })
    expect(malformed).toBe('config.origin_secret_invalid')
  })

  it('AC-6: a server built with network: app.network refuses an unlocked request from another machine, and one built under the same environment from a block without originLock answers it', async () => {
    const kernel = await kernelWith(S)
    const twin = await kernelWith(S)
    const { originLock: _lock, ...withoutLock } = twin.app.network as ResolvedNetwork & {
      originLock?: unknown
    }
    const fromBlock = await serverOf(kernel)
    const withoutBlock = await withSecret(S, () => serverOf(twin, withoutLock as ResolvedNetwork))
    const req = requestOf(TARGETS[0]!, DIRECT, { kind: 'absent' })

    const answers = [await fromBlock.inject(req), await withoutBlock.inject(req)]

    expect(answers.map(isLocked)).toEqual([true, false])
  })
})
