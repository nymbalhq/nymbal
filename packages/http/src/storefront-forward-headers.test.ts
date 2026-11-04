import { createServer, request, type Server } from 'node:http'
import type { Socket } from 'node:net'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'
import { buildSecurityHeaders } from './security-middleware.js'
import { forwardToStorefront } from './storefront-forward.js'

// AC-1: a page the storefront answers reaches the shopper with the forward's security headers wherever the storefront
// set none of its own: HSTS (https public URL and `hsts` on), a floor CSP that forbids framing, plugins and foreign
// base URLs, nosniff, X-Frame-Options and a Referrer-Policy. A header the storefront set passes byte for byte, once;
// an /api/ answer keeps the API's own. The storefront is an upstream this file owns: `/page?set=<json>` answers HTML
// with exactly the headers the JSON names.

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
const security = securitySchema.parse({ adapter: 'middleware' })
const HTTPS_URL = 'https://shop.example'
const HTTP_URL = 'http://shop.test:8080'

const FLOOR_CSP = new Map([
  ['frame-ancestors', ["'none'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
])
const HSTS = 'max-age=31536000; includeSubDomains'

/** The five headers the forward fills in, and what each is when the storefront set none and the config is default. */
const FILLED = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
] as const
type Filled = (typeof FILLED)[number]

const DEFAULT_FILL: Record<Exclude<Filled, 'content-security-policy'>, string> = {
  'strict-transport-security': HSTS,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': security.headers.referrerPolicy,
}

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function startStorefront(): Promise<number> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://storefront')
    const own = JSON.parse(url.searchParams.get('set') ?? '{}') as Record<string, string>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...own })
    res.end('<!doctype html><title>page</title>')
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}

type HeaderConfig = Pick<typeof security.headers, 'hsts' | 'referrerPolicy' | 'xFrameOptions'>

async function serve(storefrontPort: number, publicUrl: string, headers?: HeaderConfig) {
  const adapter = new FastifyHttpAdapter({ logger, security })
  adapter.registerRoute('GET', '/api/ping', async () => ({ status: 200, body: { ok: true } }))
  forwardToStorefront(adapter, {
    port: storefrontPort,
    publicUrl,
    ...(headers !== undefined && { headers }),
  })
  await adapter.start(0, '127.0.0.1')
  cleanup.push(() => adapter.stop())
  return `http://127.0.0.1:${adapter.boundPort}`
}

/** Every value the answer carried for each header, as sent: two headers of one name stay two. */
function get(url: string): Promise<(name: string) => string[]> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, (res) => {
      res.resume()
      res.on('end', () => {
        const raw = res.rawHeaders
        resolve((name) => {
          const values: string[] = []
          for (let i = 0; i < raw.length; i += 2) {
            if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!)
          }
          return values
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const pagePath = (own: Record<string, string> = {}) =>
  `/page?set=${encodeURIComponent(JSON.stringify(own))}`

/** A CSP as directive name to its sources, in the order sent. */
function directives(policy: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of (policy ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), sources)
  }
  return out
}

describe('AC-1: the forward fills in the security headers a page lacks and never replaces the storefront’s', () => {
  // Kills: a forward that adds no response header, one that overwrites the storefront's own, and one that appends a
  // second header beside it.
  it('AC-1: property: whatever subset of the five headers the storefront answers, each reaches the client exactly once, the storefront’s byte for byte and the forward’s default for every one it left out', async () => {
    const base = await serve(await startStorefront(), HTTPS_URL)
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...FILLED]),
        fc.stringMatching(/^[a-z0-9][a-z0-9 =;'.:/-]{0,40}[a-z0-9']$/),
        async (own, value) => {
          const sent = Object.fromEntries(own.map((name) => [name, `${value} ${name}`]))
          const header = await get(`${base}${pagePath(sent)}`)

          // The floor CSP is compared by directive, so its order and spacing are the forward's to choose.
          const read = (name: Filled, values: string[]) =>
            name === 'content-security-policy' && !(name in sent)
              ? values.map((v) => directives(v))
              : values
          const expected = (name: Filled) =>
            name in sent
              ? [sent[name]]
              : name === 'content-security-policy'
                ? [FLOOR_CSP]
                : [DEFAULT_FILL[name]]
          const got = Object.fromEntries(FILLED.map((name) => [name, read(name, header(name))]))

          expect(got).toEqual(Object.fromEntries(FILLED.map((name) => [name, expected(name)])))
        },
      ),
      {
        numRuns: 30,
        examples: [
          [[], 'x'],
          [['content-security-policy', 'referrer-policy'], "default-src 'self'"],
        ],
      },
    )
  })

  // Kills: HSTS sent over a plain-http store (a browser pinned to https for a year on a store that has none), or sent
  // when the store turned it off; X-Frame-Options not following the config.
  it('AC-1: HSTS is filled in exactly when the public URL is https and hsts is on, and X-Frame-Options follows xFrameOptions', async () => {
    const storefront = await startStorefront()
    const seen: Array<{ publicUrl: string; hsts: boolean; xfo: string; got: string[] }> = []
    const want: typeof seen = []
    for (const publicUrl of [HTTPS_URL, HTTP_URL]) {
      for (const hsts of [true, false]) {
        for (const xFrameOptions of ['deny', 'sameorigin'] as const) {
          const base = await serve(storefront, publicUrl, {
            hsts,
            referrerPolicy: 'no-referrer',
            xFrameOptions,
          })
          const header = await get(`${base}${pagePath()}`)
          const xfo = xFrameOptions === 'deny' ? 'DENY' : 'SAMEORIGIN'
          const https = new URL(publicUrl).protocol === 'https:'
          seen.push({
            publicUrl,
            hsts,
            xfo: header('x-frame-options').join(', '),
            got: header('strict-transport-security').concat(header('referrer-policy')),
          })
          want.push({
            publicUrl,
            hsts,
            xfo,
            got: (https && hsts ? [HSTS] : []).concat(['no-referrer']),
          })
        }
      }
    }

    expect(seen).toEqual(want)
  })

  // Kills: the forward's floor written over an API answer, or the API's strict policy and the floor sent together.
  it('AC-1: an /api/ answer keeps the API’s own strict policy, once, while a page with none gets the floor in its place', async () => {
    const base = await serve(await startStorefront(), HTTPS_URL)
    const apiOwn = buildSecurityHeaders(security)['content-security-policy']

    const api = await get(`${base}/api/ping`)
    const page = await get(`${base}${pagePath()}`)

    expect(api('content-security-policy')).toEqual([apiOwn])
    expect(page('content-security-policy')).toHaveLength(1)
    expect(page('content-security-policy')[0]).not.toBe(apiOwn)
    expect(directives(page('content-security-policy')[0])).toEqual(FLOOR_CSP)
  })
})
