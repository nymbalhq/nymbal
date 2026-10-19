import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// P1-14 AC-3: shutdown is bounded and shared. `runShutdown` runs the steps in order and exits 0; a step that never
// resolves is named in the log and the process exits 1 at the bound; a repeat signal exits 1 at once; and the CLI's
// bound fires before the E2E wrapper's SIGKILL.

const HERE = dirname(fileURLToPath(import.meta.url))
const E2E_SERVER = resolve(HERE, '..', '..', '..', '..', 'scripts', 'e2e-server.mjs')

type Step = { name: string; run: () => Promise<void> }

interface Recorder {
  events: string[]
  logged: string[]
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  exit: (code: number) => never
  /** Resolves with the first exit code and the time it was called. */
  firstExit: Promise<{ code: number; at: number }>
}

function recorder(): Recorder {
  const events: string[] = []
  const logged: string[] = []
  let resolveExit!: (v: { code: number; at: number }) => void
  const firstExit = new Promise<{ code: number; at: number }>((r) => {
    resolveExit = r
  })
  let exited = false
  const log = (...args: unknown[]): void => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  return {
    events,
    logged,
    logger: { info: log, error: log },
    exit: ((code: number) => {
      events.push(`exit:${code}`)
      if (!exited) {
        exited = true
        resolveExit({ code, at: Date.now() })
      }
    }) as (code: number) => never,
    firstExit,
  }
}

/** The first exit, or `null` when none came within `ms`: the test fails rather than hangs. */
async function exitWithin(rec: Recorder, ms: number): Promise<{ code: number; at: number } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms)
  })
  try {
    return await Promise.race([rec.firstExit, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const never = (): Promise<void> => new Promise<void>(() => {})

// The module holds the "shutdown already running" state, so every case starts from a fresh copy of it.
async function load() {
  vi.resetModules()
  return import('./shutdown.js')
}

beforeEach(() => {
  vi.resetModules()
})

describe('P1-14 runShutdown', () => {
  it('AC-3: a step that never resolves is named in the log and exit(1) is called within boundMs + 500 ms', async () => {
    const { runShutdown } = await load()
    const rec = recorder()
    const boundMs = 200
    const hungName = `stop-http-${Math.random().toString(36).slice(2, 8)}`
    const steps: Step[] = [
      { name: 'stop-storefront', run: async () => {} },
      { name: hungName, run: never },
      { name: 'stop-app', run: async () => {} },
    ]
    const startedAt = Date.now()
    void runShutdown(steps, { boundMs, logger: rec.logger, exit: rec.exit })

    const first = await exitWithin(rec, boundMs + 2000)
    expect(first, 'exit was called at all').not.toBeNull()
    expect(first!.code).toBe(1)
    expect(first!.at - startedAt).toBeLessThanOrEqual(boundMs + 500)
    expect(rec.logged.filter((line) => line.includes(hungName)).length).toBeGreaterThan(0)
  })

  it('AC-3: a second call while a shutdown runs calls exit(1) at once, without waiting for the first run', async () => {
    const { runShutdown } = await load()
    const rec = recorder()
    let release!: () => void
    const pending = new Promise<void>((r) => {
      release = r
    })
    const boundMs = 60_000
    void runShutdown([{ name: 'stop-http', run: () => pending }], {
      boundMs,
      logger: rec.logger,
      exit: rec.exit,
    })
    // The first run is still inside its pending step.
    await new Promise((r) => setTimeout(r, 20))
    expect(rec.events).toEqual([])

    const secondAt = Date.now()
    void runShutdown([{ name: 'stop-http', run: () => pending }], {
      boundMs,
      logger: rec.logger,
      exit: rec.exit,
    })
    const first = await exitWithin(rec, 1000)
    release()
    expect(first, 'the second call exited').not.toBeNull()
    expect(first!.code).toBe(1)
    expect(first!.at - secondAt).toBeLessThan(100)
  })

  it('AC-3: steps that resolve run one after another in the order given, then exit(0) is called once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            name: fc.stringMatching(/^[a-z][a-z-]{0,11}$/),
            delayMs: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 5, selector: (s) => s.name },
        ),
        async (plan) => {
          const { runShutdown } = await load()
          const rec = recorder()
          const steps: Step[] = plan.map(({ name, delayMs }) => ({
            name,
            run: async () => {
              rec.events.push(`start:${name}`)
              await new Promise((r) => setTimeout(r, delayMs))
              rec.events.push(`end:${name}`)
            },
          }))
          void runShutdown(steps, { boundMs: 3000, logger: rec.logger, exit: rec.exit })
          const first = await exitWithin(rec, 2000)
          expect(first?.code).toBe(0)
          const expected = [...plan.flatMap((s) => [`start:${s.name}`, `end:${s.name}`]), 'exit:0']
          expect(rec.events).toEqual(expected)
        },
      ),
      { numRuns: 25 },
    )
  })

  it("AC-3: SHUTDOWN_BOUND_MS is below scripts/e2e-server.mjs's DEFAULT_SHUTDOWN_MS, so the CLI's own bound fires before the wrapper's SIGKILL", async () => {
    const { SHUTDOWN_BOUND_MS } = await load()
    // Read, not imported: the wrapper runs its CLI on import.
    const match = /export const DEFAULT_SHUTDOWN_MS = (\d+)/.exec(readFileSync(E2E_SERVER, 'utf8'))
    expect(match, `DEFAULT_SHUTDOWN_MS in ${E2E_SERVER}`).not.toBeNull()
    const wrapperMs = Number(match![1])
    expect(SHUTDOWN_BOUND_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_BOUND_MS).toBeLessThan(wrapperMs)
  })
})
