import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseYaml, type Yaml } from '../tooling/workflow-yaml.js'

// The CI workflow create-nymbal-app wrote into the scaffolded store (scripts/scaffold-clean.sh sets the variable
// below), run as GitHub would run it on a checkout: a copy of the project holding only what git tracks, committed, and
// the workflow's `run` steps executed there in order with CI=true. The install resolves from the local registry the
// script exported. Afterwards git sees nothing new in the copy.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
if (!SCAFFOLD_DIR) {
  throw new Error(
    'The workflow case needs NYMBAL_SCAFFOLD_DIR (the scaffolded project). Run it through scripts/scaffold-clean.sh <astro|nextjs>.',
  )
}
const DIR: string = SCAFFOLD_DIR
const WORKFLOW = join(DIR, '.github', 'workflows', 'nymbal.yml')
/** Each step's bound: an install from the registry, or verify's production build and journey. */
const STEP_MS = 12 * 60_000

type YamlMap = { [key: string]: Yaml }
const asMap = (value: Yaml | undefined): YamlMap => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`not a mapping: ${JSON.stringify(value)}`)
  }
  return value
}

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=ci@scaffold.local', '-c', 'user.name=ci', ...args],
    { cwd, encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${run.stderr}`)
  return run.stdout
}

/**
 * What a runner's shell holds: this environment without Vitest's, the scaffold run's own variables, NODE_ENV or the
 * package manager's lifecycle variables, keeping the registry the script set up. CI=true as on GitHub.
 */
function runnerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^VITEST|^NYMBAL_|^NODE_ENV$/.test(key)) continue
    if (/^npm_/i.test(key) && !/^npm_config_(registry|userconfig|cache)$/i.test(key)) continue
    env[key] = value
  }
  return { ...env, CI: 'true' }
}

/** One `run` step as GitHub's default shell runs it: bash, errexit and pipefail. */
function runStep(script: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env: runnerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr.on('data', (b: Buffer) => (out += b.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe("AC-14: the store's own CI workflow on a CI checkout", () => {
  it(
    'AC-14: on a committed copy holding only what git tracks, the run steps each exit 0 with CI=true, the last prints verify: passed, 7 steps, and git status is empty afterwards',
    async () => {
      expect(existsSync(WORKFLOW), `create-nymbal-app wrote no ${WORKFLOW}`).toBe(true)
      const jobs = asMap(asMap(parseYaml(readFileSync(WORKFLOW, 'utf8')))['jobs'])
      const steps = (asMap(jobs['verify'])['steps'] as Yaml[]).map(asMap)
      const runs = steps.filter((s) => typeof s['run'] === 'string').map((s) => s['run'] as string)
      expect(runs.length, 'the workflow has run steps').toBeGreaterThanOrEqual(2)

      // The checkout: the project without node_modules (copying it would only be deleted below), then without every
      // other entry its own .gitignore lists, committed. Nothing ignored is left, so this is what actions/checkout gives.
      const copy = join(realpathSync(mkdtempSync(join(tmpdir(), 'scaffold-checkout-'))), 'shop')
      scratch.push(join(copy, '..'))
      cpSync(DIR, copy, {
        recursive: true,
        filter: (source) => !/[/\\](node_modules|\.next|\.astro)$/.test(source),
      })
      git(copy, 'init', '-q')
      git(copy, 'clean', '-ffdqX')
      expect(
        git(copy, 'status', '--porcelain', '--ignored')
          .split('\n')
          .filter((l) => l.startsWith('!!')),
      ).toEqual([])
      git(copy, 'add', '-A')
      git(copy, 'commit', '-q', '-m', 'checkout')
      expect(
        ['.env', 'nymbal.db', 'node_modules'].filter((f) => existsSync(join(copy, f))),
      ).toEqual([])

      const results: Array<{ run: string; code: number | null; out: string }> = []
      for (const run of runs) {
        const result = await runStep(run, copy)
        results.push({ run, ...result })
        if (result.code !== 0) break
      }

      expect(
        results.map((r) => [r.run, r.code]),
        results.map((r) => `$ ${r.run}\n${r.out.slice(-3000)}`).join('\n'),
      ).toEqual(runs.map((run) => [run, 0]))
      expect(results.at(-1)!.out).toContain('verify: passed, 7 steps')
      expect(git(copy, 'status', '--porcelain')).toBe('')
    },
    2 * STEP_MS + 120_000,
  )
})
