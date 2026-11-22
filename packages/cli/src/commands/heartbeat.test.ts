import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLI_BIN,
  cliEnv,
  closedPort,
  freePort,
  runCli,
  stripAnsi,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import { storeConfig, storeProject, type StoreProject } from '../../../../tests/support/start.js'
import { startStripeFake, type StripeFake } from '../../../../tests/fixtures/stripe-api/server.mjs'
import { shopper } from '../../../platform/tests/support/shopper.js'

// `nymbal heartbeat` through the built CLI (`pnpm build` first), one run per call, as cron runs it. The store is
// `nymbal dev --api-only` in a project of its own with the heartbeat on (native stub payments), on a port its config
// names, so the command's default API URL reaches it. Other projects share that store's heartbeat block and API and
// differ in what a case needs: no card, a card on an adapter that records being used, a heartbeat address the store does
// not know, a misconfiguration, or Stripe pointed at the offline fake. Each run is read by its exit status, its two
// streams and what the store holds afterwards.

const HEARTBEAT = `heartbeat-${randomUUID().slice(0, 8)}@shop.example`
const ADMIN = { email: `admin-${randomUUID()}@heartbeat.test`, password: 'heartbeat-correct-horse' }
const ADDRESS = {
  firstName: 'Heartbeat',
  lastName: 'Check',
  addressLine1: '9 Monitor Row',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}
const STRIPE_SECRET = 'sk_test_heartbeat_cli'
const RUN_MS = 60_000

const STORE_OK = /^heartbeat: store ok: order (\S+) placed and cancelled \(\d+ ms\)$/m
const CARD_OK = /^heartbeat: card ok: .+ charged and refunded \(\d+ ms\)$/m

const projects: StoreProject[] = []
let store: { child: ChildProcess; base: string; out: () => string } | undefined
let storeDb = ''
let adminToken = ''
let stripe: StripeFake | undefined

afterAll(async () => {
  // Hygiene only, after every assertion has read what the runs left.
  store?.child.kill('SIGKILL')
  await stripe?.close().catch(() => undefined)
  for (const p of projects) p.remove()
})

