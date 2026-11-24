import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, conventionPackage } from '@nymbalhq/config'
import { runPromotionsContract } from '@nymbalhq/contract-tests'
import type { Logger, PromotionEffect, PromotionSession, PromotionsAdapter } from '@nymbalhq/types'
import {
  createTalonOnePromotionsAdapter,
  provider,
  slot,
  type TalonOnePromotionsAdapterConfig,
} from '../../packages/adapters/promotions/talon-one/src/index.js'
import {
  closedBaseUrl,
  FAKE_TALON_ONE_API_KEY,
  startFakeTalonOne,
  type FakeTalonOne,
} from '../../packages/adapters/promotions/talon-one/src/tests/fake-talon-one.js'

// The promotions suite on @nymbalhq/promotions-talon-one against the in-process Talon.One fake (unreachable is a closed
// port), and the package's place in the catalogue and the registry. With TALON_ONE_BASE_URL, TALON_ONE_API_KEY,
// TALON_ONE_CURRENCY and TALON_ONE_TEST_CODE set, the same suite runs against a Talon.One sandbox Application (one
// campaign that needs a coupon, that coupon's code, no campaign without a code), followed by one order's open, close
// and repeated close and a second order's open and cancel, each call's latency printed. Without all four the live
// block is skipped. The live run is started by hand; it never runs in CI.

const ROOT = join(import.meta.dirname, '..', '..')

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

async function built(config: TalonOnePromotionsAdapterConfig): Promise<PromotionsAdapter> {
  const adapter = createTalonOnePromotionsAdapter({ logger, config })
  await adapter.initialize(config)
  return adapter
}

let fake: FakeTalonOne
let dead = ''

beforeAll(async () => {
  fake = await startFakeTalonOne()
  dead = await closedBaseUrl()
})
afterAll(async () => {
  await fake?.close()
})

runPromotionsContract(
  'talon-one (fake Talon.One)',
  () => built({ baseUrl: fake.baseUrl, apiKey: FAKE_TALON_ONE_API_KEY, currency: 'GBP' }),
  {
    unreachable: () =>
      built({ baseUrl: dead, apiKey: FAKE_TALON_ONE_API_KEY, currency: 'GBP', timeoutMs: 1000 }),
  },
)

describe('AC-9: the package is where the kernel, nymbal add and the registry look for it', () => {
  it('AC-9: conventionPackage(promotions, talon-one) is the package’s name, the catalogue lists talon-one, and the registry lists it first-party on the promotions slot', () => {
    const dir = 'packages/adapters/promotions/talon-one'
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
      name: string
    }
    const registry = JSON.parse(readFileSync(join(ROOT, 'registry/adapters.json'), 'utf8')) as {
      adapters: {
        package: string
        slot: string
        provider: string
        tier: string
        source: { dir: string }
      }[]
    }

    expect(conventionPackage(slot, provider)).toBe(pkg.name)
    expect(pkg.name).toBe('@nymbalhq/promotions-talon-one')
    expect(Object.keys(ADAPTER_CATALOGUE.promotions)).toContain(provider)
    expect(registry.adapters.filter((e) => e.package === pkg.name)).toEqual([
      { package: pkg.name, slot: 'promotions', provider, tier: 'first-party', source: { dir } },
    ])
  })
})

const live = {
  baseUrl: process.env['TALON_ONE_BASE_URL'] ?? '',
  apiKey: process.env['TALON_ONE_API_KEY'] ?? '',
  currency: process.env['TALON_ONE_CURRENCY'] ?? '',
  code: process.env['TALON_ONE_TEST_CODE'] ?? '',
}
const liveSet = Object.values(live).every((v) => v !== '')

