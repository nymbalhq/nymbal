import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { PromotionSession } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { addLine, putCode, readCart, scriptedEngine, type Shop } from '../support/promotions.js'
import { primedShopper } from '../support/security.js'
import {
  both,
  placeOrder,
  quote,
  TABLE,
  withShipping,
  type ShippingRow,
} from '../support/shipping.js'
import { scriptedTax, withTax, type ScriptedTax } from '../support/tax.js'

// What a tax engine in the `custom` slot is told about shipping, through the quote and the checkout over HTTP on
// served kernels (SQLite): on a store with a table, the chosen option's amount less any shipping discount the
// promotions engine gave; on a store with none, no shipping at all. And how many times it is asked.

interface Store {
  k: Kernel
  served: ServedKernel
  tax: ScriptedTax
}

/** The scripted promotions engine's code: £1.50 off shipping. */
const SHIP_OFF = 'SHIPOFF'
const SHIP_OFF_MINOR = 150

async function serve(table: readonly ShippingRow[]): Promise<Store> {
  const tax = scriptedTax({ percent: 10 })
  const engine = scriptedEngine()
  engine.answer((session: PromotionSession) =>
    session.codes.includes(SHIP_OFF)
      ? {
          effects: [
            { kind: 'code_accepted', code: SHIP_OFF },
            { kind: 'shipping', amountMinor: SHIP_OFF_MINOR, label: SHIP_OFF, code: SHIP_OFF },
          ],
        }
      : { effects: [] },
  )
  const k = await createKernel({
    dialect: 'sqlite',
    configure: both(
      withTax({ provider: 'custom' }),
      withShipping(table),
      (config: NymbalConfig) =>
        ({
          ...config,
          commerce: {
            ...config.commerce,
            promotions: { provider: 'custom', onUnavailable: 'proceed' },
          },
        }) as NymbalConfig,
    ),
    appOptions: { adapters: { tax: tax.adapter, promotions: engine.adapter } },
  })
  return { k, served: await serveKernel(k), tax }
}

let shipped: Store
let unshipped: Store

beforeAll(async () => {
  ;[shipped, unshipped] = await Promise.all([serve(TABLE), serve([])])
}, 60_000)

afterAll(async () => {
  for (const s of [shipped, unshipped]) {
    s?.tax.recover()
    await s?.served.stop()
  }
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@shipping-engine.test`

/** A shopper of its own with £12 of goods and, when asked, the shipping code. */
async function basket(s: Store, withCode: boolean): Promise<Shop> {
  const seeded = await seedVariant(s.k, 10, { priceMinor: 1_200 })
  const shop = await primedShopper(s.served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  expect((await addLine(shop, seeded, 1)).status).toBe(200)
  if (withCode) {
    const coded = await putCode(shop, SHIP_OFF)
    expect(coded.status, JSON.stringify(coded.body)).toBe(200)
  }
  return shop
}

describe('AC-11: the tax engine is asked about shipping', () => {
  // Kills: a provider never told shipping was charged (shipping tax under-collected), told the gross rate after a
  // shipping discount, or asked twice for one quote or one checkout.
  it('AC-11: on a store with a table, each quote and each checkout asks the provider once, with shipping the chosen option’s amount less its shipping discount (0 for a free option)', async () => {
    for (const withCode of [false, true]) {
      for (const optionId of ['standard', 'express', 'collect']) {
        const shop = await basket(shipped, withCode)
        const row = TABLE.find((r) => r.id === optionId)!
        // £12 of goods is under every threshold: each option costs its row's amount.
        const shipping =
          row.amountMinor - (withCode ? Math.min(SHIP_OFF_MINOR, row.amountMinor) : 0)
        const where = `${optionId}${withCode ? ' with the code' : ''}`

        const fromQuote = shipped.tax.calls.length
        const res = await quote(shop, { shippingAddress: address, shippingOptionId: optionId })
        const quoteCalls = shipped.tax.calls.slice(fromQuote)

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const totals = res.body.data!.totals
        expect(totals.shippingTotalMinor - totals.shippingDiscountMinor, where).toBe(shipping)
        expect(
          quoteCalls.map((c) => c.shipping),
          where,
        ).toEqual([{ amountMinor: shipping }])

        const fromPlace = shipped.tax.calls.length
        const placed = await placeOrder(shop, pendingEmail(), {
          shippingOptionId: optionId,
          expectedTotalMinor: totals.totalMinor,
        })
        const placeCalls = shipped.tax.calls.slice(fromPlace)

        expect(placed.status, JSON.stringify(placed.body)).toBe(200)
        expect(
          placeCalls.map((c) => c.shipping),
          where,
        ).toEqual([{ amountMinor: shipping }])
        // The checkout asks the provider exactly what the quote asked it.
        expect(placeCalls.length, where).toBe(quoteCalls.length)
        expect(placeCalls.map((c) => c.shipping), where).toStrictEqual(
          quoteCalls.map((c) => c.shipping),
        )
      }
    }
  })

  // Kills: a store that set no table telling its provider about a shipping amount it does not charge.
  it('AC-11: on a store with no table, the quote and the checkout each ask the provider once with shipping null', async () => {
    const shop = await basket(unshipped, false)

    const fromQuote = unshipped.tax.calls.length
    const res = await quote(shop, { shippingAddress: address })
    const quoteCalls = unshipped.tax.calls.slice(fromQuote)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(quoteCalls.map((c) => c.shipping)).toEqual([null])

    const fromPlace = unshipped.tax.calls.length
    const placed = await placeOrder(shop, pendingEmail(), {
      expectedTotalMinor: res.body.data!.totals.totalMinor,
    })
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    const placeCalls = unshipped.tax.calls.slice(fromPlace)
    expect(placeCalls.map((c) => c.shipping)).toEqual([null])
    expect(placeCalls.length).toBe(quoteCalls.length)
  })
})
