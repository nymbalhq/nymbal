import { describe, expect, it } from 'vitest'
import type { HealthReport } from '@nymbalhq/types'

/** How long a health check, or a call on an unreachable dependency, may take to settle. */
export const BOUND_MS = 6000

/** A case's own timeout: the bound, plus room for `build` and the case's own calls. */
export const CASE_MS = 30_000

/** Makes the adapter under test: a fresh, initialized one each time it is called. */
export type Build<A> = () => A | Promise<A>

/** The options every suite takes. */
export interface ContractOptions<A = unknown> {
  /**
   * An adapter whose dependency cannot be reached. Given, the suite adds the downtime cases: `healthCheck()` reports
   * `down`, and one representative operation rejects, each within 6 s. For a client that connects when it is built,
   * build it while the dependency is up and then take the dependency away (close a proxy in front of it).
   */
  unreachable?: Build<A>
}

interface Checkable {
  healthCheck?: () => Promise<HealthReport>
}

type Settled<T> =
  | { state: 'resolved'; value: T; ms: number }
  | { state: 'rejected'; error: unknown; ms: number }
  | { state: 'hung'; ms: number }

/** How `call` settled within `ms`: a synchronous throw is a rejection, and a call still pending is `hung`. */
export async function settle<T>(call: () => T | Promise<T>, ms = BOUND_MS): Promise<Settled<T>> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const hung = new Promise<{ state: 'hung' }>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'hung' }), ms)
  })
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(call)
        .then(
          (value) => ({ state: 'resolved' as const, value }),
          (error: unknown) => ({ state: 'rejected' as const, error }),
        ),
      hung,
    ])
    return { ...outcome, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Closes what has a `close()`, without letting a close that hangs (a client on a dead host) hold the case. */
export async function release(target: unknown): Promise<void> {
  const close = (target as { close?: unknown } | null)?.close
  if (typeof close !== 'function') return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.resolve()
      .then(() => (close as () => unknown).call(target))
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000)
    }),
  ])
  clearTimeout(timer)
}

function healthOf(target: Checkable): Promise<Settled<HealthReport>> {
  expect(
    typeof target.healthCheck,
    'healthCheck() is missing: certification needs it, though the type keeps it optional',
  ).toBe('function')
  return settle(() => target.healthCheck!())
}

/** `healthCheck()` resolves `healthy` or `degraded` within the bound. */
export async function expectHealthy(target: Checkable): Promise<void> {
  const health = await healthOf(target)
  expect(health.state, `healthCheck() did not resolve within ${BOUND_MS} ms`).toBe('resolved')
  const status = health.state === 'resolved' ? health.value?.status : undefined
  expect(['healthy', 'degraded'], `healthCheck() reported ${String(status)}`).toContain(status)
}

/** `healthCheck()` resolves `down` within the bound. */
export async function expectDown(target: Checkable): Promise<void> {
  const health = await healthOf(target)
  expect(health.state, `healthCheck() did not resolve within ${BOUND_MS} ms`).toBe('resolved')
  expect(health.state === 'resolved' ? health.value?.status : undefined).toBe('down')
}

/** `call` rejects within the bound: it neither succeeds on a dead dependency nor hangs on one. */
export async function expectRejects(call: () => Promise<unknown>): Promise<void> {
  const outcome = await settle(call)
  expect(
    outcome.state,
    outcome.state === 'hung' ? `still pending after ${BOUND_MS} ms` : 'it succeeded',
  ).toBe('rejected')
}

/** Builds the adapter, runs `body` on it, and closes it when it has a `close()`. */
export async function using<A, T>(build: Build<A>, body: (adapter: A) => Promise<T>): Promise<T> {
  const adapter = await build()
  try {
    return await body(adapter)
  } finally {
    await release(adapter)
  }
}

/**
 * The health case every suite has, and, when `unreachable` is given, the downtime cases: health `down`, and
 * `operation` (named by `label`) rejecting, each within the bound.
 */
export function healthAndDowntime<A extends object>(
  build: Build<A>,
  unreachable: Build<A> | undefined,
  label: string,
  operation: (adapter: A) => Promise<unknown>,
): void {
  it(
    'health: healthCheck() resolves healthy or degraded within 6 s',
    () => using(build, (adapter) => expectHealthy(adapter as Checkable)),
    CASE_MS,
  )
  if (unreachable === undefined) return
  describe('unreachable dependency', () => {
    it(
      'down: healthCheck() reports down within 6 s',
      () => using(unreachable, (adapter) => expectDown(adapter as Checkable)),
      CASE_MS,
    )
    it(
      `down: ${label} rejects within 6 s instead of hanging`,
      () => using(unreachable, (adapter) => expectRejects(() => operation(adapter))),
      CASE_MS,
    )
  })
}
