import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address, Caller } from '@nymbalhq/types'
import * as platform from '../../src/index.js'
import { goldenAdmin, goldenView as viewOfGolden } from '../../src/assistant/golden.js'
import { goldenScript, rowOf, type Deviation } from '../../../../tests/support/assistant-golden.js'
import { assistantStore, type AssistantStore } from '../support/assistant.js'

// The golden set's two count questions against the scripted model (tests/support/assistant-golden.ts), on throwaway
// SQLite stores the golden store fills.
// - AC-13: rows 26 and 27 ask how many orders shipped to SW1 and to Germany; the golden orders ship to five addresses
//   of their own, so each filter has something to separate; each fact is counted from whole orders, not through the
//   filter it judges; the set passes 27/27, and a model that counts an unfiltered page fails that question alone.
// - AC-8: the eval's view of an order (`goldenView`) reads the assistant's tool surface whole: each golden order's id,
//   money and shipping name are the repository's.

type Part = 'placed' | 'unpaid' | 'waiting' | 'refunded' | 'paid'

/** The Interface's shipping address of each golden order. */
const SHIPS_TO: Record<Part, Pick<Address, 'addressLine1' | 'city' | 'postalCode' | 'country'>> = {
  placed: {
    addressLine1: '1 Market Street',
    city: 'London',
    postalCode: 'SW1A 1AA',
    country: 'GB',
  },
  unpaid: { addressLine1: '1 Market Street', city: 'London', postalCode: 'E1 6AN', country: 'GB' },
  waiting: {
    addressLine1: '2 Vauxhall Bridge Road',
    city: 'London',
    postalCode: 'SW1V 3LP',
    country: 'GB',
  },
  refunded: {
    addressLine1: 'Unter den Linden 1',
    city: 'Berlin',
    postalCode: '10117',
    country: 'DE',
  },
  paid: { addressLine1: '1 Piccadilly', city: 'Manchester', postalCode: 'M1 1AE', country: 'GB' },
}
const PARTS = Object.keys(SHIPS_TO) as Part[]

interface Question {
  id: string
  ask: string
  kind: 'read' | 'write' | 'none'
  calls?: string[]
  answer?: (view: unknown) => Promise<Array<string | readonly string[]>>
}
interface GoldenOrder {
  id: string
  name: string
  capturedMinor: number
  refundedMinor: number
}
interface Report {
  passed: number
  total: number
  results: Array<{ id: string; ok: boolean; reasons: string[]; calls: string[]; answer: string }>
}

const GOLDEN_QUESTIONS = platform.GOLDEN_QUESTIONS as unknown as readonly Question[]
type App = AssistantStore['kernel']['app']
const goldenStore = platform.goldenStore as (app: App) => Promise<void>
const goldenView = viewOfGolden as unknown as (
  app: App,
  caller: Caller,
  currency: string,
) => { order(part: Part): Promise<GoldenOrder> }
const runGolden = platform.runGolden as unknown as (app: App) => Promise<Report>

/** A golden store with the scripted model set, `deviate` applied. */
async function goldenReady(deviate?: Partial<Record<number, Deviation>>): Promise<AssistantStore> {
  const store = await assistantStore()
  try {
    await goldenStore(store.kernel.app)
    await store.kernel.app.relay.drain()
    store.standIn.script = goldenScript({
      currency: store.kernel.config.store.currency,
      ...(deviate !== undefined && { deviate }),
    })
    return store
  } catch (error) {
    await store.close()
    throw error
  }
}

/** Every order's shipping address, read from the orders table. */
async function shippedTo(store: AssistantStore): Promise<Address[]> {
  const rows = await store.raw.rows<{ shipping_address: string }>(
    'SELECT shipping_address FROM orders',
  )
  return rows.map((r) => JSON.parse(r.shipping_address) as Address)
}

const squeezed = (text: string) => text.toUpperCase().replaceAll(' ', '')
const failedOf = (report: Report) => report.results.filter((r) => !r.ok).map((r) => r.id)

