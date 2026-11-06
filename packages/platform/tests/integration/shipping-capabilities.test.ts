import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots } from '../support/inbound-webhooks.js'
import { createKernel } from '../support/kernel.js'
import { createTestShipAdapter } from '../support/test-ship.js'

// GET /api/capabilities reports the shipping adapter's words beside the other slots', so a storefront (and checkout
// rates later) can tell whether the store rates, sells labels or registers tracking, without learning the provider.

interface Report {
  shipping?: { capabilities?: unknown }
  [slot: string]: unknown
}

async function reportOf(
  served: ServedKernel,
): Promise<{ status: number; report: Report; text: string }> {
  const res = await fetch(`${served.baseUrl}/api/capabilities`, {
    headers: { accept: 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, report: (JSON.parse(text) as { data: Report }).data, text }
}

describe('AC-3: the report carries the shipping words', () => {
  let native: ServedKernel
  let tracked: ServedKernel

  beforeAll(async () => {
    native = await serveKernel(await createKernel({ dialect: 'sqlite' }))
    tracked = await serveKernel(
      await createKernel({
        dialect: 'sqlite',
        configure: customSlots('shipping'),
        appOptions: {
          adapters: { shipping: createTestShipAdapter({ providerName: 'caps-ship' }) },
        },
      }),
    )
  }, 60_000)
  afterAll(async () => {
    await native?.stop()
    await tracked?.stop()
  })

  it('AC-3: shipping.capabilities is [] on native and rates, labels and tracking on an injected test-ship, each the adapter’s own words', async () => {
    const answers = await Promise.all([reportOf(native), reportOf(tracked)])

    expect(answers.map((a) => a.status)).toEqual([200, 200])
    expect(answers.map((a) => a.report.shipping?.capabilities)).toEqual([
      [...native.kernel.app.adapters.shipping.capabilities()],
      [...tracked.kernel.app.adapters.shipping.capabilities()],
    ])
    expect(answers.map((a) => a.report.shipping?.capabilities)).toEqual([
      [],
      ['rates', 'labels', 'tracking'],
    ])
  })

  it('AC-3: the shipping report names no provider: no provider key, and not the adapter’s providerName anywhere in the body', async () => {
    const { report, text } = await reportOf(tracked)

    expect(Object.keys(report.shipping ?? { missing: true })).toEqual(['capabilities'])
    expect(text.includes('caps-ship')).toBe(false)
  })

  it('AC-3: property: over generated word sets of an injected shipping adapter, the report’s shipping.capabilities is exactly the adapter’s words', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(fc.subarray(['rates', 'labels', 'tracking']), async (words) => {
        run += 1
        const served = await serveKernel(
          await createKernel({
            dialect: 'sqlite',
            configure: customSlots('shipping'),
            appOptions: {
              adapters: {
                shipping: createTestShipAdapter({ providerName: `caps-ship-${run}`, words }),
              },
            },
          }),
        )
        try {
          const { report } = await reportOf(served)
          expect(report.shipping?.capabilities).toEqual(words)
        } finally {
          await served.stop()
        }
      }),
      { numRuns: 4 },
    )
  }, 120_000)
})
