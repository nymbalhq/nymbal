// Reads: scripts/changeset-needed.ts, .changeset/config.json
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
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

// AC-5: a test-only diff needs no changeset. `changeset status --since` fails any diff that changes a file under a
// package without a changeset, test files included. scripts/changeset-needed.ts exports
// `needsChangeset(changed, publishedPackageDirs)`: true when a file under a published package changed that is not a
// test path (*.test.*, *.spec.*, *.test-d.ts, or under tests/, test/, __tests__/, __fixtures__/, fixtures/,
// journeys/, sentinels/). `tsx scripts/changeset-needed.ts --base <ref>` exits 0 with
// `changeset: not needed (tests only)` when none is needed, and otherwise runs `changeset status --since=<ref>` and
// takes its verdict. The CLI runs in a scratch repository of its working directory, where `changeset` (through pnpm,
// npx or node_modules/.bin) is a stand-in that logs its call and exits FAKE_CHANGESET_EXIT.

afterEach(cleanupScratch)

type NeedsChangeset = (changed: string[], publishedPackageDirs: string[]) => boolean
const needsChangeset = async (): Promise<NeedsChangeset> =>
  ((await import('../../scripts/changeset-needed')) as { needsChangeset: NeedsChangeset })
    .needsChangeset

const PUBLISHED = ['packages/platform', 'packages/create-app', 'packages/sdk', 'apps/admin']

describe('AC-5: needsChangeset', () => {
  it('AC-5: a diff whose only package files are test paths needs no changeset', async () => {
    const needs = await needsChangeset()
    expect(
      needs(['packages/create-app/test/x.test.ts', 'packages/platform/src/y.test.ts'], PUBLISHED),
    ).toBe(false)
  })

  it.each([['packages/platform/src/z.ts'], ['packages/platform/package.json']])(
    'AC-5: %s needs a changeset, beside test paths',
    async (path) => {
      const needs = await needsChangeset()
      expect(needs([path], PUBLISHED)).toBe(true)
      expect(needs(['packages/create-app/test/x.test.ts', path], PUBLISHED)).toBe(true)
    },
  )

  it('AC-5: a diff outside packages needs none', async () => {
    const needs = await needsChangeset()
    expect(
      needs(
        ['scripts/gate.ts', '.github/workflows/ci.yml', 'tests/tooling/x.test.ts', 'README.md'],
        PUBLISHED,
      ),
    ).toBe(false)
  })

  it('AC-5: property: a changeset is needed exactly when a non-test file under a published package changed', async () => {
    const needs = await needsChangeset()
    const tests = [
      'packages/create-app/test/x.test.ts',
      'packages/platform/src/y.test.ts',
      'packages/platform/tests/integration/order-flow.test.ts',
      'packages/sdk/src/__tests__/client.ts',
      'packages/sdk/src/client.spec.tsx',
      'packages/platform/src/money.test-d.ts',
      'packages/platform/tests/fixtures/catalog.json',
      'apps/admin/src/pages/orders.test.tsx',
    ]
    const outside = [
      'scripts/gate.ts',
      '.github/workflows/ci.yml',
      'docs/notes.md',
      'tests/e2e/journeys/cart.spec.ts',
      'templates/astro/src/pages/index.astro',
      'packages/test-factories/src/product.ts',
      'packages/proof-kit/src/run.ts',
    ]
    const sources = [
      'packages/platform/src/z.ts',
      'packages/platform/package.json',
      'packages/create-app/src/index.ts',
      'packages/sdk/tsup.config.ts',
      'apps/admin/src/main.tsx',
    ]
    fc.assert(
      fc.property(
        fc.subarray(tests),
        fc.subarray(outside),
        fc.subarray(sources),
        fc.boolean(),
        (t, o, s, reverse) => {
          const changed = [...t, ...o, ...s]
          if (reverse) changed.reverse()
          expect(needs(changed, PUBLISHED), changed.join(' ')).toBe(s.length > 0)
        },
      ),
      { numRuns: 300 },
    )
  })
})

