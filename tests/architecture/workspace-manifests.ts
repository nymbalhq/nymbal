import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
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

/** The `packages:` globs of pnpm-workspace.yaml (single-segment `*` and `**` only, which is all pnpm uses here). */
export function workspaceGlobs(root: string = REPO_ROOT): string[] {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs: string[] = []
  let inPackages = false
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/#.*$/, '')
    if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line)
    if (!inPackages) continue
    const m = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)
    if (m?.[1]) globs.push(m[1])
  }
  return globs
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('/')
    .map((seg) =>
      seg === '**'
        ? '.*'
        : seg
            .split('*')
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]+'),
    )
    .join('/')
  return new RegExp(`^${body}$`)
}

/** Every workspace member (the root first), from tracked `package.json` files matching the workspace globs. */
export function workspaceMembers(root: string = REPO_ROOT): WorkspaceMember[] {
  const globs = workspaceGlobs(root)
  const include = globs.filter((g) => !g.startsWith('!')).map(globToRegExp)
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
  const dirs = trackedFiles(root)
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .map((f) => posix.dirname(f))
    .map((d) => (d === '.' ? '' : d))
    .filter((d) => d === '' || (include.some((r) => r.test(d)) && !exclude.some((r) => r.test(d))))
    .sort()
  return dirs.map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as Manifest,
  }))
}

export function isPublished(m: Manifest): boolean {
  return m.private !== true
}
