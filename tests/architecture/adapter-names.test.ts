// Reads: **
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECIPE_HOLDERS } from '../../packages/cli/src/recipes/holders'
import type { Slot } from '../../packages/types/src/index'
import {
  ADAPTER_CATALOGUE,
  conventionPackage,
  slotFolder,
} from '../../packages/config/src/adapter-names'
import { ADAPTER_NAMES, RETIRED_NAMES, ROOT, pnpmMembers } from './adapter-table'

// AC-3: every name the kernel and the CLI import is a workspace package. The workspace adapters are the catalogue's
// first-party entries at their convention names, and the recipe holders and the platform's optional peers name a
// member whose manifest has that name; the changesets `fixed` group and NON_SCAFFOLD_PACKAGES name no package missing
// from the workspace; every pending changeset's frontmatter keys are members. No tracked file names a retired name, READMEs included, but CHANGELOG.md files, the lockfile and
// the changeset bodies (which may say "renamed from").

interface PlatformManifest {
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const members = pnpmMembers()
const memberNames = new Set(members.map((m) => m.name))
const retired = new Set(RETIRED_NAMES)

/** The names in `names` that `changeset version` or an import would not find: not a member, or a retired name. */
const unresolved = (names: Iterable<string>): string[] =>
  [...names].filter((n) => !memberNames.has(n) || retired.has(n)).sort()

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0')
    .filter(Boolean)

/** A pending changeset: `.changeset/<name>.md` with frontmatter (the README has none). */
const changesets = (): string[] =>
  trackedFiles().filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && read(f).startsWith('---\n'))

/** The package keys of a changeset's frontmatter, the names `changeset version` resolves. */
function frontmatterKeys(text: string): string[] {
  const end = text.indexOf('\n---', 4)
  return text
    .slice(4, end)
    .split('\n')
    .map((line) => /^\s*['"]?([^'":]+)['"]?\s*:/.exec(line)?.[1]?.trim())
    .filter((k): k is string => k !== undefined)
}

