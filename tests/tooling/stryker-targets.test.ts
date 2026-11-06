// Reads: stryker.config.mjs, vitest.stryker.config.ts
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mutateSet, strykerTargets } from '../../scripts/gate'
import {
  cleanupScratch,
  gateCli,
  GATE_PACKAGE_JSON,
  type Scratch,
  scratchRepo,
  TSX,
  write as writeIn,
} from './scratch-gate'

// Fix: Stryker re-measures every mutate file when its tests change. Stryker runs incremental, so a changed unit test
// invalidates the cached kills it made in every mutated file; a `--mutate` narrowed to the changed sources leaves the
// other files' mutants unmeasured, their scores fall in the report and the ratchet fails on files the change never
// touched (PR #24: order-history.ts 30.77 < 76.92). So whenever a Stryker input changed, the targets are the whole
// mutate set; a source change alone targets only that source. Called on this checkout, whose stryker.config.mjs
// defines the set.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE = 'packages/platform/src/services/checkout-service.ts'
const UNIT_TEST = 'packages/platform/src/services/checkout-service.test.ts'

async function wholeSet(): Promise<string[]> {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  return (await mutateSet(REPO, tracked)).sort()
}

describe('the mutate set', () => {
  it('holds only source: no unit test or type test file, which no mutant run can kill', async () => {
    const whole = await wholeSet()
    expect(whole).toContain(SOURCE)
    expect(whole.filter((path) => /\.test(?:-d)?\.ts$/.test(path))).toEqual([])
  })
})

describe('strykerTargets', () => {
  it('a source change plus a platform unit-test change targets the whole mutate set', async () => {
    const whole = await wholeSet()
    expect(whole.length).toBeGreaterThan(1)
    const targets = await strykerTargets(REPO, [SOURCE, UNIT_TEST])
    expect([...targets].sort()).toEqual(whole)
  })

  it('a source change plus a Stryker config change targets the whole mutate set', async () => {
    const targets = await strykerTargets(REPO, [SOURCE, 'vitest.stryker.config.ts'])
    expect([...targets].sort()).toEqual(await wholeSet())
  })

  it('a source change alone targets only that source', async () => {
    const targets = await strykerTargets(REPO, [SOURCE, 'README.md'])
    expect(targets).toEqual([SOURCE])
    expect(targets.length).toBeLessThan((await wholeSet()).length)
  })

  it('a unit-test change alone targets the whole mutate set', async () => {
    const targets = await strykerTargets(REPO, [UNIT_TEST])
    expect([...targets].sort()).toEqual(await wholeSet())
  })

  // vitest.stryker.config.ts runs the importer's mapper tests beside the platform's: a change that drops a mapper
  // test's assertion lowers a mapper's score with no mutated file changed.
  it.each(['packages/importers/tests/mappers/order.test.ts'])(
    'a change to %s alone, which the Stryker tests run, targets the whole mutate set',
    async (path) => {
      const targets = await strykerTargets(REPO, [path])
      expect([...targets].sort()).toEqual(await wholeSet())
    },
  )

  it('a file of every test glob vitest.stryker.config.ts includes targets the whole mutate set', async () => {
    const { default: config } = await import('../../vitest.stryker.config')
    const include = config.test?.include ?? []
    expect(include.length).toBeGreaterThan(1)
    const whole = await wholeSet()
    for (const glob of include) {
      const [first] = globSync(glob, { cwd: REPO }).sort()
      expect(first, glob).toBeDefined()
      expect([...(await strykerTargets(REPO, [first as string]))].sort(), glob).toEqual(whole)
    }
  })

  it('a change outside both the mutate set and the Stryker inputs targets nothing', async () => {
    expect(await strykerTargets(REPO, ['README.md', 'packages/sdk/src/index.ts'])).toEqual([])
  })
})

// A new service arrives untracked: `git ls-files` does not list it, so a whole set built from `ls-files` alone drops
// exactly the file the change adds. Built in a scratch git repo with the real stryker.config.mjs, so nothing is
// written into this checkout.
describe('strykerTargets with an untracked file', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('an untracked new source changed with a platform unit test stays in the whole mutate set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stryker-targets-'))
    scratch = root
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    copyFileSync(join(REPO, 'stryker.config.mjs'), join(root, 'stryker.config.mjs'))
    write('packages/platform/src/services/tracked-service.ts', 'export const tracked = 1\n')
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')

    const newSource = 'packages/platform/src/services/new-service.ts'
    const newTest = 'packages/platform/src/services/new-service.test.ts'
    write(newSource, 'export const added = 1\n')
    write(newTest, 'export {}\n')
    expect(git('ls-files', '--others', '--exclude-standard').split('\n')).toContain(newSource)

    const targets = await strykerTargets(root, [newSource, newTest])
    const tracked = git('ls-files').split('\n').filter(Boolean)
    const whole = (await mutateSet(root, [...tracked, newSource, newTest])).sort()
    expect(whole).toContain(newSource)
    expect([...targets].sort()).toEqual(whole)
  })
})

