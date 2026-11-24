import { format } from 'node:util'
import { runCommand } from 'citty'
import { main } from '../../main.js'
import { stripAnsi, type CliRun } from '../../../../../tests/support/doctor.js'

// `nymbal <args>` in the test's own process, for the cases that read a refusal, a validation or a printed report: a
// spawn of the built CLI costs most of a second in start-up, a call here almost nothing. What it runs is the command
// tree the bin runs (src/main.ts), from source; each command keeps a spawned case, which is what proves the bin, its
// argv and its exit codes.
//
// What a call here does not see, so a test that needs it spawns (`runCli`):
// - output written to fd 1 or 2 directly, such as the store logger's pino-pretty transport from its worker thread: a
//   test that a secret or an email never reaches the terminal must spawn;
// - an escaped throw prints only its message here, where the real runMain prints its stack and cause: a "never in the
//   output" test whose command ends through a throw must spawn;
// - a config edited in place: jiti caches a config module per path for the life of the process, so each call that
//   needs another config gets a fresh project directory.
// The store logs at warn here unless `env` sets LOG_LEVEL, as nothing here reads its lines and its debug lines would
// fill the test output.

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

type Write = typeof process.stdout.write

let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs the command as the bin would in `cwd` with `env` (and LOG_LEVEL=warn when `env` has none), and returns what it printed and the exit code it
 * asked for (`process.exit`, else `process.exitCode`, else 0); an error that escapes the command is exit 1 with its
 * message on stderr, as citty's runMain gives it. Output after an exit is dropped, as a real exit drops it. Calls made
 * together run one after another: the process's cwd, environment, streams and exit are the command's until it returns.
 */
export function runInProcess(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliRun> {
  const run = queue.then(() => runAlone(args, opts))
  queue = run.catch(() => undefined)
  return run
}

async function runAlone(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  let code: number | undefined
  const sink = (append: (text: string) => void): Write =>
    ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      if (code === undefined) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      }
      const done = typeof encoding === 'function' ? encoding : callback
      // Called before returning, so an exit in the callback (`write(text, () => process.exit(1))`) ends the command
      // where it wrote.
      if (typeof done === 'function') (done as () => void)()
      return true
    }) as Write
  const toOut = sink((text) => (stdout += text))
  const toErr = sink((text) => (stderr += text))

  const saved = {
    cwd: process.cwd(),
    env: { ...process.env },
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    console: (({ log, info, warn, error }) => ({ log, info, warn, error }))(console),
  }
  const setEnv = (env: NodeJS.ProcessEnv): void => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    for (const [key, value] of Object.entries(env))
      if (value !== undefined) process.env[key] = value
  }

  process.stdout.write = toOut
  process.stderr.write = toErr
  const toOutLine = (...parts: unknown[]) => toOut(`${format(...parts)}\n`)
  const toErrLine = (...parts: unknown[]) => toErr(`${format(...parts)}\n`)
  Object.assign(console, { log: toOutLine, info: toOutLine, warn: toErrLine, error: toErrLine })
  process.exit = ((exitCode?: number | string | null) => {
    code ??= Number(exitCode ?? process.exitCode ?? 0)
    throw new Exited(code)
  }) as typeof process.exit
  process.exitCode = undefined
  setEnv({ LOG_LEVEL: 'warn', ...opts.env })
  process.chdir(opts.cwd)
  try {
    await runCommand(main, { rawArgs: args })
    code ??= Number(process.exitCode ?? 0)
  } catch (error) {
    if (!(error instanceof Exited) && code === undefined) {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`
      code = 1
    }
  } finally {
    process.chdir(saved.cwd)
    setEnv(saved.env)
    process.exit = saved.exit
    process.exitCode = saved.exitCode
    process.stdout.write = saved.stdout
    process.stderr.write = saved.stderr
    Object.assign(console, saved.console)
  }
  return { code: code ?? 1, stdout, stderr, out: stripAnsi(stdout + stderr) }
}
