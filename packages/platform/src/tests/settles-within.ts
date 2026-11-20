// How a promise stands after at most `ms`: settled, either way, or still pending. For a test that asserts a call
// answers while something it must not wait on is held open: the bound elapses only when the call does wait, so a
// passing run spends none of it.

export type Settlement = 'resolved' | 'rejected' | 'pending'

export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<Settlement> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Settlement>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * A hold that work can be stopped at: while held, `pass()` waits until `release()`; `waiting(n)` resolves once `n`
 * callers are stopped at it. Holding again after a release stops the next callers, and any not yet resumed.
 */
export interface Hold {
  hold(): void
  release(): void
  /** Whether the hold is on: a caller arriving now would stop. */
  readonly holding: boolean
  /** Waits here while held. */
  pass(): Promise<void>
  /** How many callers are stopped at the hold now. */
  readonly stopped: number
  waiting(n: number): Promise<void>
}

export function createHold(): Hold {
  let gate: Deferred | undefined
  let stopped = 0
  const waiters: Array<{ n: number; resolve(): void }> = []
  const wake = () => {
    for (const w of waiters.splice(0)) {
      if (stopped >= w.n) w.resolve()
      else waiters.push(w)
    }
  }
  return {
    hold() {
      gate ??= deferred()
    },
    release() {
      const g = gate
      gate = undefined
      g?.resolve()
    },
    get holding() {
      return gate !== undefined
    },
    async pass() {
      if (gate === undefined) return
      stopped += 1
      wake()
      try {
        while (gate !== undefined) await gate.promise
      } finally {
        stopped -= 1
      }
    },
    get stopped() {
      return stopped
    },
    waiting(n) {
      if (stopped >= n) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push({ n, resolve }))
    },
  }
}
