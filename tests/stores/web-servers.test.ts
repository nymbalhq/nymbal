import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger } from '../../packages/types/src/index.js'
import { webServerRecipe } from '../../packages/cli/src/commands/deploy-web-server.js'
import { FastifyHttpAdapter } from '../../packages/http/src/fastify-adapter.js'

// The web server configs `nymbal deploy nginx|apache|caddy` writes, run in each server's own image (pinned by digest)
// in front of an API this test serves on the host. Each config is rendered for https://shop.example with the upstream
// a container reaches the host at; the exact 127.0.0.1:<PORT> text is the CLI test's. nginx and Apache get a test
// certificate at the rendered Let's Encrypt paths; Caddy gets `local_certs` (and `skip_install_trust`) added to the
// rendered file's global options block, or a block of its own when the render opens with none, and the rendered file
// is otherwise unchanged. Apache's wrapper loads the modules the steps enable (a2enmod) and the
// HTTPS listener a distribution's ports.conf holds, then includes the rendered file. The API lists loopback and
// uniquelocal, where a container's connection reaches the host from (Docker Desktop and Linux bridges).
// Needs Docker; pulls about 100 MB on the first run.

const exec = promisify(execFile)

const IMAGES = {
  nginx: 'nginx@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de',
  apache: 'httpd@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c',
  caddy: 'caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
} as const
type WebServer = keyof typeof IMAGES
const SERVERS = Object.keys(IMAGES) as WebServer[]

const SITE = 'shop.example'
const PUBLIC_URL = `https://${SITE}`
const SPOOFED = '203.0.113.9'
/** A client-written entry left of the one the CDN appended in an X-Forwarded-For chain. */
const FORGED = '198.51.100.66'
/** The CDN's ranges for (b): the private ones, which hold the Docker host gateway the test client arrives from. */
const CDN_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']
/** How long the API holds a stream open after its first event when the client never says it arrived. */
const STREAM_HOLD_MS = 6000
/** The bound on a stream event's trip through the web server. */
const STREAM_WITHIN_MS = 2000

const silent = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silent
  },
} as unknown as Logger

/** A JSON answer of about 4 KB that compresses well. */
const BIG = {
  items: Array.from({ length: 64 }, (_, i) => ({ i, name: `item-${i}`, note: 'x'.repeat(40) })),
}

interface Api {
  port: number
  /** When the API wrote stream `id`'s first event. */
  writtenAt(id: string): number | undefined
  /** Ends stream `id` now: its client has the first event. */
  release(id: string): void
  stop(): Promise<void>
}

async function startApi(): Promise<Api> {
  const adapter = new FastifyHttpAdapter({
    logger: silent,
    security: securitySchema.parse({ adapter: 'middleware', csrf: false }),
    trustedProxies: ['loopback', 'uniquelocal'],
  })
  adapter.registerRoute('GET', '/api/echo', async (ctx) => ({
    status: 200,
    body: {
      ip: ctx.ip,
      forwardedFor: ctx.headers['x-forwarded-for'] ?? null,
      realIp: ctx.headers['x-real-ip'] ?? null,
      proto: ctx.headers['x-forwarded-proto'] ?? null,
    },
  }))
  adapter.registerRoute('GET', '/api/big', async () => ({ status: 200, body: BIG }))
  // Cacheable on purpose: a server that caches responses would serve one shopper's answer to the next.
  adapter.registerRoute('GET', '/api/cookie', async (ctx) => ({
    status: 200,
    headers: { 'cache-control': 'public, max-age=300' },
    body: { cookie: ctx.headers.cookie ?? null },
  }))
  const streams = new Map<string, { writtenAt: number; end: () => void }>()
  adapter.registerStreamRoute('GET', '/api/stream', (ctx, stream) => {
    const id = String(ctx.query['id'])
    stream.send({ event: 'first', data: { id } })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      stream.send({ event: 'last', data: { id } })
      stream.close()
    }
    const timer = setTimeout(end, STREAM_HOLD_MS)
    streams.set(id, { writtenAt: Date.now(), end })
  })
  await adapter.start(0, '0.0.0.0')
  return {
    port: adapter.boundPort,
    writtenAt: (id) => streams.get(id)?.writtenAt,
    release: (id) => streams.get(id)?.end(),
    stop: () => adapter.stop(),
  }
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** One HTTPS request to the web server for https://shop.example, certificate unchecked. */
function https(port: number, path: string, headers: OutgoingHttpHeaders = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        servername: SITE,
        headers: { host: SITE, ...headers },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function plainHttp(port: number, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host: SITE }, agent: false },
      (res) => {
        res.resume()
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.alloc(0) }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

