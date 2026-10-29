// Reads: packages/**, pnpm-workspace.yaml, packages/config/src/known-providers.ts
// Reads: packages/config/src/known-infrastructure.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_INFRASTRUCTURE } from '../../packages/config/src/known-infrastructure'
import { KNOWN_PROVIDERS } from '../../packages/config/src/known-providers'
import { MOVED_ADAPTERS, ROOT, kebab, pnpmMembers, pnpmPackageDirs } from './adapter-table'

// AC-2: each of the twelve first-party adapters is a workspace member at packages/adapters/<kebab slot>/<provider>/,
// named @nymbalhq/<kebab slot>-<provider>, with `repository.directory` its own directory; none of the old
// directories is left, and every other package stays at packages/<name>. The slot folder is the config's slot key in
// kebab case.

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

/** Each slot key the config has, and the values it accepts: the commerce slots, infrastructure, `security.adapter`. */
const CONFIG_SLOTS: Record<string, readonly string[]> = {
  ...KNOWN_PROVIDERS,
  ...KNOWN_INFRASTRUCTURE,
  security: ['cloudflare'],
}

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
  it('AC-2: each of the twelve is a workspace member at packages/adapters/<kebab slot>/<provider>, under its new name', () => {
    const byDir = new Map(pnpmMembers().map((m) => [m.dir, m.name]))
    const wrong = MOVED_ADAPTERS.filter((a) => byDir.get(a.dir) !== a.name).map(
      (a) => `${a.dir}: ${byDir.has(a.dir) ? `named ${byDir.get(a.dir)}` : 'not a member'}`,
    )

    expect(wrong).toEqual([])
    expect(MOVED_ADAPTERS.filter((a) => byDir.has(a.dir)).length).toBe(MOVED_ADAPTERS.length)
  })

  it("AC-2: each moved manifest's repository.directory is its own directory", () => {
    const wrong = MOVED_ADAPTERS.map((a) => {
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
    const adapterDirs = new Set(MOVED_ADAPTERS.map((a) => a.dir))
    const others = pnpmPackageDirs().filter((d) => !adapterDirs.has(d))

    expect(others.filter((d) => !/^packages\/[^/]+$/.test(d))).toEqual([])
    expect(others).toEqual(CORE_DIRS)
    expect(pnpmPackageDirs().length).toBe(CORE_DIRS.length + MOVED_ADAPTERS.length)
  })

  it('AC-2: each slot folder is a config slot key in kebab case, and each provider one that slot accepts', () => {
    const wrong = MOVED_ADAPTERS.filter((a) => {
      const [, , folder, provider] = a.dir.split('/')
      return (
        folder !== kebab(a.slot) ||
        provider !== a.provider ||
        !(CONFIG_SLOTS[a.slot] ?? []).includes(a.provider)
      )
    }).map((a) => `${a.dir}: slot ${a.slot} → ${kebab(a.slot)}, provider ${a.provider}`)
    const folders = existsSync(join(ROOT, 'packages/adapters'))
      ? readdirSync(join(ROOT, 'packages/adapters'))
      : []
    const slotFolders = new Set(Object.keys(CONFIG_SLOTS).map(kebab))

    expect(wrong).toEqual([])
    expect(folders.filter((f) => !slotFolders.has(f))).toEqual([])
    expect(new Set(folders).size).toBe(new Set(MOVED_ADAPTERS.map((a) => kebab(a.slot))).size)
  })
})
