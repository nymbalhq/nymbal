import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