/** The store's raw config with the heartbeat block given; `http` on `port`. */
function heartbeatConfig(
  port: number,
  heartbeat: Record<string, unknown> | undefined,
  over: { features?: Record<string, unknown>; payments?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const config = storeConfig()
  return {
    ...config,
    security: {
      ...(config['security'] as Record<string, unknown>),
      rateLimit: {
        '/api/auth/login': { requests: 1000, window: '1m', action: 'block' },
        '/api/checkout': { requests: 1000, window: '1m', action: 'block' },
      },
    },
    commerce: {
      ...(config['commerce'] as Record<string, unknown>),
      ...(over.payments !== undefined && { payments: over.payments }),
    },
    http: { adapter: 'fastify', port, host: '127.0.0.1' },
    features: over.features ?? { heartbeat: true },
    ...(heartbeat !== undefined && { heartbeat }),
  }
}

function project(
  config: Record<string, unknown>,
  installed: Record<string, string> = {},
): StoreProject {
  const p = storeProject(config, installed)
  projects.push(p)
  return p
}

/** The command in `cwd`, against the store's database, as cron runs it from the project directory. */
function heartbeat(cwd: string): Promise<CliRun> {
  return runCli(['heartbeat'], {
    cwd,
    env: cliEnv({ NYMBAL_SQLITE_PATH: storeDb, NODE_ENV: undefined }),
    timeoutMs: RUN_MS - 5_000,
  })
}

const said = (run: CliRun) =>
  `exit ${run.code}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`
const lines = (text: string, pattern: RegExp) =>
  stripAnsi(text)
    .split('\n')
    .filter((l) => pattern.test(l))

async function admin<T>(
  path: string,
): Promise<{ status: number; data: T; total: number | undefined }> {
  const res = await fetch(`${store!.base}${path}`, {
    headers: { authorization: `Bearer ${adminToken}`, accept: 'application/json' },
  })
  const body = (await res.json()) as { data: T; meta?: { total?: number } }
  return { status: res.status, data: body.data, total: body.meta?.total }
}

/** Every order the store holds, by number: the admin's default list and its synthetic list, which may overlap. */
async function orderNumbers(): Promise<Set<string>> {
  const read = async (query: string) =>
    (await admin<Array<{ orderNumber: string }>>(`/api/admin/orders?limit=200${query}`)).data.map(
      (o) => o.orderNumber,
    )
  return new Set([...(await read('')), ...(await read('&source=synthetic'))])
}

let storePort = 0
let storeProjectDir = ''

beforeAll(async () => {
  storePort = await freePort()
  const p = project(
    heartbeatConfig(storePort, {
      store: { email: HEARTBEAT, address: ADDRESS },
      card: { customer: 'cus_stub_ok', paymentMethod: 'pm_stub' },
    }),
  )
  storeProjectDir = p.dir
  storeDb = join(p.dir, 'nymbal.db')
  const child = spawn(
    process.execPath,
    [CLI_BIN, 'dev', '--api-only', '--port', String(storePort)],
    {
      cwd: p.dir,
      env: cliEnv({
        NYMBAL_SQLITE_PATH: storeDb,
        NYMBAL_ADMIN_EMAIL: ADMIN.email,
        NYMBAL_ADMIN_PASSWORD: ADMIN.password,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  let gone = false
  child.once('exit', () => (gone = true))
  const base = `http://127.0.0.1:${storePort}`
  store = { child, base, out: () => stripAnsi(out) }
  const deadline = Date.now() + 90_000
  for (;;) {
    const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) break
    if (gone || Date.now() > deadline) {
      throw new Error(
        `the store did not come up (${gone ? 'exited' : 'still running'}):\n${out.slice(-3000)}`,
      )
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  const shop = shopper(base)
  const login = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', ADMIN)
  if (login.status !== 200)
    throw new Error(`admin login: ${login.status} ${JSON.stringify(login.body)}`)
  adminToken = login.body.data!.accessToken
}, 120_000)

describe('AC-13: nymbal heartbeat against the running local store', () => {
  // Kills: the command missing, printing nothing a cron mail can read, or reporting an order the store did not cancel.
  it(
    'AC-13: with heartbeat on and the stub card cus_stub_ok/pm_stub: exit 0, the store ok line names an order the store holds as a cancelled synthetic order, and the card ok line follows',
    async () => {
      const run = await heartbeat(storeProjectDir)
      expect(run.code, said(run)).toBe(0)
      const orderNumber = STORE_OK.exec(stripAnsi(run.stdout))?.[1]
      expect(orderNumber, said(run)).toMatch(/\S/)
      expect(stripAnsi(run.stdout)).toMatch(CARD_OK)
      expect(lines(run.stderr, /FAILED/)).toEqual([])
      const read = await admin<{ status: string; source: string }>(
        `/api/admin/orders/${orderNumber}`,
      )
      expect({ status: read.status, order: read.data.status, source: read.data.source }).toEqual({
        status: 200,
        order: 'cancelled',
        source: 'synthetic',
      })
    },
    RUN_MS,
  )

  // Kills: payments resolved (and its provider's keys read or its process touched) on every run with no card set.
  it(
    'AC-13: with no card ids, only the store line is printed and the project’s payments adapter is never used; with both ids the same adapter is charged',
    async () => {
      const write = (dir: string, marker: string, card: Record<string, string> | undefined) => {
        const config = heartbeatConfig(
          storePort,
          { store: { email: HEARTBEAT, address: ADDRESS }, ...(card !== undefined && { card }) },
          { payments: { provider: 'custom' } },
        )
        writeFileSync(
          join(dir, 'nymbal.config.ts'),
          [
            "import { appendFileSync } from 'node:fs'",
            `const marker = ${JSON.stringify(marker)}`,
            'const used = (what: string) => appendFileSync(marker, `${what}\\n`)',
            'const refuse = async (what: string): Promise<never> => {',
            '  used(what)',
            "  throw new Error(`${what} is not the heartbeat's`)",
            '}',
            'export const adapters = {',
            '  payments: {',
            "    kind: 'payments',",
            "    providerName: 'recording',",
            '    producesEvents: [],',
            '    consumesEvents: [],',
            "    initialize: async () => used('initialize'),",
            "    healthCheck: async () => ({ status: 'healthy' }),",
            "    capabilities: () => ['intent', 'capture', 'refund', 'saved-card'],",
            '    chargeSavedCard: async (charge: { amountMinor: number; currency: string }) => {',
            "      used('chargeSavedCard')",
            "      return { status: 'captured', paymentId: 'pi_recording', amountMinor: charge.amountMinor, currency: charge.currency }",
            '    },',
            '    refund: async (paymentId: string, amountMinor: number, reason: string, opts: { currency?: string }) => {',
            "      used('refund')",
            "      return { refundId: 're_recording', paymentId, amountMinor, currency: opts?.currency ?? 'GBP', reason: reason ?? null, status: 'succeeded' }",
            '    },',
            "    createPaymentIntent: () => refuse('createPaymentIntent'),",
            "    capturePayment: () => refuse('capturePayment'),",
            "    listRefunds: () => refuse('listRefunds'),",
            "    getPaymentStatus: () => refuse('getPaymentStatus'),",
            "    getPaymentIntent: () => refuse('getPaymentIntent'),",
            "    cancelPaymentIntent: () => refuse('cancelPaymentIntent'),",
            "    parseWebhook: () => refuse('parseWebhook'),",
            '  },',
            '}',
            `export default ${JSON.stringify(config, null, 2)}`,
            '',
          ].join('\n'),
        )
      }
      const noCard = project({})
      const withCard = project({})
      const markers = {
        noCard: join(noCard.dir, 'used.log'),
        withCard: join(withCard.dir, 'used.log'),
      }
      write(noCard.dir, markers.noCard, undefined)
      write(withCard.dir, markers.withCard, {
        customer: 'cus_recording',
        paymentMethod: 'pm_recording',
      })

      const bare = await heartbeat(noCard.dir)
      const charged = await heartbeat(withCard.dir)
      const usedBy = (marker: string) =>
        existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []

      expect(bare.code, said(bare)).toBe(0)
      expect(stripAnsi(bare.stdout)).toMatch(STORE_OK)
      expect(lines(`${bare.stdout}\n${bare.stderr}`, /^heartbeat: card /)).toEqual([])
      expect(usedBy(markers.noCard)).toEqual([])

      expect(charged.code, said(charged)).toBe(0)
      expect(stripAnsi(charged.stdout)).toMatch(CARD_OK)
      expect(usedBy(markers.withCard)).toContain('chargeSavedCard')
    },
    RUN_MS * 2,
  )

  // Kills: a misconfigured heartbeat that runs anyway (an order with no address), or fails in a way cron reads as ok.
  it(
    'AC-13: with features.heartbeat false, or heartbeat.store.email unset, the run exits 2 with one stderr line naming the cause, before any check',
    async () => {
      const off = project(
        heartbeatConfig(
          storePort,
          { store: { email: HEARTBEAT, address: ADDRESS } },
          { features: { heartbeat: false } },
        ),
      )
      const noEmail = project(heartbeatConfig(storePort, { store: { address: ADDRESS } }))
      const before = await orderNumbers()

      const offRun = await heartbeat(off.dir)
      const noEmailRun = await heartbeat(noEmail.dir)

      expect({ code: offRun.code, lines: lines(offRun.stderr, /heartbeat/) }, said(offRun)).toEqual(
        {
          code: 2,
          lines: [expect.stringContaining('features.heartbeat')],
        },
      )
      expect(
        { code: noEmailRun.code, lines: lines(noEmailRun.stderr, /heartbeat/) },
        said(noEmailRun),
      ).toEqual({
        code: 2,
        lines: [expect.stringContaining('heartbeat.store.email')],
      })
      expect(lines(`${offRun.stdout}${noEmailRun.stdout}`, /^heartbeat: (store|card) /)).toEqual([])
      expect([...(await orderNumbers())].sort()).toEqual([...before].sort())
    },
    RUN_MS * 2,
  )
})

describe('AC-11: a heartbeat address the store does not know', () => {
  // Kills: the store placing a real order for the heartbeat, reported as ok or as an ordinary failure.
  it(
    'AC-11: the checkout answers 200, so the run prints unrecognised naming the order the store placed, and exits 2',
    async () => {
      const stranger = project(
        heartbeatConfig(storePort, {
          store: { email: `stranger-${randomUUID().slice(0, 8)}@shop.example`, address: ADDRESS },
        }),
      )
      const before = await orderNumbers()
      const run = await heartbeat(stranger.dir)
      const placed = [...(await orderNumbers())].filter((n) => !before.has(n))

      expect(run.code, said(run)).toBe(2)
      expect(placed).toHaveLength(1)
      const failed = lines(run.stderr, /^heartbeat: store FAILED unrecognised: /)
      expect(failed).toHaveLength(1)
      expect(failed[0]).toContain(placed[0]!)
      const read = await admin<{ source: string }>(`/api/admin/orders/${placed[0]}`)
      expect(read.data.source).toBe('storefront')
    },
    RUN_MS,
  )
})

describe('AC-14: a payments outage meets the run that checks', () => {
  // Kills: an outage not reported in the run that meets it, reported as a card problem (or a decline as an outage),
  // or taking the store check down with it.
  it(
    'AC-14: with Stripe on the offline fake: healthy, exit 0 and card ok; a declining card, exit 1 with card_refused; the fake stopped, exit 1 with provider_unreachable; the store line is ok in every run',
    async () => {
      stripe = await startStripeFake({ host: '127.0.0.1', secretKey: STRIPE_SECRET })
      const stripeAt = (paymentMethod: string) =>
        project(
          heartbeatConfig(
            storePort,
            {
              store: { email: HEARTBEAT, address: ADDRESS },
              card: { customer: 'cus_heartbeat', paymentMethod },
            },
            {
              payments: {
                provider: 'stripe',
                config: {
                  secretKey: STRIPE_SECRET,
                  webhookSecret: 'whsec_heartbeat_cli',
                  host: '127.0.0.1',
                  port: stripe!.port,
                  protocol: 'http',
                },
              },
            },
          ),
          workspace('@nymbalhq/payments-stripe'),
        )
      const visa = stripeAt('pm_card_visa')
      const declining = stripeAt('pm_card_chargeDeclined')

      const healthy = await heartbeat(visa.dir)
      const declined = await heartbeat(declining.dir)
      await stripe.close()
      stripe = undefined
      const outage = await heartbeat(visa.dir)

      expect(healthy.code, said(healthy)).toBe(0)
      expect(stripAnsi(healthy.stdout)).toMatch(CARD_OK)
      expect(declined.code, said(declined)).toBe(1)
      expect(lines(declined.stderr, /^heartbeat: card FAILED card_refused/)).toHaveLength(1)
      expect(outage.code, said(outage)).toBe(1)
      expect(lines(outage.stderr, /^heartbeat: card FAILED provider_unreachable/)).toHaveLength(1)
      for (const run of [healthy, declined, outage]) {
        expect(stripAnsi(run.stdout), said(run)).toMatch(STORE_OK)
      }
    },
    RUN_MS * 3,
  )

  // Kills: a payments adapter that cannot be built in this run (its saved settings unreadable) ending the run as a
  // misconfiguration before the store is checked.
  it(
    'AC-14: with Stripe whose saved settings sit in a Postgres that does not answer: the store line is ok, the card check FAILED, exit 1',
    async () => {
      const [pgPort, stripePort] = [await closedPort(), await closedPort()]
      const config = heartbeatConfig(
        storePort,
        {
          store: { email: HEARTBEAT, address: ADDRESS },
          card: { customer: 'cus_heartbeat', paymentMethod: 'pm_card_visa' },
        },
        {
          payments: {
            provider: 'stripe',
            config: {
              secretKey: STRIPE_SECRET,
              webhookSecret: 'whsec_heartbeat_cli',
              host: '127.0.0.1',
              port: stripePort,
              protocol: 'http',
            },
          },
        },
      )
      const unreachable = project(
        {
          ...config,
          infrastructure: {
            ...(config['infrastructure'] as Record<string, unknown>),
            commandStore: 'postgres',
          },
        },
        workspace('@nymbalhq/payments-stripe'),
      )

      const run = await runCli(['heartbeat'], {
        cwd: unreachable.dir,
        env: cliEnv({
          DATABASE_URL: `postgres://nymbal:nymbal@127.0.0.1:${pgPort}/nymbal`,
          NODE_ENV: undefined,
        }),
        timeoutMs: RUN_MS - 5_000,
      })

      expect(run.code, said(run)).toBe(1)
      expect(stripAnsi(run.stdout), said(run)).toMatch(STORE_OK)
      expect(lines(run.stderr, /^heartbeat: /), said(run)).toEqual([
        expect.stringMatching(
          /^heartbeat: card FAILED failed: the payments adapter did not build: /,
        ),
      ])
    },
    RUN_MS,
  )

  // Kills: a payments key set nowhere reported as a passing or ordinary failed run, as a provider that cannot charge a
  // saved card (naming no key), or ending the run before the store is checked.
  it(
    'AC-13: with Stripe whose secret key is set nowhere and both card ids set: the store line is ok, then one refusal naming the key, exit 2',
    async () => {
      const keyless = project(
        heartbeatConfig(
          storePort,
          {
            store: { email: HEARTBEAT, address: ADDRESS },
            card: { customer: 'cus_heartbeat', paymentMethod: 'pm_card_visa' },
          },
          {
            payments: {
              provider: 'stripe',
              config: {
                webhookSecret: 'whsec_heartbeat_cli',
                host: '127.0.0.1',
                port: await closedPort(),
                protocol: 'http',
              },
            },
          },
        ),
        workspace('@nymbalhq/payments-stripe'),
      )

      const run = await runCli(['heartbeat'], {
        cwd: keyless.dir,
        env: cliEnv({
          NYMBAL_SQLITE_PATH: storeDb,
          NODE_ENV: undefined,
          STRIPE_SECRET_KEY: undefined,
        }),
        timeoutMs: RUN_MS - 5_000,
      })

      expect(run.code, said(run)).toBe(2)
      expect(stripAnsi(run.stdout), said(run)).toMatch(STORE_OK)
      expect(lines(run.stderr, /^heartbeat: /), said(run)).toEqual([
        expect.stringContaining('payments.secretKey'),
      ])
    },
    RUN_MS,
  )
})
