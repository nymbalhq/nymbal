/**
 * The CLI's own bound on a signal shutdown. Below the E2E wrapper's `DEFAULT_SHUTDOWN_MS` (`scripts/e2e-server.mjs`),
 * so the pending step is logged before the wrapper's SIGKILL lands.
 */
export const SHUTDOWN_BOUND_MS = 3000

export interface ShutdownStep {
  name: string
  run: () => Promise<void>
}

export interface ShutdownOptions {
  boundMs: number
  logger: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
  exit: (code: number) => never
}

let running = false

/**
 * Runs the steps in order, then exits 0. A step that throws is logged and the rest still run, then it exits 1. A step
 * still pending at `boundMs` is named in the log and it exits 1, so no client can hold the process open. A second call
 * while one runs (a repeat signal) exits 1 at once.
 */
export async function runShutdown(steps: ShutdownStep[], opts: ShutdownOptions): Promise<never> {
  if (running) {
    opts.logger.error({}, 'Shutdown already running; exiting now')
    return opts.exit(1)
  }
  running = true

  let pending: string | undefined
  let failed = false
  const work = (async () => {
    for (const step of steps) {
      pending = step.name
      try {
        await step.run()
      } catch (err) {
        failed = true
        opts.logger.error({ err, step: step.name }, `Shutdown step "${step.name}" failed`)
      }
    }
    pending = undefined
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), opts.boundMs)
  })
  const outcome = await Promise.race([work.then(() => 'done' as const), bound])
  clearTimeout(timer)

  if (outcome === 'bound') {
    opts.logger.error(
      { step: pending, boundMs: opts.boundMs },
      `Shutdown step "${pending}" did not finish within ${opts.boundMs} ms; exiting`,
    )
    return opts.exit(1)
  }
  return opts.exit(failed ? 1 : 0)
}
