import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EventBusAdapter, NymbalEvent } from '@nymbalhq/types'

export interface EventBusContractOptions {
  /** Another instance on the same streams as the bus `make` returned last: only a shared bus passes it. */
  second?: () => Promise<EventBusAdapter>
}

type Make = () => EventBusAdapter | Promise<EventBusAdapter>

const SLOW = 30_000

function makeEvent(type: string, payload: Record<string, unknown> = {}): NymbalEvent {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'contract-tests',
    correlationId: `corr-${randomUUID()}`,
    payload,
    metadata: { storeId: 'test', environment: 'development', version: '0.0.0' },
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function using(buses: EventBusAdapter[], body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } finally {
    for (const bus of buses) await bus.close()
  }
}

/**
 * The event bus contract every implementation runs. `publish` resolves only after every matching subscription's
 * handler has finished (what a read straight after a command relies on); a throwing handler is logged and does not
 * reject it; `replay` reaches `derived` subscriptions only; each subscription takes its events in order. With `second`,
 * a named subscription is handled once across instances and an unnamed one on every instance.
 */
export function runEventBusContract(
  name: string,
  make: Make,
  opts: EventBusContractOptions = {},
): void {
  describe(`EventBusAdapter contract: ${name}`, () => {
    it('publish resolves after the matching handler has finished, and never calls a non-matching one', async () => {
      const bus = await make()
      await using([bus], async () => {
        const received: unknown[] = []
        const other: unknown[] = []
        await bus.subscribe('test.event.v1', async (e) => {
          await delay(50)
          received.push(e.payload)
        })
        await bus.subscribe('test.other.v1', async (e) => void other.push(e))
        await bus.publish(makeEvent('test.event.v1', { x: 1 }))
        expect(received).toEqual([{ x: 1 }])
        expect(other).toEqual([])
      })
    })

    it('a handler that throws leaves publish resolved and every other handler called', async () => {
      const bus = await make()
      await using([bus], async () => {
        const results: string[] = []
        await bus.subscribe('error.test.v1', async () => {
          throw new Error('boom')
        })
        await bus.subscribe('error.test.v1', async () => void results.push('ok'))
        await expect(bus.publish(makeEvent('error.test.v1'))).resolves.toBeUndefined()
        expect(results).toEqual(['ok'])
      })
    })

    it('replay reaches derived subscriptions only', async () => {
      const bus = await make()
      await using([bus], async () => {
        const derived: string[] = []
        const sideEffect: string[] = []
        await bus.subscribe('replay.test.v1', async (e) => void derived.push(e.id), {
          name: 'contract-projection',
          derived: true,
        })
        await bus.subscribe('replay.test.v1', async (e) => void sideEffect.push(e.id), {
          name: 'contract-side-effect',
        })
        const events = [makeEvent('replay.test.v1'), makeEvent('replay.test.v1')]
        await bus.replay(events)
        expect(derived).toEqual(events.map((e) => e.id))
        expect(sideEffect).toEqual([])
      })
    })

    it('publishBatch reaches each subscription in batch order, through wildcards and pattern arrays', async () => {
      const bus = await make()
      await using([bus], async () => {
        const wildcard: string[] = []
        const listed: string[] = []
        await bus.subscribe('batch.*', async (e) => void wildcard.push(e.id))
        await bus.subscribe(['batch.a.v1', 'batch.c.v1'], async (e) => void listed.push(e.id), {
          name: 'contract-listed',
        })
        const events = ['batch.a.v1', 'batch.b.v1', 'batch.c.v1', 'batch.a.v1'].map((t, seq) =>
          makeEvent(t, { seq }),
        )
        await bus.publishBatch(events)
        expect(wildcard).toEqual(events.map((e) => e.id))
        expect(listed).toEqual(events.filter((e) => e.type !== 'batch.b.v1').map((e) => e.id))
      })
    })

    it('an unsubscribed handler receives nothing more', async () => {
      const bus = await make()
      await using([bus], async () => {
        const received: string[] = []
        const sub = await bus.subscribe('unsub.event.v1', async (e) => void received.push(e.id))
        const before = makeEvent('unsub.event.v1')
        await bus.publish(before)
        await bus.unsubscribe(sub)
        await bus.publish(makeEvent('unsub.event.v1'))
        expect(received).toEqual([before.id])
      })
    })

    it('on one instance, a named and an unnamed subscription each handle every event once', async () => {
      const bus = await make()
      await using([bus], async () => {
        const named: string[] = []
        const unnamed: string[] = []
        await bus.subscribe('both.event.v1', async (e) => void named.push(e.id), {
          name: 'contract-named',
        })
        await bus.subscribe('both.event.v1', async (e) => void unnamed.push(e.id))
        const events = [makeEvent('both.event.v1'), makeEvent('both.event.v1')]
        for (const e of events) await bus.publish(e)
        expect(named).toEqual(events.map((e) => e.id))
        expect(unnamed).toEqual(named)
      })
    })

    const second = opts.second
    if (second === undefined) return

    it(
      'across two instances, a named subscription handles each event once in total, and an unnamed one on each',
      async () => {
        const a = await make()
        const b = await second()
        await using([a, b], async () => {
          const named: string[] = []
          const onA: string[] = []
          const onB: string[] = []
          await a.subscribe('shared.*', async (e) => void named.push(e.id), {
            name: 'contract-shared',
          })
          await b.subscribe('shared.*', async (e) => void named.push(e.id), {
            name: 'contract-shared',
          })
          await a.subscribe('shared.*', async (e) => void onA.push(e.id))
          await b.subscribe('shared.*', async (e) => void onB.push(e.id))
          const events = Array.from({ length: 6 }, (_, seq) => makeEvent('shared.x', { seq }))
          for (const [i, e] of events.entries()) await (i % 2 === 0 ? a : b).publish(e)
          // Each instance's own unnamed subscription is waited on by its own publishes: a fence on each.
          const fenceA = makeEvent('shared.fence')
          const fenceB = makeEvent('shared.fence')
          await a.publish(fenceA)
          await b.publish(fenceB)

          const ids = events.map((e) => e.id)
          expect(named.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort())
          expect(onA.filter((id) => ids.includes(id))).toEqual(ids)
          expect(onB.filter((id) => ids.includes(id))).toEqual(ids)
        })
      },
      SLOW,
    )
  })
}
