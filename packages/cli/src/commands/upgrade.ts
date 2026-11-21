import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import semver from 'semver'
import { fetchMatrix, type Matrix, MATRIX_URL, MatrixError } from '../upgrade/matrix.js'
import { applyEdits, declaredVersions, planUpgrade, type ProjectManifest } from '../upgrade/plan.js'
import { isFlatScaffold, resolveLocalBin } from '../utils/template-runner.js'

// The lockfile picks the package manager, never the user agent: under `npx` in a pnpm store the agent says npm.
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const

function packageManagerOf(root: string): { pm: string; lockfile: string } {
  for (const [lockfile, pm] of LOCKFILES) {
    if (existsSync(join(root, lockfile))) return { pm, lockfile }
  }
  return { pm: 'npm', lockfile: 'package-lock.json' }
}

const say = (line: string): void => void process.stdout.write(`${line}\n`)

function fail(message: string): number {
  process.stderr.write(`${message}\n`)
  return 1
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

/** The version a package in `node_modules` declares, or undefined when it is absent or unreadable. */
function installedVersion(root: string, name: string): string | undefined {
  try {
    const { version } = readJson(join(root, 'node_modules', name, 'package.json')) as {
      version?: unknown
    }
    return typeof version === 'string' && semver.valid(version) === version ? version : undefined
  } catch {
    return undefined
  }
}

function readManifest(file: string): ProjectManifest | undefined {
  try {
    const value = readJson(file)
    return typeof value === 'object' && value !== null ? (value as ProjectManifest) : undefined
  } catch {
    return undefined
  }
}

/** Each adapter any row lists that the store declares, at its version in `node_modules` when it is there. */
function installedAdapters(
  root: string,
  manifest: ProjectManifest,
  matrix: Matrix,
): Record<string, string> {
  const declared = declaredVersions(manifest)
  const listed = new Set(Object.values(matrix.stacks).flatMap((row) => Object.keys(row.adapters)))
  const installed: Record<string, string> = {}
  for (const name of listed) {
    if (!declared.has(name)) continue
    const version = installedVersion(root, name)
    if (version !== undefined) installed[name] = version
  }
  return installed
}

/** What doctor says about migrations; doctor exits 1 on a pending migration, so its exit code means nothing here. */
function migrationsDetail(bin: string, root: string): string | undefined {
  const doctor = spawnSync(bin, ['doctor', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  try {
    const { checks } = JSON.parse(doctor.stdout) as {
      checks?: Array<{ name?: unknown; detail?: unknown }>
    }
    const detail = checks?.find((check) => check.name === 'migrations')?.detail
    return typeof detail === 'string' ? detail : undefined
  } catch {
    return undefined
  }
}

async function upgrade(root: string): Promise<number> {
  const manifestFile = join(root, 'package.json')
  const isStore = isFlatScaffold(root, 'astro') || isFlatScaffold(root, 'nextjs')
  if (!isStore) return fail(`${root} is not a Nymbal store: no Astro or Next config file`)
  const manifest = existsSync(manifestFile) ? readManifest(manifestFile) : undefined
  if (manifest === undefined) return fail(`${root} is not a Nymbal store: no readable package.json`)
  const current = installedVersion(root, 'nymbal')
  if (current === undefined) {
    return fail(`${root} is not a Nymbal store: nymbal is not installed, run your package manager`)
  }

  const url = process.env['NYMBAL_MATRIX_URL'] ?? MATRIX_URL
  let matrix: Matrix
  try {
    matrix = await fetchMatrix(url)
  } catch (err) {
    if (!(err instanceof MatrixError)) throw err
    return fail(`cannot read the compatibility matrix at ${url}: ${err.message}`)
  }

  const plan = planUpgrade({
    current,
    manifest,
    installed: installedAdapters(root, manifest, matrix),
    matrix,
  })
  if (plan.kind === 'current') {
    say(`no newer release than ${current}`)
    return 0
  }
  if (plan.kind === 'refused') {
    const lines = plan.blocked.map(
      (b) =>
        `${b.stack}: ${b.adapter} ${b.version ?? 'unknown'} ${b.status}${b.line === undefined ? '' : `: ${b.line}`}`,
    )
    return fail(
      [`upgrade refused: nymbal stays at ${current}, no newer release works with:`, ...lines].join(
        '\n',
      ),
    )
  }

  for (const b of plan.held) say(`${b.stack} held back: ${b.adapter} ${b.status}`)
  for (const name of plan.unchecked) say(`not certified: ${name}`)

  const { pm, lockfile } = packageManagerOf(root)
  const lockPath = join(root, lockfile)
  const manifestBefore = readFileSync(manifestFile)
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath) : undefined
  const restore = (): void => {
    writeFileSync(manifestFile, manifestBefore)
    if (lockBefore === undefined) rmSync(lockPath, { force: true })
    else writeFileSync(lockPath, lockBefore)
  }

  writeFileSync(manifestFile, `${JSON.stringify(applyEdits(manifest, plan.edits), null, 2)}\n`)
  const installArgs = pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install']
  const install = spawnSync(pm, installArgs, { cwd: root, stdio: 'inherit' })
  const restored = `package.json and ${lockfile} were restored; run ${pm} install to bring node_modules back`
  if (install.status !== 0) {
    restore()
    return fail(`install failed (${pm} ${installArgs.join(' ')}): ${restored}`)
  }
  const found = installedVersion(root, 'nymbal')
  if (found !== plan.target) {
    restore()
    return fail(`nymbal is at ${found ?? 'an unknown version'}, not ${plan.target}: ${restored}`)
  }

  // The install replaced this process's own files, so the rest runs through the store's new CLI.
  const bin = resolveLocalBin(root, 'nymbal')
  const build =
    bin === null ? undefined : spawnSync(bin, ['build'], { cwd: root, stdio: 'inherit' })
  if (bin === null || build?.status !== 0) {
    const declared = declaredVersions(manifest)
    const previous = Object.keys(plan.edits).map((name) => `  ${name} ${declared.get(name)}`)
    return fail(
      [
        `build failed after moving from ${current} to ${plan.target}; the upgrade stays installed so the error above can be read.`,
        `To go back to ${current} in git: git restore package.json ${lockfile}`,
        'Not in git: set these back in package.json, in dependencies and the overrides:',
        ...previous,
        `Either way, then run ${pm} install`,
      ].join('\n'),
    )
  }

  say(`upgraded to ${plan.target}`)
  const detail = migrationsDetail(bin, root)
  say(
    detail === undefined
      ? 'could not read the migrations: run nymbal doctor'
      : `migrations: ${detail}`,
  )
  return 0
}

export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Move this store to the newest Nymbal release its adapters are certified with',
  },
  async run() {
    process.exitCode = await upgrade(process.cwd())
  },
})