// A stand-in for `changeset` behind pnpm, npx and node_modules/.bin; any other pnpm call goes to the real pnpm.
const REAL_PNPM = execFileSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).trim()
const CHANGESET_STAND_IN = `#!/usr/bin/env bash
if [ "$NAME" = changeset ] || [[ " $* " == *" changeset "* ]]; then
  echo "$NAME $*" >>"$SCRATCH/calls.log"
  exit "\${FAKE_CHANGESET_EXIT:-0}"
fi
if [ "$NAME" = pnpm ]; then exec '${REAL_PNPM}' "$@"; fi
echo "stand-in $NAME: unexpected call: $*" >&2
exit 127
`

function standIn(path: string, name: string): void {
  writeFileSync(
    path,
    CHANGESET_STAND_IN.replace('#!/usr/bin/env bash\n', `#!/usr/bin/env bash\nNAME=${name}\n`),
  )
  chmodSync(path, 0o755)
}

/** A workspace with two published packages and an unpublished one; the change is committed on top of `base`. */
function changesetRepo(change: Record<string, string>): { repo: Scratch; base: string } {
  const repo = scratchRepo({
    'package.json': JSON.stringify({ name: 'nymbal-scratch', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    '.changeset/config.json': readFileSync(join(REPO, '.changeset/config.json'), 'utf8'),
    'packages/platform/package.json': JSON.stringify({
      name: '@nymbalhq/platform',
      version: '0.1.0',
    }),
    'packages/platform/src/z.ts': 'export const z = 1\n',
    'packages/create-app/package.json': JSON.stringify({
      name: 'create-nymbal-app',
      version: '0.1.0',
    }),
    'packages/create-app/src/index.ts': 'export {}\n',
    'packages/proof-kit/package.json': JSON.stringify({
      name: '@nymbalhq/proof-kit',
      private: true,
    }),
  })
  standIn(join(repo.bin, 'pnpm'), 'pnpm')
  standIn(join(repo.bin, 'npx'), 'npx')
  standIn(join(repo.bin, 'changeset'), 'changeset')
  standIn(join(repo.root, 'node_modules/.bin/changeset'), 'changeset')
  const base = git(repo.root, 'rev-parse', 'HEAD')
  for (const [path, text] of Object.entries(change)) write(repo.root, path, text)
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'change')
  return { repo, base }
}

function changesetNeeded(
  repo: Scratch,
  base: string,
  fakeExit: number,
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
          FAKE_CHANGESET_EXIT: String(fakeExit),
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

const statusCalls = (repo: Scratch): string[] =>
  repo.calls().filter((c) => /\bchangeset status\b/.test(c))

describe('AC-5: scripts/changeset-needed.ts', () => {
  it('AC-5: a test-only diff exits 0 with "not needed (tests only)" and never asks changeset status', async () => {
    const { repo, base } = changesetRepo({
      'packages/create-app/test/x.test.ts': 'export {}\n',
      'packages/platform/src/y.test.ts': 'export {}\n',
    })
    const run = await changesetNeeded(repo, base, 1)
    expect(run.code, run.output).toBe(0)
    expect(run.output).toMatch(/changeset: not needed \(tests only\)/)
    expect(statusCalls(repo), run.output).toEqual([])
  })

  it('AC-5: a source change defers to `changeset status --since=<base>`: its exit is the verdict', async () => {
    const { repo, base } = changesetRepo({ 'packages/platform/src/z.ts': 'export const z = 2\n' })
    for (const fakeExit of [1, 0]) {
      const before = statusCalls(repo).length
      const run = await changesetNeeded(repo, base, fakeExit)
      const calls = statusCalls(repo).slice(before)
      expect(calls.length, run.output).toBe(1)
      expect(calls[0]).toMatch(new RegExp(`--since[= ]${base}\\b`))
      expect(run.code, run.output).toBe(fakeExit)
    }
  })

  it('AC-5: moving a source file into tests/ still defers to `changeset status`: the source path left the package', async () => {
    const { repo } = changesetRepo({ 'packages/platform/src/helpers.ts': 'export const h = 1\n' })
    const base = git(repo.root, 'rev-parse', 'HEAD')
    mkdirSync(join(repo.root, 'packages/platform/tests'))
    git(repo.root, 'mv', 'packages/platform/src/helpers.ts', 'packages/platform/tests/helpers.ts')
    git(repo.root, 'commit', '-q', '-m', 'move')
    const run = await changesetNeeded(repo, base, 1)
    expect(run.output).not.toMatch(/not needed/)
    expect(statusCalls(repo).length, run.output).toBe(1)
    expect(run.code, run.output).toBe(1)
  })
})