// Stryker's incremental mode reuses a mutant's result while the mutated code and the test files that killed or covered
// it are unchanged; it never reads the mapper tests' support or the recorded stores. So a change to those, selected
// alone, re-measures nothing: emptying a recorded store's products reused every cached mapper result. The gate CLI
// runs in a scratch repository whose `pnpm` stand-in copies the incremental report as Stryker would find it.
describe('the stryker step after a change to what the mapper tests read', () => {
  afterEach(cleanupScratch)

  const INCREMENTAL = 'reports/mutation/stryker-incremental.json'
  const AT_RUN = 'incremental-at-stryker-run.json'
  const SERVICE = 'packages/platform/src/services/a-service.ts'
  const MAPPER = 'packages/importers/src/woocommerce/mappers/product.ts'
  const STAND_IN = `#!/usr/bin/env bash
echo "pnpm $*" >>"$SCRATCH/calls.log"
if [ "$1" = exec ] && [ "$2" = tsx ]; then shift 2; exec '${TSX}' "$@"; fi
if [[ " $* " == *" stryker run "* ]]; then cp ${INCREMENTAL} "$SCRATCH/${AT_RUN}"; fi
exit 0
`
  const cached = (path: string, source: string) => ({
    language: 'typescript',
    source,
    mutants: [
      {
        id: `${path}#0`,
        mutatorName: 'BlockStatement',
        status: 'Killed',
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 20 } },
      },
    ],
  })
  const REPORT = {
    files: {
      [SERVICE]: cached(SERVICE, 'export const a = 1\n'),
      [MAPPER]: cached(MAPPER, 'export const p = 1\n'),
    },
  }

  function strykerRepo(): Scratch {
    const repo = scratchRepo({
      'package.json': GATE_PACKAGE_JSON,
      'stryker.config.mjs': [
        'export default {',
        "  mutate: ['packages/platform/src/services/**/*.ts', 'packages/importers/src/woocommerce/mappers/**/*.ts', '!**/*.test.ts'],",
        '  incremental: true,',
        `  incrementalFile: '${INCREMENTAL}',`,
        '}',
        '',
      ].join('\n'),
      [SERVICE]: 'export const a = 1\n',
      [MAPPER]: 'export const p = 1\n',
      'packages/importers/tests/mappers/support/wc.ts': 'export const store = 1\n',
      'packages/importers/tests/integration/support/wc-orders.ts': 'export const orders = 1\n',
      'packages/importers/tests/integration/fixtures/recorded/store-a-gbp/manifest.json': '{}\n',
      'packages/importers/tests/integration/fixtures/recorded/store-b-jpy/products.page-1.json':
        '[{"id":1}]\n',
      'packages/importers/tests/integration/fixtures/recorded/store-c-eur/products.page-1.json':
        '[{"id":1}]\n',
      'packages/platform/src/tests/publisher.ts': 'export const publisher = 1\n',
    })
    writeFileSync(join(repo.bin, 'pnpm'), STAND_IN)
    chmodSync(join(repo.bin, 'pnpm'), 0o755)
    writeIn(repo.root, INCREMENTAL, `${JSON.stringify(REPORT)}\n`)
    return repo
  }

  const ARGS = ['--full', '--only', 'stryker', '--no-build', '--base', 'HEAD', '--json']

  const mutateArgs = (repo: Scratch): string[][] =>
    repo
      .calls()
      .filter((c) => /\bstryker run\b/.test(c))
      .map((c) => {
        const m = /--mutate[= ]+(?:'([^']*)'|(\S+))/.exec(c)
        return (m?.[1] ?? m?.[2] ?? '').split(',').filter(Boolean).sort()
      })

  it.each([
    ['packages/importers/tests/mappers/support/wc.ts', 'export const store = 2\n'],
    ['packages/importers/tests/integration/support/wc-orders.ts', 'export const orders = 2\n'],
    [
      'packages/importers/tests/integration/fixtures/recorded/store-a-gbp/manifest.json',
      '{"a":1}\n',
    ],
    [
      'packages/importers/tests/integration/fixtures/recorded/store-b-jpy/products.page-1.json',
      '[]\n',
    ],
  ])(
    'a change to %s alone mutates the mappers, and Stryker finds the report without their cached mutants',
    async (path, text) => {
      const repo = strykerRepo()
      writeIn(repo.root, path, text)
      const run = await gateCli(repo, ARGS)
      const atRun = join(repo.root, AT_RUN)
      expect(existsSync(atRun), run.output).toBe(true)
      const report = JSON.parse(readFileSync(atRun, 'utf8')) as typeof REPORT
      expect(report.files[MAPPER]?.mutants ?? [], 'cached mapper mutants').toEqual([])
      expect(report.files[SERVICE]).toEqual(REPORT.files[SERVICE])
      expect(mutateArgs(repo), run.output).toEqual([[MAPPER]])
    },
  )

  // store-c-eur is read by no mapper test; the platform's test helpers are left to the nightly's forced run.
  it.each([
    'packages/importers/tests/integration/fixtures/recorded/store-c-eur/products.page-1.json',
    'packages/platform/src/tests/publisher.ts',
  ])(
    'a change to %s alone, which no Stryker run measures, leaves the step skipped',
    async (path) => {
      const repo = strykerRepo()
      writeIn(repo.root, path, 'export const changed = 2\n')
      const run = await gateCli(repo, ARGS)
      expect(run.steps.find((s) => s.name === 'stryker')?.status, run.output).toBe('skipped')
      expect(mutateArgs(repo), run.output).toEqual([])
    },
  )
})
