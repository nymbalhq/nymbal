import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { HttpServer } from '@nymbalhq/http'
import type { NymbalApp } from '@nymbalhq/platform'
import { isPortFree } from './port.js'
import type { ShutdownStep } from './shutdown.js'

// What `nymbal preview` and `nymbal verify` share to run a throwaway store beside a project: ports, the storefront's
// wait, and the stop sequence that leaves the project as it was.

/** What Next.js rewrites for its dist dir; put back as they were when the throwaway store stops. */
export const NEXT_REWRITES = ['next-env.d.ts', 'tsconfig.json', 'tsconfig.dist.json']
/** Long enough for a storefront's process group to exit and the directory to go. */
export const STOP_BOUND_MS = 15_000
export const STOREFRONT_WAIT_MS = 180_000

/** Whether something accepts connections on `host:port`. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host })
    const end = (result: boolean) => {
      socket.destroy()
      done(result)
    }
    socket.setTimeout(500, () => end(false))
    socket.once('connect', () => end(true))
    socket.once('error', () => end(false))
  })
}

/**
 * The first port from `preferred` up that is free and not `taken`. A bind probe alone can succeed beside a server
 * holding the port on one loopback address (BSD's SO_REUSEADDR), so a port anything answers on is busy too.
 */
export async function freePortFrom(
  preferred: number,
  taken: number[] = [],
  hint = '',
): Promise<number> {
  for (let candidate = preferred; candidate <= Math.min(preferred + 19, 65535); candidate++) {
    if (taken.includes(candidate)) continue
    if (!(await isPortFree(candidate))) continue
    if ((await answers(candidate, '127.0.0.1')) || (await answers(candidate, '::1'))) continue
    return candidate
  }
  throw new Error(`No free port from ${preferred} to ${preferred + 19}${hint}`)
}

/**
 * Answers once the storefront answers anything, or throws when it cannot start, exits or never answers. Called as soon
 * as the child is spawned, so its `error` event (a launcher that cannot be run) has a listener.
 */
export async function storefrontUp(url: string, child: ChildProcess): Promise<void> {
  const launch: { error?: Error } = {}
  child.once('error', (err) => {
    launch.error = err
  })
  const deadline = Date.now() + STOREFRONT_WAIT_MS
  while (Date.now() < deadline) {
    if (launch.error !== undefined) {
      throw new Error(`The storefront could not start: ${launch.error.message}`)
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `The storefront exited (${child.exitCode ?? child.signalCode}) before it answered`,
      )
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(30_000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`The storefront at ${url} did not answer within ${STOREFRONT_WAIT_MS / 1000} s`)
}

/** The files in `cwd` that Next.js rewrites, as they are now: null for one that does not exist. */
export async function nextFilesOf(cwd: string): Promise<Map<string, Buffer | null>> {
  const files = new Map<string, Buffer | null>()
  for (const name of NEXT_REWRITES) {
    const path = join(cwd, name)
    files.set(path, existsSync(path) ? await readFile(path) : null)
  }
  return files
}

/** What a throwaway store has started, in the order it stops them. */
export interface Throwaway {
  dir?: string
  app?: NymbalApp
  http?: HttpServer
  storefront?: ChildProcess
  /** The storefront's production build, while it runs. */
  build?: ChildProcess
  /** The project files Next.js rewrites, as they were: null for one that did not exist. */
  nextFiles?: Map<string, Buffer | null>
  nextDistDir?: string
}

export async function stopStorefront(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  // Its own process group: the framework's workers go with it.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, s)
    } catch {
      // the group is gone
    }
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
  signal('SIGKILL')
}

/**
 * The stop sequence for `running`: the build and storefront process groups, the HTTP server, the app, the Next.js
 * files put back, then its dist dir and (unless `keepDir`) the throwaway directory removed.
 */
export function throwawayStopSteps(
  running: Throwaway,
  { keepDir }: { keepDir: boolean },
): ShutdownStep[] {
  return [
    {
      name: 'build.stop',
      run: async () => {
        if (running.build !== undefined) await stopStorefront(running.build)
      },
    },
    {
      name: 'storefront.stop',
      run: async () => {
        if (running.storefront !== undefined) await stopStorefront(running.storefront)
      },
    },
    { name: 'http.stop', run: async () => running.http?.stop() },
    { name: 'app.stop', run: async () => running.app?.stop() },
    {
      name: 'storefront.files',
      run: async () => {
        if (running.nextFiles === undefined) return
        for (const [path, bytes] of running.nextFiles) {
          const now = existsSync(path) ? await readFile(path) : null
          if (bytes === null) await rm(path, { force: true })
          else if (now === null || !now.equals(bytes)) await writeFile(path, bytes)
        }
      },
    },
    {
      name: 'dir.remove',
      run: async () => {
        if (running.nextDistDir !== undefined) {
          await rm(running.nextDistDir, { recursive: true, force: true, maxRetries: 3 })
        }
        if (running.dir !== undefined && !keepDir) {
          await rm(running.dir, { recursive: true, force: true, maxRetries: 3 })
        }
      },
    },
  ]
}
