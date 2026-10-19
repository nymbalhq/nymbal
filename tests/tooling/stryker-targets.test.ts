import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mutateSet, strykerTargets } from '../../scripts/gate'

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
