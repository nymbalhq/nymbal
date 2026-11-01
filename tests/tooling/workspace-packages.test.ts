// Reads: scripts/workspace-packages.ts, scripts/gate.ts, scripts/changeset-needed.ts, scripts/scaffold-clean.sh
// Reads: .changeset/config.json
import { execFile, execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isBuildInput,
  isHarnessPath,
  packagesBuilt,
  selectTests,
  workspaceClosure,
} from '../../scripts/gate'
import {
  childEnv,
  cleanupScratch,
  git,
  REPO,
  type Scratch,
  scratchRepo,
  TSX,
  write,
} from './scratch-gate'

// AC-1, the fixture half: in a workspace whose globs are `packages/*` and `packages/adapters/*/*`, with a member at
// packages/adapters/email/x, every tool sees that member. workspacePackageDirs lists it (from tracked manifests only);
// isBuildInput takes its source and not its tests; workspaceClosure follows a dependency on it; packagesBuilt waits
// for its dist; changeset-needed defers a change to its src/ to `changeset status`; scaffold-clean.sh stamps its
// manifest and its exit trap restores exactly what it stamped.

afterEach(cleanupScratch)

const NESTED = 'packages/adapters/email/x'

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** The scratch workspace: a flat package depending on a nested one, and a private flat one. */
const WORKSPACE: Record<string, string> = {
  'package.json': json({ name: 'scratch-root', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "packages/adapters/*/*"\n  - "apps/*"\n',
  'packages/core/package.json': json({
    name: '@scratch/core',
    version: '1.4.0',
    scripts: { build: 'tsup' },
    dependencies: { '@scratch/x': 'workspace:*' },
  }),
  'packages/core/src/index.ts': 'export const core = 1\n',
  [`${NESTED}/package.json`]: json({
    name: '@scratch/x',
    version: '1.4.0',
    scripts: { build: 'tsup' },
  }),
  [`${NESTED}/src/a.ts`]: 'export const a = 1\n',
  'packages/kit/package.json': json({ name: '@scratch/kit', version: '1.4.0', private: true }),
}

type WorkspacePackageDirs = (root: string) => string[]
const workspacePackageDirs = async (): Promise<WorkspacePackageDirs> =>
  (
    (await import('../../scripts/workspace-packages')) as {
      workspacePackageDirs: WorkspacePackageDirs
    }
  ).workspacePackageDirs

describe('AC-1: the tools see a nested workspace member', () => {
  it('AC-1: workspacePackageDirs lists the nested member beside the flat ones, from tracked manifests only', async () => {
    const repo = scratchRepo(WORKSPACE)
    // On the disk but never staged: pnpm would see it, the tracked view must not.
    write(repo.root, 'packages/adapters/email/y/package.json', json({ name: '@scratch/y' }))
    const dirs = (await workspacePackageDirs())(repo.root)

    expect(dirs).toEqual([NESTED, 'packages/core', 'packages/kit'])
    git(repo.root, 'add', 'packages/adapters/email/y/package.json')
    expect((await workspacePackageDirs())(repo.root)).toEqual([
      NESTED,
      'packages/adapters/email/y',
      'packages/core',
      'packages/kit',
    ])
  })

  it("AC-1: isBuildInput is true for the nested member's source and manifest, false for its tests", () => {
    expect(isBuildInput(`${NESTED}/src/a.ts`)).toBe(true)
    expect(isBuildInput(`${NESTED}/src/a.test.ts`)).toBe(false)
    expect(isBuildInput(`${NESTED}/package.json`)).toBe(true)
  })

  it("AC-1: a change to the nested member's manifest or tsconfig runs the whole suite, as a flat member's does", () => {
    for (const file of ['package.json', 'tsconfig.json']) {
      const flat = `packages/core/${file}`
      const nested = `${NESTED}/${file}`

      expect(selectTests([nested]).mode, nested).toBe('all')
      expect(selectTests([nested]).mode, nested).toBe(selectTests([flat]).mode)
      expect(isHarnessPath(nested), nested).toBe(true)
      expect(isHarnessPath(nested), nested).toBe(isHarnessPath(flat))
    }
  })

  it('AC-1: property: under packages/adapters/<slot>/<provider>, isBuildInput holds for source and never for a test file', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/)
    const sub = fc
      .array(segment, { maxLength: 3 })
      .map((parts) => parts.map((p) => `${p}/`).join(''))
    fc.assert(
      fc.property(
        segment,
        segment,
        sub,
        segment,
        fc.constantFrom('test', 'spec'),
        (slot, provider, dir, name, kind) => {
          const pkg = `packages/adapters/${slot}/${provider}`
          expect(isBuildInput(`${pkg}/src/${dir}${name}.ts`)).toBe(true)
          expect(isBuildInput(`${pkg}/src/${dir}${name}.${kind}.ts`)).toBe(false)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: workspaceClosure of a flat package holds the nested member it depends on', () => {
    const repo = scratchRepo(WORKSPACE)
    const closure = workspaceClosure(repo.root, 'packages/core')

    expect(closure).toContain(NESTED)
    expect(closure).not.toContain('packages/kit')
    expect(workspaceClosure(repo.root, NESTED)).toEqual([NESTED])
  })

  it("AC-1: packagesBuilt is false until the nested member's dist exists", () => {
    const repo = scratchRepo(WORKSPACE)
    mkdirSync(join(repo.root, 'packages/core/dist'))
    const before = packagesBuilt(repo.root)
    mkdirSync(join(repo.root, NESTED, 'dist'))

    expect(before).toBe(false)
    expect(packagesBuilt(repo.root)).toBe(!before)
  })
})

// A stand-in for `changeset` behind pnpm and node_modules/.bin, as in changeset-needed.test.ts; any other pnpm call
// goes to the real pnpm.
const REAL_PNPM = execFileSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).trim()
const CHANGESET_STAND_IN = (name: string): string => `#!/usr/bin/env bash
NAME=${name}
if [ "$NAME" = changeset ] || [[ " $* " == *" changeset "* ]]; then
  echo "$NAME $*" >>"$SCRATCH/calls.log"
  exit "\${FAKE_CHANGESET_EXIT:-0}"
fi
if [ "$NAME" = pnpm ]; then exec '${REAL_PNPM}' "$@"; fi
echo "stand-in $NAME: unexpected call: $*" >&2
exit 127
`

function standIn(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function changesetNeeded(
  repo: Scratch,
  base: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    execFile(
      TSX,
      [join(REPO, 'scripts/changeset-needed.ts'), '--base', base],
      {
        cwd: repo.root,
        env: childEnv({
          PATH: `${repo.bin}:${process.env.PATH ?? ''}`,
          SCRATCH: repo.root,
          FAKE_CHANGESET_EXIT: '1',
        }),
        encoding: 'utf8',
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        done({ code, output: `${stdout}${stderr}` })
      },
    )
  })
}

describe('AC-1: changeset-needed sees a nested member', () => {
  it("AC-1: a commit that changes the nested member's src/ with no changeset exits non-zero, by `changeset status`", async () => {
    const repo = scratchRepo({
      ...WORKSPACE,
      '.changeset/config.json': readFileSync(join(REPO, '.changeset/config.json'), 'utf8'),
    })
    standIn(join(repo.bin, 'pnpm'), CHANGESET_STAND_IN('pnpm'))
    standIn(join(repo.bin, 'npx'), CHANGESET_STAND_IN('npx'))
    standIn(join(repo.bin, 'changeset'), CHANGESET_STAND_IN('changeset'))
    standIn(join(repo.root, 'node_modules/.bin/changeset'), CHANGESET_STAND_IN('changeset'))
    const base = git(repo.root, 'rev-parse', 'HEAD')
    write(repo.root, `${NESTED}/src/a.ts`, 'export const a = 2\n')
    git(repo.root, 'commit', '-q', '-am', 'change the nested source')
    const before = repo.calls().filter((c) => /\bchangeset status\b/.test(c)).length

    const run = await changesetNeeded(repo, base)
    const calls = repo.calls().filter((c) => /\bchangeset status\b/.test(c))

    expect(run.output).not.toMatch(/not needed/)
    expect(calls.length, run.output).toBe(before + 1)
    expect(run.code, run.output).not.toBe(0)
  })
})

// scaffold-clean.sh in a scratch copy of the checkout's scripts: a registry is given (no Docker), and `pnpm` is a
// stand-in that records which files the stamping left modified, then rewrites the lockfile for the stamped versions as
// the real one does, and fails the build, so the script stops before it publishes anything and its exit trap restores
// the backup.
const RECORDING_PNPM = `#!/usr/bin/env bash
git -c core.quotepath=false diff --name-only >>"$SCRATCH/stamped.log"
echo "  /stamped: {}" >>"$SCRATCH/pnpm-lock.yaml"
echo "stand-in pnpm: $*" >&2
exit 1
`

describe('AC-1: scaffold-clean.sh stamps and restores the nested member', () => {
  it('AC-1: it stamps every public manifest, the nested one included, and its exit trap restores exactly what it stamped and the lockfile pnpm rewrote', () => {
    const repo = scratchRepo({
      ...WORKSPACE,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'packages/stack/package.json': json({
        name: '@nymbalhq/stack',
        version: '1.4.0',
        dependencies: {},
      }),
      'packages/create-app/package.json': json({ name: 'create-nymbal-app', version: '1.4.0' }),
      'packages/create-app/scaffold/README.md': 'scaffold\n',
      'apps/admin/package.json': json({ name: '@nymbalhq/admin', version: '1.4.0' }),
    })
    // A copy, not the link: a script that finds the root from its own path must find this one.
    rmSync(join(repo.root, 'scripts'))
    cpSync(join(REPO, 'scripts'), join(repo.root, 'scripts'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    rmSync(join(repo.root, 'node_modules'), { recursive: true, force: true })
    execFileSync('ln', ['-s', join(REPO, 'node_modules'), join(repo.root, 'node_modules')])
    const bin = join(repo.root, '.stand-ins')
    standIn(join(bin, 'pnpm'), RECORDING_PNPM)
    // The script puts Node's own directory first on PATH: the stand-in must not be shadowed there.
    expect(existsSync(join(dirname(process.execPath), 'pnpm'))).toBe(false)

    let code = 0
    try {
      execFileSync('bash', [join(repo.root, 'scripts/scaffold-clean.sh'), 'astro'], {
        cwd: repo.root,
        env: childEnv({
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SCRATCH: repo.root,
          NYMBAL_REGISTRY: 'http://127.0.0.1:9',
        }),
        stdio: 'pipe',
        timeout: 60_000,
      })
    } catch (error) {
      code = (error as { status?: number }).status ?? -1
    }
    const log = join(repo.root, 'stamped.log')
    const stamped = existsSync(log)
      ? [...new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean))].sort()
      : []
    const left = git(repo.root, 'status', '--porcelain', '--untracked-files=no')

    expect(code).toBe(1)
    expect(stamped).toEqual([
      'apps/admin/package.json',
      `${NESTED}/package.json`,
      'packages/core/package.json',
      'packages/create-app/package.json',
      'packages/stack/package.json',
    ])
    expect(left, 'left stamped after the exit trap').toBe('')
    expect(JSON.parse(readFileSync(join(repo.root, NESTED, 'package.json'), 'utf8')).version).toBe(
      JSON.parse(WORKSPACE[`${NESTED}/package.json`]!).version,
    )
  })
})
