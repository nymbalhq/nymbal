import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Address, Parcel, ShippingAdapter, ShippingRate } from '@nymbalhq/types'
import {
  CASE_MS,
  expectDown,
  expectHealthy,
  expectRejects,
  settle,
  using,
  type Build,
  type ContractOptions,
} from './common.js'

// A shipping adapter says what it does with three words and has exactly the methods they name: `rates` rate,
// `labels` createLabel, `tracking` startTracking. `words:` holds every adapter to that; each other case runs only under
// its word, and only on the method behind it (a word without its method is the `words:` case's to report, once).

export interface ShippingContractOptions extends ContractOptions<ShippingAdapter> {
  /** A tracking number the provider takes, fresh on each call (a provider may let each be registered once). */
  trackingNumber?: () => string
  /** The carrier sent with it; none (the provider detects it) unless given. */
  carrier?: string
  /** Where rates are asked from and to: two US addresses unless given. */
  from?: Address
  to?: Address
  /** The parcel rated: 500 g unless given. */
  parcel?: Parcel
}

const WORDS = ['rates', 'labels', 'tracking'] as const
type Word = (typeof WORDS)[number]
const METHOD: Record<Word, 'rate' | 'createLabel' | 'startTracking'> = {
  rates: 'rate',
  labels: 'createLabel',
  tracking: 'startTracking',
}

const FROM: Address = {
  firstName: 'Nymbal',
  lastName: 'Warehouse',
  company: 'Nymbal Contract',
  addressLine1: '417 Montgomery Street',
  addressLine2: 'Floor 5',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94104',
  country: 'US',
  phone: '4155559999',
}

const TO: Address = {
  firstName: 'Dr Steve',
  lastName: 'Brule',
  addressLine1: '179 N Harbor Dr',
  city: 'Redondo Beach',
  region: 'CA',
  postalCode: '90277',
  country: 'US',
  phone: '3105551234',
}

const PARCEL: Parcel = { weightGrams: 500 }

type Methods = Partial<Record<'rate' | 'createLabel' | 'startTracking', unknown>>

const declares = (adapter: ShippingAdapter, word: Word): boolean =>
  (adapter.capabilities() as readonly string[]).includes(word)

/** The word is declared and its method is there: the case for it can run. */
const serves = (adapter: ShippingAdapter, word: Word): boolean =>
  declares(adapter, word) && typeof (adapter as Methods)[METHOD[word]] === 'function'

const freshNumber = (): string =>
  `NYM${randomUUID().replace(/\D/g, '').padEnd(18, '7').slice(0, 18)}`

/** A parcel of 1 g to 30 kg, with all three dimensions or none. */
const arbParcel: fc.Arbitrary<Parcel> = fc.oneof(
  fc.record({ weightGrams: fc.integer({ min: 1, max: 30_000 }) }),
  fc.record({
    weightGrams: fc.integer({ min: 1, max: 30_000 }),
    lengthMm: fc.integer({ min: 10, max: 1000 }),
    widthMm: fc.integer({ min: 10, max: 1000 }),
    heightMm: fc.integer({ min: 10, max: 1000 }),
  }),
)

function expectRate(rate: ShippingRate): void {
  const what = JSON.stringify(rate)
  expect(typeof rate.id === 'string' && rate.id.length > 0, `a rate without an id: ${what}`).toBe(
    true,
  )
  expect(Number.isInteger(rate.amountMinor), `amountMinor not an integer: ${what}`).toBe(true)
  expect(rate.amountMinor, what).toBeGreaterThanOrEqual(0)
  expect(rate.currency, what).toMatch(/^[A-Z]{3}$/)
  const days = rate.estimatedDays
  expect(
    days === null || (Number.isInteger(days) && days >= 0),
    `estimatedDays neither null nor an integer ≥ 0: ${what}`,
  ).toBe(true)
}

