import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EventBusAdapter, NymbalEvent } from '@nymbalhq/types'
import type { Build } from './common.js'

// The event bus delivery contract. With `second` (another instance on the same streams as the bus `make` returned
// last) and `timing` (the bus's own knobs, set small) it adds the cases only a shared bus has. Kills: a publish that
// resolves before its handlers ran (a read straight after a command misses its projection), a throwing named handler
// that is swallowed or starves another, replay reaching side effects, batch order lost, two instances double-handling a
// named event, an instance missing an unnamed (admin tab) event, and a dead instance or consumer stalling every
// publish (every checkout) until the timeout.

/** What the delivery cases read of the suite's options. */
export interface DeliveryOptions {
  second?: () => Promise<EventBusAdapter>
  timing?: { claimIdleMs: number; ackTimeoutMs: number }
}

const SLOW = 60_000

function event(type: string, payload: Record<string, unknown> = {}): NymbalEvent {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'contract-contract',
    correlationId: `corr-${randomUUID()}`,
    payload,
    metadata: { storeId: 'contract', environment: 'development', version: '0.0.0' },
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `check` (no fixed sleep); throws naming `label` after `ms`. */
async function until(check: () => boolean, label: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await delay(10)
  }
}

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void
  const wait = new Promise<void>((r) => {
    open = r
  })
  return { wait, open }
}

async function closingAll(buses: EventBusAdapter[], body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } finally {
    for (const bus of buses) await bus.close()
  }
}

const TYPES = ['order.created.v1', 'order.paid.v1', 'cart.updated.v1'] as const

