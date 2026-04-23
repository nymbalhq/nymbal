import { describe, it, expect } from 'vitest'
import type { AiAdapter } from '@nymbal/types'

export function runAiContract(build: () => AiAdapter): void {
  describe('AiAdapter contract', () => {
    it('embed returns embedding vectors with correct dimensions', async () => {
      const adapter = build()
      const embeddings = await adapter.embed(['hello world', 'test text'])
      expect(Array.isArray(embeddings)).toBe(true)
      expect(embeddings).toHaveLength(2)
      expect(Array.isArray(embeddings[0])).toBe(true)
      expect((embeddings[0] ?? []).length).toBeGreaterThan(0)
    })

    it('complete returns a non-empty string', async () => {
      const adapter = build()
      const result = await adapter.complete('Write one word: hello', { maxTokens: 10 })
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
