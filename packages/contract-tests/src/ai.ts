import { describe, expect, it } from 'vitest'
import type { AiAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

export function runAiContract(
  name: string,
  build: Build<AiAdapter>,
  options: ContractOptions<AiAdapter> = {},
): void {
  describe(`AiAdapter contract: ${name}`, () => {
    it(
      'embed returns embedding vectors with correct dimensions',
      async () => {
        const adapter = await build()
        const embeddings = await adapter.embed(['hello world', 'test text'])
        expect(Array.isArray(embeddings)).toBe(true)
        expect(embeddings).toHaveLength(2)
        expect(Array.isArray(embeddings[0])).toBe(true)
        expect((embeddings[0] ?? []).length).toBeGreaterThan(0)
      },
      CASE_MS,
    )

    it(
      'complete returns a non-empty string',
      async () => {
        const adapter = await build()
        const result = await adapter.complete('Write one word: hello', { maxTokens: 10 })
        expect(typeof result).toBe('string')
        expect(result.length).toBeGreaterThan(0)
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'complete()', (adapter) =>
      adapter.complete('Write one word: hello', { maxTokens: 10 }),
    )
  })
}
