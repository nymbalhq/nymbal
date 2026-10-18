import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_INVENTORY_LOW_STOCK,
  EVT_INVENTORY_OUT_OF_STOCK,
  EVT_INVENTORY_RESERVED,
  type NymbalEvent,
} from '@nymbalhq/types'
import { seedVariant, type Kernel } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'

// P1-02 AC-4 (SQLite) / AC-5 (Postgres): a transaction that writes through two repositories then throws leaves
// neither write. AC-9 (both): events are delivered after commit, never after rollback, in order, before
// `transaction` resolves; a rejected joined block poisons the outermost even when the outer callback catches it.

type Reserved = NymbalEvent<{ variantId: string; reservationId: string }>
type Marker = NymbalEvent<{ variantId: string }>

export function transactionsSuite(
  rollbackAc: string,
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`transactions (${dialect})`, () => {
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

    it(`${rollbackAc}: a transaction that writes a variant and a reservation through two repositories then throws leaves neither write and rejects with the thrown error`, async () => {
      const seeded = await seedVariant(k, 1)
      const variantId = randomUUID()
      const reservationId = randomUUID()
      const now = new Date()
      const boom = new Error('abort after two writes')

      await expect(
        k.store.transaction(async (tx) => {
          await k.repos.variant.insert(tx, {
            id: variantId,
            productId: seeded.productId,
            sku: `RB-${variantId}`,
            name: 'Rolled back',
            priceMinor: 100,
            stock: 4,
            options: [],
            createdAt: now,
            updatedAt: now,
          })
          await k.repos.inventoryReservation.insert(tx, {
            reservationId,
            variantId,
            qty: 1,
            orderRef: null,
            expiresAt: new Date(now.getTime() + 60_000),
            createdAt: now,
          })
          throw boom
        }),
      ).rejects.toBe(boom)

      const variants = await raw.count('variants', 'id = ?', [variantId])
      const reservations = await raw.count('inventory_reservations', 'reservation_id = ?', [
        reservationId,
      ])
      expect({ variants, reservations }).toEqual({ variants: 0, reservations: 0 })
      // The read API agrees with the second connection.
      expect(await k.store.read((tx) => k.repos.variant.findById(tx, variantId))).toBeNull()
    })

    it('AC-9: a subscriber to inventory.reserved.v1 always sees the reservation row, through store.read and through a second connection', async () => {
      const seeded = await seedVariant(k, 20)
      const seen: Array<{ viaStoreRead: unknown; viaSecondConnection: number }> = []
      await k.eventBus.subscribe(EVT_INVENTORY_RESERVED, async (event) => {
        const { variantId, reservationId } = (event as Reserved).payload
        if (variantId !== seeded.variantId) return
        const viaStoreRead = await (async () => {
          try {
            const row = await k.store.read((tx) =>
              k.repos.inventoryReservation.findById(tx, reservationId),
            )
            return row === null ? 'no row' : 'row'
          } catch (error) {
            return `error: ${String(error)}`
          }
        })()
        const viaSecondConnection = await raw.count(
          'inventory_reservations',
          'reservation_id = ?',
          [reservationId],
        )
        seen.push({ viaStoreRead, viaSecondConnection })
      })

      const attempts = 5
      for (let i = 0; i < attempts; i += 1) {
        await k.services.inventory.reserveStock(seeded.variantId, 1)
      }

      expect(seen).toHaveLength(attempts)
      expect(seen.filter((s) => s.viaStoreRead !== 'row' || s.viaSecondConnection !== 1)).toEqual(
        [],
      )
    })

    it('AC-9: a transaction that publishes then throws delivers nothing', async () => {
      const marker = `rollback-${randomUUID()}`
      const delivered: string[] = []
      await k.eventBus.subscribe(EVT_INVENTORY_LOW_STOCK, (event) => {
        if ((event as Marker).payload.variantId === marker) delivered.push(event.type)
      })

      await expect(
        k.store.transaction(async () => {
          await k.publisher.publish(EVT_INVENTORY_LOW_STOCK, {
            variantId: marker,
            currentQty: 1,
            threshold: 2,
          })
          throw new Error('abort after publish')
        }),
      ).rejects.toThrow('abort after publish')

      expect(delivered).toEqual([])
    })

    it('AC-9: two publishes inside one transaction arrive in order, and transaction() resolves only after they are delivered', async () => {
      const marker = `order-${randomUUID()}`
      const delivered: string[] = []
      await k.eventBus.subscribe([EVT_INVENTORY_LOW_STOCK, EVT_INVENTORY_OUT_OF_STOCK], (event) => {
        if ((event as Marker).payload.variantId === marker) delivered.push(event.type)
      })

      const seenAtResolve = await k.store.transaction(async () => {
        await k.publisher.publish(EVT_INVENTORY_LOW_STOCK, {
          variantId: marker,
          currentQty: 1,
          threshold: 2,
        })
        await k.publisher.publish(EVT_INVENTORY_OUT_OF_STOCK, { variantId: marker })
        return delivered.length
      })

      // Nothing awaited between the resolution and this line.
      expect(delivered).toEqual([EVT_INVENTORY_LOW_STOCK, EVT_INVENTORY_OUT_OF_STOCK])
      expect(seenAtResolve).toBeLessThan(delivered.length)
    })

    it('AC-9: a joined block that rejects and is caught by the outer callback still rolls back the outermost, which rejects and delivers nothing (rule 3)', async () => {
      const marker = `poison-${randomUUID()}`
      const delivered: string[] = []
      await k.eventBus.subscribe([EVT_INVENTORY_LOW_STOCK, EVT_INVENTORY_OUT_OF_STOCK], (event) => {
        if ((event as Marker).payload.variantId === marker) delivered.push(event.type)
      })
      const outerSlug = `outer-${marker}`
      const innerSlug = `inner-${marker}`

      await expect(
        k.store.transaction(async () => {
          await k.services.product.create({ slug: outerSlug, name: 'Outer', status: 'active' })
          try {
            await k.store.transaction(async () => {
              await k.services.product.create({ slug: innerSlug, name: 'Inner', status: 'active' })
              await k.publisher.publish(EVT_INVENTORY_LOW_STOCK, {
                variantId: marker,
                currentQty: 1,
                threshold: 2,
              })
              throw new Error('inner failure')
            })
          } catch {
            // swallowed on purpose: the outer caller pretends nothing happened
          }
          await k.publisher.publish(EVT_INVENTORY_OUT_OF_STOCK, { variantId: marker })
          return 'committed'
        }),
      ).rejects.toThrow()

      const products = await raw.rows<{ slug: string }>(
        'SELECT slug FROM products WHERE slug = ? OR slug = ?',
        [outerSlug, innerSlug],
      )
      expect(products).toEqual([])
      expect(delivered).toEqual([])
    })
  })
}
