import { describe, expect, it } from 'vitest'
import { InMemoryDocumentStore } from './in-memory.js'
import { AdapterError } from '@nymbal/types'

describe('InMemoryDocumentStore', () => {
  it('put and get round-trip', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await store.put('products', 'abc', { id: 'abc', title: 'Thing' })
    const value = await store.get<{ id: string }>('products', 'abc')
    expect(value).toEqual({ id: 'abc', title: 'Thing' })
  })

  it('delete removes', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await store.put('c', 'k', { v: 1 })
    await store.delete('c', 'k')
    expect(await store.get('c', 'k')).toBeNull()
  })

  it('TTL expires lazily', async () => {
    let now = 1_000_000
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0, now: () => now })
    await store.put('c', 'k', { v: 1 }, { ttl: 5 })
    expect(await store.get('c', 'k')).toEqual({ v: 1 })
    now += 6_000
    expect(await store.get('c', 'k')).toBeNull()
  })

  it('optimistic concurrency rejects mismatched conditionValue', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await store.put('c', 'k', { version: 1, name: 'a' })
    await expect(
      store.put('c', 'k', { version: 2, name: 'b' }, { conditionKey: 'version', conditionValue: 5 }),
    ).rejects.toBeInstanceOf(AdapterError)
    await store.put('c', 'k', { version: 2, name: 'b' }, { conditionKey: 'version', conditionValue: 1 })
    expect(await store.get('c', 'k')).toEqual({ version: 2, name: 'b' })
  })

  it('query with partition key, sort, and cursor pagination', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const items = new Map<string, { id: string; storeId: string; order: number }>()
    for (let i = 0; i < 7; i++) {
      items.set(`k${i}`, { id: `k${i}`, storeId: 's1', order: i })
    }
    for (let i = 0; i < 3; i++) {
      items.set(`o${i}`, { id: `o${i}`, storeId: 'other', order: i })
    }
    await store.batchPut('c', items)

    const page1 = await store.query<{ id: string; order: number }>('c', {
      partitionKey: { field: 'storeId', value: 's1' },
      sortKey: { field: 'order', operator: 'gt', value: -1 },
      limit: 3,
    })
    expect(page1.items.map((i) => i.id)).toEqual(['k0', 'k1', 'k2'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await store.query<{ id: string; order: number }>('c', {
      partitionKey: { field: 'storeId', value: 's1' },
      sortKey: { field: 'order', operator: 'gt', value: -1 },
      limit: 3,
      cursor: page1.nextCursor!,
    })
    expect(page2.items.map((i) => i.id)).toEqual(['k3', 'k4', 'k5'])
  })

  it('batchGet returns only found keys', async () => {
    const store = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await store.put('c', 'a', { v: 1 })
    await store.put('c', 'b', { v: 2 })
    const result = await store.batchGet<{ v: number }>('c', ['a', 'b', 'missing'])
    expect(result.size).toBe(2)
    expect(result.get('a')).toEqual({ v: 1 })
  })
})
