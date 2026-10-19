import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// The Changeset check. `changeset status --since` fails any diff that changes a file under a package without a
// changeset, its tests included, so a test-only change went red. A change needs one when it touches a file under a
// published (non-private) workspace package that is not a test path; then `changeset status` decides.

/** The hooks' test path (`.claude/hooks/lib.sh`, `TEST_PATH_RE`): one rule for what counts as a test. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|__fixtures__|fixtures|journeys|sentinels)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.test-d\.ts$/

export function needsChangeset(changed: string[], publishedPackageDirs: string[]): boolean {
  return changed.some(
    (path) =>
      !TEST_PATH.test(path) && publishedPackageDirs.some((dir) => path.startsWith(`${dir}/`)),
  )
}

/** The `packages:` entries of pnpm-workspace.yaml: `dir/*` or a plain directory. */
function workspaceGlobs(root: string): string[] {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs: string[] = []
  let inPackages = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line)
    const entry = inPackages ? /^\s+-\s+["']?([^"'#\s]+)["']?/.exec(line)?.[1] : undefined
    if (entry !== undefined) globs.push(entry)
  }
  return globs
}

/** The workspace package directories, from the root, whose package.json is not `private`. */
function publishedPackageDirs(root: string): string[] {
  const globs = workspaceGlobs(root)
  const excluded = new Set(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)))
  const dirs = globs
    .filter((g) => !g.startsWith('!'))
    .flatMap((glob) => {
      if (!glob.endsWith('/*')) return [glob]
      const parent = glob.slice(0, -2)
      if (!existsSync(join(root, parent))) return []
      return readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`)
    })
  return dirs.filter((dir) => {
    if (excluded.has(dir)) return false
    const manifest = join(root, dir, 'package.json')
    if (!existsSync(manifest)) return false
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { private?: boolean }).private !== true
  })
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { base: { type: 'string' } } })
  if (values.base === undefined) throw new Error('usage: changeset-needed.ts --base <ref>')
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  // The pull request's own changes: from where it left the base, as `changeset status --since` reads them.
  // Without renames, a move out of a package source path lists the path it left, not only where it landed.
  const changed = git(root, ['diff', '--name-only', '--no-renames', `${values.base}...HEAD`])
    .split('\n')
    .filter(Boolean)
  if (!needsChangeset(changed, publishedPackageDirs(root))) {
    process.stdout.write('changeset: not needed (tests only)\n')
    return 0
  }
  const status = spawnSync('pnpm', ['exec', 'changeset', 'status', `--since=${values.base}`], {
    cwd: root,
    stdio: 'inherit',
  })
  if (status.error !== undefined) throw status.error
  return status.status ?? 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
