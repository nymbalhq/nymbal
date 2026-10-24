import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_ABANDONED, EVT_INVENTORY_RELEASED } from '@nymbalhq/types'
import { startInventoryReservationSweeper } from '../../src/sweepers/index.js'
import { correlationIdsOf, eventsAfter, originId, payloadOf } from '../support/correlation.js'
import { seedVariant } from '../support/kernel.js'
import { maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { clockAt, lineFor, migrateTarget, openReplica, type Replica } from '../support/replica.js'

// AC-4, the sweepers, on SQLite: each run gets one id, `<origin>:<uuidv7>` (`sweep:cart-abandonment:…`,
// `sweep:reservations:…`), and the next run another. The sweepers run on a replica (tests/support/replica.ts) on the
// test's clock. The import half is packages/cli/src/commands/import-correlation.test.ts.

const HOUR_MS = 60 * 60_000
const ABANDONMENT = originId('sweep:cart-abandonment')
const RESERVATIONS = originId('sweep:reservations')

let dir: string
let target: string
let raw: RawReader
let replica: Replica
const clock = clockAt()

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'events-sweeps-'))
  target = join(dir, 'store.sqlite')
  await migrateTarget('sqlite', target)
  replica = await openReplica('sqlite', target, { clock })
  raw = openRaw('sqlite', target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await replica?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('AC-4: one id per sweeper run', () => {
  it('AC-4: one cart-abandonment sweep over 3 abandoned carts publishes 3 cart.abandoned under one sweep:cart-abandonment:<uuidv7>; a second sweep publishes under another', async () => {
    const seeded = await seedVariant(replica, 100)
    const carts = async (n: number) => {
      const tokens: string[] = []
      for (let i = 0; i < n; i += 1) {
        const cart = await replica.services.cart.getOrCreate()
        await replica.services.cart.addItem(cart.token, lineFor(seeded, 1))
        tokens.push(cart.token)
      }
      return tokens
    }
    const sweep = replica.startSweeper({ inactivityMs: HOUR_MS })

    const first = await carts(3)
    clock.advance(HOUR_MS + 60_000)
    const beforeFirst = await maxSeq(raw)
    await sweep.tick()
    const firstRows = (await eventsAfter(raw, beforeFirst)).filter(
      (row) => row.type === EVT_CART_ABANDONED,
    )

    const second = await carts(1)
    clock.advance(HOUR_MS + 60_000)
    const beforeSecond = await maxSeq(raw)
    await sweep.tick()
    const secondRows = (await eventsAfter(raw, beforeSecond)).filter(
      (row) => row.type === EVT_CART_ABANDONED,
    )

    expect(firstRows.map((row) => payloadOf(row)['cartId']).sort()).toEqual([...first].sort())
    expect(secondRows.map((row) => payloadOf(row)['cartId'])).toEqual(second)

    const firstIds = [...new Set(correlationIdsOf(firstRows))]
    const secondIds = [...new Set(correlationIdsOf(secondRows))]
    expect(firstIds, 'the first sweep’s ids').toHaveLength(1)
    expect(ABANDONMENT.test(firstIds[0]!), firstIds[0]).toBe(true)
    expect(secondIds, 'the second sweep’s ids').toHaveLength(1)
    expect(ABANDONMENT.test(secondIds[0]!), secondIds[0]).toBe(true)
    expect(firstIds[0] === secondIds[0], 'two sweeps share an id').toBe(false)
  })

  it('AC-4: one reservation-expiry sweep over 3 expired reservations publishes every release under one sweep:reservations:<uuidv7>; a second sweep publishes under another', async () => {
    const seeded = await seedVariant(replica, 100)
    const sweeper = startInventoryReservationSweeper({
      inventoryService: replica.services.inventory,
      reservationRepo: replica.repos.inventoryReservation,
      logger: replica.logger,
      intervalMs: 3_600_000,
    })
    // Reservations taken with a TTL already in the past: the next tick releases them.
    const expire = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await replica.services.inventory.reserveStock(seeded.variantId, 1, null, -3600)
      }
    }
    try {
      await expire(3)
      const beforeFirst = await maxSeq(raw)
      await sweeper.tick()
      const firstRows = await eventsAfter(raw, beforeFirst)

      await expire(2)
      const beforeSecond = await maxSeq(raw)
      await sweeper.tick()
      const secondRows = await eventsAfter(raw, beforeSecond)

      const released = (rows: typeof firstRows) =>
        rows.filter(
          (row) => row.type === EVT_INVENTORY_RELEASED && payloadOf(row)['reason'] === 'expired',
        ).length
      expect([released(firstRows), released(secondRows)]).toEqual([3, 2])

      const firstIds = [...new Set(correlationIdsOf(firstRows))]
      const secondIds = [...new Set(correlationIdsOf(secondRows))]
      expect(firstIds, 'the first sweep’s ids, over every event it published').toHaveLength(1)
      expect(RESERVATIONS.test(firstIds[0]!), firstIds[0]).toBe(true)
      expect(secondIds, 'the second sweep’s ids, over every event it published').toHaveLength(1)
      expect(RESERVATIONS.test(secondIds[0]!), secondIds[0]).toBe(true)
      expect(firstIds[0] === secondIds[0], 'two sweeps share an id').toBe(false)
    } finally {
      sweeper.stop()
    }
  })
})
