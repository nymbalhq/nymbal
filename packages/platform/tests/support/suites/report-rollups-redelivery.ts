import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Kernel } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import {
  AROUND_CLOCK_CHANGE,
  clearReports,
  deliver,
  rollupEventArb,
  seedPool,
  storedRollups,
  type Pool,
} from '../report-rollups.js'

// One event applied once, however it reaches the handler: repeated, or by two workers at the same moment.

export function reportRollupRedeliverySuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`AC-10: redelivery applies an event once (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    let pool: Pool

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
      pool = await seedPool(k)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    it(`AC-10: property: redelivering a delivered event any number of times leaves every report table as the first delivery did (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          rollupEventArb(pool, AROUND_CLOCK_CHANGE),
          fc.integer({ min: 1, max: 4 }),
          async (event, repeats) => {
            await clearReports(k)
            await deliver(k, event)
            const afterFirst = await storedRollups(raw)

            for (let i = 0; i < repeats; i += 1) await deliver(k, event)

            expect(await storedRollups(raw)).toEqual(afterFirst)
          },
        ),
        { numRuns: 10 },
      )
    }, 120_000)

    it(`AC-10: property: two concurrent deliveries of one event leave what a single delivery of it leaves (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(rollupEventArb(pool, AROUND_CLOCK_CHANGE), async (event) => {
          await clearReports(k)
          await deliver(k, { ...event, id: randomUUID() })
          const single = await storedRollups(raw)

          await clearReports(k)
          const twice = { ...event, id: randomUUID() }
          await Promise.all([deliver(k, twice), deliver(k, twice)])

          expect(await storedRollups(raw)).toEqual(single)
        }),
        { numRuns: 10 },
      )
    }, 120_000)
  })
}