/** The delivery cases, registered inside the suite's describe. */
export function eventBusDeliveryCases(make: Build<EventBusAdapter>, opts: DeliveryOptions): void {
  describe('keeps the delivery contract', () => {
    it(
      'publish resolves only after every matching handler has finished: a 200 ms handler, named and unnamed, is done first',
      async () => {
        const bus = await make()
        await closingAll([bus], async () => {
          const finished: string[] = []
          await bus.subscribe('contract.slow.v1', async () => {
            await delay(200)
            finished.push('unnamed')
          })
          await bus.subscribe(
            'contract.slow.v1',
            async () => {
              await delay(200)
              finished.push('named')
            },
            { name: 'contract-slow' },
          )

          const startedAt = Date.now()
          await bus.publish(event('contract.slow.v1'))
          const elapsed = Date.now() - startedAt

          expect([...finished].sort()).toEqual(['named', 'unnamed'])
          expect(elapsed).toBeGreaterThanOrEqual(190)
        })
      },
      SLOW,
    )

    it(
      'a throwing named handler rejects publish with handler_failed naming it, and every other matching handler is called, event after event',
      async () => {
        const bus = await make()
        await closingAll([bus], async () => {
          const received: string[] = []
          await bus.subscribe(
            'contract.boom.v1',
            async () => {
              throw new Error('contract handler failure')
            },
            { name: 'contract-throws' },
          )
          await bus.subscribe('contract.boom.v1', async (e) => {
            received.push(e.id)
          })
          const events = [
            event('contract.boom.v1'),
            event('contract.boom.v1'),
            event('contract.boom.v1'),
          ]

          for (const e of events) {
            await expect(bus.publish(e)).rejects.toMatchObject({
              code: 'adapter.handler_failed',
              context: { eventId: e.id, failed: [{ subscription: 'contract-throws' }] },
            })
          }

          expect(received).toEqual(events.map((e) => e.id))
        })
      },
      SLOW,
    )

    it(
      'replay reaches derived subscriptions only, in order; a later publish still reaches every subscription',
      async () => {
        const bus = await make()
        await closingAll([bus], async () => {
          const derived: string[] = []
          const sideNamed: string[] = []
          const sideUnnamed: string[] = []
          await bus.subscribe('contract.replay.v1', async (e) => void derived.push(e.id), {
            name: 'contract-projection',
            derived: true,
          })
          await bus.subscribe('contract.replay.v1', async (e) => void sideNamed.push(e.id), {
            name: 'contract-side-effect',
          })
          await bus.subscribe('contract.replay.v1', async (e) => void sideUnnamed.push(e.id))
          const replayed = [event('contract.replay.v1'), event('contract.replay.v1')]

          await bus.replay(replayed)

          expect(derived).toEqual(replayed.map((e) => e.id))
          expect(sideNamed).toEqual([])
          expect(sideUnnamed).toEqual([])

          const live = event('contract.replay.v1')
          await bus.publish(live)
          expect(derived).toEqual([...replayed, live].map((e) => e.id))
          expect(sideNamed).toEqual([live.id])
          expect(sideUnnamed).toEqual([live.id])
        })
      },
      SLOW,
    )

    it(
      'publishBatch reaches each subscription with exactly its matching events, in batch order (wildcards and pattern arrays)',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 12 }),
            async (types) => {
              const bus = await make()
              await closingAll([bus], async () => {
                const fence = event('contract.fence.v1')
                const subs = [
                  { patterns: ['order.*', fence.type], name: undefined },
                  {
                    patterns: ['cart.updated.v1', 'order.paid.v1', fence.type],
                    name: 'contract-arr',
                  },
                  { patterns: ['order.created.v1', fence.type], name: 'contract-one' },
                ]
                const seen = subs.map(() => [] as string[])
                for (const [i, sub] of subs.entries()) {
                  await bus.subscribe(
                    sub.patterns,
                    async (e) => void seen[i]!.push(e.id),
                    sub.name === undefined ? undefined : { name: sub.name },
                  )
                }
                const events = types.map((type, seq) => event(type, { seq }))

                await bus.publishBatch(events)
                // Each subscription takes its events in order, so once the fence is handled the batch was too.
                await bus.publish(fence)

                const matches = (patterns: string[], type: string): boolean =>
                  patterns.some((p) =>
                    p.endsWith('*') ? type.startsWith(p.slice(0, -1)) : p === type,
                  )
                for (const [i, sub] of subs.entries()) {
                  const expected = events.filter((e) => matches(sub.patterns, e.type))
                  expect(seen[i], sub.patterns.join('|')).toEqual([
                    ...expected.map((e) => e.id),
                    fence.id,
                  ])
                }
              })
            },
          ),
          { numRuns: 15 },
        )
      },
      SLOW,
    )

    it(
      'an unsubscribed handler, by bus.unsubscribe or by its own unsubscribe(), receives nothing more',
      async () => {
        const bus = await make()
        await closingAll([bus], async () => {
          const gone: string[] = []
          const goneToo: string[] = []
          const kept: string[] = []
          const a = await bus.subscribe('contract.unsub.v1', async (e) => void gone.push(e.id), {
            name: 'contract-unsub',
          })
          const b = await bus.subscribe('contract.unsub.v1', async (e) => void goneToo.push(e.id))
          await bus.subscribe('contract.unsub.v1', async (e) => void kept.push(e.id))
          const before = event('contract.unsub.v1')
          await bus.publish(before)

          await bus.unsubscribe(a)
          await b.unsubscribe()
          const after = [event('contract.unsub.v1'), event('contract.unsub.v1')]
          for (const e of after) await bus.publish(e)

          expect(kept).toEqual([before, ...after].map((e) => e.id))
          expect(gone).toEqual([before.id])
          expect(goneToo).toEqual([before.id])
        })
      },
      SLOW,
    )

    it(
      'on one instance, a named and an unnamed subscription each handle every event once',
      async () => {
        const bus = await make()
        await closingAll([bus], async () => {
          const named: string[] = []
          const unnamed: string[] = []
          await bus.subscribe('contract.both.v1', async (e) => void named.push(e.id), {
            name: 'contract-named',
          })
          await bus.subscribe('contract.both.v1', async (e) => void unnamed.push(e.id))
          const events = Array.from({ length: 6 }, () => event('contract.both.v1'))

          for (const e of events) await bus.publish(e)

          expect(named).toEqual(events.map((e) => e.id))
          expect(unnamed).toEqual(named)
        })
      },
      SLOW,
    )

    const second = opts.second
    if (second === undefined) return

    describe('two instances on the same streams', () => {
      const N = 12

      it(
        'one named subscription on both instances handles each of N events exactly once in total',
        async () => {
          const a = await make()
          const b = await second()
          await closingAll([a, b], async () => {
            const byA: string[] = []
            const byB: string[] = []
            await a.subscribe('contract.named.*', async (e) => void byA.push(e.id), {
              name: 'contract-shared',
            })
            await b.subscribe('contract.named.*', async (e) => void byB.push(e.id), {
              name: 'contract-shared',
            })
            const events = Array.from({ length: N }, (_, seq) => event('contract.named.x', { seq }))

            for (const [i, e] of events.entries()) await (i % 2 === 0 ? a : b).publish(e)
            // A per-instance group would hand every event to both; these fences make its copies show before the count.
            await b.publish(event('contract.named.fence'))
            await a.publish(event('contract.named.fence'))

            const ids = new Set(events.map((e) => e.id))
            const handled = [...byA, ...byB].filter((id) => ids.has(id))
            expect(handled.length).toBe(events.length)
            expect([...handled].sort()).toEqual(events.map((e) => e.id).sort())
          })
        },
        SLOW,
      )

      it(
        'an unnamed subscription on each instance receives all N events, in order, on both',
        async () => {
          const a = await make()
          const b = await second()
          await closingAll([a, b], async () => {
            const onA: string[] = []
            const onB: string[] = []
            await a.subscribe('contract.fanout.*', async (e) => void onA.push(e.id))
            await b.subscribe('contract.fanout.*', async (e) => void onB.push(e.id))
            const events = Array.from({ length: N }, (_, seq) =>
              event('contract.fanout.x', { seq }),
            )

            for (const e of events) await a.publish(e)
            const fenceB = event('contract.fanout.fence')
            await b.publish(fenceB)

            const ids = events.map((e) => e.id)
            expect(onA.slice(0, N)).toEqual(ids)
            expect(onB.slice(0, N)).toEqual(ids)
            expect(onB[N]).toBe(fenceB.id)
          })
        },
        SLOW,
      )

      it(
        'replay on one instance reaches its own derived handlers and nothing on the other instance',
        async () => {
          const a = await make()
          const b = await second()
          await closingAll([a, b], async () => {
            const derivedA: string[] = []
            const derivedB: string[] = []
            const sideB: string[] = []
            await a.subscribe('contract.rebuild.*', async (e) => void derivedA.push(e.id), {
              name: 'contract-projection',
              derived: true,
            })
            await b.subscribe('contract.rebuild.*', async (e) => void derivedB.push(e.id), {
              name: 'contract-projection',
              derived: true,
            })
            await b.subscribe('contract.rebuild.*', async (e) => void sideB.push(e.id), {
              name: 'contract-side-effect',
            })
            const replayed = [event('contract.rebuild.x'), event('contract.rebuild.x')]

            await a.replay(replayed)
            // b reads its groups in stream order: a replay that went through the stream would reach b before this.
            const fence = event('contract.rebuild.fence')
            await b.publish(fence)

            expect(derivedA.slice(0, replayed.length)).toEqual(replayed.map((e) => e.id))
            const ids = new Set(replayed.map((e) => e.id))
            expect(derivedB.filter((id) => ids.has(id))).toEqual([])
            expect(sideB).toEqual([fence.id])
          })
        },
        SLOW,
      )

      const timing = opts.timing
      if (timing === undefined) return
      const { claimIdleMs, ackTimeoutMs } = timing

      it(
        'groups left by a stopped instance (never unsubscribed) do not delay publish on the other instance',
        async () => {
          const a = await make()
          const b = await second()
          await closingAll([a], async () => {
            await b.subscribe('contract.left.*', async () => undefined, {
              name: 'contract-left-behind',
            })
            await b.subscribe('contract.left.*', async () => undefined)
            await b.close()
            const handled: string[] = []
            await a.subscribe('contract.left.*', async (e) => void handled.push(e.id), {
              name: 'contract-live',
            })
            const e = event('contract.left.x')

            const startedAt = Date.now()
            await a.publish(e)
            const elapsed = Date.now() - startedAt

            expect(handled).toEqual([e.id])
            expect(elapsed).toBeLessThan(ackTimeoutMs / 2)
          })
        },
        SLOW,
      )

      it(
        'an entry pending on a stopped consumer of a named group is handled by the live one after claimIdleMs and before ackTimeoutMs',
        async () => {
          const a = await make()
          const b = await second()
          const held = gate()
          let closingB: Promise<void> | undefined
          try {
            let receivedByB: number | undefined
            await b.subscribe(
              'contract.claim.*',
              async () => {
                receivedByB = Date.now()
                await held.wait
              },
              { name: 'contract-claimed' },
            )
            const stranded = event('contract.claim.x')
            // a holds no subscription to the group yet, so this publish waits on nothing and b's consumer takes it.
            await a.publish(stranded)
            await until(() => receivedByB !== undefined, 'b to receive the entry', ackTimeoutMs)
            closingB = b.close()

            const byA: Array<{ id: string; at: number }> = []
            await a.subscribe(
              'contract.claim.*',
              async (e) => void byA.push({ id: e.id, at: Date.now() }),
              {
                name: 'contract-claimed',
              },
            )
            const next = event('contract.claim.x')
            const startedAt = Date.now()
            await a.publish(next)
            const publishMs = Date.now() - startedAt
            await until(
              () => byA.some((h) => h.id === stranded.id),
              'a to take over the stranded entry',
              ackTimeoutMs * 2,
            )

            const claimed = byA.find((h) => h.id === stranded.id)!
            const idle = claimed.at - receivedByB!
            expect(idle, 'taken over before claimIdleMs').toBeGreaterThanOrEqual(claimIdleMs - 50)
            expect(idle, 'taken over only after ackTimeoutMs').toBeLessThan(ackTimeoutMs)
            expect(byA.filter((h) => h.id === stranded.id).length).toBe(1)
            expect(publishMs, 'a publish on the group waited out the timeout').toBeLessThan(
              ackTimeoutMs,
            )
          } finally {
            held.open()
            await closingB
            await a.close()
          }
        },
        SLOW,
      )

      it(
        'an unnamed subscription unsubscribed while publish waits on it lets publish resolve well before ackTimeoutMs',
        async () => {
          const a = await make()
          const held = gate()
          try {
            let entered = false
            const sub = await a.subscribe('contract.wait.*', async () => {
              entered = true
              await held.wait
            })
            const publishing = a.publish(event('contract.wait.x')).then(
              () => Date.now(),
              (error: unknown) => error,
            )
            await until(() => entered, 'the handler to start', ackTimeoutMs)

            const unsubscribedAt = Date.now()
            const unsubscribing = a.unsubscribe(sub)
            const outcome = await publishing

            expect(typeof outcome, `publish rejected: ${String(outcome)}`).toBe('number')
            expect((outcome as number) - unsubscribedAt).toBeLessThan(ackTimeoutMs / 2)
            held.open()
            await unsubscribing
          } finally {
            held.open()
            await a.close()
          }
        },
        SLOW,
      )
    })
  })
}
