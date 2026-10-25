import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_KEYS } from '@nymbalhq/types'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { createFixtureSearchAdapter } from '../../../../tests/e2e/fixtures/custom-providers/adapters.js'

// AC-1 and AC-3's integration half, over HTTP against a kernel built from `src/`. GET /api/capabilities is public and
// reports what the configured adapters can do, never a provider name or a secret; GET /api/products sends no `facets`
// when the search adapter lacks `facet`. Needs the adapter packages built (the Stripe kernel loads
// @nymbalhq/adapter-stripe).

interface Report {
  payments: {
    capabilities: string[]
    client: { driver: string; options: Record<string, string> } | null
  }
  search: { capabilities: string[] }
  catalog: { sortKeys: string[]; defaultSort: string }
}

const logger = createLogger({ pretty: false, level: 'error' })

async function getJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; text: string; body: { data?: unknown } }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body: { data?: unknown } = {}
  try {
    body = JSON.parse(text) as { data?: unknown }
  } catch {
    // A non-JSON answer (a 404 page) leaves the body empty; the status says what happened.
  }
  return { status: res.status, text, body }
}

async function capabilitiesOf(served: ServedKernel): Promise<Report> {
  const res = await getJson(served.baseUrl, '/api/capabilities')
  expect(res.status, `GET /api/capabilities: ${res.text.slice(0, 300)}`).toBe(200)
  return res.body.data as Report
}

/** Every key anywhere in a JSON value, and every string value, for the leak scan. */
function walk(value: unknown, keys: string[] = [], strings: string[] = []) {
  if (typeof value === 'string') strings.push(value)
  else if (Array.isArray(value)) for (const v of value) walk(v, keys, strings)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k)
      walk(v, keys, strings)
    }
  }
  return { keys, strings }
}

const FORBIDDEN_KEYS = ['provider', 'providerName', 'secretKey', 'webhookSecret']

function withCustom(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: { provider: 'custom' },
      search: { provider: 'custom' },
    },
  }
}

function withStripe(paymentsConfig: Record<string, string>) {
  return (config: NymbalConfig): NymbalConfig => ({
    ...config,
    commerce: { ...config.commerce, payments: { provider: 'stripe', config: paymentsConfig } },
  })
}

type ClientShape = 'absent' | 'null' | { driver: string; options: Record<string, string> }

const arbClient: fc.Arbitrary<ClientShape> = fc.oneof(
  fc.constant('absent' as const),
  fc.constant('null' as const),
  fc.record({
    driver: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
    options: fc.dictionary(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/),
      fc.stringMatching(/^[a-zA-Z0-9_.-]{0,24}$/).filter((v) => !/^(sk_|whsec_)/.test(v)),
      { maxKeys: 3 },
    ),
  }),
)

const arbSearchCaps = fc.subarray(['index', 'search', 'facet', 'caps-extra'])
const arbPaymentCaps = fc.subarray(['intent', 'capture', 'refund', 'webhook', 'caps-extra'])

/** A payments adapter of the project's own: the stub's behaviour, with the generated client half and capabilities. */
function injectedPayments(tag: string, caps: string[], client: ClientShape) {
  // The stub's own client() reports test-mode; an adapter without a client half must not inherit it.
  const { client: _stubClient, ...stub } = createNativeStubPaymentsAdapter({ logger })
  return {
    ...stub,
    providerName: `caps-payments-${tag}`,
    capabilities: () => caps,
    ...(client === 'absent' ? {} : { client: () => (client === 'null' ? null : client) }),
  }
}

function injectedSearch(tag: string, caps: string[]) {
  return {
    ...createFixtureSearchAdapter(),
    providerName: `caps-search-${tag}`,
    capabilities: () => caps,
  }
}

describe('AC-1: GET /api/capabilities on the native config', () => {
  let served: ServedKernel

  beforeAll(async () => {
    served = await serveKernel(await createKernel({ dialect: 'sqlite' }))
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-1: answers without a session: payments client test-mode, search with facet, sort keys PRODUCT_SORT_KEYS in order', async () => {
    const report = await capabilitiesOf(served)
    const adapters = served.kernel.app.adapters

    expect(report.payments.client).toEqual({ driver: 'test-mode', options: {} })
    expect(report.payments.capabilities).toEqual([...adapters.payments.capabilities()])
    expect(report.search.capabilities).toEqual([...adapters.search.capabilities()])
    expect(report.search.capabilities).toContain('facet')
    expect(report.catalog.sortKeys).toEqual([...PRODUCT_SORT_KEYS])
    expect(report.catalog.defaultSort).toBe(DEFAULT_PRODUCT_SORT)
    expect(report.catalog.sortKeys).toContain(report.catalog.defaultSort)
  })

  it('AC-1: the native report names no provider: no provider or providerName key, and no adapter providerName value', async () => {
    const report = await capabilitiesOf(served)
    const { keys, strings } = walk(report)
    const names = [
      served.kernel.app.adapters.payments.providerName,
      served.kernel.app.adapters.search.providerName,
    ]

    expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([])
    expect(strings.filter((s) => names.includes(s))).toEqual([])
  })
})

