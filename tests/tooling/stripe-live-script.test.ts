// Reads: scripts/stripe-live.sh, vitest.config.ts, packages/platform/tests/live/**
import { execFile, execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// AC-14's runner, offline: scripts/stripe-live.sh finds the Stripe test keys (the environment, then .env.local at the
// checkout's root, then at the main checkout's), refuses anything but test keys and a missing key with a non-zero
// exit before it runs anything, and otherwise runs the stripe-live project, the only one that selects the live test.
// The script runs in a scratch repository with a stand-in `pnpm` that records what it was asked to run: Stripe is
// never reached here.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const LIVE_FILE = 'packages/platform/tests/live/acp-stripe.test.ts'
const exec = promisify(execFile)

let root: string
let main: string
let linked: string
let record: string
let marker: string
let path: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], {
    cwd,
    stdio: 'ignore',
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stripe-live-'))
  main = join(root, 'main')
  linked = join(root, 'linked')
  record = join(root, 'pnpm-calls.txt')
  marker = join(root, 'sourced')
  mkdirSync(main, { recursive: true })
  writeFileSync(join(main, '.gitignore'), '.env.local\n')
  git(main, 'init', '-q')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'scratch')
  git(main, 'worktree', 'add', '-q', linked)

  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      `{ printf 'call\\n'; printf 'arg:%s\\n' "$@"; printf 'live:%s\\n' "$NYMBAL_STRIPE_LIVE"; printf 'sk:%s\\n' "$STRIPE_SECRET_KEY"; printf 'pk:%s\\n' "$STRIPE_PUBLISHABLE_KEY"; } >> '${record}'`,
      'echo "acp-stripe-live: pi_standin 1s"',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  const bash = dirname(
    execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
  )
  path = [bin, bash, '/usr/bin', '/bin'].join(':')
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

interface Run {
  code: number
  output: string
  /** What the stand-in pnpm was asked, one entry per call. */
  calls: string[]
}

/** The script under test, as each checkout holds it. */
function place(cwd: string): string {
  const script = join(cwd, 'scripts/stripe-live.sh')
  mkdirSync(dirname(script), { recursive: true })
  copyFileSync(join(REPO, 'scripts/stripe-live.sh'), script)
  chmodSync(script, 0o755)
  return script
}

async function run(cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const script = place(cwd)
  rmSync(record, { force: true })
  let code = 0
  let output = ''
  try {
    const done = await exec(script, [], {
      cwd,
      env: { PATH: path, HOME: root, ...env },
    })
    output = `${done.stdout}${done.stderr}`
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof failed.code === 'number' ? failed.code : -1
    output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
  }
  const calls = existsSync(record)
    ? readFileSync(record, 'utf8')
        .split(/^call\n/m)
        .filter((c) => c !== '')
    : []
  return { code, output, calls }
}

/** The files `vitest list` selects, with their projects, for these arguments and variables (no NYMBAL_ or VITEST_ of ours). */
async function selected(args: string[], extra: Record<string, string>): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_') && !key.startsWith('STRIPE_'))
      env[key] = value
  }
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', ...args],
    { cwd: REPO, env: { ...env, ...extra }, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{
    file: string
    projectName?: string
  }>
  return rows.map((r) => `${r.projectName ?? ''} ${r.file.replace(REPO, '')}`).sort()
}

describe('AC-14: scripts/stripe-live.sh runs the live proof on test keys only, and never reads as a pass without them', () => {
  // Kills: a missing proof that exits 0 (a skip read as a pass); a live key used; a refusal after the run started.
  it('AC-14: with no key in the environment or any .env.local the script prints the no-keys reason and exits 1; with a secret key not sk_test_ or a publishable key not pk_test_ it exits 2 saying only test keys run the proof; none of them runs anything', async () => {
    const none = await run(main)
    const liveSecret = await run(main, {
      STRIPE_SECRET_KEY: 'sk_live_standin',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_standin',
    })
    const livePublishable = await run(main, {
      STRIPE_SECRET_KEY: 'sk_test_standin',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_standin',
    })

    expect(none.code).toBe(1)
    expect(none.output).toContain(
      'stripe-live: no Stripe test keys: no STRIPE_SECRET_KEY in the environment or .env.local',
    )
    expect([liveSecret.code, livePublishable.code]).toEqual([2, 2])
    expect(liveSecret.output).toContain('only Stripe test keys run this proof')
    expect(livePublishable.output).toContain('only Stripe test keys run this proof')
    expect([none.calls, liveSecret.calls, livePublishable.calls]).toEqual([[], [], []])
  })

  // Kills: keys looked for only in the current checkout; a .env.local sourced (running its lines) or echoed; a run
  // that does not set the one variable the live project needs, or selects anything but the live test.
  it('AC-14: from a linked worktree with no .env.local, the keys in the main checkout’s .env.local are read without running or printing that file, and the script runs the stripe-live project once with NYMBAL_STRIPE_LIVE=1 and those keys; those arguments under that variable select exactly the live test, and without the variable no project selects it', async () => {
    const secret = 'sk_test_fromfile_0123456789'
    const publishable = 'pk_test_fromfile_0123456789'
    writeFileSync(
      join(main, '.env.local'),
      [
        `STRIPE_SECRET_KEY=${secret}`,
        `NYMBAL_SOURCED=$(touch '${marker}')`,
        `STRIPE_PUBLISHABLE_KEY=${publishable}`,
        '',
      ].join('\n'),
    )
    try {
      const ran = await run(linked)
      const call = ran.calls[0] ?? ''
      const args = call
        .split('\n')
        .filter((l) => l.startsWith('arg:'))
        .map((l) => l.slice('arg:'.length))
      const vitestArgs = args.slice(args.indexOf('run') + 1)

      expect(ran.code, ran.output).toBe(0)
      expect(ran.calls).toHaveLength(1)
      expect(call).toContain('live:1\n')
      expect(call).toContain(`sk:${secret}\n`)
      expect(call).toContain(`pk:${publishable}\n`)
      expect(existsSync(marker)).toBe(false)
      expect(ran.output).not.toContain(secret)
      expect(ran.output).not.toContain(publishable)
      const byScript = await selected(vitestArgs, { NYMBAL_STRIPE_LIVE: '1' })
      expect(byScript).toEqual([`stripe-live ${LIVE_FILE}`])
      // What the script runs is the live project, all of it and nothing else.
      expect(byScript).toEqual(
        await selected(['--project', 'stripe-live'], { NYMBAL_STRIPE_LIVE: '1' }),
      )
      expect((await selected([], {})).filter((f) => f.endsWith(LIVE_FILE))).toEqual([])
    } finally {
      rmSync(join(main, '.env.local'), { force: true })
    }
  }, 120_000)
})
