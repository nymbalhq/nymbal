import { afterEach, describe, expect, it } from 'vitest'
import {
  alive,
  DEFAULT_SHUTDOWN_MS,
  readiness,
  send,
  spawnStart,
  startEnv,
  storeConfig,
  storeProject,
  untilServing,
  upstream,
  type StartRun,
  type Upstream,
} from '../../../../tests/support/start.js'

// AC-5: on SIGTERM `nymbal start` drains before it stops. The storefront is the stand-in through NYMBAL_STOREFRONT_ENTRY:
// it holds a page request under /held until the test releases it, then calls GET /api/products on NYMBAL_API_URL and
// answers with what it got, and, like the Astro server, it exits at once on SIGTERM. So a render completes only when
// `start` waits for it before signalling the child and keeps the API up until the child has gone. Spawns the built CLI
// (`pnpm build` first), on SQLite in a project of its own.

/** How long a second signal may take to end the process. */
const AT_ONCE_MS = 1000
/** Slack on the shutdown bound for the process to be reaped and its exit seen. */
const REAP_MS = 1500

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** Resolves with `p`'s value, or rejects naming `what` after `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gave up after ${ms} ms waiting for ${what}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Polls GET /ready until it is not 200; its status then. */
async function untilNotReady(base: string, ms: number): Promise<number> {
  const deadline = Date.now() + ms
  for (;;) {
    const status = await readiness(base, 2000).then(
      (r) => r.status,
      () => 0,
    )
    if (status !== 200 || Date.now() > deadline) return status
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function serving(
  extra: Record<string, string> = {},
): Promise<{ run: StartRun; stand: Upstream; pid: number }> {
  const project = storeProject(storeConfig())
  cleanup.push(() => project.remove())
  const stand = await upstream(project.dir)
  cleanup.push(() => stand.close())
  const run = await spawnStart(['start', '--migrate'], {
    cwd: project.dir,
    env: startEnv({ NYMBAL_STOREFRONT_ENTRY: stand.entry, ...extra }),
  })
  cleanup.push(() => run.kill())
  await untilServing(run)
  const pid = await within(stand.up(), 30_000, 'the storefront stand-in to come up')
  cleanup.push(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  })
  return { run, stand, pid }
}

describe('AC-5: start drains the storefront before it stops', () => {
  it('AC-5: SIGTERM with a page render in flight: /ready and new pages answer 503, the held render completes 200 with the API products, only then the child exits, and start exits 0 within NYMBAL_SHUTDOWN_MS', async () => {
    const { run, stand, pid } = await serving({ NYMBAL_SHUTDOWN_MS: String(DEFAULT_SHUTDOWN_MS) })
    const products = (await (await fetch(`${run.base}/api/products`)).json()) as unknown

    const held = send(`${run.base}/held/product`)
    held.catch(() => undefined)
    expect(await within(stand.arrival(), 10_000, 'the held page request')).toBe('/held/product')
    const childGone = stand.gone()

    const signalledAt = run.signal('SIGTERM')
    const ready = await untilNotReady(run.base, 3000)
    const page = await send(`${run.base}/after-signal`)
    const childAliveDuringDrain = alive(pid)
    stand.release()
    const render = await within(held, 10_000, 'the held render')
    const childExitAt = await within(childGone, DEFAULT_SHUTDOWN_MS, 'the child to exit')
    const exit = await within(run.exited, DEFAULT_SHUTDOWN_MS, 'start to exit')

    expect(ready).toBe(503)
    expect(page.status).toBe(503)
    expect(stand.requests.map((r) => r.path)).not.toContain('/after-signal')
    expect(childAliveDuringDrain).toBe(true)
    expect(render.status, render.body.toString()).toBe(200)
    const rendered = JSON.parse(render.body.toString()) as {
      api: { status?: number; body?: unknown; error?: string }
    }
    expect(rendered.api.status, JSON.stringify(rendered.api)).toBe(200)
    expect(rendered.api.body).toEqual(products)
    expect(childExitAt).toBeGreaterThanOrEqual(render.at)
    expect(exit.at).toBeGreaterThanOrEqual(childExitAt)
    expect(exit.code, run.output().slice(-2000)).toBe(0)
    expect(exit.at - signalledAt).toBeLessThan(DEFAULT_SHUTDOWN_MS)
    expect(alive(pid)).toBe(false)
  }, 120_000)

  it('AC-5: a second SIGTERM during the drain exits 1 at once', async () => {
    const { run, stand } = await serving()
    const held = send(`${run.base}/held/second-signal`)
    held.catch(() => undefined)
    await within(stand.arrival(), 10_000, 'the held page request')

    run.signal('SIGTERM')
    expect(await untilNotReady(run.base, 3000)).toBe(503)
    const secondAt = run.signal('SIGTERM')
    const exit = await within(run.exited, 5000, 'start to exit on the second signal')

    expect(exit.code).toBe(1)
    expect(exit.at - secondAt).toBeLessThan(AT_ONCE_MS)
  }, 120_000)

  it('AC-5: a render held past NYMBAL_SHUTDOWN_MS does not hold the process: it exits within the bound and leaves no storefront child behind', async () => {
    const bound = 2000
    const { run, stand, pid } = await serving({ NYMBAL_SHUTDOWN_MS: String(bound) })
    const held = send(`${run.base}/held/never-released`)
    held.catch(() => undefined)
    await within(stand.arrival(), 10_000, 'the held page request')
    const childGone = stand.gone()

    const signalledAt = run.signal('SIGTERM')
    const exit = await within(run.exited, bound * 5, 'start to exit past its bound')
    const childExitAt = await within(childGone, REAP_MS, 'the child to be gone after start exited')

    expect(exit.at - signalledAt).toBeLessThan(bound + REAP_MS)
    expect(childExitAt - signalledAt).toBeLessThan(bound + REAP_MS)
    expect(alive(pid)).toBe(false)
  }, 120_000)
})