describe('AC-1: the report is what the injected adapters return', () => {
  const opened: ServedKernel[] = []

  afterEach(async () => {
    for (const s of opened.splice(0)) await s.stop()
  })

  it('AC-1: over generated payments client halves (absent, null, a driver) and capability sets, the route reports exactly the adapters’ own answers and never their provider names', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        arbClient,
        arbPaymentCaps,
        arbSearchCaps,
        async (client, paymentCaps, searchCaps) => {
          run += 1
          const tag = `r${run}`
          const payments = injectedPayments(tag, paymentCaps, client)
          const search = injectedSearch(tag, searchCaps)
          const served = await serveKernel(
            await createKernel({
              dialect: 'sqlite',
              configure: withCustom,
              appOptions: { adapters: { payments, search } },
            }),
          )
          opened.push(served)

          const report = await capabilitiesOf(served)

          expect(report.payments.capabilities).toEqual(paymentCaps)
          expect(report.payments.client).toEqual(
            client === 'absent' || client === 'null' ? null : client,
          )
          expect(report.search.capabilities).toEqual(searchCaps)
          expect(report.catalog.sortKeys).toEqual([...PRODUCT_SORT_KEYS])
          const { keys, strings } = walk(report)
          expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([])
          expect(
            strings.filter((s) => s === payments.providerName || s === search.providerName),
          ).toEqual([])

          await served.stop()
          opened.splice(opened.indexOf(served), 1)
        },
      ),
      { numRuns: 25 },
    )
  }, 180_000)
})

describe('AC-1: a Stripe store leaks no secret', () => {
  const opened: ServedKernel[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const s of opened.splice(0)) await s.stop()
  })

  const SECRET = 'sk_test_caps_never_served'
  const WEBHOOK = 'whsec_caps_never_served'

  it('AC-1: with Stripe configured with fake secrets, the body has the publishable key as the stripe client and no provider, providerName, secretKey or webhookSecret key, and no sk_ or whsec_ value', async () => {
    const served = await serveKernel(
      await createKernel({
        dialect: 'sqlite',
        configure: withStripe({
          secretKey: SECRET,
          webhookSecret: WEBHOOK,
          publishableKey: 'pk_test_caps_config',
        }),
      }),
    )
    opened.push(served)
    expect(served.kernel.app.adapters.payments.providerName).toBe('stripe')

    const res = await getJson(served.baseUrl, '/api/capabilities')
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    const report = res.body.data as Report
    const { keys, strings } = walk(res.body)

    expect(report.payments.client).toEqual({
      driver: 'stripe',
      options: { publishableKey: 'pk_test_caps_config' },
    })
    expect(report.payments.capabilities).toEqual([
      ...served.kernel.app.adapters.payments.capabilities(),
    ])
    expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([])
    expect(strings.filter((s) => /^(sk_|whsec_)/.test(s))).toEqual([])
    expect(res.text.includes(SECRET) || res.text.includes(WEBHOOK)).toBe(false)
  }, 60_000)

  it('AC-1: with no publishableKey in the Stripe config, the stripe client takes STRIPE_PUBLISHABLE_KEY from the environment', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_caps_env')
    const served = await serveKernel(
      await createKernel({
        dialect: 'sqlite',
        configure: withStripe({ secretKey: SECRET, webhookSecret: WEBHOOK }),
      }),
    )
    opened.push(served)

    const report = await capabilitiesOf(served)

    expect(report.payments.client).toEqual({
      driver: 'stripe',
      options: { publishableKey: 'pk_test_caps_env' },
    })
  }, 60_000)
})

