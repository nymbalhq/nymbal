import semver from 'semver'
import type { Matrix } from '../upgrade/matrix.js'
import { blockersIn } from '../upgrade/plan.js'

export const STORE_PRESET = 'github>nymbalhq/nymbal//renovate/store'
export const AUTO_UPDATES_PRESET = 'github>nymbalhq/nymbal//renovate/auto-updates'

/** A preset known to leave automerge off: the store preset exactly, or one of Renovate's own `config:` presets. */
const quietPreset = (entry: unknown): boolean =>
  entry === STORE_PRESET || (typeof entry === 'string' && entry.startsWith('config:'))

/** True when `automerge: true` sits at any depth, or any `extends` names a preset other than a quiet one. */
function mayAutomerge(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mayAutomerge)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, inner]) => {
    if (key === 'automerge' && inner === true) return true
    if (key === 'extends' && !(Array.isArray(inner) && inner.every(quietPreset))) return true
    return mayAutomerge(inner)
  })
}

/**
 * Parsed renovate.json: off only when every `extends` holds the store preset or `config:` presets and no `automerge`
 * is true. Any other preset counts as on, since Renovate accepts many spellings of one (a `#tag`, a `.json` suffix,
 * `:automergePatch`) and an unrecognised one must not let an update skip the check.
 */
export function renovateEnablesAutomerge(config: unknown): boolean {
  return mayAutomerge(config)
}

export interface UpdateFacts {
  /** No renovate.json reads as `{ automerge: false }`. */
  renovate: { automerge: boolean } | { error: string }
  /** What the base declares (declaredVersions of its package.json). */
  base: Record<string, string> | { error: string }
  /** What the head declares. */
  head: Record<string, string>
  /** The declared versions or the lockfile differ between base and head. */
  dependencyFilesChanged: boolean
  ownMigrations: boolean
  /** The head's installed version of each declared name installedVersion finds. */
  installed: Record<string, string>
  matrix: Matrix | { error: string }
  /** Journal tags at the head absent at the base. */
  migrationsAdded: string[] | { error: string }
}

export interface Decision {
  ok: boolean
  lines: string[]
}

const isError = (value: object): value is { error: string } =>
  typeof (value as { error?: unknown }).error === 'string'

/** The lowest version a declared value allows, or null for one semver cannot read (an `npm:` alias, `workspace:*`). */
function minimum(value: string): semver.SemVer | null {
  try {
    return semver.validRange(value) === null ? null : semver.minVersion(value)
  } catch {
    return null
  }
}

function declarationReasons(base: Record<string, string>, head: Record<string, string>): string[] {
  const reasons: string[] = []
  const names = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
  for (const name of names) {
    const from = Object.hasOwn(base, name) ? base[name] : undefined
    const to = Object.hasOwn(head, name) ? head[name] : undefined
    if (from === undefined) reasons.push(`${name} ${to} is added`)
    else if (to === undefined) reasons.push(`${name} ${from} is removed`)
    else if (from !== to) {
      const low = minimum(from)
      const high = minimum(to)
      if (low === null || high === null) {
        reasons.push(`${name} changes from ${from} to ${to}, which semver cannot compare`)
      } else if (high.major > low.major) {
        reasons.push(`${name} moves from ${from} to ${to}, a new major version`)
      }
    }
  }
  return reasons
}

function matrixReasons(facts: UpdateFacts): string[] {
  if (isError(facts.matrix)) return [`cannot read the compatibility matrix: ${facts.matrix.error}`]
  const stack = facts.installed['nymbal']
  if (stack === undefined)
    return ['nymbal is not installed, so no compatibility matrix row applies']
  const row = facts.matrix.stacks[stack]
  if (row === undefined) return [`nymbal ${stack} is not in the compatibility matrix`]
  const reasons: string[] = []
  for (const [name, certified] of Object.entries(row.packages)) {
    const found = Object.hasOwn(facts.installed, name) ? facts.installed[name] : undefined
    if (!Object.hasOwn(facts.head, name) || found === undefined || found === certified) continue
    reasons.push(
      `${name} is installed at ${found}, but nymbal ${stack} is certified with ${certified}`,
    )
  }
  for (const b of blockersIn(stack, row, { dependencies: facts.head })) {
    reasons.push(
      `${b.adapter} ${b.version ?? 'unknown'} is ${b.status} with nymbal ${stack}${b.line === undefined ? '' : `: ${b.line}`}`,
    )
  }
  return reasons
}

/** Whether an update may merge itself: ok with one line, or refused with one line per reason that holds. */
export function decideUpdate(facts: UpdateFacts): Decision {
  if (isError(facts.renovate)) {
    return { ok: false, lines: [`renovate.json cannot be read: ${facts.renovate.error}`] }
  }
  if (!facts.renovate.automerge) return { ok: true, lines: ['auto-updates off'] }
  if (isError(facts.base)) {
    return { ok: false, lines: [`cannot read the base's package.json: ${facts.base.error}`] }
  }
  if (!facts.dependencyFilesChanged) return { ok: true, lines: ['no dependency changed'] }

  const reasons: string[] = []
  if (facts.ownMigrations) {
    reasons.push('the project has its own migrations/ folder, which an update cannot be judged by')
  }
  reasons.push(...declarationReasons(facts.base, facts.head))
  reasons.push(...matrixReasons(facts))
  if (isError(facts.migrationsAdded)) {
    reasons.push(`cannot read the base's migrations: ${facts.migrationsAdded.error}`)
  } else if (facts.migrationsAdded.length > 0) {
    reasons.push(`the update adds migrations: ${facts.migrationsAdded.join(', ')}`)
  }
  return reasons.length === 0 ? { ok: true, lines: ['may merge'] } : { ok: false, lines: reasons }
}
