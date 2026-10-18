import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AdapterError,
  EVT_INVENTORY_RELEASED,
  NotFoundError,
  ValidationError,
  type NymbalEvent,
} from '@nymbalhq/types'
import { seedVariant, type Kernel } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'

// P1-02 AC-3, AC-13 and AC-16 on one dialect: the conditional decrement under concurrency, adjustStock's floor and
// its concurrency, and the release/commit race on one reservation. State is read through a second connection.

export function inventoryConcurrencySuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { propertyRuns: number },
): void {
  describe(`inventory under concurrency (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    it(`AC-3: property: for any initial stock 0..10 and 1..20 concurrent reserveStock calls of qty 1..4, successes' qty sum <= initial, final stock = initial - that sum >= 0, one reservation row per success, every failure is inventory.insufficient (${opts.propertyRuns} runs)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10 }),
          fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 20 }),
          async (initial, qtys) => {
            const seeded = await seedVariant(k, initial)
            const settled = await Promise.allSettled(
              qtys.map((qty) => k.services.inventory.reserveStock(seeded.variantId, qty)),
            )
            const reservedQty = settled.reduce(
              (sum, r, i) => sum + (r.status === 'fulfilled' ? qtys[i]! : 0),
              0,
            )
            const successes = settled.filter((r) => r.status === 'fulfilled').length
            const failures = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
            const final = await stockOf(raw, seeded.variantId)
            const rows = await raw.count('inventory_reservations', 'variant_id = ?', [
              seeded.variantId,
            ])

            expect(reservedQty, `initial ${initial}, qtys ${qtys}`).toBeLessThanOrEqual(initial)
            expect(final).toBeGreaterThanOrEqual(0)
            expect(final).toBe(initial - reservedQty)
            expect(rows).toBe(successes)
            for (const failure of failures) {
              expect(failure).toBeInstanceOf(AdapterError)
              // AdapterError prefixes its codes with `adapter.`.
              expect((failure as AdapterError).code).toBe('adapter.inventory.insufficient')
            }
          },
        ),
        { numRuns: opts.propertyRuns },
      )
    }, 120_000)

    it('AC-13: adjustStock with a negative delta larger than stock rejects with ValidationError and changes nothing', async () => {
      const seeded = await seedVariant(k, 5)
      await expect(
        k.services.inventory.adjustStock(seeded.variantId, -6, 'manual', 'tester'),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])).toBe(0)
    })

    it('AC-16: release and commit of one reservation cannot both land: one stock-adjustment row, one inventory.released.v1, stock initial - q if commit won else initial, 10 runs', async () => {
      const released: NymbalEvent<{ reservationId: string; reason: string }>[] = []
      await k.eventBus.subscribe(EVT_INVENTORY_RELEASED, (event) => {
        released.push(event as NymbalEvent<{ reservationId: string; reason: string }>)
      })
      const qtys = fc.sample(fc.integer({ min: 1, max: 5 }), { numRuns: 10, seed: 102 })
      const initial = 10

      const outcomes: Array<{ winner: 'commit' | 'release'; consistent: boolean }> = []
      for (const q of qtys) {
        const seeded = await seedVariant(k, initial)
        const { reservationId } = await k.services.inventory.reserveStock(seeded.variantId, q)
        expect(await stockOf(raw, seeded.variantId)).toBe(initial - q)

        const [release, commit] = await Promise.allSettled([
          k.services.inventory.releaseReservation(reservationId, 'expired'),
          k.services.inventory.commitReservation(reservationId, 'tester'),
        ])

        expect(release!.status).toBe('fulfilled')
        const winner = commit!.status === 'fulfilled' ? 'commit' : 'release'
        if (commit!.status === 'rejected') expect(commit!.reason).toBeInstanceOf(NotFoundError)

        const stock = await stockOf(raw, seeded.variantId)
        const adjustments = await raw.count('stock_adjustments', 'variant_id = ?', [
          seeded.variantId,
        ])
        const releasedForR = released.filter((e) => e.payload.reservationId === reservationId)
        const expectedStock = winner === 'commit' ? initial - q : initial

        expect(adjustments, `q=${q}, winner ${winner}: stock-adjustment rows`).toBe(1)
        expect(releasedForR.length, `q=${q}, winner ${winner}: released events`).toBe(1)
        expect(stock, `q=${q}, winner ${winner}: stock`).toBe(expectedStock)
        expect(
          await raw.count('inventory_reservations', 'reservation_id = ?', [reservationId]),
        ).toBe(0)
        outcomes.push({ winner, consistent: stock === expectedStock && adjustments === 1 })
      }
      expect(outcomes.filter((o) => !o.consistent)).toEqual([])
    }, 30_000)

    // Last on purpose: today's Postgres kernel holds a pool connection per transaction and takes a second one for
    // every repository call, so ten concurrent transactions exhaust the default pool and this hangs until timeout.
    it('AC-13: ten concurrent adjustStock(-1) on stock 5 succeed exactly five times; the rest reject with ValidationError and stock ends at 0', async () => {
      const seeded = await seedVariant(k, 5)
      const settled = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          k.services.inventory.adjustStock(seeded.variantId, -1, 'manual', 'tester'),
        ),
      )
      const fulfilled = settled.filter((r) => r.status === 'fulfilled').length
      const rejections = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
      const final = await stockOf(raw, seeded.variantId)
      const adjustments = await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])

      expect(fulfilled, 'adjustStock(-1) calls that succeeded').toBe(seeded.initialStock)
      expect(final, 'final stock = initial - successful decrements').toBe(
        seeded.initialStock - fulfilled,
      )
      expect(adjustments, 'one stock-adjustment row per success').toBe(fulfilled)
      expect(final).toBe(0)
      for (const reason of rejections) expect(reason).toBeInstanceOf(ValidationError)
    })
  })
}
