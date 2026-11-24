import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import semver from 'semver'
import { decideUpdate, renovateEnablesAutomerge, type UpdateFacts } from '../update-check/decide.js'
import { addedMigrations, installedJournals, publishedJournals } from '../update-check/journal.js'
import { fetchMatrix, MATRIX_URL, MatrixError } from '../upgrade/matrix.js'
import { declaredVersions, type ProjectManifest } from '../upgrade/plan.js'
import { installedVersion } from './upgrade.js'

const PLATFORM = '@nymbalhq/platform'
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function readRenovate(root: string): UpdateFacts['renovate'] {
  const file = join(root, 'renovate.json')
  if (!existsSync(file)) return { automerge: false }
  try {
    return { automerge: renovateEnablesAutomerge(JSON.parse(readFileSync(file, 'utf8'))) }
  } catch (err) {
    return { error: message(err) }
  }
}

function readBase(root: string, rev: string): UpdateFacts['base'] {
  const show = spawnSync('git', ['show', `${rev}:./package.json`], { cwd: root, encoding: 'utf8' })
  if (show.status !== 0) {
    return { error: `git show ${rev}:package.json: ${show.stderr.trim() || `exit ${show.status}`}` }
  }
  try {
    return Object.fromEntries(declaredVersions(JSON.parse(show.stdout) as ProjectManifest))
  } catch (err) {
    return { error: `package.json at ${rev}: ${message(err)}` }
  }
}

function sameDeclarations(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a)
  return names.length === Object.keys(b).length && names.every((n) => b[n] === a[n])
}

/** Any lockfile differs between `rev` and the working tree; a git failure counts as a change. */
function lockfileChanged(root: string, rev: string): boolean {
  const diff = spawnSync('git', ['diff', '--quiet', rev, '--', ...LOCKFILES], { cwd: root })
  return diff.status !== 0
}

async function readMatrix(): Promise<UpdateFacts['matrix']> {
  const url = process.env['NYMBAL_MATRIX_URL'] ?? MATRIX_URL
  try {
    return await fetchMatrix(url)
  } catch (err) {
    if (!(err instanceof MatrixError)) throw err
    return { error: `${url}: ${err.message}` }
  }
}

/** The migrations the head's platform adds over the one the base declares; no fetch when the version is the same. */
async function readMigrationsAdded(
  root: string,
  base: Record<string, string>,
): Promise<UpdateFacts['migrationsAdded']> {
  const head = installedVersion(root, PLATFORM)
  if (head === undefined) return { error: `${PLATFORM} is not installed` }
  const declared = base[PLATFORM]
  let from: string | undefined
  try {
    from = declared === undefined ? undefined : semver.minVersion(declared)?.version
  } catch {
    from = undefined
  }
  if (from === undefined) {
    return { error: `the base declares no version of ${PLATFORM} semver can read` }
  }
  if (from === head) return []
  try {
    const published = await publishedJournals(PLATFORM, from)
    return addedMigrations(published, installedJournals(join(root, 'node_modules', PLATFORM)))
  } catch (err) {
    return { error: message(err) }
  }
}

async function gatherFacts(root: string, rev: string, head: Record<string, string>) {
  // Facts past the first that decides are never read; these stand in for them.
  const unread = { error: 'not read' }
  const facts: UpdateFacts = {
    renovate: readRenovate(root),
    base: unread,
    head,
    dependencyFilesChanged: false,
    ownMigrations: false,
    installed: {},
    matrix: unread,
    migrationsAdded: unread,
  }
  if ('error' in facts.renovate || !facts.renovate.automerge) return facts
  const base = readBase(root, rev)
  facts.base = base
  if ('error' in base) return facts
  facts.dependencyFilesChanged = !sameDeclarations(base, head) || lockfileChanged(root, rev)
  if (!facts.dependencyFilesChanged) return facts

  for (const name of Object.keys(head)) {
    const version = installedVersion(root, name)
    if (version !== undefined) facts.installed[name] = version
  }
  facts.ownMigrations = existsSync(join(root, 'migrations'))
  ;[facts.matrix, facts.migrationsAdded] = await Promise.all([
    readMatrix(),
    readMigrationsAdded(root, base),
  ])
  return facts
}

async function updateCheck(root: string, rev: string): Promise<number> {
  let head: Record<string, string>
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as ProjectManifest
    head = Object.fromEntries(declaredVersions(manifest))
  } catch (err) {
    process.stderr.write(`update-check: cannot read package.json in ${root}: ${message(err)}\n`)
    return 1
  }
  const decision = decideUpdate(await gatherFacts(root, rev, head))
  for (const line of decision.lines) {
    if (decision.ok) process.stdout.write(`update-check: ${line}\n`)
    else process.stderr.write(`update-check: refused: ${line}\n`)
  }
  return decision.ok ? 0 : 1
}

export const updateCheckCommand = defineCommand({
  meta: {
    name: 'update-check',
    description:
      'Decide whether a dependency update may merge itself under the auto-updates Renovate preset',
  },
  args: {
    base: {
      type: 'string',
      description: 'The git revision the update is compared with',
      default: 'HEAD^1',
    },
  },
  async run({ args }) {
    process.exitCode = await updateCheck(process.cwd(), args.base)
  },
})
