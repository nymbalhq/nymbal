import { onTestFinished, vi } from 'vitest'

// A time bound proved on a fake clock instead of by sleeping through it. setTimeout, clearTimeout and Date are faked,
// and AbortSignal.timeout is put on the same clock: Node arms its timer from inside, where fake timers do not reach.
// Real I/O still runs (setImmediate is left real), so a local server still takes the request a bound cuts off.

/**
 * Fakes the clock time bounds run on; the returned function puts the real one back, and so does the end of the
 * calling test, even one cut off by its timeout before its own restore runs.
 */
export function fakeTimeBounds(): () => void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController()
    setTimeout(
      () =>
        controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      ms,
    )
    return controller.signal
  })
  const realClock = (): void => {
    timeout.mockRestore()
    vi.useRealTimers()
  }
  onTestFinished(realClock)
  return realClock
}

/**
 * Resolves once `done()` holds, letting real I/O run between checks without moving the fake clock (`vi.waitFor` moves
 * it); throws, naming `what`, if it never does.
 */
export async function until(done: () => boolean, what: string, turns = 20_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (done()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`${what}: still not so after ${turns} I/O turns`)
}
