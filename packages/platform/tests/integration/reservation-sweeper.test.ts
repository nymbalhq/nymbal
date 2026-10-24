import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_INVENTORY_RELEASED, type NymbalEvent } from '@nymbalhq/types'
import { startInventoryReservationSweeper } from '../../src/sweepers/inventory-reservation-sweeper.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'

// AC-12: the reservation sweeper returns the stock of an expired reservation on tick(), deletes the row and publishes
// one inventory.released.v1 with reason `expired`; a second tick changes nothing.

type Released = NymbalEvent<{ reservationId: string; reason: string }>

let k: Kernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

describe('AC-12: the reservation sweeper', () => {
  it('AC-12: a reservation past its expiry, then tick(): stock back to its pre-reservation value, the row gone, one inventory.released.v1 with reason expired; a second tick() changes nothing', async () => {
    const seeded = await seedVariant(k, 10)
    const qty = 3
    const released: Released[] = []
    await k.eventBus.subscribe(EVT_INVENTORY_RELEASED, (event) => {
      released.push(event as Released)
    })
    // A TTL in the past: the reservation is expired the moment it exists.
    const { reservationId } = await k.services.inventory.reserveStock(
      seeded.variantId,
      qty,
      null,
      -1,
    )
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
    const forThis = () => released.filter((e) => e.payload.reservationId === reservationId)

    const sweeper = startInventoryReservationSweeper({
      inventoryService: k.services.inventory,
      reservationRepo: k.repos.inventoryReservation,
      logger: k.logger,
      intervalMs: 60 * 60 * 1000,
    })
    try {
      await sweeper.tick()

      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      expect(await raw.count('inventory_reservations', 'reservation_id = ?', [reservationId])).toBe(
        0,
      )
      expect(forThis().map((e) => e.payload.reason)).toEqual(['expired'])
      const adjustmentsAfterFirst = await raw.count('stock_adjustments', 'variant_id = ?', [
        seeded.variantId,
      ])
      expect(adjustmentsAfterFirst).toBe(1)

      await sweeper.tick()

      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
      expect(forThis()).toHaveLength(1)
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])).toBe(
        adjustmentsAfterFirst,
      )
    } finally {
      sweeper.stop()
    }
  })
})
