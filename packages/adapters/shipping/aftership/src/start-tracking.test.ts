import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport, Logger, ShippingAdapter } from '@nymbalhq/types'
import { createAfterShipShippingAdapter } from './index.js'
import {
  closedApiBase,
  COURIERS_PATH,
  FAKE_AFTERSHIP_API_KEY,
  metaError,
  REFUSALS,
  startFakeAfterShip,
  TRACKINGS_PATH,
  type FakeAfterShip,
  type FakeAnswer,
} from './tests/fake-aftership.js'
import { codeOf, outcomeOf, recordingLogger, silent, stringsIn } from './tests/support.js'

// startTracking registers a number with AfterShip: POST /tracking/2026-07/trackings { tracking_number, slug? } under
// as-api-key, the slug named only for a carrier in the table (testing-courier included, for the live run). A new or
// already-registered number is `tracking`; a refusal for good is `refused` with AfterShip's meta.message, so the relay
// does not retry it; an outage rejects, so it does. Health with a key reads the couriers: down through an outage,
// degraded naming the key when AfterShip refuses it.

const TIMEOUT_MS = 300
const GRACE_MS = 1000

let fake: FakeAfterShip
let dead = ''

beforeAll(async () => {
  fake = await startFakeAfterShip()
  dead = await closedApiBase()
})
afterEach(() => fake.clear())
afterAll(async () => {
  await fake.close()
})

function aftership(
  opts: { apiKey?: string; apiBase?: string; webhookSecret?: string; logger?: Logger } = {},
): ShippingAdapter {
  return createAfterShipShippingAdapter({
    logger: opts.logger ?? silent,
    config: {
      apiKey: opts.apiKey ?? FAKE_AFTERSHIP_API_KEY,
      apiBase: opts.apiBase ?? fake.apiBase,
      timeoutMs: TIMEOUT_MS,
      ...(opts.webhookSecret !== undefined && { webhookSecret: opts.webhookSecret }),
    },
  })
}

let serial = 0
const freshNumber = (): string => {
  serial += 1
  return `AS${Date.now()}${String(serial).padStart(6, '0')}`
}

/** The carriers AfterShip is told the slug of, as the merchant may type each name; any other is left to detection. */
const SLUGS: Array<[string[], string]> = [
  [['USPS', 'usps', ' u s p s '], 'usps'],
  [['UPS', 'ups'], 'ups'],
  [['FedEx', 'fedex', 'FEDEX', 'Fed Ex'], 'fedex'],
  [['DHL', 'DHL Express', 'dhl express', 'dhlexpress'], 'dhl'],
  [['Royal Mail', 'royal mail', 'ROYALMAIL'], 'royal-mail'],
  [['testing-courier'], 'testing-courier'],
]

describe('AC-13: startTracking registers the number with AfterShip', () => {
  // Kills: a wrong slug sent for free text, so every registration fails; the live run's test courier detected instead
  // of named.
  it('AC-13: property: over the carrier table’s names in any case and spacing, and free text outside it, startTracking posts one /tracking/2026-07/trackings { tracking_number, slug } with the table’s slug, or no slug, under as-api-key, and answers tracking', async () => {
    const a = aftership()
    const named = SLUGS.flatMap(([names, slug]) => names.map((n) => [n, slug] as const))
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(...named),
          fc
            .stringMatching(/^[A-Z][a-z]{2,9}( [A-Z][a-z]{2,9})?$/)
            .filter(
              (t) =>
                !named.some(
                  ([n]) =>
                    n.replace(/\s/g, '').toLowerCase() === t.replace(/\s/g, '').toLowerCase(),
                ),
            )
            .map((t) => [t, null] as const),
          fc.constant([null, null] as const),
        ),
        async ([carrier, slug]) => {
          const number = freshNumber()
          const before = fake.requests.length

          const answer = await a.startTracking!({ trackingNumber: number, carrier })

          const sent = fake.requests.slice(before)
          expect(answer).toEqual({ status: 'tracking' })
          expect(sent.map((r) => [r.method, r.path, r.apiKey])).toEqual([
            ['POST', TRACKINGS_PATH, FAKE_AFTERSHIP_API_KEY],
          ])
          expect(sent[0]!.body).toEqual(
            slug === null ? { tracking_number: number } : { tracking_number: number, slug },
          )
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-13: a number AfterShip already holds (meta 4003) answers tracking, as the first registration did', async () => {
    const a = aftership()
    const number = freshNumber()

    const first = await a.startTracking!({ trackingNumber: number, carrier: 'UPS' })
    const again = await a.startTracking!({ trackingNumber: number, carrier: 'UPS' })

    const metas = fake.requests
      .filter((r) => (r.body as { tracking_number?: string } | null)?.tracking_number === number)
      .map((r) => [r.status, (r.response as { meta: { code: number } }).meta.code])
    expect(metas).toEqual([
      [201, 201],
      [400, 4003],
    ])
    expect(again).toEqual(first)
  })

  it.each([
    ['4005 (invalid number)', REFUSALS['4005']],
    ['4010 (invalid slug)', REFUSALS['4010']],
    ['4012 (courier not detected)', REFUSALS['4012']],
  ] as Array<[string, FakeAnswer]>)(
    'AC-13: meta %s answers refused with AfterShip’s meta.message',
    async (_name, answer) => {
      const a = aftership()
      fake.answer('trackings.create', answer)

      const result = await a.startTracking!({ trackingNumber: freshNumber(), carrier: 'USPS' })

      const message = (answer as { body: { meta: { message: string } } }).body.meta.message
      expect(result).toEqual({
        status: 'refused',
        reason: expect.stringContaining(message) as unknown,
      })
    },
  )

  it('AC-13: a key AfterShip refuses (401) answers refused naming it, and health is degraded naming the key, not down', async () => {
    const revoked = aftership({ apiKey: 'asat_revoked_000000000000', webhookSecret: 'whsec_a' })

    const result = await revoked.startTracking!({ trackingNumber: freshNumber(), carrier: null })
    const health = await revoked.healthCheck!()

    expect([result.status, health.status]).toEqual(['refused', 'degraded'])
    expect((result as { reason?: string }).reason).toContain('Invalid API key.')
    expect(health.detail ?? '').toMatch(/api ?key/i)
  })

  it.each([
    ['429', metaError(429, 429, 'TooManyRequests', 'You have exceeded the API call rate limit.')],
    ['500', metaError(500, 500, 'InternalError', 'Something went wrong on AfterShip’s end.')],
    ['503', { status: 503 } as FakeAnswer],
    ['a closed port', 'closed' as const],
    ['no answer within timeoutMs', 'hang' as FakeAnswer],
  ])(
    'AC-13: %s: startTracking rejects within timeoutMs + 1 s, never answering refused',
    async (_name, failure) => {
      const a = aftership(failure === 'closed' ? { apiBase: dead } : {})
      if (failure !== 'closed') fake.answer('trackings.create', failure)

      const { value, error, ms } = await outcomeOf(() =>
        a.startTracking!({ trackingNumber: freshNumber(), carrier: 'USPS' }),
      )

      expect(value).toBeUndefined()
      expect(codeOf(error)).toBe('adapter.shipping.unavailable')
      expect(ms).toBeLessThan(TIMEOUT_MS + GRACE_MS)
    },
  )
})

