import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The workspace members as pnpm sees them, read from the tracked files only (git-ignored smoke-test projects never
 * count).
 */

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The old scope, built so that this file never contains it literally (AC-1 scans every tracked file). */
export const OLD_SCOPE = ['@nymbal', '/'].join('')
export const NEW_SCOPE = '@nymbalhq/'

export interface Manifest {
  name?: string
  version?: string
  private?: boolean
  files?: unknown
  repository?: unknown
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

export interface WorkspaceMember {
  /** Directory relative to the repository root, posix separators; '' for the root. */
  dir: string
  manifest: Manifest
}

export function trackedFiles(cwd: string = REPO_ROOT): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.length > 0)
}

// The expander is scripts/workspace-packages.ts, the one every tool reads the workspace from; it is re-exported here for
// the tests that import it from this module.
export { workspaceGlobs, workspaceMembers } from '../../scripts/workspace-packages'

export function isPublished(m: Manifest): boolean {
  return m.private !== true
}
