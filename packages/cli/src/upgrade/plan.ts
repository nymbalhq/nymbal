import semver from 'semver'
import type { Matrix, MatrixRow } from './matrix.js'

export interface ProjectManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
  overrides?: Record<string, string>
}

export interface PlanInput {
  current: string
  manifest: ProjectManifest
  installed: Record<string, string>
  matrix: Matrix
}

export interface Blocked {
  stack: string
  adapter: string
  version: string | null
  status: 'failing' | 'suspended'
  line?: string
}

export type UpgradePlan =
  | { kind: 'current'; current: string }
  | { kind: 'refused'; current: string; blocked: Blocked[] }
  | {
      kind: 'upgrade'
      current: string
      target: string
      edits: Record<string, string>
      held: Blocked[]
      unchecked: string[]
    }

/** Every name the manifest declares, with the value of the first of the four sections that has it. */
export function declaredVersions(manifest: ProjectManifest): Map<string, string> {
  const out = new Map<string, string>()
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.pnpm?.overrides,
    manifest.overrides,
  ]
  for (const section of sections) {
    for (const [name, value] of Object.entries(section ?? {})) {
      if (!out.has(name)) out.set(name, value)
    }
  }
  return out
}

function blockersIn(stack: string, row: MatrixRow, manifest: ProjectManifest): Blocked[] {
  const dependencies = manifest.dependencies ?? {}
  const blocked: Blocked[] = []
  for (const [adapter, entry] of Object.entries(row.adapters)) {
    if (!Object.hasOwn(dependencies, adapter)) continue
    if (entry.status !== 'failing' && entry.status !== 'suspended') continue
    blocked.push({
      stack,
      adapter,
      version: entry.version,
      status: entry.status,
      ...(entry.line === undefined ? {} : { line: entry.line }),
    })
  }
  return blocked
}

function editsFor(input: PlanInput, row: MatrixRow): Record<string, string> {
  const declared = declaredVersions(input.manifest)
  const installedOf = (name: string): string | undefined => {
    if (name === 'nymbal') return input.current
    const known = input.installed[name]
    if (known !== undefined) return known
    // A range nothing can compare (a workspace or file reference) stays as the store wrote it.
    const range = declared.get(name)
    if (range === undefined || semver.validRange(range) === null) return undefined
    return semver.minVersion(range)?.version
  }
  const edits: Record<string, string> = {}
  const moveUp = (name: string, version: string): void => {
    if (!declared.has(name)) return
    const from = installedOf(name)
    if (from !== undefined && semver.gt(version, from)) edits[name] = version
  }
  for (const [name, version] of Object.entries(row.packages)) moveUp(name, version)
  for (const [name, entry] of Object.entries(row.adapters)) {
    if ((entry.status === 'passing' || entry.status === 'first-party') && entry.version !== null) {
      moveUp(name, entry.version)
    }
  }
  return edits
}

/** The newest row above the installed version that none of the store's adapters blocks. */
export function planUpgrade(input: PlanInput): UpgradePlan {
  const { current, manifest, matrix } = input
  const above = Object.keys(matrix.stacks)
    .filter((stack) => semver.gt(stack, current))
    .sort(semver.rcompare)
  if (above.length === 0) return { kind: 'current', current }

  const held: Blocked[] = []
  for (const stack of above) {
    const row = matrix.stacks[stack]!
    const blocked = blockersIn(stack, row, manifest)
    if (blocked.length > 0) {
      held.push(...blocked)
      continue
    }
    const dependencies = manifest.dependencies ?? {}
    const unchecked = Object.entries(row.adapters)
      .filter(([name, entry]) => entry.status === 'no-suite' && Object.hasOwn(dependencies, name))
      .map(([name]) => name)
    return { kind: 'upgrade', current, target: stack, edits: editsFor(input, row), held, unchecked }
  }
  return { kind: 'refused', current, blocked: held }
}

/** `manifest` with each edited name set in every one of the four sections that has it, key order kept. */
export function applyEdits(
  manifest: ProjectManifest,
  edits: Record<string, string>,
): ProjectManifest {
  const move = (section: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(section).map(([name, value]) => [
        name,
        Object.hasOwn(edits, name) ? edits[name]! : value,
      ]),
    )
  const out: ProjectManifest = { ...manifest }
  if (out.dependencies) out.dependencies = move(out.dependencies)
  if (out.devDependencies) out.devDependencies = move(out.devDependencies)
  if (out.overrides) out.overrides = move(out.overrides)
  if (out.pnpm?.overrides) out.pnpm = { ...out.pnpm, overrides: move(out.pnpm.overrides) }
  return out
}
