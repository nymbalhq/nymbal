import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLocalFsMediaStorage } from '../../src/media/index.js'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient } from '../support/money.js'

// AC-4: app.capabilities() reports the eight commerce slots, security, documentStore, eventBus and media, each with the
// adapter's own capabilities() answer, and for ai `none` no adapter at all (the admin AI route answers 503). Needs the
// adapter packages built (the Stripe kernel loads @nymbalhq/payments-stripe).

const COMMERCE = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const
const INFRASTRUCTURE = ['security', 'documentStore', 'eventBus', 'media'] as const

type Report = Record<string, { provider: string; capabilities: readonly string[] }>

const logger = createLogger({ pretty: false, level: 'error' })

/** An adapter's own answer: `capabilities` is a method on every adapter, storage and bus. */
function own(adapter: object): readonly string[] {
  return (adapter as { capabilities(): readonly string[] }).capabilities()
}

function reportOf(k: Kernel): Report {
  return (k.app as unknown as { capabilities(): Report }).capabilities()
}

function withStripe(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_adapters_never_called', webhookSecret: 'whsec_adapters' },
      },
    },
  }
}

describe('AC-4: the app reports each adapter its own capabilities', () => {
  const kernels: Kernel[] = []
  const dirs: string[] = []

  afterAll(async () => {
    for (const k of kernels.splice(0)) await k.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function kernel(opts: Parameters<typeof createKernel>[0]): Promise<Kernel> {
    const k = await createKernel(opts)
    kernels.push(k)
    return k
  }

  it('AC-4: with native providers and ai none, every slot is reported with its adapter’s own capabilities(), and ai is { provider: none, capabilities: [] } with no adapter behind it', async () => {
    const k = await kernel({ dialect: 'sqlite' })
    expect(k.config.commerce.ai.provider).toBe('none')

    const report = reportOf(k)

    expect(Object.keys(report).sort()).toEqual([...COMMERCE, ...INFRASTRUCTURE].sort())
    const adapters = k.app.adapters as unknown as Record<string, object | null>
    for (const slot of COMMERCE.filter((s) => s !== 'ai')) {
      expect(report[slot]!.capabilities, slot).toEqual(own(adapters[slot]!))
    }
    expect(report['security']!.capabilities).toEqual(own(k.app.adapters.security))
    expect(report['documentStore']!.capabilities).toEqual(own(k.documentStore))
    expect(report['eventBus']!.capabilities).toEqual(own(k.eventBus))
    // The kernel ships one MediaStorage, on the local filesystem; its answer does not depend on the root.
    const root = mkdtempSync(join(tmpdir(), 'adapters-media-'))
    dirs.push(root)
    expect(report['media']!.capabilities).toEqual(own(createLocalFsMediaStorage({ root })))
    expect(report['ai']).toEqual({ provider: 'none', capabilities: [] })
    expect(adapters['ai']).toBeNull()
  })

  it('AC-4: with Stripe configured, payments reports Stripe’s own list, which is not the native stub’s', async () => {
    const k = await kernel({ dialect: 'sqlite', configure: withStripe })
    expect(k.app.adapters.payments.providerName).toBe('stripe')

    const payments = reportOf(k)['payments']!

    expect(payments.provider).toBe('stripe')
    expect(payments.capabilities).toEqual(own(k.app.adapters.payments))
    expect(payments.capabilities).not.toEqual(own(createNativeStubPaymentsAdapter({ logger })))
  })

  it('AC-4: with payments custom, payments reports the injected adapter’s own list', async () => {
    const injected = {
      ...createNativeStubPaymentsAdapter({ logger }),
      providerName: 'adapters-injected',
      capabilities: () => ['intent', 'adapters-injected-only'],
    }
    const k = await kernel({
      dialect: 'sqlite',
      configure: (config) => ({
        ...config,
        commerce: { ...config.commerce, payments: { provider: 'custom' } },
      }),
      appOptions: { adapters: { payments: injected } },
    })

    expect(reportOf(k)['payments']!.capabilities).toEqual(injected.capabilities())
  })
})

describe('AC-4: ai none answers the admin AI route with 503 admin.unavailable', () => {
  let k: Kernel
  let served: ServedKernel

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-4: POST /api/admin/products/:id/enhance as an admin is 503 admin.unavailable, and the product is unchanged', async () => {
    expect(k.config.commerce.ai.provider).toBe('none')
    const seeded = await seedVariant(k, 1)
    const admin = await adminClient(k, served.baseUrl)
    const before = await k.services.product.getById(seeded.productId)

    const res = await admin.call<unknown>(
      'POST',
      `/api/admin/products/${seeded.productId}/enhance`,
      {
        field: 'description',
        context: { name: 'Transactional Widget' },
      },
    )

    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(res.body.error?.code).toBe('admin.unavailable')
    expect(await k.services.product.getById(seeded.productId)).toEqual(before)
  })
})
