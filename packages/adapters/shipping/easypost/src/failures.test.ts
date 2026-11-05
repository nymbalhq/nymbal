import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport, Logger, ShippingAdapter } from '@nymbalhq/types'
import { createEasyPostShippingAdapter } from './index.js'
import {
  closedApiBase,
  FAKE_EASYPOST_API_KEY,
  startFakeEasyPost,
  type EasyPostRoute,
  type FakeAnswer,
  type FakeEasyPost,
} from './tests/fake-easypost.js'
import { codeOf, FROM, outcomeOf, recordingLogger, silent, stringsIn, TO } from './tests/support.js'

// What each EasyPost failure means to the store. A 4xx but 429 is EasyPost refusing for good: rate and createLabel
// reject adapter.shipping.refused and startTracking answers refused, each with EasyPost's message, so the relay does
// not retry what will never pass. A 429, a 5xx, a closed port or no answer in time is an outage: every method rejects
// adapter.shipping.unavailable within timeoutMs, and health answers down, so the relay holds the event instead of
// counting its failures. A key EasyPost refuses is degraded, not down: a permanent outage would keep every failure
// from counting. The API key appears in no error, log line or health detail.

const TIMEOUT_MS = 300
const GRACE_MS = 1000
const REFUSAL = 'Tracking code is not valid for this carrier.'
const EASYPOST_ERROR = (status: number): FakeAnswer => ({
  status,
  body: { error: { code: `E${status}`, message: REFUSAL, errors: [] } },
})

let fake: FakeEasyPost
let dead = ''

beforeAll(async () => {
  fake = await startFakeEasyPost()
  dead = await closedApiBase()
})
afterEach(() => fake.clear())
afterAll(async () => {
  await fake.close()
})

function easypost(
  opts: {
    apiKey?: string
    apiBase?: string
    /** `default` leaves timeoutMs unset, so the adapter's own 10 s applies. */
    timeoutMs?: number | 'default'
    logger?: Logger
    webhookSecret?: string
  } = {},
): ShippingAdapter {
  return createEasyPostShippingAdapter({
    logger: opts.logger ?? silent,
    config: {
      apiKey: opts.apiKey ?? FAKE_EASYPOST_API_KEY,
      apiBase: opts.apiBase ?? fake.apiBase,
      ...(opts.timeoutMs !== 'default' && { timeoutMs: opts.timeoutMs ?? TIMEOUT_MS }),
      ...(opts.webhookSecret !== undefined && { webhookSecret: opts.webhookSecret }),
    },
  })
}

type Method = 'rate' | 'createLabel' | 'startTracking'

/** The route each method's failure is forced on: a label's buy, after a rate the fake answered. */
const ROUTE: Record<Method, EasyPostRoute> = {
  rate: 'shipments.create',
  createLabel: 'shipments.buy',
  startTracking: 'trackers.create',
}

/** Calls `method` as the kernel would; createLabel first gets a real rate id while the fake still answers. */
async function call(a: ShippingAdapter, method: Method, rateId?: string): Promise<unknown> {
  if (method === 'rate') return a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } })
  if (method === 'createLabel')
    return a.createLabel!({ rateId: rateId ?? 'shp_closed:rate_closed' })
  return a.startTracking!({ trackingNumber: '9400100000000000000007', carrier: 'USPS' })
}

async function rateIdFrom(a: ShippingAdapter): Promise<string> {
  const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } })
  return rates[0]!.id
}

const METHODS: Method[] = ['rate', 'createLabel', 'startTracking']

describe('AC-9: a refusal is permanent, never retried', () => {
  it.each([400, 422])(
    'AC-9: a %i from EasyPost: rate and createLabel reject adapter.shipping.refused with EasyPost’s error.message, startTracking answers refused with it',
    async (status) => {
      const outcomes: Array<[Method, unknown, string]> = []
      for (const method of METHODS) {
        const a = easypost()
        const rateId = method === 'createLabel' ? await rateIdFrom(a) : undefined
        fake.answer(ROUTE[method], EASYPOST_ERROR(status))
        const { value, error } = await outcomeOf(() => call(a, method, rateId))
        fake.clear()
        outcomes.push([
          method,
          error === undefined ? value : codeOf(error),
          error === undefined
            ? ((value as { reason?: string }).reason ?? '')
            : (error as Error).message,
        ])
      }

      expect(
        outcomes.map(([m, o]) => [
          m,
          typeof o === 'string' ? o : (o as { status?: unknown }).status,
        ]),
      ).toEqual([
        ['rate', 'adapter.shipping.refused'],
        ['createLabel', 'adapter.shipping.refused'],
        ['startTracking', 'refused'],
      ])
      for (const [method, , text] of outcomes) expect(text, method).toContain(REFUSAL)
    },
  )

  it('AC-9: a key EasyPost refuses (401): rate and createLabel reject adapter.shipping.refused, startTracking answers refused, and health is degraded naming the key as refused, not down', async () => {
    const wrong = easypost({ apiKey: 'EZTKrevoked0000000000000' })

    const rate = await outcomeOf(() => call(wrong, 'rate'))
    const label = await outcomeOf(() => call(wrong, 'createLabel'))
    const tracking = await outcomeOf(() => call(wrong, 'startTracking'))
    const health = await wrong.healthCheck!()

    expect([
      codeOf(rate.error),
      codeOf(label.error),
      (tracking.value as { status?: unknown })?.status,
    ]).toEqual(['adapter.shipping.refused', 'adapter.shipping.refused', 'refused'])
    expect(health.status).toBe('degraded')
    expect(health.detail ?? '').toMatch(/api ?key/i)
  })
})

