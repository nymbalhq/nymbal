import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The installed `@nymbalhq/admin` dist directory when it holds `index.html`; null when it is missing or unbuilt. */
export function resolveAdminRoot(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve('@nymbalhq/admin/package.json')
    const dist = join(dirname(manifest), 'dist')
    return existsSync(join(dist, 'index.html')) ? dist : null
  } catch {
    return null
  }
}
