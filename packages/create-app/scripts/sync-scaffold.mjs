#!/usr/bin/env node
// Syncs templates/astro and templates/nextjs into scaffold/templates/* so the scaffolder
// always copies from a single canonical source. Also merges root-manifest deps/scripts and
// rewrites workspace:* references to real semver versions baked from the monorepo.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const MONOREPO_ROOT = resolve(PKG_ROOT, '..', '..')
const PACKAGES_DIR = resolve(MONOREPO_ROOT, 'packages')
const SCAFFOLD_TEMPLATES = resolve(PKG_ROOT, 'scaffold', 'templates')

// Packages explicitly excluded from the scaffold dep map (dev/testing packages, not runtime deps).
// If a new @nymbal/* package appears in the monorepo and is NOT intended as a scaffold dep,
// add it here so the coverage test knows it's intentionally absent.
export const NON_SCAFFOLD_PACKAGES = new Set([
  '@nymbal/contract-tests',
  '@nymbal/test-factories',
])

// Static list of publishable @nymbal/* packages. Add an entry here when a new package ships.
export const NYMBAL_PACKAGE_DIRS = [
  { name: '@nymbal/cli', dir: 'cli' },
  { name: '@nymbal/config', dir: 'config' },
  { name: '@nymbal/http', dir: 'http' },
  { name: '@nymbal/importers', dir: 'importers' },
  { name: '@nymbal/platform', dir: 'platform' },
  { name: '@nymbal/react', dir: 'react' },
  { name: '@nymbal/sdk', dir: 'sdk' },
  { name: '@nymbal/types', dir: 'types' },
  { name: '@nymbal/web-components', dir: 'web-components' },
]

const templates = [
  { name: 'astro', from: resolve(MONOREPO_ROOT, 'templates', 'astro') },
  { name: 'nextjs', from: resolve(MONOREPO_ROOT, 'templates', 'nextjs') },
]

// Entries excluded from the scaffold copy, matched by EXACT basename so that
// *.astro page/component FILES are copied while the .astro CACHE DIRECTORY is not.
// (A previous endsWith() filter excluded every *.astro file — see the filter
// regression test in test/scaffold.test.ts.)
const EXCLUDED_BASENAMES = new Set(['node_modules', 'dist', '.astro', '.next'])

/**
 * Predicate for fs.cp's filter option: returns true when the entry should be copied.
 * Excludes build/cache directories by exact basename plus *.tsbuildinfo files.
 * @param {string} src absolute path of the entry being considered
 */
export function shouldCopyScaffoldEntry(src) {
  const name = basename(src)
  if (EXCLUDED_BASENAMES.has(name)) return false
  if (name.endsWith('.tsbuildinfo')) return false
  return true
}

export async function readNymbalVersions() {
  /** @type {Record<string, string>} */
  const versions = {}
  for (const { name, dir } of NYMBAL_PACKAGE_DIRS) {
    const pkgPath = resolve(PACKAGES_DIR, dir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    versions[name] = pkg.version
  }
  return versions
}

/**
 * Rewrites workspace:* values to ^version for @nymbal/* keys.
 * Throws if a workspace:* key has no entry in the version map — fail-loud at build time.
 * @param {Record<string, string> | undefined} deps
 * @param {Record<string, string>} versions
 */
export function rewriteWorkspaceVersions(deps, versions) {
  if (!deps) return deps
  /** @type {Record<string, string>} */
  const result = {}
  for (const [key, val] of Object.entries(deps)) {
    if (val === 'workspace:*' && key.startsWith('@nymbal/')) {
      const version = versions[key]
      if (!version) {
        throw new Error(
          `No version found for "${key}" — add it to NYMBAL_PACKAGE_DIRS in sync-scaffold.mjs`,
        )
      }
      result[key] = `^${version}`
    } else {
      result[key] = val
    }
  }
  return result
}

/**
 * Merges a template's package.json with the root-manifest deps/scripts to produce
 * the single flat package.json that ships in the scaffold.
 * @param {Record<string, unknown>} templatePkg
 * @param {Record<string, string>} versions
 */
export function mergePackageJson(templatePkg, versions) {
  // Deps from the old root-manifest that are injected into every flat project
  const rootDeps = {
    '@nymbal/cli': `^${versions['@nymbal/cli']}`,
    '@nymbal/config': `^${versions['@nymbal/config']}`,
    '@nymbal/platform': `^${versions['@nymbal/platform']}`,
  }

  const templateDeps = rewriteWorkspaceVersions(
    /** @type {Record<string, string>} */ (templatePkg.dependencies),
    versions,
  )
  const templateDevDeps = rewriteWorkspaceVersions(
    /** @type {Record<string, string>} */ (templatePkg.devDependencies),
    versions,
  )

  // Template wins on overlap (e.g. @nymbal/types present in both root and template)
  const dependencies = { ...rootDeps, ...templateDeps }

  return {
    name: templatePkg.name,
    version: templatePkg.version,
    private: true,
    description: 'A Nymbal commerce project',
    license: templatePkg.license,
    type: templatePkg.type,
    engines: templatePkg.engines,
    scripts: {
      ...(/** @type {Record<string, string>} */ (templatePkg.scripts)),
      migrate: 'nymbal migrate',
      seed: 'nymbal seed',
    },
    dependencies,
    ...(templateDevDeps ? { devDependencies: templateDevDeps } : {}),
  }
}

/**
 * Syncs templates/* into the scaffold destination root.
 * NOTE: this only ever removes/rewrites <destRoot>/<template-name>. The sibling
 * scaffold/project/ directory (project-layer overrides) lives OUTSIDE the
 * destination root and must never be touched by this sync.
 * @param {string} [destRoot] destination root (defaults to scaffold/templates)
 */
export async function main(destRoot = SCAFFOLD_TEMPLATES) {
  await mkdir(destRoot, { recursive: true })

  const versions = await readNymbalVersions()

  for (const t of templates) {
    const dest = resolve(destRoot, t.name)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    await cp(t.from, dest, {
      recursive: true,
      filter: shouldCopyScaffoldEntry,
    })

    const pkgPath = resolve(dest, 'package.json')
    const templatePkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const mergedPkg = mergePackageJson(templatePkg, versions)
    await writeFile(pkgPath, JSON.stringify(mergedPkg, null, 2) + '\n', 'utf8')

    // eslint-disable-next-line no-console
    console.log(`✓ synced ${dest}`)
  }
}

// Guard: only run when invoked directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
