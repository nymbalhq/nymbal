import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, kernelConfig, seedVariant, type Kernel } from '../support/kernel.js'
import {
  addLine,
  putCode,
  readCart,
  scriptedEngine,
  type PricedCart,
} from '../support/promotions.js'
import { primedShopper } from '../support/security.js'

// AC-7: the promotions slot. An existing store's config has no `commerce.promotions`, and keeps working on the native
// engine; a `custom` provider with an injected adapter is the one the cart and the checkout use.

type Report = Record<string, { provider: string; capabilities: readonly string[] }>

const open: (Kernel | ServedKernel)[] = []

afterAll(async () => {
  for (const held of open.splice(0)) {
    if ('stop' in held) await held.stop()
    else await held.close()
  }
})

describe('AC-7: the promotions slot', () => {
  it('AC-7: a config with no commerce.promotions block parses to the native engine with onUnavailable proceed, and boots on it', async () => {
    const config = kernelConfig('sqlite') as unknown as {
      commerce: Record<string, unknown>
    } & Record<string, unknown>
    const { promotions: _absent, ...commerce } = config.commerce

    const parsed = nymbalConfigSchema.parse({ ...config, commerce })

    expect(parsed.commerce.promotions).toEqual({ provider: 'native', onUnavailable: 'proceed' })

    const k = await createKernel({ dialect: 'sqlite' })
    open.push(k)
    expect(k.app.adapters.promotions.providerName).toBe('native')
    expect(k.app.adapters.promotions.capabilities()).toEqual(['codes'])
  })

  it('AC-7: the app’s capability report lists the promotions slot with the adapter’s own answer', async () => {
    const k = await createKernel({ dialect: 'sqlite' })
    open.push(k)

    const report = (k.app as unknown as { capabilities(): Report }).capabilities()

    expect(report['promotions']).toEqual({
      provider: k.config.commerce.promotions.provider,
      capabilities: k.app.adapters.promotions.capabilities(),
    })
    expect(report['promotions']!.provider).toBe('native')
  })

  it('AC-7: provider custom with an injected adapter is the engine the cart and checkout use', async () => {
    const engine = scriptedEngine({ providerName: 'injected-promotions' })
    const k = await createKernel({
      dialect: 'sqlite',
      configure: (config: NymbalConfig) =>
        ({
          ...config,
          commerce: {
            ...config.commerce,
            promotions: { provider: 'custom', onUnavailable: 'proceed' },
          },
        }) as NymbalConfig,
      appOptions: { adapters: { promotions: engine.adapter } },
    })
    const served = await serveKernel(k)
    open.push(served)
    const seeded = await seedVariant(k, 20, { priceMinor: 2000 })
    const shop = await primedShopper(served.baseUrl)
    expect((await readCart(shop)).status).toBe(200)
    expect((await addLine(shop, seeded, 3)).status).toBe(200)

    const cart = (await putCode(shop, 'INJECT')).body.data! as PricedCart

    expect(cart.totals.discountTotalMinor).toBe(600)
    const placed = await shop.call<{ orderId: string }>('POST', '/api/checkout', {
      email: `custom-${randomUUID()}+stub-pending@promo.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    const order = await k.store.read(async (tx) =>
      k.repos.order.findById(tx, placed.body.data!.orderId),
    )
    expect(order!.discountTotalMinor).toBe(600)
    expect((order!.metadata as { promotions?: { provider: string } }).promotions?.provider).toBe(
      'injected-promotions',
    )
    expect(engine.calls.some((call) => call.opts?.orderId === order!.id)).toBe(true)
  })
})
