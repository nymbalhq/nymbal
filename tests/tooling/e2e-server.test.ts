// Reads: scripts/e2e-server.mjs, tests/e2e/playwright.config.ts
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO, TSX } from './scratch-gate'

// The wrapper half of AC-10 and AC-20. scripts/e2e-server.mjs -- <command…> runs the E2E API: it forwards SIGTERM and
// SIGINT to the child and, when the child outlives NYMBAL_E2E_SHUTDOWN_MS, writes reports/e2e-shutdown.json
// ({ command, pid, waitedMs }) and SIGKILLs it. The wrapper is copied into a scratch root (scripts/ and reports/ side
// by side, the cwd), so the file lands there whether the wrapper resolves reports/ from its own path or from the cwd.
// Children report readiness and the signal they saw through files, polled; nothing sleeps for a fixed time.

const exec = promisify(execFile)
const WRAPPER = join(REPO, 'scripts/e2e-server.mjs')
const created: string[] = []
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-e2e-server-')))
  created.push(root)
  mkdirSync(join(root, 'scripts'))
  if (existsSync(WRAPPER)) copyFileSync(WRAPPER, join(root, 'scripts/e2e-server.mjs'))
  return root
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A child that writes its pid to `ready` and, on each signal, the signal's name to `got`; `ignore` keeps it alive. */
function childScript(ignore: boolean): string {
  return [
    "const fs = require('node:fs')",
    "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => {",
    "  fs.appendFileSync('got', s + '\\n')",
    ...(ignore ? [] : ['  process.exit(0)']),
    '})',
    "fs.writeFileSync('ready', String(process.pid))",
    'setInterval(() => {}, 1000)',
  ].join('\n')
}

type Wrapped = {
  root: string
  wrapper: ChildProcess
  exited: Promise<number | null>
  childPid: number
  marker: string
}

async function startWrapped(ignore: boolean, env: Record<string, string>): Promise<Wrapped> {
  expect(existsSync(WRAPPER), 'scripts/e2e-server.mjs exists').toBe(true)
  const root = scratchRoot()
  const marker = `e2e-server-test-${Math.random().toString(36).slice(2)}`
  const environment: NodeJS.ProcessEnv = { ...process.env, ...env }
  if (env.NYMBAL_E2E_SHUTDOWN_MS === undefined) delete environment.NYMBAL_E2E_SHUTDOWN_MS
  const wrapper = spawn(
    process.execPath,
    ['scripts/e2e-server.mjs', '--', process.execPath, '-e', childScript(ignore), marker],
    { cwd: root, env: environment, stdio: 'ignore' },
  )
  const exited = new Promise<number | null>((resolve) =>
    wrapper.on('exit', (code) => resolve(code)),
  )
  await until(() => existsSync(join(root, 'ready')), 'the child to start')
  const childPid = Number(readFileSync(join(root, 'ready'), 'utf8'))
  return { root, wrapper, exited, childPid, marker }
}

const shutdownFile = (root: string): string => join(root, 'reports/e2e-shutdown.json')

