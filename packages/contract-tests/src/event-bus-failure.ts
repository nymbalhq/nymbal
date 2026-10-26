import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EventBusAdapter, NymbalEvent } from '@nymbalhq/types'
import type { Build } from './common.js'
import type { DeliveryOptions } from './event-bus-delivery.js'

// What a bus does when a handler throws. A named subscription's throw rejects the publish with `handler_failed`
// naming it, once every other matching handler has finished; an unnamed one's is logged and fails nothing; a batch is
// handed out whole before it rejects; replay never rejects. The bus never retries on its own: the store publishes the
// event again, and that reaches every subscription. With `second` and `timing`, a failure on another instance is
// reported rather than timed out. Kills: a swallowed error (the store marks the event delivered and the side effect is
// lost), a rejection before the slow handlers finish, a batch cut short, a claim loop that re-runs the failed handler,
// and a cross-instance failure read as a success.

const SLOW = 60_000
/** How long the slow handler takes: a rejection before it has finished is the defect. */
const SLOW_HANDLER_MS = 200
/** The window a single-process bus is watched for a retry of its own; a shared bus is watched over 3 × claimIdleMs. */
const IN_PROCESS_WINDOW_MS = 200

function event(type: string, payload: Record<string, unknown> = {}): NymbalEvent {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'contract-failure',
    correlationId: `corr-${randomUUID()}`,
    payload,
    metadata: { storeId: 'contract', environment: 'development', version: '0.0.0' },
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

async function closing(buses: EventBusAdapter[], body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } finally {
    for (const bus of buses) await bus.close()
  }
}

interface Settled {
  state: 'resolved' | 'rejected'
  error: unknown
  /** When it settled. */
  at: number
  /** How long it took. */
  ms: number
}

async function settled(promise: Promise<unknown>): Promise<Settled> {
  const started = Date.now()
  try {
    await promise
    return { state: 'resolved', error: undefined, at: Date.now(), ms: Date.now() - started }
  } catch (error) {
    return { state: 'rejected', error, at: Date.now(), ms: Date.now() - started }
  }
}

interface Failure {
  name: string
  code: string
  message: string
  context: {
    eventId?: unknown
    eventType?: unknown
    failed?: Array<{ subscription: string; message: string }>
  }
}

/** The rejection as the store reads it: by name and code, so a copy of the error class in another package counts. */
function failure(outcome: Settled): Failure {
  expect(outcome.state, 'publish resolved, so the failure was swallowed').toBe('rejected')
  const e = outcome.error as Partial<Failure>
  return {
    name: String(e.name),
    code: String(e.code),
    message: String(e.message),
    context: (e.context ?? {}) as Failure['context'],
  }
}

const failedNames = (f: Failure): string[] => (f.context.failed ?? []).map((x) => x.subscription)

