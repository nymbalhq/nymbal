import { describe, it, expect, vi } from 'vitest'
import type { EventBusAdapter, NymbalEvent } from '@nymbal/types'

function makeEvent(type: string, payload: unknown = {}): NymbalEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'test',
    correlationId: 'corr-1',
    payload,
    metadata: { storeId: 'test', environment: 'development', version: '0.0.0' },
  }
}

export function runEventBusContract(build: () => EventBusAdapter): void {
  describe('EventBusAdapter contract', () => {
    it('handler receives published event', async () => {
      const bus = build()
      const received: unknown[] = []
      await bus.subscribe('test.event.v1', async (e) => { received.push(e.payload) })
      await bus.publish(makeEvent('test.event.v1', { x: 1 }))
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({ x: 1 })
      await bus.close()
    })

    it('handler not called for non-matching event type', async () => {
      const bus = build()
      const received: unknown[] = []
      await bus.subscribe('event.A.v1', async (e) => { received.push(e) })
      await bus.publish(makeEvent('event.B.v1'))
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(0)
      await bus.close()
    })

    it('multiple subscribers all receive the event', async () => {
      const bus = build()
      const countA = { n: 0 }
      const countB = { n: 0 }
      await bus.subscribe('shared.event.v1', async () => { countA.n++ })
      await bus.subscribe('shared.event.v1', async () => { countB.n++ })
      await bus.publish(makeEvent('shared.event.v1'))
      await new Promise((r) => setTimeout(r, 20))
      expect(countA.n).toBe(1)
      expect(countB.n).toBe(1)
      await bus.close()
    })

    it('error in one handler does not prevent others from running', async () => {
      const bus = build()
      const results: string[] = []
      await bus.subscribe('error.test.v1', async () => { throw new Error('boom') })
      await bus.subscribe('error.test.v1', async () => { results.push('ok') })
      await bus.publish(makeEvent('error.test.v1'))
      await new Promise((r) => setTimeout(r, 20))
      expect(results).toContain('ok')
      await bus.close()
    })

    it('publishBatch delivers all events', async () => {
      const bus = build()
      const ids: string[] = []
      await bus.subscribe('batch.event.v1', async (e) => {
        ids.push((e.payload as Record<string, string>).id ?? '')
      })
      await bus.publishBatch([
        makeEvent('batch.event.v1', { id: 'a' }),
        makeEvent('batch.event.v1', { id: 'b' }),
        makeEvent('batch.event.v1', { id: 'c' }),
      ])
      await new Promise((r) => setTimeout(r, 20))
      expect(ids.sort()).toEqual(['a', 'b', 'c'])
      await bus.close()
    })

    it('subscribe with array of patterns matches all listed types', async () => {
      const bus = build()
      const received: string[] = []
      await bus.subscribe(['type.X.v1', 'type.Y.v1'], async (e) => { received.push(e.type) })
      await bus.publish(makeEvent('type.X.v1'))
      await bus.publish(makeEvent('type.Y.v1'))
      await new Promise((r) => setTimeout(r, 20))
      expect(received.sort()).toEqual(['type.X.v1', 'type.Y.v1'])
      await bus.close()
    })

    it('unsubscribe stops handler from receiving further events', async () => {
      const bus = build()
      const received: unknown[] = []
      const sub = await bus.subscribe('unsub.event.v1', async (e) => { received.push(e) })
      await bus.unsubscribe(sub)
      await bus.publish(makeEvent('unsub.event.v1'))
      await new Promise((r) => setTimeout(r, 20))
      expect(received).toHaveLength(0)
      await bus.close()
    })
  })
}
