import { describe, it, expect } from 'vitest'
import { createNativeAiAdapter, createLogger } from '@nymbal/platform'

// The native AI adapter is an intentional stub — embed/complete throw AdapterError('not_configured').
// A real adapter test requires a configured AI provider (Anthropic, OpenAI, etc.).
// This file tests the contract surface that the stub does implement.
const logger = createLogger({ pretty: false, level: 'error' })
const adapter = createNativeAiAdapter(logger)

describe('AiAdapter contract — native stub', () => {
  it('healthCheck returns a valid report', async () => {
    const report = await adapter.healthCheck()
    expect(['healthy', 'degraded', 'down']).toContain(report.status)
  })

  it('embed throws AdapterError (stub: requires real AI provider)', async () => {
    await expect(adapter.embed(['hello'])).rejects.toThrow()
  })

  it('complete throws AdapterError (stub: requires real AI provider)', async () => {
    await expect(adapter.complete('hello')).rejects.toThrow()
  })
})