describe('AC-10: the wrapper records a child that outlives its shutdown, and only that', () => {
  // Run once, with the default timeout, so AC-20 can compare the default the wrapper really waits with Playwright's.
  // Memoised rather than a beforeAll, so that each test that needs it fails on its own.
  type Hang = Wrapped & {
    report: { command?: string; pid?: number; waitedMs?: number }
    waited: number
  }
  let hangRun: Promise<Hang> | undefined
  const hang = (): Promise<Hang> => {
    hangRun ??= (async () => {
      const run = await startWrapped(true, {})
      const sentAt = Date.now()
      run.wrapper.kill('SIGTERM')
      await Promise.race([
        run.exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('wrapper never exited')), 20_000),
        ),
      ])
      const waited = Date.now() - sentAt
      const report = existsSync(shutdownFile(run.root))
        ? (JSON.parse(readFileSync(shutdownFile(run.root), 'utf8')) as Hang['report'])
        : {}
      return { ...run, report, waited }
    })()
    return hangRun
  }

  it('AC-10: a child that ignores SIGTERM gets it, is recorded with its command and pid, and is killed', async () => {
    const { root, report, childPid, marker, waited } = await hang()
    expect(readFileSync(join(root, 'got'), 'utf8')).toContain('SIGTERM')
    expect(existsSync(shutdownFile(root)), 'reports/e2e-shutdown.json').toBe(true)
    expect(report.pid).toBe(childPid)
    expect(report.command ?? '').toContain(marker)
    expect(report.waitedMs ?? 0).toBeGreaterThan(0)
    expect(report.waitedMs ?? Infinity).toBeLessThanOrEqual(waited)
    await until(() => !alive(childPid), 'the child to be killed')
    expect(alive(childPid)).toBe(false)
  }, 30_000)

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'AC-10: a child that exits on %s gets it forwarded and leaves no file',
    async (signal) => {
      const run = await startWrapped(false, { NYMBAL_E2E_SHUTDOWN_MS: '3000' })
      run.wrapper.kill(signal)
      await run.exited
      // Under a full gate's load the record has been read as missing right after the wrapper's exit: wait for it.
      const got = join(run.root, 'got')
      await until(
        () => existsSync(got) && readFileSync(got, 'utf8').includes('\n'),
        'the child to record the signal',
      )
      expect(readFileSync(got, 'utf8').trim()).toBe(signal)
      expect(existsSync(shutdownFile(run.root))).toBe(false)
      expect(alive(run.childPid)).toBe(false)
    },
  )

  it('AC-10: NYMBAL_E2E_SHUTDOWN_MS sets how long the wrapper waits', async () => {
    const run = await startWrapped(true, { NYMBAL_E2E_SHUTDOWN_MS: '300' })
    run.wrapper.kill('SIGTERM')
    await run.exited
    const written = JSON.parse(readFileSync(shutdownFile(run.root), 'utf8')) as { waitedMs: number }
    expect(written.waitedMs).toBeGreaterThanOrEqual(300)
    expect(written.waitedMs).toBeLessThan((await hang()).report.waitedMs ?? 0)
  }, 30_000)

  describe('AC-20: Playwright waits longer than the wrapper', () => {
    const PRINT = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
      process.stdout.write('\\n' + JSON.stringify(m.default.webServer ?? null) + '\\n')
    })`

    it("AC-20: the API server runs under the wrapper, stops on SIGTERM, and gracefulShutdown.timeout exceeds the wrapper's default wait", async () => {
      // The gate runs Playwright with CI=1, the only case in which the config starts servers.
      const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NYMBAL_E2E_TARGET: 'admin' }
      for (const key of ['NYMBAL_E2E_ADMIN', 'NYMBAL_STOREFRONT_URL', 'NYMBAL_ADMIN_URL']) {
        delete env[key]
      }
      const { stdout } = await exec(TSX, ['--eval', PRINT], {
        cwd: join(REPO, 'tests/e2e'),
        env: {
          ...env,
          NYMBAL_TEST_CONFIG_URL: pathToFileURL(join(REPO, 'tests/e2e/playwright.config.ts')).href,
        },
      })
      const parsed = JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null') as
        | Array<{ command: string; gracefulShutdown?: { signal?: string; timeout?: number } }>
        | { command: string; gracefulShutdown?: { signal?: string; timeout?: number } }
        | null
      const servers = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]
      const api = servers.find((s) => /--api-only/.test(s.command))
      expect(api?.command ?? '').toMatch(/scripts\/e2e-server\.mjs\s+--\s/)
      expect(api?.gracefulShutdown?.signal).toBe('SIGTERM')
      const { report } = await hang()
      expect(report.waitedMs ?? Infinity, 'the default wait, measured').toBeLessThan(
        api?.gracefulShutdown?.timeout ?? 0,
      )
    }, 30_000)
  })
})
