import { defineCommand } from 'citty'
import { loadConfig } from '@nymbal/config'
import { createCommandStore, runMigrations } from '@nymbal/platform'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

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
  try {
    const req = createRequire(resolve(projectRoot, 'package.json'))
    const pkgDir = resolve(req.resolve('@nymbal/platform/package.json'), '..')
    const pkgMigrations = resolve(pkgDir, 'migrations')
    if (existsSync(pkgMigrations)) return pkgMigrations
  } catch {
    // package not resolvable from this root
  }

  return local
}
