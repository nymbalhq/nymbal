import { describe, it, expect } from 'vitest'
import type { SearchAdapter } from '@nymbal/types'

export function runSearchContract(build: () => SearchAdapter): void {
  describe('SearchAdapter contract', () => {
    it('index returns count of indexed documents', async () => {
      const adapter = build()
      const result = await adapter.index([
        { id: 'doc-1', type: 'product', fields: { name: 'Widget' } },
        { id: 'doc-2', type: 'product', fields: { name: 'Gadget' } },
      ])
      expect(result.indexed).toBe(2)
    })

    it('search returns indexed documents', async () => {
      const adapter = build()
      await adapter.index([{ id: 'search-doc-1', type: 'product', fields: { name: 'Searchable Item' } }])
      const result = await adapter.search('Searchable')
      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(result.total).toBeGreaterThanOrEqual(1)
    })

    it('remove deletes documents from index', async () => {
      const adapter = build()
      const tag = `remove-${Date.now()}`
      await adapter.index([{ id: tag, type: 'product', fields: { name: 'To Remove' } }])
      await adapter.remove([tag])
      const result = await adapter.search('To Remove')
      const found = result.items.find((i) => i.id === tag)
      expect(found).toBeUndefined()
    })

    it('facet returns values for a field', async () => {
      const adapter = build()
      await adapter.index([
        { id: 'facet-doc-1', type: 'product', fields: { category: 'shirts' } },
        { id: 'facet-doc-2', type: 'product', fields: { category: 'trousers' } },
        { id: 'facet-doc-3', type: 'product', fields: { category: 'shirts' } },
      ])
      const facet = await adapter.facet('category')
      expect(typeof facet.field).toBe('string')
      expect(typeof facet.label).toBe('string')
      expect(Array.isArray(facet.values)).toBe(true)
      if (facet.values.length > 0) {
        expect(typeof facet.values[0]!.value).toBe('string')
      }
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
