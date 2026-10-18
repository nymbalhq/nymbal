import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

function hasIndex(dir: string): boolean {
  return existsSync(join(dir, 'index.html'))
}

/**
 * The admin dist to serve: `NYMBAL_ADMIN_DIST` when it holds `index.html` (read per call), else the installed
 * `@nymbalhq/admin` dist when built, else null.
 */
export function resolveAdminRoot(): string | null {
  const override = process.env['NYMBAL_ADMIN_DIST']
  if (override && hasIndex(override)) return override
  try {
    const manifest = createRequire(import.meta.url).resolve('@nymbalhq/admin/package.json')
    const dist = join(dirname(manifest), 'dist')
    return hasIndex(dist) ? dist : null
  } catch {
    return null
  }
}
