// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adminBuildIsCurrent, adminInputsStamp, type Step } from '../../scripts/gate'
import {
  ARTEFACT,
  childEnv,
  cleanupScratch,
  GATE,
  GATE_PACKAGE_JSON,
  gateCli,
  git,
  scratchRepo,
  STRYKER_CONFIG,
  TSX,
  write,
} from './scratch-gate'

// The build stamp covers apps/admin/dist: `pnpm build` builds packages/** only, so an admin built before its source
// moved (an edit, a merge of dev) went on being served by a walk or a gate:full --no-build. The stamp records the
// admin's inputs when the admin is built (`build-stamp --admin`); `build-stamp --check` is red while they differ from
// the work tree's or no admin is built, and the plain gate rebuilds a stale admin. The real gate.ts runs in a scratch
// repository whose `pnpm` is a stand-in that logs each call (scratch-gate.ts).

afterEach(cleanupScratch)

const ADMIN_BUILD = 'pnpm --filter @nymbalhq/admin build'

function adminRepo(): ReturnType<typeof scratchRepo> {
  return scratchRepo({
    'package.json': GATE_PACKAGE_JSON,
    'stryker.config.mjs': STRYKER_CONFIG,
    ...ARTEFACT,
    'apps/admin/package.json': JSON.stringify({ name: '@nymbalhq/admin', scripts: {} }),
    'apps/admin/src/main.tsx': 'export const page = 1\n',
    'apps/admin/src/main.test.tsx': 'export {}\n',
  })
}

function stamp(root: string, ...args: string[]): { code: number | null; stdout: string } {
  const run = spawnSync(TSX, [GATE, 'build-stamp', ...args], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
  })
  return { code: run.status, stdout: run.stdout }
}

/** The build commands the stand-in pnpm saw. */
const builds = (repo: ReturnType<typeof scratchRepo>): string[] =>
  repo.calls().filter((call) => /\bbuild\b/.test(call))
const build = (steps: Step[]): Step | undefined => steps.find((s) => s.name === 'build')

describe('the build stamp covers the admin build', () => {
  it('an admin source edit makes the admin stale until it is built and stamped with --admin; a test edit or a package-only stamp does not', () => {
    const { root } = adminRepo()
    expect(adminBuildIsCurrent(root), 'built but never stamped').toBe(false)
    stamp(root, '--admin')
    expect(adminBuildIsCurrent(root), 'built and stamped').toBe(true)
    write(root, 'apps/admin/src/main.test.tsx', 'export const t = 1\n')
    expect(adminBuildIsCurrent(root), 'a test file is not an admin input').toBe(true)
    write(root, 'apps/admin/src/main.tsx', 'export const page = 2\n')
    expect(adminBuildIsCurrent(root), 'an admin source edit').toBe(false)
    stamp(root)
    expect(adminBuildIsCurrent(root), 'a package-only stamp keeps the admin entry').toBe(false)
    stamp(root, '--admin')
    expect(adminBuildIsCurrent(root)).toBe(true)
    git(root, 'commit', '-q', '-am', 'the admin bytes that were built')
    expect(adminBuildIsCurrent(root), 'committing those bytes keeps it current').toBe(true)
  }, 30_000)

  it('build-stamp --check is red naming the admin while its source differs from what was built, green once rebuilt and stamped', () => {
    const { root } = adminRepo()
    expect(stamp(root, '--admin').code).toBe(0)
    expect(stamp(root, '--check').code).toBe(0)
    write(root, 'apps/admin/src/main.tsx', 'export const page = 2\n')
    const stale = stamp(root, '--check')
    expect(stale.code, stale.stdout).toBe(1)
    expect(stale.stdout).toContain('apps/admin/dist')
    expect(stale.stdout).toContain('build-stamp --admin')
    expect(stale.stdout, 'the packages are not blamed').toMatch(/package build output matches HEAD/)
    stamp(root, '--admin')
    expect(stamp(root, '--check').code).toBe(0)
    rmSync(join(root, 'apps/admin/dist'), { recursive: true })
    expect(stamp(root, '--check').code, 'no admin build at all').toBe(1)
  }, 30_000)

  it('the plain gate builds a stale admin (and not the packages), stamps it, and the next gate builds nothing', async () => {
    const repo = adminRepo()
    stamp(repo.root, '--admin')
    write(repo.root, 'apps/admin/src/main.tsx', 'export const page = 2\n')
    const args = ['--base', 'HEAD', '--json']

    const first = await gateCli(repo, args)
    expect(build(first.steps)?.status, first.output).toBe('ok')
    expect(builds(repo), first.output).toEqual([ADMIN_BUILD])
    const stamped = JSON.parse(
      readFileSync(join(repo.root, 'reports/build-stamp.json'), 'utf8'),
    ) as { admin?: string }
    expect(stamped.admin, 'the build step stamped the admin it built').toBe(
      adminInputsStamp(repo.root),
    )

    const second = await gateCli(repo, args)
    expect(build(second.steps)?.status, second.output).toBe('skipped')
    expect(builds(repo), 'no second build').toEqual([ADMIN_BUILD])
  }, 60_000)
})
