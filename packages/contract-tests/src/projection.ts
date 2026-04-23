import { describe, it, expect } from 'vitest'
import type { NymbalEvent } from '@nymbal/types'

export interface ProjectionContractOptions {
  /**
   * Build a fresh projection handler context. Returns:
   * - `handle(event)` — processes the event through the idempotency-guarded handler
   * - `applicationCount()` — returns how many times the underlying handler actually ran
   */
  build: () => Promise<{
    handle: (event: NymbalEvent) => Promise<void>
    applicationCount: () => Promise<number>
  }>
}

function makeEvent(id: string): NymbalEvent {
  return {
    id,
    type: 'test.event.v1',
    timestamp: new Date().toISOString(),
    source: 'test',
    correlationId: 'corr-1',
    payload: { id },
    metadata: { storeId: 'test', environment: 'development', version: '0.0.0' },
  }
}

export function runProjectionContract(opts: ProjectionContractOptions): void {
  describe('Projection idempotency contract', () => {
    it('processing the same event twice applies the mutation only once', async () => {
      const ctx = await opts.build()
      const event = makeEvent('dedup-evt-001')
      await ctx.handle(event)
      await ctx.handle(event)
      expect(await ctx.applicationCount()).toBe(1)
    })

    it('distinct events each apply their mutation', async () => {
      const ctx = await opts.build()
      await ctx.handle(makeEvent('distinct-evt-001'))
      await ctx.handle(makeEvent('distinct-evt-002'))
      expect(await ctx.applicationCount()).toBe(2)
    })

    it('after reprocessing a batch the count equals unique event count', async () => {
      const ctx = await opts.build()
      const events = [makeEvent('batch-001'), makeEvent('batch-002'), makeEvent('batch-003')]
      for (const e of events) await ctx.handle(e)
      for (const e of events) await ctx.handle(e)
      expect(await ctx.applicationCount()).toBe(3)
    })
  })
}
