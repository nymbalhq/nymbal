import { spawn } from 'node:child_process'
import type { EventBusAdapter, NymbalEvent } from '@nymbalhq/types'

export type ChaosPoint = { beforePublish: string | '*'; nth?: number }

export const CHAOS_ENV = 'NYMBAL_CHAOS'

function pointFromEnv(): ChaosPoint | undefined {
  const raw = process.env[CHAOS_ENV]
  if (raw === undefined || raw === '') return undefined
  try {
    return JSON.parse(raw) as ChaosPoint
  } catch (cause) {
    throw new Error(`${CHAOS_ENV} is not valid JSON: ${raw}`, { cause })
  }
}

/**
 * Wraps the bus instance so the nth event of the chosen type SIGKILLs this process before it is delivered. Without
 * a point it reads NYMBAL_CHAOS, and with neither it does nothing. Counts are per event: a batch whose events the
 * bus then hands to its own publish() still counts each event once.
 */
export function armChaos(
  bus: EventBusAdapter,
  point: ChaosPoint | undefined = pointFromEnv(),
): void {
  if (point === undefined) return
  const nth = point.nth ?? 1
  if (!Number.isInteger(nth) || nth < 1) {
    throw new RangeError(`armChaos: nth must be a positive integer, got ${nth}`)
  }
  const publish = bus.publish.bind(bus)
  const publishBatch = bus.publishBatch.bind(bus)
  const counted = new WeakSet<object>()
  let seen = 0

  const isKillPoint = (event: NymbalEvent<unknown>): boolean => {
    if (counted.has(event)) return false
    counted.add(event)
    if (point.beforePublish !== '*' && event.type !== point.beforePublish) return false
    seen += 1
    return seen === nth
  }

  const die = async (): Promise<never> => {
    process.kill(process.pid, 'SIGKILL')
    return new Promise<never>(() => {})
  }

  bus.publish = async (event) => {
    if (isKillPoint(event)) await die()
    return publish(event)
  }

  bus.publishBatch = async (events) => {
    const at = events.findIndex(isKillPoint)
    if (at === -1) return publishBatch(events)
    if (at > 0) await publishBatch(events.slice(0, at))
    return die()
  }
}

export interface KilledRun {
  killed: boolean
  signal: NodeJS.Signals | null
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Runs `script` under this Node with the chaos point in NYMBAL_CHAOS. `killed` is true only when the child died by
 * SIGKILL on its own; a child that exits without reaching the point, or is stopped for outrunning `timeoutMs`,
 * is not a kill.
 */
export function runUntilKilled(opts: {
  script: string
  args?: string[]
  env?: Record<string, string>
  point: ChaosPoint
  timeoutMs?: number
}): Promise<KilledRun> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.script, ...(opts.args ?? [])], {
      env: { ...process.env, ...opts.env, [CHAOS_ENV]: JSON.stringify(opts.point) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        killed: signal === 'SIGKILL' && !timedOut,
        signal,
        code,
        timedOut,
        stdout,
        stderr,
      })
    })
  })
}
