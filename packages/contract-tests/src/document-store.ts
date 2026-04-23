import { describe, it, expect } from 'vitest'
import type { DocumentStoreAdapter } from '@nymbal/types'

export function runDocumentStoreContract(build: () => DocumentStoreAdapter): void {
  describe('DocumentStoreAdapter contract', () => {
    it('get returns null for missing key', async () => {
      const store = build()
      expect(await store.get('col', 'missing')).toBeNull()
      await store.close()
    })

    it('put then get round-trips', async () => {
      const store = build()
      await store.put('col', 'k1', { name: 'test', value: 42 })
      expect(await store.get<{ name: string; value: number }>('col', 'k1')).toEqual({
        name: 'test',
        value: 42,
      })
      await store.close()
    })

    it('delete removes document', async () => {
      const store = build()
      await store.put('col', 'k1', { v: 1 })
      await store.delete('col', 'k1')
      expect(await store.get('col', 'k1')).toBeNull()
      await store.close()
    })

    it('delete of non-existent key does not throw', async () => {
      const store = build()
      await expect(store.delete('col', 'nope')).resolves.not.toThrow()
      await store.close()
    })

    it('put overwrites existing document', async () => {
      const store = build()
      await store.put('col', 'k1', { v: 1 })
      await store.put('col', 'k1', { v: 2 })
      expect(await store.get<{ v: number }>('col', 'k1')).toEqual({ v: 2 })
      await store.close()
    })

    it('collections are isolated', async () => {
      const store = build()
      await store.put('colA', 'key', { from: 'A' })
      await store.put('colB', 'key', { from: 'B' })
      expect(await store.get<{ from: string }>('colA', 'key')).toEqual({ from: 'A' })
      expect(await store.get<{ from: string }>('colB', 'key')).toEqual({ from: 'B' })
      await store.close()
    })

    it('batchGet returns map of existing keys', async () => {
      const store = build()
      await store.put('col', 'a', { v: 1 })
      await store.put('col', 'b', { v: 2 })
      const result = await store.batchGet<{ v: number }>('col', ['a', 'b', 'missing'])
      expect(result.get('a')).toEqual({ v: 1 })
      expect(result.get('b')).toEqual({ v: 2 })
      expect(result.has('missing')).toBe(false)
      await store.close()
    })

    it('batchPut stores multiple items', async () => {
      const store = build()
      const items = new Map<string, { n: number }>([
        ['x', { n: 10 }],
        ['y', { n: 20 }],
      ])
      await store.batchPut('col', items)
      expect(await store.get<{ n: number }>('col', 'x')).toEqual({ n: 10 })
      expect(await store.get<{ n: number }>('col', 'y')).toEqual({ n: 20 })
      await store.close()
    })
  })
}