export function runShippingContract(
  name: string,
  build: Build<ShippingAdapter>,
  options: ShippingContractOptions = {},
): void {
  const from = options.from ?? FROM
  const to = options.to ?? TO
  const trackingNumber = options.trackingNumber ?? freshNumber
  const carrier = options.carrier ?? null

  async function ratesOf(adapter: ShippingAdapter, parcel: Parcel): Promise<ShippingRate[]> {
    const rates = await adapter.rate!({ from, to, parcel })
    expect(Array.isArray(rates), 'rate() did not answer an array').toBe(true)
    return rates
  }

  /** The first declared word's method, called as the store would; none for an adapter without a word. */
  function firstOperation(adapter: ShippingAdapter): (() => Promise<unknown>) | undefined {
    const word = WORDS.find((w) => serves(adapter, w))
    if (word === 'rates') return () => adapter.rate!({ from, to, parcel: options.parcel ?? PARCEL })
    if (word === 'labels') return () => adapter.createLabel!({ rateId: 'contract-unbought-rate' })
    if (word === 'tracking') {
      return () => adapter.startTracking!({ trackingNumber: trackingNumber(), carrier })
    }
    return undefined
  }

  describe(`ShippingAdapter contract: ${name}`, () => {
    // Kills: a rejecting stub shipped under a word, a method the kernel cannot see because its word is missing, a
    // tracking adapter that cannot report back, a label with no rate to buy it from, a word the kernel does not know.
    it(
      'words: each of rates, labels and tracking is declared exactly when its method (rate, createLabel, startTracking) is a function; tracking needs receiveWebhook, labels needs rates, and no other word is declared or any twice',
      () =>
        using(build, async (adapter) => {
          const words = [...(adapter.capabilities() as readonly string[])]
          const methods = adapter as Methods

          expect(
            words.filter((w) => !(WORDS as readonly string[]).includes(w)),
            'words the shipping slot does not have',
          ).toEqual([])
          expect(words.length, `a word declared twice: ${JSON.stringify(words)}`).toBe(
            new Set(words).size,
          )
          expect(
            Object.fromEntries(WORDS.map((w) => [w, words.includes(w)])),
            'declared words against the methods present',
          ).toEqual(
            Object.fromEntries(WORDS.map((w) => [w, typeof methods[METHOD[w]] === 'function'])),
          )
          if (words.includes('tracking')) {
            expect(typeof adapter.receiveWebhook, 'tracking without receiveWebhook').toBe(
              'function',
            )
          }
          if (words.includes('labels')) {
            expect(words, 'labels without rates: a label is bought from a rate').toContain('rates')
          }
        }),
      CASE_MS,
    )

    it(
      'rates: property: over generated parcels, every rate has a non-empty id, an integer amountMinor ≥ 0, a three-letter currency and estimatedDays null or an integer ≥ 0',
      (ctx) =>
        using(build, async (adapter) => {
          if (!serves(adapter, 'rates')) return ctx.skip()
          const parcels = options.parcel === undefined ? arbParcel : fc.constant(options.parcel)
          await fc.assert(
            fc.asyncProperty(parcels, async (parcel) => {
              for (const rate of await ratesOf(adapter, parcel)) expectRate(rate)
            }),
            { numRuns: 3 },
          )
        }),
      CASE_MS,
    )

    it(
      'labels: createLabel({ rateId }) of a returned rate answers a labelUrl that parses as a URL and a non-empty trackingNumber',
      (ctx) =>
        using(build, async (adapter) => {
          if (!serves(adapter, 'labels') || !serves(adapter, 'rates')) return ctx.skip()
          const rates = await ratesOf(adapter, options.parcel ?? PARCEL)
          expect(rates.length, 'no rate to buy a label from').toBeGreaterThan(0)

          const label = await adapter.createLabel!({ rateId: rates[0]!.id })

          expect(URL.canParse(label.labelUrl), `labelUrl ${label.labelUrl}`).toBe(true)
          expect(label.trackingNumber.trim().length, JSON.stringify(label)).toBeGreaterThan(0)
        }),
      CASE_MS,
    )

    // Kills: a retried buy (its first answer lost) charging the store for a second label.
    it(
      'labels: property: one rateId bought 2 to 3 times answers the first label’s trackingNumber or rejects, never a second, different label',
      (ctx) =>
        using(build, async (adapter) => {
          if (!serves(adapter, 'labels') || !serves(adapter, 'rates')) return ctx.skip()
          await fc.assert(
            fc.asyncProperty(fc.integer({ min: 2, max: 3 }), fc.nat(), async (buys, pick) => {
              const rates = await ratesOf(adapter, options.parcel ?? PARCEL)
              expect(rates.length, 'no rate to buy a label from').toBeGreaterThan(0)
              const rateId = rates[pick % rates.length]!.id
              const first = await adapter.createLabel!({ rateId })
              const again: string[] = []
              for (let i = 1; i < buys; i += 1) {
                const answer = await settle(() => adapter.createLabel!({ rateId }))
                if (answer.state === 'resolved') again.push(answer.value.trackingNumber)
                else expect(answer.state, 'a repeated buy hung').toBe('rejected')
              }
              expect(again, `rate ${rateId} bought ${buys} times`).toEqual(
                again.map(() => first.trackingNumber),
              )
            }),
            { numRuns: 3 },
          )
        }),
      CASE_MS,
    )

    // Kills: a repeat registration that throws, which the kernel's relay would retry until the event dies.
    it(
      'tracking: startTracking of one number twice answers tracking both times',
      (ctx) =>
        using(build, async (adapter) => {
          if (!serves(adapter, 'tracking')) return ctx.skip()
          const number = trackingNumber()

          const first = await adapter.startTracking!({ trackingNumber: number, carrier })
          const second = await adapter.startTracking!({ trackingNumber: number, carrier })

          expect([first, second]).toEqual([{ status: 'tracking' }, { status: 'tracking' }])
        }),
      CASE_MS,
    )

    it(
      'health: healthCheck() resolves healthy or degraded within 6 s',
      () => using(build, (adapter) => expectHealthy(adapter)),
      CASE_MS,
    )

    const unreachable = options.unreachable
    if (unreachable === undefined) return
    describe('unreachable dependency', () => {
      it(
        'down: healthCheck() reports down within 6 s',
        () => using(unreachable, (adapter) => expectDown(adapter)),
        CASE_MS,
      )
      it(
        'down: the first declared word’s method rejects within 6 s instead of hanging',
        (ctx) =>
          using(unreachable, async (adapter) => {
            const operation = firstOperation(adapter)
            if (operation === undefined) return ctx.skip()
            await expectRejects(operation)
          }),
        CASE_MS,
      )
    })
  })
}