describe('AC-3: GET /api/products sends facets only when search can facet', () => {
  const opened: ServedKernel[] = []

  afterEach(async () => {
    for (const s of opened.splice(0)) await s.stop()
  })

  it('AC-3: over generated search capability sets, the listing carries facets iff the search adapter reports facet', async () => {
    let run = 0
    const seen = { with: 0, without: 0 }
    await fc.assert(
      fc.asyncProperty(arbSearchCaps, async (searchCaps) => {
        run += 1
        const served = await serveKernel(
          await createKernel({
            dialect: 'sqlite',
            configure: (config) => ({
              ...config,
              commerce: { ...config.commerce, search: { provider: 'custom' } },
            }),
            appOptions: { adapters: { search: injectedSearch(`f${run}`, searchCaps) } },
          }),
        )
        opened.push(served)

        const res = await getJson(served.baseUrl, '/api/products')
        expect(res.status, res.text.slice(0, 300)).toBe(200)
        const data = res.body.data as Record<string, unknown>
        const canFacet = searchCaps.includes('facet')
        seen[canFacet ? 'with' : 'without'] += 1

        expect(Array.isArray(data['items'])).toBe(true)
        expect(Object.hasOwn(data, 'facets'), `capabilities ${JSON.stringify(searchCaps)}`).toBe(
          canFacet,
        )

        await served.stop()
        opened.splice(opened.indexOf(served), 1)
      }),
      {
        numRuns: 15,
        // Both branches every time: one set with facet and one without lead the generated ones.
        examples: [[['index', 'search']], [['index', 'search', 'facet']]],
      },
    )
    expect(Math.min(seen.with, seen.without)).toBeGreaterThan(0)
  }, 180_000)
})

// AC-7: the report says whether the store's email delivers: false for the `native` adapter, which only logs, and true
// for `smtp` and for any custom adapter, whatever its name. The answer names no provider.
describe('AC-7: GET /api/capabilities reports whether email delivers', () => {
  const opened: ServedKernel[] = []

  afterEach(async () => {
    for (const s of opened.splice(0)) await s.stop()
  })

  /** An email adapter of the project's own, under a generated provider name. */
  function injectedEmail(providerName: string) {
    return {
      kind: 'email' as const,
      providerName,
      capabilities: () => ['transactional'],
      producesEvents: [],
      consumesEvents: [],
      initialize: async () => undefined,
      healthCheck: async () => ({ status: 'healthy' as const }),
      sendTransactional: async () => ({ messageId: null, accepted: true }),
      syncCustomerToList: async () => undefined,
      removeCustomerFromList: async () => undefined,
    }
  }

  async function emailReport(served: ServedKernel): Promise<{ email?: { delivers?: unknown } }> {
    opened.push(served)
    return (await capabilitiesOf(served)) as Report & { email?: { delivers?: unknown } }
  }

  it('AC-7: the native email store reports email.delivers false; an smtp store reports true; neither names its provider', async () => {
    const native = await emailReport(await serveKernel(await createKernel({ dialect: 'sqlite' })))
    const smtp = await emailReport(
      await serveKernel(
        await createKernel({
          dialect: 'sqlite',
          configure: (config) => ({
            ...config,
            commerce: {
              ...config.commerce,
              email: {
                provider: 'smtp',
                config: { from: 'store@alerts.test', smtp: { host: '127.0.0.1', port: 2525 } },
              },
            },
          }),
        }),
      ),
    )

    expect([native.email?.delivers, smtp.email?.delivers]).toEqual([false, true])
    for (const report of [native, smtp]) {
      const { keys, strings } = walk(report)
      expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([])
      expect(strings.filter((s) => s === 'native' || s === 'smtp')).toEqual([])
    }
  }, 60_000)

  it('AC-7: property: over generated provider names other than native, a custom email adapter reports email.delivers true and the name appears nowhere in the report', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Prefixed, so a generated name never equals a capability or sort key the report rightly holds.
        fc.stringMatching(/^mailer-[a-z0-9-]{1,12}$/),
        async (providerName) => {
          const report = await emailReport(
            await serveKernel(
              await createKernel({
                dialect: 'sqlite',
                configure: (config) => ({
                  ...config,
                  commerce: { ...config.commerce, email: { provider: 'custom' } },
                }),
                appOptions: { adapters: { email: injectedEmail(providerName) } },
              }),
            ),
          )
          expect(report.email?.delivers, providerName).toBe(true)
          const { keys, strings } = walk(report)
          expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([])
          expect(strings.filter((s) => s === providerName)).toEqual([])
          await opened.pop()!.stop()
        },
      ),
      { numRuns: 10 },
    )
  }, 180_000)
})
