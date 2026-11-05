import { request, type OutgoingHttpHeaders } from 'node:http'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger } from '@nymbalhq/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// The client address a request resolves to, on a started adapter reached over real sockets from 127.0.0.1. The peer
// is listed or not by the adapter's `trustedProxies`, so one machine plays both a proxy and a direct client.
// X-Forwarded-For is walked from the peer leftwards while each hop is listed; a configured client-address header is
// read only from a listed peer, and only when it holds one address. An unlisted peer that sends either header logs
// one warning naming itself and the value to set.

const PEER = '127.0.0.1'
const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'
/** Outside every preset: listing it leaves the 127.0.0.1 peer unlisted. */
const ELSEWHERE = '192.0.2.1'
const CHECKOUT_LIMIT = 2

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
const messageOf = (entry: Logged): string =>
  entry.args.filter((a): a is string => typeof a === 'string').join(' ')

/** The warns about an unlisted peer: those whose fields name NYMBAL_TRUSTED_PROXIES. */
const peerWarns = (logged: Logged[]) =>
  logged.filter((e) => e.level === 'warn' && fieldsOf(e)['variable'] === LIST_VAR)
/** The warns about an unusable client-address header: those whose fields carry a reason. */
const headerWarns = (logged: Logged[]) =>
  logged.filter((e) => e.level === 'warn' && fieldsOf(e)['reason'] !== undefined)

const open: FastifyHttpAdapter[] = []
afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

interface Served {
  logged: Logged[]
  /** The request context's `ip` for a GET carrying these headers (an array value is sent as repeated header lines). */
  ipOf(headers?: OutgoingHttpHeaders): Promise<string>
  /** The status of a cartless POST /api/checkout carrying these headers. */
  checkout(headers?: OutgoingHttpHeaders): Promise<number>
  /** Three requests (GET, POST with a body, GET) carrying these headers: each status and body. */
  three(headers?: OutgoingHttpHeaders): Promise<string[]>
  stop(): Promise<void>
}

interface NetworkOptions {
  trustedProxies?: string[]
  clientIpHeader?: string
  clientIpRequiresLock?: boolean
}

async function serve(network: NetworkOptions = {}, host = PEER): Promise<Served> {
  const { logger, logged } = recordingLogger()
  const adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({
      adapter: 'middleware',
      csrf: false,
      rateLimit: {
        '/api/checkout': { requests: CHECKOUT_LIMIT, window: '1m', action: 'block' },
      },
    }),
    ...network,
  })
  adapter.registerRoute('GET', '/api/ip', async (ctx) => ({ status: 200, body: { ip: ctx.ip } }))
  adapter.registerRoute('GET', '/api/ping', async () => ({ status: 200, body: { ok: true } }))
  adapter.registerRoute('POST', '/api/echo', async (ctx) => ({ status: 201, body: ctx.body }))
  adapter.registerRoute('POST', '/api/checkout', async () => ({ status: 200, body: { ok: 1 } }))
  await adapter.start(0, host)
  open.push(adapter)
  const port = adapter.boundPort
  const send = (method: string, path: string, headers: OutgoingHttpHeaders, body?: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: PEER, port, method, path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        )
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(body)
    })
  return {
    logged,
    async ipOf(headers = {}) {
      const res = await send('GET', '/api/ip', headers)
      return (JSON.parse(res.text) as { ip: string }).ip
    },
    async checkout(headers = {}) {
      return (
        await send(
          'POST',
          '/api/checkout',
          { ...headers, 'content-type': 'application/json' },
          '{}',
        )
      ).status
    },
    async three(headers = {}) {
      const out: string[] = []
      for (const [method, path, body] of [
        ['GET', '/api/ping', undefined],
        ['POST', '/api/echo', '{"n":1}'],
        ['GET', '/api/ping', undefined],
      ] as const) {
        const res = await send(
          method,
          path,
          { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
          body,
        )
        out.push(`${res.status} ${res.text}`)
      }
      return out
    },
    stop: () => adapter.stop(),
  }
}

