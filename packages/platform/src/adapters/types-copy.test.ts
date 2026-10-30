import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { sameTypesCopy } from './resolve.js'

// AC-3: `sameTypesCopy(adapterUrl, kernelUrl)` tells whether an adapter module and the kernel load one
// @nymbalhq/types. Each generated layout is a project on disk: the kernel's types hoisted, or nested as a pnpm-style
// symlink into a store; the adapter's types hoisted, a symlink to the kernel's copy, the pnpm store's sibling link, its
// own copied directory, or not resolvable at all. The oracle is the physical directory each side's copy lives in, as
// the layout built it; the adapter's URL is passed realpath'd, as Node and import-meta-resolve give it.

const TYPES = '@nymbalhq/types'

const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A copy of @nymbalhq/types at `version`, a real directory at `dir`. */
function typesCopy(dir: string, version: string): string {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: TYPES,
      version,
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }),
  )
  writeFileSync(join(dir, 'dist', 'index.js'), 'export const copy = true\n')
  return dir
}

/** A module file at `path` (its package's package.json beside it), returned as the file URL Node would load. */
function moduleAt(path: string, name: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    join(dirname(path), 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module' }),
  )
  writeFileSync(path, 'export {}\n')
  return pathToFileURL(realpathSync(path)).href
}

function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, 'dir')
}

/** A path or a file URL, as a path. */
const asPath = (value: string): string => (value.startsWith('file:') ? fileURLToPath(value) : value)

/** Whether `path` is `dir` or lies inside it. */
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep)

const version = fc
  .tuple(fc.nat({ max: 3 }), fc.nat({ max: 9 }), fc.nat({ max: 9 }))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

const layout = fc.record({
  kernel: fc.constantFrom('hoisted', 'pnpm-nested'),
  adapter: fc.constantFrom('hoisted', 'link-to-kernel', 'pnpm-store', 'own-copy', 'unresolvable'),
  kernelVersion: version,
  otherVersion: version,
})
type Layout = typeof layout extends fc.Arbitrary<infer T> ? T : never

interface Built {
  adapterUrl: string
  kernelUrl: string
  /** The physical directory of the copy each side should load, or null where none resolves. */
  adapterCopy: { dir: string; version: string } | null
  kernelCopy: { dir: string; version: string }
}

function build(l: Layout): Built {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'types-copy-')))
  roots.push(root)
  const project = join(root, 'project')
  const nm = join(project, 'node_modules')
  const hoisted = join(nm, ...TYPES.split('/'))

  // The kernel's copy.
  const kernelModule = join(nm, '@nymbalhq', 'platform', 'dist', 'index.js')
  let kernelCopy: Built['kernelCopy']
  if (l.kernel === 'hoisted') {
    kernelCopy = { dir: typesCopy(hoisted, l.kernelVersion), version: l.kernelVersion }
  } else {
    const stored = typesCopy(join(root, 'store', 'types-kernel'), l.kernelVersion)
    link(stored, join(nm, '@nymbalhq', 'platform', 'node_modules', ...TYPES.split('/')))
    kernelCopy = { dir: stored, version: l.kernelVersion }
  }
  const kernelUrl = moduleAt(kernelModule, '@nymbalhq/platform')

  // The adapter's copy.
  let adapterModule = join(nm, '@acme', 'adapter', 'index.js')
  let adapterCopy: Built['adapterCopy']
  switch (l.adapter) {
    case 'hoisted': {
      if (l.kernel === 'hoisted') adapterCopy = kernelCopy
      else adapterCopy = { dir: typesCopy(hoisted, l.otherVersion), version: l.otherVersion }
      break
    }
    case 'link-to-kernel': {
      link(kernelCopy.dir, join(nm, '@acme', 'adapter', 'node_modules', ...TYPES.split('/')))
      adapterCopy = kernelCopy
      break
    }
    case 'pnpm-store': {
      // pnpm: the project's entry links into the store, and the adapter's types is its sibling link there.
      const storeNm = join(root, 'store', 'acme-adapter', 'node_modules')
      adapterModule = join(storeNm, '@acme', 'adapter', 'index.js')
      link(kernelCopy.dir, join(storeNm, ...TYPES.split('/')))
      link(join(storeNm, '@acme', 'adapter'), join(nm, '@acme', 'adapter'))
      adapterCopy = kernelCopy
      break
    }
    case 'own-copy': {
      const own = join(nm, '@acme', 'adapter', 'node_modules', ...TYPES.split('/'))
      adapterCopy = { dir: typesCopy(own, l.otherVersion), version: l.otherVersion }
      break
    }
    case 'unresolvable': {
      // Outside the project, with no node_modules on the way up to the temp root.
      adapterModule = join(root, 'elsewhere', 'adapter', 'index.js')
      adapterCopy = null
      break
    }
  }
  const adapterUrl = moduleAt(adapterModule, '@acme/adapter')
  return { adapterUrl, kernelUrl, adapterCopy, kernelCopy }
}

describe('AC-3: sameTypesCopy compares the copies two modules load', () => {
  it('AC-3: over generated symlinked and copied layouts, two URLs reaching one realpath are one copy, two directories are two, and an adapter with no resolvable types gives adapterTypes null', () => {
    fc.assert(
      fc.property(layout, (l) => {
        const built = build(l)

        const result = sameTypesCopy(built.adapterUrl, built.kernelUrl)

        expect(within(asPath(result.kernelTypes), built.kernelCopy.dir), result.kernelTypes).toBe(
          true,
        )
        expect(result.kernelVersion).toBe(built.kernelCopy.version)
        // Null exactly when no copy resolves from the adapter; otherwise the copy the layout put there.
        expect(result.adapterTypes === null, String(result.adapterTypes)).toBe(
          built.adapterCopy === null,
        )
        const placed =
          result.adapterTypes !== null && built.adapterCopy !== null
            ? within(asPath(result.adapterTypes), built.adapterCopy.dir)
            : result.adapterTypes === built.adapterCopy
        expect(placed, String(result.adapterTypes)).toBe(true)
        expect(result.adapterVersion).toBe(built.adapterCopy?.version ?? null)
        // One copy exactly when both sides reach one physical directory, whatever links lead there.
        expect(result.adapterTypes !== null && result.adapterTypes === result.kernelTypes).toBe(
          built.adapterCopy?.dir === built.kernelCopy.dir,
        )
      }),
      { numRuns: 40 },
    )
  })

  it('AC-3: a copy at the same version as the kernel is still a second copy', () => {
    fc.assert(
      fc.property(version, fc.constantFrom('hoisted', 'pnpm-nested'), (v, kernel) => {
        const built = build({ kernel, adapter: 'own-copy', kernelVersion: v, otherVersion: v })

        const result = sameTypesCopy(built.adapterUrl, built.kernelUrl)

        expect(result.adapterVersion).toBe(result.kernelVersion)
        expect(result.adapterTypes).not.toBe(result.kernelTypes)
      }),
      { numRuns: 10 },
    )
  })

  it("AC-3: an adapter's copy whose exports target is missing gives adapterTypes null, not a bare ENOENT", () => {
    const built = build({
      kernel: 'hoisted',
      adapter: 'own-copy',
      kernelVersion: '1.0.0',
      otherVersion: '1.0.0',
    })
    rmSync(join(built.adapterCopy!.dir, 'dist', 'index.js'))

    const result = sameTypesCopy(built.adapterUrl, built.kernelUrl)

    expect(result.adapterTypes).toBeNull()
    expect(result.adapterVersion).toBeNull()
    expect(within(asPath(result.kernelTypes), built.kernelCopy.dir)).toBe(true)
  })
})
