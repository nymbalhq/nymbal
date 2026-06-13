import { defineCommand } from 'citty'
import { loadConfig } from '@nymbal/config'
import { createCommandStore, runMigrations } from '@nymbal/platform'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

export const migrateCommand = defineCommand({
  meta: { name: 'migrate', description: 'Run database migrations (Drizzle)' },
  async run() {
    const { config, projectRoot } = await loadConfig()
    const store = createCommandStore(config)
    try {
      const migrationsRoot = resolveMigrations(projectRoot)
      await runMigrations(store, { migrationsRoot })
      // eslint-disable-next-line no-console
      console.log(`✓ migrations applied (${store.kind})`)
    } finally {
      await store.close()
    }
  },
})

export function resolveMigrations(projectRoot: string): string {
  // 1. Project-local override (scaffolded projects or custom migrations)
  const local = resolve(projectRoot, 'migrations')
  if (existsSync(local)) return local

  // 2. Monorepo workspace: packages/platform/migrations (for CI and fresh clones)
  const monorepoDev = resolve(projectRoot, 'packages/platform/migrations')
  if (existsSync(monorepoDev)) return monorepoDev

  // 3. Published package: node_modules/@nymbal/platform/migrations
  //
  // We must NOT use `require.resolve('@nymbal/platform/package.json')` nor
  // `require.resolve('@nymbal/platform')`: the package's `exports` map is
  // ESM-only and does not expose `./package.json`, so CJS resolution throws
  // (ERR_PACKAGE_PATH_NOT_EXPORTED / "No exports main defined"). Instead we
  // locate the installed package directory directly under node_modules, which
  // is independent of the exports map and works for symlinked (pnpm workspace)
  // and flat installs alike.
  const pkgDir = resolvePackageDir(projectRoot, '@nymbal/platform')
  if (pkgDir) {
    const pkgMigrations = resolve(pkgDir, 'migrations')
    if (existsSync(pkgMigrations)) return pkgMigrations
  }

  return local
}

/**
 * Resolve the on-disk root directory of an installed package from `fromRoot`,
 * by walking up the directory tree looking for `node_modules/<pkgName>`. This
 * does not depend on the package's `exports` map (which may be ESM-only and not
 * expose `./package.json`), and resolves correctly for pnpm symlinked workspace
 * installs as well as flat node_modules. Returns null when not found.
 */
export function resolvePackageDir(fromRoot: string, pkgName: string): string | null {
  let dir = resolve(fromRoot)
  for (let i = 0; i < 24; i++) {
    const candidate = resolve(dir, 'node_modules', pkgName)
    if (existsSync(resolve(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
