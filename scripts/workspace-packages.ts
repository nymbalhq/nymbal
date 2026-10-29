// The workspace members, read from pnpm-workspace.yaml's globs and the tracked package.json files, so every tool sees
// a member at any depth. Tracked files win over the disk: a package nobody has staged is no member here, and the
// workspace census compares this view with `pnpm -r list` to make that red. Plain Node runs it (no pnpm, no tsx):
// `node scripts/workspace-packages.ts --manifests` prints each member's package.json, one per line.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

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

function trackedFiles(cwd: string): string[] {
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

/** The members' directories relative to `root`, sorted, without the root. */
export function workspacePackageDirs(root: string = REPO_ROOT): string[] {
  return workspaceMembers(root)
    .map((m) => m.dir)
    .filter((dir) => dir !== '')
}

const main = process.argv[1]
if (
  main !== undefined &&
  existsSync(main) &&
  realpathSync(main) === realpathSync(fileURLToPath(import.meta.url))
) {
  if (process.argv.slice(2).join(' ') !== '--manifests') {
    process.stderr.write('usage: node scripts/workspace-packages.ts --manifests\n')
    process.exit(2)
  }
  for (const dir of workspacePackageDirs()) process.stdout.write(`${dir}/package.json\n`)
}
