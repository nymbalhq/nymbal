import { describe, expect, it } from 'vitest'
import { InProcessEventBus } from './in-process.js'
import type { NymbalEvent } from '@nymbal/types'

function event<T>(type: string, payload: T): NymbalEvent<T> {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'test',
    correlationId: 'cid-1',
    payload,
    metadata: { storeId: 'store-1', environment: 'development', version: '0.1.0' },
  }
}

describe('InProcessEventBus', () => {
  it('routes exact matches', async () => {
    const bus = new InProcessEventBus()
    const received: string[] = []
    await bus.subscribe('product.created.v1', async (e) => {
      received.push(e.type)
    })
    await bus.publish(event('product.created.v1', { id: 'x' }))
    await bus.publish(event('product.updated.v1', { id: 'x' }))
    expect(received).toEqual(['product.created.v1'])
  })

  it('routes wildcard matches', async () => {
    const bus = new InProcessEventBus()
    const received: string[] = []
    await bus.subscribe('product.*', async (e) => {
      received.push(e.type)
    })
    await bus.publish(event('product.created.v1', { id: 'x' }))
    await bus.publish(event('product.updated.v1', { id: 'x' }))
    await bus.publish(event('order.placed.v1', { id: 'y' }))
    expect(received).toEqual(['product.created.v1', 'product.updated.v1'])
  })

  it('accepts array of patterns', async () => {
    const bus = new InProcessEventBus()
    const received: string[] = []
    await bus.subscribe(['product.created.v1', 'order.placed.v1'], async (e) => {
      received.push(e.type)
    })
    await bus.publish(event('product.created.v1', { id: 'x' }))
    await bus.publish(event('product.updated.v1', { id: 'x' }))
    await bus.publish(event('order.placed.v1', { id: 'y' }))
    expect(received.sort()).toEqual(['order.placed.v1', 'product.created.v1'])
  })

  it('handler errors do not abort other handlers', async () => {
    const bus = new InProcessEventBus()
    const good: string[] = []
    await bus.subscribe('foo.*', () => {
      throw new Error('boom')
    })
    await bus.subscribe('foo.*', (e) => {
      good.push(e.type)
    })
    await bus.publish(event('foo.bar', {}))
    expect(good).toEqual(['foo.bar'])
  })

  it('unsubscribe stops delivery', async () => {
    const bus = new InProcessEventBus()
    const hits: string[] = []
    const sub = await bus.subscribe('foo.*', (e) => {
      hits.push(e.type)
    })
    await bus.publish(event('foo.bar', {}))
    await sub.unsubscribe()
    await bus.publish(event('foo.bar', {}))
    expect(hits).toEqual(['foo.bar'])
  })

  it('publishBatch preserves order', async () => {
    const bus = new InProcessEventBus()
    const seen: number[] = []
    await bus.subscribe('seq.*', (e) => {
      seen.push((e.payload as { n: number }).n)
    })
    await bus.publishBatch([event('seq.a', { n: 1 }), event('seq.a', { n: 2 }), event('seq.a', { n: 3 })])
    expect(seen).toEqual([1, 2, 3])
  })
})