describe('AC-3: every package name the kernel and the CLI import is a workspace package', () => {
  it("AC-3: the workspace adapters at packages/adapters/<folder>/<provider> are exactly the catalogue's first-party entries, each named conventionPackage of the slot whose slotFolder is <folder>, and peering the catalogue's SDK and nothing else", () => {
    const slots = Object.keys(ADAPTER_CATALOGUE) as Slot[]
    const slotOf = new Map(slots.map((slot) => [slotFolder(slot), slot]))
    const workspace = members
      .filter((m) => /^packages\/adapters\/[^/]+\/[^/]+$/.test(m.dir))
      .map((m) => {
        const [, , folder = '', provider = ''] = m.dir.split('/')
        return { folder, provider, name: m.name, dir: m.dir }
      })
    const firstParty = slots.flatMap((slot) =>
      Object.entries(
        ADAPTER_CATALOGUE[slot] as Readonly<Record<string, { builtIn?: true; sdk?: string }>>,
      )
        .filter(([, entry]) => entry.builtIn !== true)
        .map(([provider, entry]) => ({ slot, provider, sdk: entry.sdk })),
    )

    expect(workspace.map((w) => `${w.folder}/${w.provider}`).sort()).toEqual(
      firstParty.map((e) => `${slotFolder(e.slot)}/${e.provider}`).sort(),
    )
    const misnamed = workspace
      .filter((w) => {
        const slot = slotOf.get(w.folder)
        return slot === undefined || w.name !== conventionPackage(slot, w.provider)
      })
      .map((w) => `${w.dir}: ${w.name}`)
    expect(misnamed).toEqual([])
    const wrongSdk = firstParty
      .map((e) => {
        const dir = `packages/adapters/${slotFolder(e.slot)}/${e.provider}`
        const peers = Object.keys(
          (JSON.parse(read(`${dir}/package.json`)) as PlatformManifest).peerDependencies ?? {},
        ).filter((name) => !name.startsWith('@nymbalhq/'))
        return { dir, peers, sdk: e.sdk === undefined ? [] : [e.sdk] }
      })
      .filter((e) => JSON.stringify(e.peers) !== JSON.stringify(e.sdk))
    expect(wrongSdk).toEqual([])
    expect(workspace.length).toBe(ADAPTER_NAMES.length)
  })

  it('AC-3: every recipe holder is a member by that name', () => {
    expect(unresolved(Object.values(RECIPE_HOLDERS))).toEqual([])
  })

  it('AC-3: the platform peers each of the twelve as optional, and every optional peer it names is a member', () => {
    const platform = JSON.parse(read('packages/platform/package.json')) as PlatformManifest
    const optional = Object.entries(platform.peerDependenciesMeta ?? {})
      .filter(([name, meta]) => meta.optional === true && name.startsWith('@nymbalhq/'))
      .map(([name]) => name)

    expect(unresolved(optional)).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => !optional.includes(n))).toEqual([])
  })

  it('AC-3: the changesets fixed group names only members, the twelve among them', () => {
    const config = JSON.parse(read('.changeset/config.json')) as { fixed: string[][] }
    const fixed = config.fixed.flat()

    expect(unresolved(fixed)).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => !fixed.includes(n))).toEqual([])
  })

  it('AC-3: NON_SCAFFOLD_PACKAGES names only members, the twelve among them', async () => {
    const { NON_SCAFFOLD_PACKAGES } = (await import(
      join(ROOT, 'packages/create-app/scripts/sync-scaffold.mjs')
    )) as { NON_SCAFFOLD_PACKAGES: ReadonlySet<string> }
    const names = [...NON_SCAFFOLD_PACKAGES]

    expect(unresolved(names)).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => !names.includes(n))).toEqual([])
  })

  it('AC-3: every pending changeset names only members in its frontmatter', () => {
    const files = changesets()
    const wrong = files.flatMap((f) =>
      unresolved(frontmatterKeys(read(f))).map((n) => `${basename(f)}: ${n}`),
    )
    const keys = files.flatMap((f) => frontmatterKeys(read(f)))

    expect(wrong).toEqual([])
    // The frontmatter parse read something: every changeset names at least one package, but an empty one
    // (`changeset --empty`, whose frontmatter has no line), which names none.
    const empty = (f: string): boolean => /^---\n---(\n|$)/.test(read(f))
    expect(files.filter((f) => !empty(f) && frontmatterKeys(read(f)).length === 0)).toEqual([])
    expect(keys.length).toBeGreaterThanOrEqual(files.length)
  })
})

describe('AC-3: no tracked file names a retired package name', () => {
  // Changesets are scanned only in their frontmatter: a body may say what a package was renamed from.
  const EXEMPT = (file: string): boolean =>
    basename(file) === 'CHANGELOG.md' || file === 'pnpm-lock.yaml'
  const NAME = new RegExp(
    `(${RETIRED_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?![a-z0-9-])`,
  )

  it('AC-3: no tracked file but the CHANGELOGs, the lockfile and the changeset bodies contains one of the nine', () => {
    const candidates = trackedFiles().filter((f) => !EXEMPT(f))
    const pending = new Set(changesets())
    const offenders: string[] = []
    let scanned = 0
    for (const file of candidates) {
      const full = join(ROOT, file)
      let regular = false
      try {
        regular = lstatSync(full).isFile()
      } catch {
        // Tracked but deleted in the work tree: nothing on disk to ship.
      }
      if (!regular) continue
      scanned += 1
      const text = readFileSync(full, 'utf8')
      const scope = pending.has(file) ? text.slice(0, text.indexOf('\n---', 4) + 4) : text
      if (!NAME.test(scope)) continue
      scope.split('\n').forEach((line, i) => {
        if (NAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
    }

    // The scan reached the files: every regular tracked file but the exemptions.
    expect(scanned).toBeGreaterThan(candidates.length / 2)
    expect(RETIRED_NAMES.length).toBe(9)
    const files = new Set(offenders.map((o) => o.slice(0, o.indexOf(':'))))
    expect(
      offenders,
      `${offenders.length} lines in ${files.size} tracked files:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
