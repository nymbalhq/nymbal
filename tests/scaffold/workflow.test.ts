import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
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
function runStep(
  script: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env: { ...runnerEnv(), ...extraEnv },
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
const servers: Server[] = []
afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** The installed CI checkout the verify case leaves, which the auto-update case goes on with. */
let installedCheckout: string | undefined

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
      installedCheckout = copy
    },
    2 * STEP_MS + 120_000,
  )
})

const AUTO_UPDATES_PRESET = 'github>nymbalhq/nymbal//renovate/auto-updates'
const NYMBAL_NAME = /^(nymbal|@nymbalhq\/.+)$/

/** A third-party devDependency and a lower range of the same major: the patch lowered, else the minor. */
function lowerRange(devDependencies: Record<string, string>): [string, string] {
  const ranges = Object.entries(devDependencies)
    .filter(([name]) => !NYMBAL_NAME.test(name))
    .map(([name, value]) => ({ name, value, at: /^([~^]?)(\d+\.\d+\.\d+)$/.exec(value) }))
    .filter((r) => r.at !== null && semver.valid(r.at[2]!) !== null)
  const patch = ranges.find((r) => semver.patch(r.at![2]!) > 0)
  if (patch) {
    const v = semver.parse(patch.at![2]!)!
    return [patch.name, `${patch.at![1]}${v.major}.${v.minor}.${v.patch - 1}`]
  }
  const minor = ranges.find((r) => semver.minor(r.at![2]!) > 0)
  if (minor) {
    const v = semver.parse(minor.at![2]!)!
    return [minor.name, `${minor.at![1]}${v.major}.${v.minor - 1}.0`]
  }
  throw new Error(
    `no devDependency of the scaffold has a range to lower: ${JSON.stringify(devDependencies)}`,
  )
}

/** A compatibility matrix whose one row, for the installed nymbal, lists every installed Nymbal package's version. */
async function matrixFor(project: string): Promise<string> {
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    pnpm?: { overrides?: Record<string, string> }
    overrides?: Record<string, string>
  }
  const names = new Set(
    [manifest.dependencies, manifest.devDependencies, manifest.pnpm?.overrides, manifest.overrides]
      .flatMap((section) => Object.keys(section ?? {}))
      .filter((name) => NYMBAL_NAME.test(name)),
  )
  const packages: Record<string, string> = {}
  for (const name of names) {
    const file = join(project, 'node_modules', name, 'package.json')
    if (existsSync(file))
      packages[name] = (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
  }
  const stack = packages['nymbal']!
  const body = JSON.stringify({
    schema: 1,
    generatedAt: new Date().toISOString(),
    stacks: { [stack]: { packages, adapters: {} } },
  })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/matrix.json`
}

describe("AC-14: the auto-update job's check on the same CI checkout", () => {
  it(
    "AC-14: its last run step with CI=true says auto-updates off after a source-only commit under the scaffold's renovate.json, and may merge a lower-range devDependency moving up under the auto-updates preset with a matrix certifying the install; git status is empty after each",
    async () => {
      const jobs = asMap(asMap(parseYaml(readFileSync(WORKFLOW, 'utf8')))['jobs'])
      const job = jobs['auto-update']
      const steps =
        job !== null &&
        typeof job === 'object' &&
        !Array.isArray(job) &&
        Array.isArray(job['steps'])
          ? job['steps'].map(asMap)
          : []
      const check = steps
        .filter((s) => typeof s['run'] === 'string')
        .map((s) => (s['run'] as string).trim())
        .at(-1)
      expect(check, "the auto-update job's last run step").toMatch(/ nymbal update-check$/)
      expect(
        installedCheckout,
        'the verify case above left no installed checkout',
      ).not.toBeUndefined()
      const copy = installedCheckout!

      // (a) a source-only commit, renovate.json as create-nymbal-app wrote it.
      // At the project root: the Next.js template has no src/.
      writeFileSync(join(copy, 'update-check-probe.txt'), 'a source-only change\n')
      git(copy, 'add', '-A')
      git(copy, 'commit', '-q', '-m', 'a source-only change')
      const off = await runStep(check!, copy)
      expect(
        [off.code, off.out.includes('update-check: auto-updates off')],
        off.out.slice(-3000),
      ).toEqual([0, true])
      expect(git(copy, 'status', '--porcelain')).toBe('')

      // (b) the base declares one devDependency a range lower; the head is the scaffold's package.json with the
      // auto-updates preset. Base and head install the same @nymbalhq/platform, so no journal is fetched.
      const manifestPath = join(copy, 'package.json')
      const scaffolded = readFileSync(manifestPath, 'utf8')
      const manifest = JSON.parse(scaffolded) as { devDependencies: Record<string, string> }
      const [name, lower] = lowerRange(manifest.devDependencies)
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...manifest, devDependencies: { ...manifest.devDependencies, [name]: lower } }, null, 2)}\n`,
      )
      git(copy, 'commit', '-q', '-am', `base: ${name} ${lower}`)
      writeFileSync(manifestPath, scaffolded)
      const renovatePath = join(copy, 'renovate.json')
      const renovate = JSON.parse(readFileSync(renovatePath, 'utf8')) as Record<string, unknown>
      writeFileSync(
        renovatePath,
        `${JSON.stringify({ ...renovate, extends: [AUTO_UPDATES_PRESET] }, null, 2)}\n`,
      )
      git(
        copy,
        'commit',
        '-q',
        '-am',
        `head: ${name} back to the scaffold's range, auto-updates on`,
      )

      const merge = await runStep(check!, copy, { NYMBAL_MATRIX_URL: await matrixFor(copy) })
      expect(
        [merge.code, merge.out.includes('update-check: may merge')],
        merge.out.slice(-3000),
      ).toEqual([0, true])
      expect(git(copy, 'status', '--porcelain')).toBe('')
    },
    2 * STEP_MS,
  )
})