/** A listed chain's client: walking from the peer leftwards, the first hop `held` refuses, else the leftmost. */
function walked(chain: string[], held: (address: string) => boolean): string {
  for (let i = chain.length - 1; i >= 0; i -= 1) if (!held(chain[i]!)) return chain[i]!
  return chain[0]!
}

describe('AC-2: a listed chain is walked from the peer to the first unlisted hop', () => {
  it("AC-2: with trustedProxies ['loopback', '198.51.100.10'], '203.0.113.1, 203.0.113.2, 198.51.100.10' resolves to 203.0.113.2 and '…, 203.0.113.2, 198.51.100.99' to 198.51.100.99", async () => {
    const s = await serve({ trustedProxies: ['loopback', '198.51.100.10'] })

    const throughListed = await s.ipOf({
      'x-forwarded-for': '203.0.113.1, 203.0.113.2, 198.51.100.10',
    })
    const throughUnlisted = await s.ipOf({
      'x-forwarded-for': '203.0.113.1, 203.0.113.2, 198.51.100.99',
    })

    expect(throughListed).toBe('203.0.113.2')
    expect(throughUnlisted).toBe('198.51.100.99')
  })

  it('AC-2: property: over generated lists (loopback, exact IPv4 and IPv6 addresses, a CIDR) and chains, the address is the first hop from the peer leftwards the list does not hold, the leftmost when it holds them all', async () => {
    const pool4 = Array.from({ length: 8 }, (_, i) => `198.51.100.${i + 1}`)
    const pool6 = Array.from({ length: 4 }, (_, i) => `2001:db8::${(i + 1).toString(16)}`)
    const pool = [...pool4, ...pool6]
    const hop = fc.oneof(
      fc.constantFrom(...pool),
      fc.integer({ min: 1, max: 254 }).map((n) => `203.0.113.${n}`),
      fc.integer({ min: 1, max: 254 }).map((n) => `10.9.8.${n}`),
      fc.integer({ min: 1, max: 254 }).map((n) => `127.0.0.${n}`),
      fc.integer({ min: 1, max: 0xfff }).map((n) => `2001:db8:1::${n.toString(16)}`),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.subarray(pool),
        fc.boolean(),
        fc.array(fc.array(hop, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        async (listed, cidr, chains) => {
          const list = ['loopback', ...listed, ...(cidr ? ['10.0.0.0/8'] : [])]
          const held = (a: string) =>
            a.startsWith('127.') || listed.includes(a) || (cidr && a.startsWith('10.'))
          const s = await serve({ trustedProxies: list })
          try {
            const resolved: string[] = []
            for (const chain of chains) {
              resolved.push(await s.ipOf({ 'x-forwarded-for': chain.join(', ') }))
            }
            expect(resolved).toEqual(chains.map((chain) => walked(chain, held)))
          } finally {
            await s.stop()
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it('AC-2: an adapter listening on :: reached at 127.0.0.1 (peer ::ffff:127.0.0.1) with the default list honours X-Forwarded-For', async () => {
    const dual = await serve({}, '::')
    const client = '203.0.113.50'

    const withHeader = await dual.ipOf({ 'x-forwarded-for': client })
    const without = await dual.ipOf()

    expect(without).toMatch(/^(::ffff:)?127\.0\.0\.1$/)
    expect(withHeader).toBe(client)
    expect(withHeader).not.toBe(without)
  })
})

describe('AC-5: an unlisted peer sending a forwarded address warns once', () => {
  const FORWARDED = { 'x-forwarded-for': '203.0.113.7' }

  it("AC-5: with trustedProxies ['192.0.2.1'], three requests from 127.0.0.1 with X-Forwarded-For log exactly one warn naming the peer, the variable and loopback, with NYMBAL_TRUSTED_PROXIES=loopback in its message and no header value, and answer as the same requests without the header", async () => {
    const plain = await serve({ trustedProxies: [ELSEWHERE] })
    const forwarded = await serve({ trustedProxies: [ELSEWHERE] })

    const withoutHeader = await plain.three()
    const withHeader = await forwarded.three(FORWARDED)
    const warns = peerWarns(forwarded.logged)

    expect(peerWarns(plain.logged)).toEqual([])
    expect(warns).toHaveLength(1)
    expect(fieldsOf(warns[0]!)).toMatchObject({
      peer: PEER,
      header: 'x-forwarded-for',
      variable: LIST_VAR,
      suggested: 'loopback',
    })
    expect(messageOf(warns[0]!)).toContain(PEER)
    expect(messageOf(warns[0]!)).toContain(`${LIST_VAR}=loopback`)
    expect(JSON.stringify(warns[0]!.args)).not.toContain(FORWARDED['x-forwarded-for'])
    expect(withHeader).toEqual(withoutHeader)
  })

  it('AC-5: no such warn when the peer is listed (the default, or loopback) or when no request carries the header', async () => {
    const byDefault = await serve()
    const loopback = await serve({ trustedProxies: ['loopback'] })
    const unlistedNoHeader = await serve({ trustedProxies: [ELSEWHERE] })
    const unlisted = await serve({ trustedProxies: [ELSEWHERE] })

    await byDefault.three(FORWARDED)
    await loopback.three(FORWARDED)
    await unlistedNoHeader.three()
    await unlisted.three(FORWARDED)

    expect([byDefault, loopback, unlistedNoHeader].map((s) => peerWarns(s.logged).length)).toEqual([
      0, 0, 0,
    ])
    // The same requests from an unlisted peer do warn: the silence above is the list's.
    expect(peerWarns(unlisted.logged)).toHaveLength(1)
  })

  it("AC-5: with clientIpHeader 'True-Client-IP', an unlisted peer sending only True-Client-IP logs the same warn with header 'true-client-ip'", async () => {
    const s = await serve({ trustedProxies: [ELSEWHERE], clientIpHeader: 'True-Client-IP' })

    await s.three({ 'true-client-ip': '203.0.113.8' })
    const warns = peerWarns(s.logged)

    expect(warns).toHaveLength(1)
    expect(fieldsOf(warns[0]!)).toMatchObject({
      peer: PEER,
      header: 'true-client-ip',
      variable: LIST_VAR,
      suggested: 'loopback',
    })
    expect(JSON.stringify(warns[0]!.args)).not.toContain('203.0.113.8')
  })
})

describe('AC-6: a configured client-address header is read from listed peers only', () => {
  const HEADER = 'True-Client-IP'

  it('AC-6: from a listed peer, True-Client-IP 203.0.113.9 beside X-Forwarded-For 198.51.100.1 resolves to 203.0.113.9, 2001:db8::9 to itself, and no header to the peer with no warn', async () => {
    const s = await serve({ trustedProxies: ['loopback'], clientIpHeader: HEADER })

    const v4 = await s.ipOf({ 'true-client-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' })
    const v6 = await s.ipOf({ 'true-client-ip': '2001:db8::9' })
    const none = await s.ipOf({ 'x-forwarded-for': '198.51.100.1' })

    expect([v4, v6, none]).toEqual(['203.0.113.9', '2001:db8::9', PEER])
    expect(headerWarns(s.logged)).toEqual([])
    expect(peerWarns(s.logged)).toEqual([])
  })

  it('AC-6: a list, the header sent twice, a port suffix or not-an-ip resolves to the peer and logs exactly one warn with its reason and no value', async () => {
    const cases: Array<[string, OutgoingHttpHeaders, 'multiple' | 'invalid']> = [
      ['a list', { 'true-client-ip': '203.0.113.9, 198.51.100.1' }, 'multiple'],
      ['sent twice', { 'true-client-ip': ['203.0.113.9', '198.51.100.1'] }, 'multiple'],
      ['a port', { 'true-client-ip': '203.0.113.9:443' }, 'invalid'],
      ['not an address', { 'true-client-ip': 'not-an-ip' }, 'invalid'],
    ]
    const seen: Array<{ ips: string[]; reasons: unknown[]; leaked: boolean }> = []
    for (const [, headers] of cases) {
      const s = await serve({ trustedProxies: ['loopback'], clientIpHeader: HEADER })
      const ips = [await s.ipOf(headers), await s.ipOf(headers)]
      const warns = headerWarns(s.logged)
      seen.push({
        ips,
        reasons: warns.map((w) => fieldsOf(w)['reason']),
        leaked: warns.some((w) =>
          /203\.0\.113\.9|198\.51\.100\.1|not-an-ip/.test(JSON.stringify(w.args)),
        ),
      })
      expect(warns.map((w) => fieldsOf(w)['peer'])).toEqual(warns.map(() => PEER))
    }

    expect(seen).toEqual(
      cases.map(([, , reason]) => ({ ips: [PEER, PEER], reasons: [reason], leaked: false })),
    )
  })

  it('AC-6: from an unlisted peer the header is ignored: the address is the peer', async () => {
    const s = await serve({ trustedProxies: [ELSEWHERE], clientIpHeader: HEADER })
    const listed = await serve({ trustedProxies: ['loopback'], clientIpHeader: HEADER })
    const headers = { 'true-client-ip': '203.0.113.9' }

    expect(await s.ipOf(headers)).toBe(PEER)
    expect(await listed.ipOf(headers)).toBe('203.0.113.9')
  })

  it('AC-6: checkouts from a listed peer keyed by two header values limit apart; from an unlisted peer the same requests share the peer’s bucket', async () => {
    const run = async (s: Served) => {
      const a: number[] = []
      for (let i = 0; i <= CHECKOUT_LIMIT; i += 1)
        a.push(await s.checkout({ 'true-client-ip': '203.0.113.21' }))
      return { a, b: await s.checkout({ 'true-client-ip': '203.0.113.22' }) }
    }
    const listed = await run(await serve({ trustedProxies: ['loopback'], clientIpHeader: HEADER }))
    const unlisted = await run(await serve({ trustedProxies: [ELSEWHERE], clientIpHeader: HEADER }))

    expect(listed.a[CHECKOUT_LIMIT]).toBe(429)
    expect(unlisted.a[CHECKOUT_LIMIT]).toBe(429)
    expect(listed.b).toBe(listed.a[0])
    expect(unlisted.b).toBe(unlisted.a[CHECKOUT_LIMIT])
    expect(listed.b).not.toBe(unlisted.b)
  })

  it('AC-6: property: over (peer listed, header valid, chain), the address is the header value exactly when the peer is listed and the header holds one valid address, otherwise the peer', async () => {
    const listed = await serve({ trustedProxies: ['loopback'], clientIpHeader: HEADER })
    const unlisted = await serve({ trustedProxies: [ELSEWHERE], clientIpHeader: HEADER })
    // Non-zero groups, so the value is already in canonical form and comes back as sent.
    const hextet = fc.integer({ min: 1, max: 0xffff }).map((n) => n.toString(16))
    const v6 = fc.tuple(hextet, hextet, hextet).map(([a, b, c]) => `2001:db8:${a}::${b}:${c}`)
    const validValue = fc.oneof(fc.ipV4(), v6)
    const invalidValue = fc.oneof(
      fc.tuple(fc.ipV4(), fc.ipV4()).map(([a, b]) => `${a}, ${b}`),
      fc.tuple(fc.ipV4(), fc.integer({ min: 1, max: 65535 })).map(([a, p]) => `${a}:${p}`),
      fc.stringMatching(/^[a-z][a-z-]{2,15}$/),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.oneof(
          validValue.map((value) => ({ value, valid: true })),
          invalidValue.map((value) => ({ value, valid: false })),
        ),
        fc.option(fc.array(fc.ipV4(), { minLength: 1, maxLength: 5 }), { nil: undefined }),
        async (peerListed, { value, valid }, chain) => {
          const headers: OutgoingHttpHeaders = {
            'true-client-ip': value,
            ...(chain !== undefined && { 'x-forwarded-for': chain.join(', ') }),
          }
          const ip = await (peerListed ? listed : unlisted).ipOf(headers)
          expect(ip).toBe(peerListed && valid ? value : PEER)
        },
      ),
      { numRuns: 200 },
    )
  })
})
