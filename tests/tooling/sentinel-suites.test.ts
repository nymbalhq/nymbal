// Reads: tests/sentinels/*.patch
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SUITE, loadSentinels, type Sentinel } from '../../scripts/sentinels'
import { words } from './vitest-filters'

// A sentinel with no `# suite:` runs DEFAULT_SUITE, every Vitest project, which made the sentinels job the push's
// critical path. Each one names the test files that kill it, so its run is a few files, not the whole suite.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** The test files a sentinel's suite runs that exist in the repo and that its `# killed-by:` names. */
function killersRun(sentinel: Sentinel): string[] {
  const killers = (sentinel.killedBy.match(/\S+\.(?:test|spec)\.[cm]?[jt]sx?/g) ?? []).map((k) =>
    k.replace(/[;,]$/, ''),
  )
  return words(sentinel.suite ?? DEFAULT_SUITE)
    .filter((w) => TEST_FILE.test(w) && existsSync(join(REPO, w)))
    .filter((w) => killers.some((k) => (k.includes('/') ? w === k : basename(w) === k)))
}

describe('AC-1: every sentinel names its suite', () => {
  it('AC-1: every sentinel in tests/sentinels runs a suite naming at least one existing test file its killed-by names', () => {
    const sentinels = loadSentinels(join(REPO, 'tests/sentinels'))
    expect(sentinels.length, 'sentinels in tests/sentinels').toBeGreaterThanOrEqual(19)
    const narrowed = sentinels.filter((s) => killersRun(s).length > 0)
    expect(narrowed.map((s) => s.id)).toEqual(sentinels.map((s) => s.id))
  })
})
