import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKernel, type Kernel } from '../support/kernel.js'
import { readRow, seedRow } from '../support/stuck-proposals.js'
import { stuckProposalsSuite } from '../support/suites/stuck-proposals.js'

stuckProposalsSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-proposals-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

describe('the sweep runs inside the app', () => {
  const SWEEP_INTERVAL_MS = 5_000
  let kernel: Kernel | undefined

  afterEach(async () => {
    await kernel?.close()
    kernel = undefined
    vi.useRealTimers()
  })

  it('AC-12: createApp starts the sweeper: a stuck row settles when its interval fires, with no call to tick, and stop leaves no timer running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const timersBefore = vi.getTimerCount()
    const shortened = { proposalSweep: { intervalMs: SWEEP_INTERVAL_MS, stuckAfterMs: 1_000 } }
    kernel = await createKernel({ dialect: 'sqlite', appOptions: { relay: {}, ...shortened } })
    const row = await seedRow(kernel, {
      command: 'product.update',
      decidedAt: new Date(Date.now() - 3_600_000),
    })

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)

    const live = kernel
    await vi.waitFor(async () => expect((await readRow(live, row.id)).status).toBe('failed'), {
      timeout: 5_000,
      interval: 20,
    })
    expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)
    await live.close()
    kernel = undefined
    expect(vi.getTimerCount()).toBe(timersBefore)
  })
})
