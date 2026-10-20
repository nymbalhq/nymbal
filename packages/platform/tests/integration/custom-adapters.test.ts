import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type Cart, type PaymentIntentParams } from '@nymbalhq/types'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createApp, type NymbalApp } from '../../src/app.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  createKernel,
  kernelConfig,
  MIGRATIONS_ROOT,
  seedVariant,
  type Kernel,
} from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'

// Acceptance tests for P2-01 AC-3: createApp(config, { adapters }) puts an injected adapter in the slot whose provider
// is `custom`, and uses it everywhere the built one would be: a checkout over the API pays through it, for the order's
// total, and the order holds the intent it returned. `custom` with nothing injected, and an adapter injected for a slot
// that is not `custom`, fail createApp with `adapter.custom_mismatch` naming the slot. AC-3's production cells (an
// injected real adapter starts, an injected stub is refused) are in production-refusals.test.ts, beside P1-05 AC-8's.
// Kills: an injected adapter ignored or partly used, and one silently accepted beside a built one.

const SLOTS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const
type Slot = (typeof SLOTS)[number]

const logger = createLogger({ pretty: false, level: 'error' })

/** A payments adapter of the project's own: the stub's behaviour, its own name and capabilities, every intent recorded. */
function recorder() {
  const stub = createNativeStubPaymentsAdapter({ logger })
  const calls: Array<{ params: PaymentIntentParams; intentId: string }> = []
  const adapter = {
    ...stub,
    providerName: 'p2-01-recorder',
    capabilities: () => ['intent', 'capture', 'refund', 'p2-01-recorded'],
    async createPaymentIntent(params: PaymentIntentParams) {
      const intent = await stub.createPaymentIntent(params)
      calls.push({ params, intentId: intent.id })
      return intent
    },
  }
  return { adapter, calls }
}

/** Something to inject into a slot; createApp must refuse it before it is ever called. */
function doubleFor(slot: Slot) {
  return {
    kind: slot,
    providerName: `p2-01-${slot}-double`,
    capabilities: () => [],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
  }
}

function withProvider(config: NymbalConfig, slot: Slot, provider: string): NymbalConfig {
  return { ...config, commerce: { ...config.commerce, [slot]: { provider } } }
}

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  orderStatus: string
}

const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 1, max: 50_000 }),
    qty: fc.integer({ min: 1, max: 4 }),
  }),
  { minLength: 1, maxLength: 3 },
)

describe('P2-01 AC-3: a custom payments adapter, injected, takes the checkout', () => {
  const rec = recorder()
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({
      dialect: 'sqlite',
      configure: (config) => withProvider(config, 'payments', 'custom'),
      appOptions: { adapters: { payments: rec.adapter } },
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-3: over generated carts, a checkout over the API calls the injected createPaymentIntent exactly once, for the order total, and the order holds the intent id it returned', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, async (lines) => {
        const seeded = await Promise.all(
          lines.map((l) => seedVariant(k, l.qty + 1, { priceMinor: l.priceMinor })),
        )
        const shop = await primedShopper(served.baseUrl)
        expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
        for (const [i, s] of seeded.entries()) {
          const added = await shop.call<Cart>('POST', '/api/cart/items', {
            variantId: s.variantId,
            qty: lines[i]!.qty,
          })
          expect(added.status, JSON.stringify(added.body)).toBe(200)
        }
        const before = rec.calls.length

        const res = await shop.call<CheckoutAnswer>('POST', '/api/checkout', {
          email: `ac3-${randomUUID()}@p2-01.test`,
          billingAddress: address,
          shippingAddress: address,
        })

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const made = rec.calls.slice(before)
        expect(made).toHaveLength(1)
        const order = await raw.one<{ total_minor: number; payment_intent_id: string | null }>(
          'SELECT total_minor, payment_intent_id FROM orders WHERE id = ?',
          [res.body.data!.orderId],
        )
        expect(order.total_minor).toBe(lines.reduce((sum, l) => sum + l.priceMinor * l.qty, 0))
        expect(made[0]!.params.amountMinor).toBe(order.total_minor)
        expect(order.payment_intent_id).toBe(made[0]!.intentId)
        expect(k.app.adapters.payments.providerName).toBe(rec.adapter.providerName)
      }),
      { numRuns: 5 },
    )
  }, 120_000)
})

describe('P2-01 AC-3: custom and an injected adapter go together, or createApp refuses', () => {
  const dirs: string[] = []
  const apps: NymbalApp[] = []

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** createApp's outcome on a migrated store: the error it rejected with, or null when it started. */
  async function attempt(
    config: NymbalConfig,
    adapters?: Record<string, unknown>,
  ): Promise<unknown> {
    const dir = mkdtempSync(join(tmpdir(), 'p2-01-custom-'))
    dirs.push(dir)
    const sqlitePath = join(dir, 'store.sqlite')
    const store = createCommandStore(config, { sqlitePath })
    try {
      await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    } finally {
      await store.close()
    }
    try {
      apps.push(await createApp(config, { sqlitePath, logger, ...(adapters && { adapters }) }))
      return null
    } catch (error) {
      return error
    }
  }

  function mismatchFor(error: unknown, slot: Slot): string | null {
    if (!(error instanceof ConfigError)) return `not a ConfigError: ${String(error)}`
    if (error.code !== 'adapter.custom_mismatch') return `code ${error.code}: ${error.message}`
    if (!new RegExp(`\\b${slot}\\b`).test(error.message)) return `slot not named: ${error.message}`
    return null
  }

  it('AC-3: for every slot, custom with nothing injected fails createApp with adapter.custom_mismatch naming the slot, and saying nymbal dev cannot inject', async () => {
    const wrong: Array<{ slot: Slot; why: string }> = []
    for (const slot of SLOTS) {
      const error = await attempt(withProvider(kernelConfig('sqlite'), slot, 'custom'))
      const why =
        mismatchFor(error, slot) ??
        ((error as ConfigError).message.includes('nymbal dev')
          ? null
          : `no word on nymbal dev: ${(error as ConfigError).message}`)
      if (why !== null) wrong.push({ slot, why })
    }
    expect(wrong).toEqual([])
  })

  it('AC-3: for every slot, an adapter injected while the slot keeps its built-in provider fails createApp with adapter.custom_mismatch naming the slot', async () => {
    const base = kernelConfig('sqlite')
    const wrong: Array<{ slot: Slot; provider: string; why: string }> = []
    for (const slot of SLOTS) {
      const provider = base.commerce[slot].provider
      const injected = slot === 'payments' ? recorder().adapter : doubleFor(slot)
      const why = mismatchFor(await attempt(base, { [slot]: injected }), slot)
      if (why !== null) wrong.push({ slot, provider, why })
    }
    expect(wrong).toEqual([])
  })
})
