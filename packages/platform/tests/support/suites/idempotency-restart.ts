import { describe, expect, it } from 'vitest'
import type { NymbalEvent } from '@nymbalhq/types'
import { createEventBuilder } from '../../../src/events/builder.js'
import { withIdempotency } from '../../../src/handlers/idempotency.js'
import type { Kernel } from '../kernel.js'
import { TEST_BUILDER_CONTEXT } from '../publisher.js'
import { openRaw } from '../raw.js'

// P1-03 AC-7 on one dialect: a withIdempotency handler sees an event id, the kernel stops, a new kernel opens the same
// database, and the same envelope delivered again does not run the side effect. The record is a processed_events row,
// so the restart cannot forget it. The handler is called directly, as a subscriber would be.

const HANDLER = 'ac7:side-effect'

export interface RestartableDatabase {
  /** A kernel on this database; each call is a fresh process's worth of state (bus, document store, repositories). */
  open(): Promise<Kernel>
  drop(): Promise<void>
}

export function idempotencyRestartSuite(
  dialect: Kernel['dialect'],
  fresh: () => Promise<RestartableDatabase>,
): void {
  describe(`idempotency across a restart (${dialect})`, () => {
    it(`AC-7: the same envelope delivered after a restart does not run the side effect again, and processed_events holds (handler, event id) (${dialect})`, async () => {
      const db = await fresh()
      try {
        const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
        const event = makeEvent('ac7.probe.v1', { n: 1 }) as NymbalEvent<unknown>
        const other = makeEvent('ac7.probe.v1', { n: 2 }) as NymbalEvent<unknown>
        const ran: string[] = []
        const sideEffect = async (e: NymbalEvent<unknown>): Promise<void> => {
          ran.push(e.id)
        }

        const first = await db.open()
        try {
          await withIdempotency(HANDLER, sideEffect, {
            repo: first.repos.processedEvent,
            logger: first.logger,
          })(event)
        } finally {
          await first.close()
        }
        expect(ran).toEqual([event.id])

        const second = await db.open()
        try {
          const handler = withIdempotency(HANDLER, sideEffect, {
            repo: second.repos.processedEvent,
            logger: second.logger,
          })
          await handler(event)
          expect(ran, 'the side effect ran again after the restart').toEqual([event.id])

          // Not a blanket skip: a new id still runs once.
          await handler(other)
          await handler(other)
          expect(ran).toEqual([event.id, other.id])

          const raw = openRaw(second.dialect, second.target)
          try {
            const rows = await raw.rows<{ handler_name: string; event_id: string }>(
              'SELECT handler_name, event_id FROM processed_events WHERE handler_name = ? ORDER BY event_id',
              [HANDLER],
            )
            expect(rows.map((r) => r.event_id).sort()).toEqual(ran.slice().sort())
          } finally {
            await raw.close()
          }
        } finally {
          await second.close()
        }
      } finally {
        await db.drop()
      }
    }, 90_000)
  })
}