describe('AC-13: health follows AfterShip', () => {
  it('AC-13: with a key and AfterShip answering, health reads the couriers and is healthy with a webhook secret, degraded without one', async () => {
    const before = fake.requests.length

    const reports = [
      await aftership({ webhookSecret: 'whsec_a' }).healthCheck!(),
      await aftership().healthCheck!(),
    ]

    expect(reports.map((r) => r.status)).toEqual(['healthy', 'degraded'])
    expect(fake.requests.slice(before).map((r) => [r.method, r.path, r.status])).toEqual([
      ['GET', COURIERS_PATH, 200],
      ['GET', COURIERS_PATH, 200],
    ])
  })

  it.each([
    ['503', { status: 503 } as FakeAnswer],
    ['429', { status: 429 } as FakeAnswer],
    ['a closed port', 'closed' as const],
    ['no answer in time', 'hang' as FakeAnswer],
  ])(
    'AC-13: health answers down for %s, where the same adapter was healthy before it',
    async (_name, failure) => {
      const a = aftership({
        webhookSecret: 'whsec_a',
        ...(failure === 'closed' && { apiBase: dead }),
      })
      const first = failure === 'closed' ? 'healthy' : (await a.healthCheck!()).status
      if (failure !== 'closed') fake.answer('couriers.list', failure)

      const during: HealthReport = await a.healthCheck!()

      expect([first, during.status]).toEqual(['healthy', 'down'])
    },
  )

  it('AC-13: through refusals, outages and health, no error, log line or health detail holds the API key', async () => {
    const key = 'asat_secret_7c1e9b2d4f6a8'
    const { logger, lines } = recordingLogger()
    const keyed = await startFakeAfterShip({ apiKey: key })
    const seen: unknown[] = []
    const outcomes = new Set<unknown>()
    try {
      const builds = [keyed.apiBase, fake.apiBase, dead].map((apiBase) =>
        createAfterShipShippingAdapter({
          logger,
          config: { apiKey: key, apiBase, timeoutMs: TIMEOUT_MS },
        }),
      )
      for (const a of builds) {
        for (const answer of [
          null,
          REFUSALS['4005'],
          { status: 503 },
          'hang',
        ] as Array<FakeAnswer | null>) {
          keyed.clear()
          if (answer !== null) keyed.answer('all', answer)
          const { value, error } = await outcomeOf(() =>
            a.startTracking!({ trackingNumber: freshNumber(), carrier: 'USPS' }),
          )
          outcomes.add(error === undefined ? (value as { status?: unknown }).status : codeOf(error))
          seen.push(value, error, await a.healthCheck!())
        }
      }
    } finally {
      await keyed.close()
    }
    const strings = stringsIn([...seen, ...lines])

    // The leak is looked for where it could happen: every refusal and every outage path ran.
    expect([...outcomes].sort()).toEqual(['adapter.shipping.unavailable', 'refused', 'tracking'])
    expect(strings.filter((s) => s.includes(key))).toEqual([])
  }, 30_000)
})
