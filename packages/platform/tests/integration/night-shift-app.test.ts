import { afterEach, describe, expect, it, vi } from 'vitest'
import { NIGHT_SHIFT_JOBS, type NightShiftJob } from '../../src/night-shift/jobs.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { NOW, RUN_DAY, runRows } from '../support/night-shift.js'
import { openRaw } from '../support/raw.js'

// The runner as createApp starts it: on its interval only, never at boot, never when switched off, and gone with
// app.stop(). Intervals are faked so a tick happens when the test advances the clock and at no other time; `now` is
// 03:30 store time, after the default `at` of 03:00, so every tick finds the night due.

const INTERVAL_MS = 1_000

const kernels: Kernel[] = []

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.close()
  vi.useRealTimers()
})

async function kernelWith(enabled: boolean, now: () => Date): Promise<Kernel> {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: (config) => ({ ...config, nightShift: { enabled, at: '03:00' } }),
    appOptions: { nightShift: { intervalMs: INTERVAL_MS, now }, relay: { intervalMs: 3_600_000 } },
  })
  kernels.push(k)
  return k
}

/** A clock that counts how often it is read. */
function countingClock() {
  const clock = {
    reads: 0,
    now: () => {
      clock.reads += 1
      return NOW
    },
  }
  return clock
}

describe('AC-19: createApp runs the night on its interval, only when enabled, and stops it on stop()', () => {
  it('AC-19: nothing is written or even asked of the clock at boot; one interval later every job has its run for the night, and a switched-off store has none', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const onClock = countingClock()
    const offClock = countingClock()
    const on = await kernelWith(true, onClock.now)
    const off = await kernelWith(false, offClock.now)
    const onRaw = openRaw(on.dialect, on.target)
    const offRaw = openRaw(off.dialect, off.target)
    try {
      await on.store.read(async () => undefined)
      const atBoot = { reads: onClock.reads, runs: (await runRows(onRaw)).length }

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.waitFor(
        async () => expect((await runRows(onRaw)).length).toBe(NIGHT_SHIFT_JOBS.length),
        {
          timeout: 10_000,
        },
      )
      await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS)

      expect(atBoot).toEqual({ reads: 0, runs: 0 })
      const runs = await runRows(onRaw)
      expect(runs.map((r) => r.job).sort()).toEqual(NIGHT_SHIFT_JOBS.map((j: NightShiftJob) => j.id).sort())
      expect(new Set(runs.map((r) => r.runDay))).toEqual(new Set([RUN_DAY]))
      expect(await runRows(offRaw)).toEqual([])
      expect(offClock.reads).toBe(0)
    } finally {
      await onRaw.close()
      await offRaw.close()
    }
  })

  it('AC-19: after app.stop() the runner never ticks again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const clock = countingClock()
    const k = await kernelWith(true, clock.now)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    const whileRunning = clock.reads
    kernels.splice(kernels.indexOf(k), 1)
    await k.close()
    const atStop = clock.reads
    await vi.advanceTimersByTimeAsync(20 * INTERVAL_MS)

    expect(whileRunning).toBeGreaterThan(0)
    expect(clock.reads).toBe(atStop)
  })
})
