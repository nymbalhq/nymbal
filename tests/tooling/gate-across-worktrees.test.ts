// Reads: scripts/gate.ts, scripts/machine-budget.ts
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CAP_VARS, MACHINE_ENV_FILE_VAR } from '../../scripts/machine-budget'

// Gates in several worktrees of one repository run their heavy steps at the same time: each step is capped by the
// machine budget alone and waits for no other worktree's gate, whether that one runs tests or the timing-bound perf.
// Each gate here is its own process in a linked worktree of a throwaway repository, running the plan's own step with
// its command swapped for a rendezvous that is green only if every other gate's step is running at the same moment.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const GATE_URL = pathToFileURL(join(REPO, 'scripts/gate.ts')).href

/** How long a rendezvous waits for the others before it goes red. */
const MEET_WITHIN_S = 5

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  for (const name of [...Object.values(CAP_VARS), 'CI', 'GITHUB_ACTIONS']) delete env[name]
  env[MACHINE_ENV_FILE_VAR] = join(tmpdir(), 'nymbal-no-machine-file.env')
  return env
}

/** A repository with one empty commit and a linked worktree for each name, and a directory the gates meet in. */
function worktrees(names: string[]): { meet: string; dirs: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-across-')))
  created.push(root)
  const main = join(root, 'main')
  const meet = join(root, 'meet')
  mkdirSync(main)
  mkdirSync(meet)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: main, env: cleanEnv(), encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  )
  for (const name of names) git('worktree', 'add', '-q', '-b', name, join(root, name))
  return { meet, dirs: names.map((name) => join(root, name)) }
}

/** Marks `me` as running in `meet`, then is green once all of `everyone` are, red after MEET_WITHIN_S. */
function rendezvous(meet: string, me: string, everyone: string[]): string {
  const all = everyone.map((name) => `[ -e '${join(meet, name)}' ]`).join(' && ')
  return `touch '${join(meet, me)}'; i=0; while [ $i -lt ${MEET_WITHIN_S * 10} ]; do if ${all}; then exit 0; fi; sleep 0.1; i=$((i+1)); done; exit 1`
}

// The plan's step by name, the plain gate's or gate:full's (`perf`), run alone with the command it is handed.
const GATE = `;(async () => {
  const m = await import(process.env.NYMBAL_TEST_GATE_URL)
  const name = process.env.NYMBAL_TEST_STEP
  const planned = m.plan({ full: name === 'perf', base: 'abc1234', changed: ['packages/sdk/src/client.ts'], mutated: [] })
  const spec = planned.steps.find((s) => s.name === name)
  const step = { ...spec, command: process.env.NYMBAL_TEST_COMMAND, needs: [] }
  const result = await m.run([step], { cwd: process.cwd(), budgetMs: 60000, loadAverage: () => 0 })
  process.stdout.write('\\n' + JSON.stringify(result.steps[0].status) + '\\n')
})()`

/** The status of the plan's `step` run as a gate in `cwd` with `command`. */
async function gateStep(cwd: string, step: string, command: string): Promise<string> {
  const { stdout } = await exec(TSX, ['--eval', GATE], {
    cwd,
    env: {
      ...cleanEnv(),
      NYMBAL_TEST_GATE_URL: GATE_URL,
      NYMBAL_TEST_STEP: step,
      NYMBAL_TEST_COMMAND: command,
    },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null') as string
}

describe('a gate waits for no other worktree', () => {
  it("three worktrees' tests steps run at the same moment", { timeout: 60_000 }, async () => {
    const names = ['one', 'two', 'three']
    const { meet, dirs } = worktrees(names)
    const statuses = await Promise.all(
      dirs.map((dir, i) => gateStep(dir, 'tests', rendezvous(meet, names[i]!, names))),
    )
    expect(statuses).toEqual(names.map(() => 'ok'))
  })

  it("perf runs while another worktree's tests step runs", { timeout: 60_000 }, async () => {
    const names = ['perf', 'tests']
    const { meet, dirs } = worktrees(names)
    const statuses = await Promise.all(
      names.map((name, i) => gateStep(dirs[i]!, name, rendezvous(meet, name, names))),
    )
    expect(statuses).toEqual(['ok', 'ok'])
  })
})