describe('AC-9: an outage rejects within timeoutMs, and health says down', () => {
  const outages: Array<[string, FakeAnswer | 'closed']> = [
    [
      '429',
      {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Too many requests', errors: [] } },
      },
    ],
    [
      '500',
      { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal error', errors: [] } } },
    ],
    ['503', { status: 503 }],
    ['a closed port', 'closed'],
    ['no answer within timeoutMs', 'hang'],
  ]

  it.each(outages)(
    'AC-9: %s: rate, createLabel and startTracking each reject adapter.shipping.unavailable within timeoutMs + 1 s',
    async (_name, failure) => {
      const results: Array<[Method, unknown, boolean]> = []
      for (const method of METHODS) {
        const a = easypost(failure === 'closed' ? { apiBase: dead } : {})
        const rateId =
          method === 'createLabel' && failure !== 'closed' ? await rateIdFrom(a) : undefined
        if (failure !== 'closed') fake.answer(ROUTE[method], failure)
        const { error, ms } = await outcomeOf(() => call(a, method, rateId))
        fake.clear()
        results.push([method, codeOf(error), ms < TIMEOUT_MS + GRACE_MS])
      }

      expect(results).toEqual(METHODS.map((m) => [m, 'adapter.shipping.unavailable', true]))
    },
    15_000,
  )

  it.each([
    ['503', { status: 503 } as FakeAnswer],
    ['429', { status: 429 } as FakeAnswer],
    ['a closed port', 'closed' as const],
    ['no answer in time', 'hang' as FakeAnswer],
  ])(
    'AC-9: health with a key answers down for %s, where the same adapter answered healthy before it',
    async (_name, failure) => {
      const a = easypost({
        webhookSecret: 'whsec_easypost_unit',
        ...(failure === 'closed' && { apiBase: dead }),
      })
      const healthyFirst = failure === 'closed' ? 'healthy' : (await a.healthCheck!()).status
      if (failure !== 'closed') fake.answer('trackers.list', failure)

      const during: HealthReport = await a.healthCheck!()

      expect([healthyFirst, during.status]).toEqual(['healthy', 'down'])
    },
    15_000,
  )

  it('AC-9: health with a key and EasyPost answering is healthy with a webhook secret and degraded without one, and reads trackers', async () => {
    const before = fake.requests.length

    const reports = [
      await easypost({ webhookSecret: 'whsec_easypost_unit' }).healthCheck!(),
      await easypost().healthCheck!(),
    ]

    expect(reports.map((r) => r.status)).toEqual(['healthy', 'degraded'])
    expect(fake.requests.slice(before).map((r) => [r.method, r.path, r.status])).toEqual([
      ['GET', '/v2/trackers', 200],
      ['GET', '/v2/trackers', 200],
    ])
  })

  it('AC-9: with the default timeoutMs (10 s), an EasyPost that never answers rejects adapter.shipping.unavailable after about 10 s, not before', async () => {
    const a = easypost({ timeoutMs: 'default' })
    fake.answer('trackers.create', 'hang')

    const { error, ms } = await outcomeOf(() => call(a, 'startTracking'))

    expect(codeOf(error)).toBe('adapter.shipping.unavailable')
    expect(ms).toBeGreaterThanOrEqual(9_500)
    expect(ms).toBeLessThan(10_000 + GRACE_MS)
  }, 20_000)
})

describe('AC-9: the API key never leaks', () => {
  it('AC-9: through refusals, a revoked key, outages and health, no error, log line or health detail holds the API key', async () => {
    const key = 'EZTKsecret5f3c9a71e2d84b06'
    const { logger, lines } = recordingLogger()
    const seen: unknown[] = []
    const keyed = await startFakeEasyPost({ apiKey: key })
    try {
      const builds = [
        createEasyPostShippingAdapter({
          logger,
          config: { apiKey: key, apiBase: keyed.apiBase, timeoutMs: TIMEOUT_MS },
        }),
        createEasyPostShippingAdapter({
          logger,
          config: { apiKey: key, apiBase: fake.apiBase, timeoutMs: TIMEOUT_MS },
        }),
        createEasyPostShippingAdapter({
          logger,
          config: { apiKey: key, apiBase: dead, timeoutMs: TIMEOUT_MS },
        }),
      ]
      const answers: Array<FakeAnswer | null> = [null, EASYPOST_ERROR(422), { status: 503 }, 'hang']
      for (const a of builds) {
        for (const answer of answers) {
          keyed.clear()
          if (answer !== null) keyed.answer('all', answer)
          for (const method of METHODS) {
            const { value, error } = await outcomeOf(() => call(a, method))
            seen.push(value, error)
          }
          seen.push(await a.healthCheck!())
        }
      }
    } finally {
      await keyed.close()
    }
    const strings = stringsIn([...seen, ...lines])

    // The leak is looked for where it could happen: every refusal and every outage path ran.
    expect([...new Set(seen.map(codeOf).filter((c) => c !== undefined))].sort()).toEqual([
      'adapter.shipping.refused',
      'adapter.shipping.unavailable',
    ])
    expect(strings.filter((s) => s.includes(key))).toEqual([])
    expect(strings.filter((s) => s.includes(Buffer.from(`${key}:`).toString('base64')))).toEqual([])
  }, 60_000)
})