describe('AC-13: the golden set asks two count questions the store answers', () => {
  it('AC-13: GOLDEN_QUESTIONS holds postcodes-sw1 and orders-germany as the scripted model’s rows 26 and 27, each a read asking its question and calling admin_orders_list', () => {
    const byRow = (row: number) =>
      GOLDEN_QUESTIONS.filter((q) => rowOf(q.ask)?.row === row).map((q) => ({
        id: q.id,
        ask: q.ask,
        kind: q.kind,
        calls: q.calls,
      }))

    expect([byRow(26), byRow(27)]).toEqual([
      [
        {
          id: 'postcodes-sw1',
          ask: 'How many orders were shipped to postcodes starting SW1?',
          kind: 'read',
          calls: ['admin_orders_list'],
        },
      ],
      [
        {
          id: 'orders-germany',
          ask: 'How many orders were shipped to Germany?',
          kind: 'read',
          calls: ['admin_orders_list'],
        },
      ],
    ])
    expect(new Set(GOLDEN_QUESTIONS.map((q) => q.id)).size).toBe(GOLDEN_QUESTIONS.length)
  })

  describe('on one golden store', () => {
    let store: AssistantStore
    let caller: Caller

    beforeAll(async () => {
      store = await goldenReady()
      caller = { auth: await goldenAdmin(store.kernel.app), agent: { name: 'acceptance' } }
    }, 120_000)

    afterAll(async () => {
      await store?.close()
    })

    it('AC-8: for each golden part, goldenView(...).order(part) equals the repository’s order: its id, capturedMinor, refundedMinor and shipping first and last name; and that order ships to the part’s address of the golden set', async () => {
      const view = goldenView(store.kernel.app, caller, store.kernel.config.store.currency)
      const seen = await Promise.all(
        PARTS.map(async (part) => {
          const order = await view.order(part)
          const stored = await store.kernel.store.read((tx) =>
            store.kernel.repos.order.findById(tx, order.id),
          )
          return {
            part,
            view: {
              id: order.id,
              capturedMinor: order.capturedMinor,
              refundedMinor: order.refundedMinor,
              name: order.name,
            },
            stored:
              stored === null
                ? null
                : {
                    id: stored.id,
                    capturedMinor: stored.capturedMinor,
                    refundedMinor: stored.refundedMinor,
                    name: `${stored.shippingAddress.firstName} ${stored.shippingAddress.lastName}`,
                  },
            ships:
              stored === null
                ? null
                : {
                    addressLine1: stored.shippingAddress.addressLine1,
                    city: stored.shippingAddress.city,
                    postalCode: stored.shippingAddress.postalCode,
                    country: stored.shippingAddress.country,
                  },
          }
        }),
      )

      expect(seen.map((s) => s.view)).toEqual(seen.map((s) => s.stored))
      expect(seen.map((s) => ({ part: s.part, ships: s.ships }))).toEqual(
        PARTS.map((part) => ({ part, ships: SHIPS_TO[part] })),
      )
    }, 60_000)

    it('AC-13: postcodes-sw1’s fact is the number of golden orders whose shipping postcode, upper-cased without spaces, starts SW1 (2) and orders-germany’s the number shipped to DE (1), counted from the orders table; runGolden passes 27/27', async () => {
      const shipped = await shippedTo(store)
      const sw1 = shipped.filter((a) => squeezed(a.postalCode).startsWith('SW1')).length
      const de = shipped.filter((a) => a.country === 'DE').length
      const view = goldenView(store.kernel.app, caller, store.kernel.config.store.currency)
      const factsOf = async (id: string) =>
        (await GOLDEN_QUESTIONS.find((q) => q.id === id)?.answer?.(view))?.flat() ?? []

      const facts = { sw1: await factsOf('postcodes-sw1'), de: await factsOf('orders-germany') }
      const report = await runGolden(store.kernel.app)

      expect({ sw1, de }).toEqual({ sw1: 2, de: 1 })
      expect({ sw1: facts.sw1.includes(String(sw1)), de: facts.de.includes(String(de)) }).toEqual({
        sw1: true,
        de: true,
      })
      expect(store.standIn.scriptErrors).toEqual([])
      expect(report.results.filter((r) => !r.ok).map((r) => [r.id, r.reasons])).toEqual([])
      expect(report.passed).toBe(report.total)
      expect(report.total).toBe(GOLDEN_QUESTIONS.length)
      expect(report.results.map((r) => r.id)).toEqual(GOLDEN_QUESTIONS.map((q) => q.id))
    }, 180_000)
  })

  it.each([
    { row: 26, id: 'postcodes-sw1' },
    { row: 27, id: 'orders-germany' },
  ])(
    'AC-13: a model that counts an unfiltered page of admin_orders_list for row $row fails $id alone, having called admin_orders_list',
    async ({ row, id }) => {
      const store = await goldenReady({ [row]: 'count-page' })
      try {
        const report = await runGolden(store.kernel.app)

        expect(store.standIn.scriptErrors).toEqual([])
        expect(failedOf(report)).toEqual([id])
        expect(report.passed).toBe(report.total - 1)
        expect(report.results.find((r) => r.id === id)?.calls).toEqual(['admin_orders_list'])
      } finally {
        await store.close()
      }
    },
    180_000,
  )
})