interface Echo {
  ip: string
  forwardedFor: string | null
  realIp: string | null
  proto: string | null
}

async function echo(port: number, headers: OutgoingHttpHeaders = {}): Promise<Echo> {
  const res = await https(port, '/api/echo', headers)
  expect(res.status, res.body.toString()).toBe(200)
  return JSON.parse(res.body.toString()) as Echo
}

interface Streamed {
  receivedAt: number
  /** Whether the first event arrived while the stream was still open: before its last event and its end. */
  beforeEnd: boolean
  encoding: string | undefined
}

/** Reads /api/stream?id=<id> through the web server; releases the stream once its first event is in. */
function stream(port: number, id: string, api: Api): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api/stream?id=${id}`,
        servername: SITE,
        headers: { host: SITE, accept: 'text/event-stream', 'accept-encoding': 'gzip' },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        let text = ''
        let receivedAt = 0
        let beforeEnd = false
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (receivedAt === 0 && text.includes('event: first')) {
            receivedAt = Date.now()
            beforeEnd = !text.includes('event: last')
            api.release(id)
          }
        })
        res.on('end', () =>
          resolve({ receivedAt, beforeEnd, encoding: res.headers['content-encoding'] }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'nymbal-web-servers-'))
const started: string[] = []

/** A self-signed certificate for shop.example, as Let's Encrypt lays it out under live/<host>/. */
async function certificate(): Promise<string> {
  const dir = mkdtempSync(join(scratch, 'live-'))
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-keyout',
    join(dir, 'privkey.pem'),
    '-out',
    join(dir, 'fullchain.pem'),
    '-subj',
    `/CN=${SITE}`,
    '-addext',
    `subjectAltName=DNS:${SITE}`,
  ])
  // The container's server reads it as its own user.
  chmodSync(join(dir, 'privkey.pem'), 0o644)
  return dir
}

const APACHE_WRAPPER = [
  'Listen 443',
  ...[
    'ssl',
    'socache_shmcb',
    'proxy',
    'proxy_http',
    'proxy_wstunnel',
    'headers',
    'remoteip',
    'deflate',
    'rewrite',
    'http2',
  ].map((m) => `LoadModule ${m}_module modules/mod_${m}.so`),
  'ServerName localhost',
  'Include conf/nymbal-site.conf',
  '',
].join('\n')

const CADDY_TEST_OPTIONS = ['\tlocal_certs', '\tskip_install_trust']

/**
 * The rendered Caddyfile with the test's certificate options in its global block: inserted into the block the render
 * opens with (its first line that is neither blank nor a comment is a lone `{`), or prepended as one of their own.
 */
function withTestCertificates(rendered: string): string {
  const lines = rendered.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (first >= 0 && lines[first]!.trim() === '{') {
    return [...lines.slice(0, first + 1), ...CADDY_TEST_OPTIONS, ...lines.slice(first + 1)].join(
      '\n',
    )
  }
  return ['{', ...CADDY_TEST_OPTIONS, '}', '', rendered].join('\n')
}

interface Running {
  https: number
  http: number
}

/** The server's container running `content` as the store's config, its ports 443 and 80 on loopback. */
async function run(server: WebServer, content: string, live: string): Promise<Running> {
  const dir = mkdtempSync(join(scratch, `${server}-`))
  const site = join(dir, 'site')
  writeFileSync(site, server === 'caddy' ? withTestCertificates(content) : content)
  const certs = ['-v', `${live}:/etc/letsencrypt/live/${SITE}:ro`]
  const mounts: Record<WebServer, string[]> = {
    nginx: [...certs, '-v', `${site}:/etc/nginx/conf.d/default.conf:ro`],
    apache: [
      ...certs,
      '-v',
      `${site}:/usr/local/apache2/conf/nymbal-site.conf:ro`,
      '-v',
      `${join(dir, 'wrapper')}:/usr/local/apache2/conf/nymbal-test.conf:ro`,
    ],
    caddy: ['-v', `${site}:/etc/caddy/Caddyfile:ro`],
  }
  if (server === 'apache') writeFileSync(join(dir, 'wrapper'), APACHE_WRAPPER)
  const command =
    server === 'apache' ? ['httpd-foreground', '-c', 'Include conf/nymbal-test.conf'] : []
  const name = `nymbal-web-servers-${server}-${randomBytes(4).toString('hex')}`
  await exec('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--add-host=host.docker.internal:host-gateway',
    '-p',
    '127.0.0.1::443',
    '-p',
    '127.0.0.1::80',
    ...mounts[server],
    IMAGES[server],
    ...command,
  ])
  started.push(name)
  /** Why the container is not serving: its state and its own log. */
  const diagnosis = async (what: string): Promise<Error> => {
    const state = await exec('docker', [
      'inspect',
      '-f',
      '{{.State.Status}} exit {{.State.ExitCode}}',
      name,
    ])
      .then((r) => r.stdout.trim())
      .catch(() => 'unknown')
    const logs = await exec('docker', ['logs', name]).catch(
      (e: { stdout?: string; stderr?: string }) => e,
    )
    return new Error(
      `${server} ${what} (container ${state}):\n${logs.stdout ?? ''}${logs.stderr ?? ''}`,
    )
  }
  const port = async (inner: number): Promise<number> => {
    const out = await exec('docker', ['port', name, `${inner}/tcp`]).catch(() => null)
    if (out === null) throw await diagnosis(`published no port ${inner}`)
    return Number(out.stdout.trim().split('\n')[0]!.split(':').pop())
  }
  const running = { https: await port(443), http: await port(80) }
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      if ((await https(running.https, '/api/echo')).status === 200) return running
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw await diagnosis('did not answer /api/echo within 60 s')
    await new Promise((r) => setTimeout(r, 250))
  }
}

let api: Api
let live = ''
beforeAll(async () => {
  api = await startApi()
  live = await certificate()
}, 60_000)

afterAll(async () => {
  if (started.length > 0) await exec('docker', ['rm', '-f', ...started]).catch(() => {})
  await api?.stop()
  rmSync(scratch, { recursive: true, force: true })
}, 60_000)

describe.each(SERVERS)('AC-13: the %s config works in front of the API', (server) => {
  let plain: Running
  let cdn: Running
  let cdnChain: Running
  beforeAll(async () => {
    const upstream = `host.docker.internal:${api.port}`
    plain = await run(
      server,
      webServerRecipe(server, { publicUrl: PUBLIC_URL, upstream }).content,
      live,
    )
    cdn = await run(
      server,
      webServerRecipe(server, {
        publicUrl: PUBLIC_URL,
        upstream,
        realIpFrom: CDN_RANGES,
        realIpHeader: 'CF-Connecting-IP',
      }).content,
      live,
    )
    cdnChain = await run(
      server,
      webServerRecipe(server, { publicUrl: PUBLIC_URL, upstream, realIpFrom: CDN_RANGES }).content,
      live,
    )
  }, 300_000)

  it(`AC-13 (a): through ${server}, a request carrying X-Forwarded-For, X-Real-IP and True-Client-IP of ${SPOOFED} and X-Forwarded-Proto http resolves to the same address as one carrying none; the API receives one X-Forwarded-For address equal to it and to X-Real-IP, and X-Forwarded-Proto https`, async () => {
    const bare = await echo(plain.https)
    const spoofed = await echo(plain.https, {
      'x-forwarded-for': SPOOFED,
      'x-real-ip': SPOOFED,
      'true-client-ip': SPOOFED,
      'x-forwarded-proto': 'http',
    })

    expect(spoofed.ip).toBe(bare.ip)
    expect(spoofed.ip).not.toBe(SPOOFED)
    expect(spoofed.forwardedFor).toBe(spoofed.ip)
    expect(spoofed.realIp).toBe(spoofed.ip)
    expect([bare.proto, spoofed.proto]).toEqual(['https', 'https'])
  })

  it(`AC-13 (b): rendered with realIpFrom the private ranges (where the test client, standing in for the CDN, reaches the container from) and realIpHeader CF-Connecting-IP, ${server} resolves a request with CF-Connecting-IP ${SPOOFED} to it, while the plain render resolves the same request to its own address`, async () => {
    const headers = { 'cf-connecting-ip': SPOOFED }
    const throughCdnStep = await echo(cdn.https, headers)
    const throughPlain = await echo(plain.https, headers)
    const plainBare = await echo(plain.https)

    expect(throughCdnStep.ip).toBe(SPOOFED)
    expect(throughCdnStep.forwardedFor).toBe(SPOOFED)
    expect(throughPlain.ip).toBe(plainBare.ip)
  })

  it(`AC-13 (b): rendered with realIpFrom the private ranges and no realIpHeader, ${server} reads X-Forwarded-For from the right: ${FORGED}, ${SPOOFED} resolves to ${SPOOFED}, the address the CDN appended, never the client-written ${FORGED}`, async () => {
    const chained = await echo(cdnChain.https, { 'x-forwarded-for': `${FORGED}, ${SPOOFED}` })

    expect(chained.ip).not.toBe(FORGED)
    expect(chained.ip).toBe(SPOOFED)
    expect(chained.forwardedFor).toBe(SPOOFED)
  })

  it(`AC-13 (c): a stream event the API writes reaches the client through ${server} within 2 s of the write, before the stream ends, uncompressed`, async () => {
    const id = randomBytes(6).toString('hex')

    const got = await stream(plain.https, id, api)
    const writtenAt = api.writtenAt(id) ?? Number.NaN

    expect(got.beforeEnd).toBe(true)
    expect(got.receivedAt - writtenAt).toBeLessThan(STREAM_WITHIN_MS)
    expect(got.encoding).toBeUndefined()
  }, 20_000)

  it(`AC-13 (d): through ${server}, a 4 KB JSON answer asked for with Accept-Encoding gzip arrives gzip-encoded and decodes to the API's body; two requests with different cookies each get their own body`, async () => {
    const big = await https(plain.https, '/api/big', { 'accept-encoding': 'gzip' })
    const first = await https(plain.https, '/api/cookie', { cookie: 'shopper=first' })
    const second = await https(plain.https, '/api/cookie', { cookie: 'shopper=second' })

    expect(big.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(big.body).toString())).toEqual(BIG)
    expect(big.body.length).toBeLessThan(JSON.stringify(BIG).length)
    expect([first, second].map((r) => JSON.parse(r.body.toString()) as { cookie: string })).toEqual(
      [{ cookie: 'shopper=first' }, { cookie: 'shopper=second' }],
    )
  })

  it(`AC-13 (e): http:// on ${server}'s port 80 redirects to https://shop.example`, async () => {
    const res = await plainHttp(plain.http, '/api/echo?from=http')

    expect([301, 302, 307, 308]).toContain(res.status)
    expect(res.headers.location).toMatch(/^https:\/\/shop\.example(\/|$)/)
  })
})
