import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { runUntilKilled } from '@nymbalhq/proof-kit/chaos'
import { EVT_ORDER_PLACED, EVT_PRODUCT_CREATED } from '@nymbalhq/types'
import {
  CHAOS_ORDER_CHILD,
  chaosCase,
  delivered,
  readRows,
  removeChaosCases,
} from './fixtures/chaos'

// Acceptance test for P1-01 AC-9: armChaos on the bus of a real store (createApp, through startTestStore) inside a
// child process. Killing it before order.placed.v1 is published leaves the order row in the SQLite file and the
// event undelivered: the kernel's write-then-publish gap is observable.

afterAll(() => {
  removeChaosCases()
})

describe('AC-9: the chaos wrapper on a real createApp bus', () => {
  it('AC-9: point { beforePublish: order.placed.v1 } kills the child after the order row exists, before the event is delivered', async () => {
    const c = chaosCase()
    // `+stub-pending` (P1-12 decision 7): the order stays pending, so the kill finds it as checkout left it.
    const email = `chaos-${randomUUID()}+stub-pending@proof-kit.test`
    const run = await runUntilKilled({
      script: CHAOS_ORDER_CHILD,
      args: [c.db, c.marker, email],
      point: { beforePublish: EVT_ORDER_PLACED },
      timeoutMs: 45_000,
    })

    expect(
      { killed: run.killed, signal: run.signal, timedOut: run.timedOut },
      `${run.stdout}\n${run.stderr}`,
    ).toEqual({ killed: true, signal: 'SIGKILL', timedOut: false })
    const orders = readRows<{ email: string; status: string }>(
      c.db,
      'SELECT email, status FROM orders',
    )
    expect(orders).toEqual([{ email, status: 'pending' }])
    const seen = delivered(c.marker)
    // The subscriber saw the kernel's earlier publishes, so the missing event is a kill, not a deaf subscriber.
    expect(seen).toContain(EVT_PRODUCT_CREATED)
    expect(seen).not.toContain(EVT_ORDER_PLACED)
    // The gap itself: more order rows than order.placed deliveries.
    expect(seen.filter((type) => type === EVT_ORDER_PLACED).length).toBeLessThan(orders.length)
  }, 60_000)
})
