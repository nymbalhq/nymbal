import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_PACKAGE_NAME = 'nymbal'

let cached: string | null = null

/**
 * Walks up from this module to the CLI's own package.json (found by name, so a nested or unrelated package.json
 * never answers). That is `dist/` in the workspace and in `node_modules/nymbal`, and `src/utils/` under Vitest.
 */
function readOwnVersion(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === CLI_PACKAGE_NAME) return pkg.version
    } catch {
      // No readable package.json in this directory: keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function getCliVersion(): string {
  cached ??= readOwnVersion() ?? '0.0.0'
  return cached
}