describe.runIf(liveSet)(
  'AC-16: Talon.One sandbox (TALON_ONE_BASE_URL, TALON_ONE_API_KEY, TALON_ONE_CURRENCY, TALON_ONE_TEST_CODE; skipped without them)',
  () => {
    const liveConfig = (): TalonOnePromotionsAdapterConfig => ({
      baseUrl: live.baseUrl,
      apiKey: live.apiKey,
      currency: live.currency,
    })

    runPromotionsContract('talon-one (Talon.One sandbox)', () => built(liveConfig()), {
      unreachable: () => built({ ...liveConfig(), baseUrl: dead, timeoutMs: 1000 }),
    })

    const sessionFor = (id: string): PromotionSession => ({
      id,
      customerId: null,
      codes: [live.code],
      currency: live.currency,
      lines: [
        {
          id: 'line-1',
          variantId: 'variant-1',
          sku: 'NYMBAL-LIVE-1',
          productId: 'product-1',
          categoryIds: [],
          unitMinor: 2500,
          qty: 2,
        },
      ],
      shipping: null,
    })
    const accepted = (effects: readonly PromotionEffect[]) =>
      effects.some((e) => e.kind === 'code_accepted' && e.code === live.code)
    const money = (effects: readonly PromotionEffect[]) =>
      effects.filter((e) => e.kind === 'order' || e.kind === 'line')

    async function timed<T>(label: string, call: () => Promise<T>): Promise<T> {
      const started = performance.now()
      try {
        return await call()
      } finally {
        console.warn(`talon-one live: ${label} ${Math.round(performance.now() - started)} ms`)
      }
    }

    /** The close answer again, by replaying the adapter's close under its own idempotency key. */
    async function replayedClose(orderId: string): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `${live.baseUrl.replace(/\/+$/, '')}/v2/customer_sessions/${encodeURIComponent(orderId)}`,
        {
          method: 'PUT',
          headers: {
            authorization: `ApiKey-v1 ${live.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': `${orderId}:closed`,
          },
          body: JSON.stringify({ customerSession: { state: 'closed' } }),
        },
      )
      return { status: res.status, body: (await res.json()) as unknown }
    }

    it('AC-16: one order opens with the code, closes, closes again, and its close answer still holds the code and its discount; a second order opens and cancels; open sessions count no use', async () => {
      const adapter = await built(liveConfig())
      const first = `nymbal-live-${randomUUID()}`
      const second = `nymbal-live-${randomUUID()}`
      const order = {
        orderId: first,
        orderNumber: 'NYM-LIVE-1',
        currency: live.currency,
        subtotalMinor: 5000,
        discountTotalMinor: 0,
        totalMinor: 5000,
      }

      const dry = await timed('place: dry evaluate', () =>
        adapter.evaluate(sessionFor(`cart-${first}`), { dry: true }),
      )
      const opened = await timed('place: open evaluate', () =>
        adapter.evaluate(sessionFor(`cart-${first}`), { orderId: first }),
      )
      const secondOpened = await timed('second order: open evaluate', () =>
        adapter.evaluate(sessionFor(`cart-${second}`), { orderId: second }),
      )
      await timed('close', () => adapter.close!(`cart-${first}`, order))
      await timed('close again', () => adapter.close!(`cart-${first}`, order))
      const replay = await timed('close answer replayed', () => replayedClose(first))
      await timed('second order: cancel', () => adapter.cancel!(`cart-${second}`, second))
      const afterClose = await timed('dry evaluate after the close', () =>
        adapter.evaluate(sessionFor(`cart-after-${first}`), { dry: true }),
      )
      console.warn(
        `talon-one live: after the first order closed, a new cart with the code reads ${JSON.stringify(
          afterClose.effects.filter(
            (e) => e.kind === 'code_accepted' || e.kind === 'code_rejected',
          ),
        )} (cap_reached when the coupon's limit is 1)`,
      )
      // A closed session cancelled gives its use back, so the sandbox's coupon serves the next run.
      await timed('first order: cancel after close', () => adapter.cancel!(`cart-${first}`, first))
      // Read the replayed close answer through the adapter's own mapping: the fake answers it verbatim.
      fake.answer({ status: replay.status, body: replay.body })
      const closeRead = await (
        await built({
          baseUrl: fake.baseUrl,
          apiKey: FAKE_TALON_ONE_API_KEY,
          currency: live.currency,
        })
      ).evaluate(sessionFor(`cart-${first}`), { dry: true })
      fake.answer(null)

      expect(accepted(dry.effects), JSON.stringify(dry.effects)).toBe(true)
      expect(accepted(opened.effects), JSON.stringify(opened.effects)).toBe(true)
      expect(money(opened.effects).length, JSON.stringify(opened.effects)).toBeGreaterThan(0)
      // Two open sessions both hold the code: an open session counted no use.
      expect(accepted(secondOpened.effects), JSON.stringify(secondOpened.effects)).toBe(true)
      expect(replay.status, JSON.stringify(replay.body)).toBe(200)
      expect(accepted(closeRead.effects), JSON.stringify(closeRead.effects)).toBe(true)
      expect(
        money(closeRead.effects).map((e) => e.amountMinor),
        JSON.stringify(closeRead.effects),
      ).toEqual(money(opened.effects).map((e) => e.amountMinor))
    }, 60_000)
  },
)
