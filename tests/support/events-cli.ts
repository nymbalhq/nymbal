import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_BIN, cliEnv, stripAnsi } from './doctor.js'

// What the `nymbal events` tests share. A SQLite project for the built CLI, the text line
// `<seq> <timestamp> <type> <correlationId> <id>`, and a spawned `events tail` read line by line. Nothing here knows
// how the command is implemented.

/** A project whose command store is the SQLite file `dbPath` (through NYMBAL_SQLITE_PATH), and its CLI environment. */
export function sqliteProject(dbPath: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'events-cli-'))
  const config = {
    store: { name: 'events-cli', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return { dir, env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }) }
}

export interface EventLine {
  seq: number
  timestamp: string
  type: string
  correlationId: string
  id: string
}

const LINE = /^(\d+) (\S+) (\S+) (\S+) (\S+)$/

/** The text line, or null for anything else. */
export function parseLine(line: string): EventLine | null {
  const m = LINE.exec(stripAnsi(line).trim())
  if (m === null) return null
  return { seq: Number(m[1]), timestamp: m[2]!, type: m[3]!, correlationId: m[4]!, id: m[5]! }
}

/** The non-empty lines of a command's stdout. */
export function stdoutLines(stdout: string): string[] {
  return stripAnsi(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

export interface Tail {
  child: ChildProcess
  /** The `<n>` of the stderr ready line `tailing from seq <n>`. */
  readyAt: number
  /** Every stdout line so far, in order. */
  lines(): string[]
  /** Every printed seq so far, in order (lines that are not event lines are skipped). */
  seqs(): number[]
  /** Resolves once a line with `seq` has been printed; rejects after `withinMs` or when the tail exits. */
  waitForSeq(seq: number, withinMs?: number): Promise<void>
  /** SIGINT, then the exit. */
  interrupt(withinMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  kill(): Promise<void>
  output(): string
}

/** `nymbal events tail <args>` in `cwd`, resolved once it has printed its stderr ready line. */
export async function startTail(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; readyWithinMs?: number },
): Promise<Tail> {
  const child = spawn(process.execPath, [CLI_BIN, 'events', 'tail', ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const w of [...waiters]) w()
  }
  child.stdout!.on('data', (b: Buffer) => {
    stdout += b.toString()
    notify()
  })
  child.stderr!.on('data', (b: Buffer) => {
    stderr += b.toString()
    notify()
  })
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      notify()
      resolve(exit)
    }),
  )
  const output = () => stripAnsi(`stdout:\n${stdout}\nstderr:\n${stderr}`).slice(-3000)
  const completeLines = () => {
    const all = stripAnsi(stdout).split('\n')
    return all
      .slice(0, -1)
      .map((l) => l.trim())
      .filter((l) => l !== '')
  }

  function until<T>(test: () => T | undefined, withinMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = test()
        if (value !== undefined) {
          done()
          resolve(value)
        } else if (exit !== undefined) {
          done()
          reject(
            new Error(`events tail exited (${JSON.stringify(exit)}) before ${what}:\n${output()}`),
          )
        }
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`events tail did not reach ${what} within ${withinMs} ms:\n${output()}`))
      }, withinMs)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })
  }

  const kill = async () => {
    if (exit !== undefined) return
    child.kill('SIGKILL')
    await exited
  }
  let readyAt: number
  try {
    readyAt = await until(
      () => {
        const m = /tailing from seq (\d+)/.exec(stripAnsi(stderr))
        return m === null ? undefined : Number(m[1])
      },
      opts.readyWithinMs ?? 30_000,
      'its ready line `tailing from seq <n>` on stderr',
    )
  } catch (error) {
    await kill()
    throw error
  }

  const seqs = () =>
    completeLines()
      .map(parseLine)
      .filter((l): l is EventLine => l !== null)
      .map((l) => l.seq)

  return {
    child,
    readyAt,
    lines: completeLines,
    seqs,
    waitForSeq: (seq, withinMs = 10_000) =>
      until(() => (seqs().includes(seq) ? true : undefined), withinMs, `printing seq ${seq}`).then(
        () => undefined,
      ),
    /** A tail that ignores SIGINT is killed after `withinMs` and answers the SIGKILL. */
    async interrupt(withinMs = 5_000) {
      if (exit !== undefined) return exit
      child.kill('SIGINT')
      const timer = setTimeout(() => child.kill('SIGKILL'), withinMs)
      try {
        return await exited
      } finally {
        clearTimeout(timer)
      }
    },
    kill,
    output,
  }
}
