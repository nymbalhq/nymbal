// Reads: packages/**, pnpm-workspace.yaml, packages/config/src/adapter-names.ts, registry/adapters.json
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Slot } from '../../packages/types/src/index'
import { ADAPTER_CATALOGUE, slotFolder } from '../../packages/config/src/adapter-names'
import {
  FIRST_PARTY_ADAPTERS,
  MOVED_ADAPTERS,
  ROOT,
  pnpmMembers,
  pnpmPackageDirs,
} from './adapter-table'

// AC-2: each first-party adapter registry/adapters.json lists is a workspace member at
// packages/adapters/<slotFolder>/<provider>/, named @nymbalhq/<slotFolder>-<provider>, with `repository.directory` its
// own directory; none of the moved adapters' old directories is left, and every other package stays at packages/<name>. The slot folder is slotFolder of a catalogue
// slot, and the provider one of that slot's catalogue entries.

/** The packages that are not adapters, which stay one level under packages/. */
const CORE_DIRS = [
  'packages/cli',
  'packages/config',
  'packages/contract-tests',
  'packages/create-app',
  'packages/http',
  'packages/importers',
  'packages/platform',
  'packages/proof-kit',
  'packages/react',
  'packages/sdk',
  'packages/stack',
  'packages/test-factories',
  'packages/types',
  'packages/web-components',
]

interface AdapterManifest {
  name?: string
  repository?: string | { directory?: string }
}

const manifest = (dir: string): AdapterManifest =>
  JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as AdapterManifest

const tracked = (dir: string): string[] =>
  execFileSync('git', ['ls-files', '--', dir], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

describe('AC-2: the adapters live by slot', () => {
  it('AC-2: each first-party adapter the registry lists is a workspace member at packages/adapters/<kebab slot>/<provider>, under its convention name', () => {
    const byDir = new Map(pnpmMembers().map((m) => [m.dir, m.name]))
    const wrong = FIRST_PARTY_ADAPTERS.filter((a) => byDir.get(a.dir) !== a.name).map(
      (a) => `${a.dir}: ${byDir.has(a.dir) ? `named ${byDir.get(a.dir)}` : 'not a member'}`,
    )

    expect(wrong).toEqual([])
    expect(FIRST_PARTY_ADAPTERS.filter((a) => byDir.has(a.dir)).length).toBe(
      FIRST_PARTY_ADAPTERS.length,
    )
  })

  it("AC-2: each first-party adapter manifest's repository.directory is its own directory", () => {
    const wrong = FIRST_PARTY_ADAPTERS.map((a) => {
      const path = join(ROOT, a.dir, 'package.json')
      const repository = existsSync(path) ? manifest(a.dir).repository : undefined
      const directory = typeof repository === 'object' ? repository.directory : undefined
      return { dir: a.dir, directory }
    }).filter(({ dir, directory }) => directory !== dir)

    expect(wrong).toEqual([])
  })

  it('AC-2: no old directory is left, on disk or tracked', () => {
    const left = MOVED_ADAPTERS.flatMap((a) => [
      ...(existsSync(join(ROOT, a.from)) ? [`${a.from} exists`] : []),
      ...tracked(a.from).map((f) => `${f} is tracked`),
    ])
    const strays = readdirSync(join(ROOT, 'packages')).filter((d) =>
      /^(adapter-|doc-store-|event-bus-|media-|security-)/.test(d),
    )

    expect(left).toEqual([])
    expect(strays).toEqual([])
  })

  it('AC-2: every other member under packages/ stays at packages/<name>', () => {
    const adapterDirs = new Set(FIRST_PARTY_ADAPTERS.map((a) => a.dir))
    const others = pnpmPackageDirs().filter((d) => !adapterDirs.has(d))

    expect(others.filter((d) => !/^packages\/[^/]+$/.test(d))).toEqual([])
    expect(others).toEqual(CORE_DIRS)
    expect(pnpmPackageDirs().length).toBe(CORE_DIRS.length + FIRST_PARTY_ADAPTERS.length)
  })

  it("AC-2: each slot folder is slotFolder of a catalogue slot, and each provider one of that slot's catalogue entries", () => {
    const wrong = FIRST_PARTY_ADAPTERS.filter((a) => {
      const [, , folder, provider] = a.dir.split('/')
      return (
        folder !== slotFolder(a.slot) ||
        provider !== a.provider ||
        !Object.hasOwn(ADAPTER_CATALOGUE[a.slot], a.provider)
      )
    }).map((a) => `${a.dir}: slot ${a.slot} → ${slotFolder(a.slot)}, provider ${a.provider}`)
    // The contributor's guide and its skill sit beside the slot folders: a file or a dot-directory is not a slot.
    const folders = existsSync(join(ROOT, 'packages/adapters'))
      ? readdirSync(join(ROOT, 'packages/adapters'), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
      : []
    const slotFolders = new Set((Object.keys(ADAPTER_CATALOGUE) as Slot[]).map(slotFolder))

    expect(wrong).toEqual([])
    expect(folders.filter((f) => !slotFolders.has(f))).toEqual([])
    expect(new Set(folders).size).toBe(
      new Set(FIRST_PARTY_ADAPTERS.map((a) => slotFolder(a.slot))).size,
    )
  })
})