/** The handler-failure cases, registered inside the suite's describe. */
export function eventBusFailureCases(make: Build<EventBusAdapter>, opts: DeliveryOptions): void {
  const window = opts.timing === undefined ? IN_PROCESS_WINDOW_MS : 3 * opts.timing.claimIdleMs

  describe('reports handler failures', () => {
    it(
      'a named handler that throws rejects publish with handler_failed naming it alone, only after the other named handlers (one of them slow) have each run once and finished; a throwing unnamed handler is named nowhere; replay past a throwing derived handler resolves',
      async () => {
        const bus = await make()
        await closing([bus], async () => {
          const type = 'contract.failure.v1'
          const ran = { a: 0, b: 0, c: 0 }
          const finished: Record<'b' | 'c', number | undefined> = { b: undefined, c: undefined }
          await bus.subscribe(
            type,
            async () => {
              ran.a += 1
              throw new Error('contract handler A refused')
            },
            { name: 'contract-failure-a' },
          )
          await bus.subscribe(
            type,
            async () => {
              ran.b += 1
              await delay(SLOW_HANDLER_MS)
              finished.b = Date.now()
            },
            { name: 'contract-failure-b' },
          )
          await bus.subscribe(
            type,
            async () => {
              ran.c += 1
              finished.c = Date.now()
            },
            { name: 'contract-failure-c' },
          )
          await bus.subscribe(type, async () => {
            throw new Error('contract admin tab refused')
          })
          const e = event(type)

          const outcome = await settled(bus.publish(e))

          expect(ran).toEqual({ a: 1, b: 1, c: 1 })
          expect(finished.b, 'the slow handler finished before the rejection').toBeLessThanOrEqual(
            outcome.at,
          )
          expect(finished.c).toBeLessThanOrEqual(outcome.at)
          expect(outcome.ms).toBeGreaterThanOrEqual(SLOW_HANDLER_MS - 10)

          const rebuilt: string[] = []
          await bus.subscribe(
            'contract.failure-replay.v1',
            async () => {
              throw new Error('contract projection refused')
            },
            { name: 'contract-failure-projection-a', derived: true },
          )
          await bus.subscribe('contract.failure-replay.v1', async (r) => void rebuilt.push(r.id), {
            name: 'contract-failure-projection-b',
            derived: true,
          })
          const replayed = [
            event('contract.failure-replay.v1'),
            event('contract.failure-replay.v1'),
          ]
          const replay = await settled(bus.replay(replayed))
          expect(replay.state).toBe('resolved')
          expect(rebuilt).toEqual(replayed.map((r) => r.id))

          const f = failure(outcome)
          expect([f.name, f.code]).toEqual(['AdapterError', 'adapter.handler_failed'])
          expect([f.context.eventId, f.context.eventType]).toEqual([e.id, e.type])
          expect(failedNames(f)).toEqual(['contract-failure-a'])
          expect(f.context.failed?.[0]?.message).toContain('contract handler A refused')
        })
      },
      SLOW,
    )

    it(
      'publishBatch of three events whose second fails a named handler hands all three, in order, to every subscription and only then rejects with handler_failed naming that event and subscription',
      async () => {
        const bus = await make()
        await closing([bus], async () => {
          const type = 'contract.failure-batch.v1'
          const picky: string[] = []
          const other: string[] = []
          const unnamed: string[] = []
          await bus.subscribe(
            type,
            async (e) => {
              picky.push(e.id)
              if ((e.payload as { seq: number }).seq === 1)
                throw new Error('contract picky refused')
            },
            { name: 'contract-failure-picky' },
          )
          await bus.subscribe(
            type,
            async (e) => {
              await delay(50)
              other.push(e.id)
            },
            { name: 'contract-failure-other' },
          )
          await bus.subscribe(type, async (e) => {
            await delay(50)
            unnamed.push(e.id)
          })
          const events = [0, 1, 2].map((seq) => event(type, { seq }))
          const seenAtRejection: string[][] = []

          const outcome = await settled(
            bus.publishBatch(events).catch((error: unknown) => {
              seenAtRejection.push([...picky], [...other], [...unnamed])
              throw error
            }),
          )

          const f = failure(outcome)
          expect(f.code).toBe('adapter.handler_failed')
          expect(f.context.eventId).toBe(events[1]!.id)
          expect(failedNames(f)).toEqual(['contract-failure-picky'])
          const ids = events.map((e) => e.id)
          expect(
            seenAtRejection,
            'what each subscription had been handed when the batch rejected',
          ).toEqual([ids, ids, ids])
        })
      },
      SLOW,
    )

    it(
      'publishing a rejected event again reaches every subscription again and resolves once the failed handler passes; in the window after the rejection the bus ran the failed handler only once per publish',
      async () => {
        const bus = await make()
        await closing([bus], async () => {
          const type = 'contract.failure-again.v1'
          const ran = { a: 0, b: 0, c: 0, unnamed: 0 }
          await bus.subscribe(
            type,
            async () => {
              ran.a += 1
              if (ran.a === 1) throw new Error('contract handler A refused once')
            },
            { name: 'contract-again-a' },
          )
          await bus.subscribe(type, async () => void (ran.b += 1), { name: 'contract-again-b' })
          await bus.subscribe(type, async () => void (ran.c += 1), { name: 'contract-again-c' })
          await bus.subscribe(type, async () => void (ran.unnamed += 1))
          const e = event(type)

          const first = await settled(bus.publish(e))
          expect(failure(first).code).toBe('adapter.handler_failed')
          // Watched for a retry the bus would make on its own (a claim of the failed entry): there must be none.
          await delay(window)
          const afterWindow = { ...ran }
          expect(afterWindow.a, 'the failed handler ran again without a publish').toBe(1)

          const second = await settled(bus.publish(e))

          expect(second.state, String(second.error)).toBe('resolved')
          expect(ran.a).toBe(2)
          expect(ran.b).toBe(2)
          expect(ran.c).toBe(ran.b)
          expect(ran.unnamed).toBe(ran.b)
          expect(ran.b - afterWindow.b, 'the second publish reached B again').toBe(1)
        })
      },
      SLOW,
    )

    const second = opts.second
    const timing = opts.timing
    if (second === undefined || timing === undefined) return

    it(
      'a named handler that throws on another instance fails the publish on this one with handler_failed, not publish_timeout, well within ackTimeoutMs',
      async () => {
        const a = await make()
        const b = await second()
        const held = gate()
        let holding: Promise<Settled> | undefined
        try {
          const group = 'contract-remote'
          const hold = 'contract.remote.hold'
          const target = 'contract.remote.target'
          const ranOn: Record<string, string[]> = {}
          const note = (id: string, where: string) => (ranOn[id] ??= []).push(where)
          let aHolding = false
          // a's consumer of the group is kept busy on `hold`, so the next entry can only be read by b's.
          await a.subscribe(
            'contract.remote.*',
            async (e) => {
              note(e.id, 'a')
              if (e.type === hold) {
                aHolding = true
                await held.wait
              }
            },
            { name: group },
          )
          holding = settled(a.publish(event(hold)))
          await until(() => aHolding, 'a to take the holding entry', timing.ackTimeoutMs)

          await b.subscribe(
            'contract.remote.*',
            async (e) => {
              if (e.type === hold) return
              note(e.id, 'b')
              throw new Error('contract remote handler refused')
            },
            { name: group },
          )
          const e = event(target)

          const outcome = await settled(a.publish(e))

          expect(ranOn[e.id], 'the failing handler ran on the second instance only').toEqual(['b'])
          const f = failure(outcome)
          expect(f.code, f.message).toBe('adapter.handler_failed')
          expect(failedNames(f)).toEqual([group])
          expect(outcome.ms).toBeLessThan(timing.ackTimeoutMs / 2)
        } finally {
          held.open()
          await holding
          await a.close()
          await b.close()
        }
      },
      SLOW,
    )

    it(
      'a named handler that fails once on another instance, then passes on the second publish within ackTimeoutMs: the first publish rejects and the second resolves, and the handler ran twice',
      async () => {
        const a = await make()
        const b = await second()
        const held = gate()
        let holding: Promise<Settled> | undefined
        try {
          const group = 'contract-remote-once'
          const hold = 'contract.remote-once.hold'
          const target = 'contract.remote-once.target'
          const ranOn: Record<string, string[]> = {}
          const note = (id: string, where: string) => (ranOn[id] ??= []).push(where)
          let aHolding = false
          // a's consumer of the group is kept busy on `hold` throughout, so both publishes are read by b's.
          await a.subscribe(
            'contract.remote-once.*',
            async (e) => {
              note(e.id, 'a')
              if (e.type === hold) {
                aHolding = true
                await held.wait
              }
            },
            { name: group },
          )
          holding = settled(a.publish(event(hold)))
          await until(() => aHolding, 'a to take the holding entry', timing.ackTimeoutMs)

          let runs = 0
          await b.subscribe(
            'contract.remote-once.*',
            async (e) => {
              if (e.type === hold) return
              note(e.id, 'b')
              runs += 1
              if (runs === 1) throw new Error('contract remote handler refused once')
            },
            { name: group },
          )
          const e = event(target)

          const first = await settled(a.publish(e))
          const again = await settled(a.publish(e))

          expect(ranOn[e.id], 'the handler ran on the second instance, once per publish').toEqual([
            'b',
            'b',
          ])
          expect(failure(first).code).toBe('adapter.handler_failed')
          // The second publish comes while the first one's failure is still within ackTimeoutMs, where a failure
          // recorded per event rather than per delivery would still be read.
          expect(again.at - first.at).toBeLessThan(timing.ackTimeoutMs)
          expect(again.state, String(again.error)).toBe('resolved')
        } finally {
          held.open()
          await holding
          await a.close()
          await b.close()
        }
      },
      SLOW,
    )
  })
}
