import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO } from './scratch-gate'
import { parseYaml } from './workflow-yaml'

// AC-3: the mutation job's incremental cache survives a ratchet change. With `hashFiles('mutation-ratchet.json')` in
// the key, any ratchet change would miss the cache and, with a changed platform test selecting the whole mutate set,
// measure every file cold (25-32 min). The changed entries are re-measured by the gate instead (AC-2), so the key
// carries no ratchet hash, and the restore key still finds the previous run's report.

type Step = { uses?: string; with?: Record<string, string> }
const INCREMENTAL = 'reports/mutation/stryker-incremental.json'

function cacheStep(): { key: string; restoreKeys: string[] } {
  const wf = parseYaml(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs?: Record<string, { steps?: Step[] }>
  }
  const steps = (wf.jobs?.mutation?.steps ?? []).filter(
    (s) => /^actions\/cache@/.test(s.uses ?? '') && (s.with?.path ?? '').includes(INCREMENTAL),
  )
  expect(steps.length, `one cache step for ${INCREMENTAL} in the mutation job`).toBe(1)
  const w = steps[0]?.with ?? {}
  return {
    key: w.key ?? '',
    restoreKeys: (w['restore-keys'] ?? '')
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean),
  }
}

describe('AC-3: the mutation cache key carries no ratchet hash', () => {
  it('AC-3: neither the key nor a restore key hashes mutation-ratchet.json, and the key still extends a restore key', () => {
    const { key, restoreKeys } = cacheStep()
    expect(restoreKeys.length).toBeGreaterThan(0)
    for (const k of [key, ...restoreKeys]) expect(k).not.toMatch(/mutation-ratchet\.json/)
    // A run restores the previous run's report: some restore key is a strict prefix of the key.
    const prefixes = restoreKeys.filter((r) => key.startsWith(r) && key.length > r.length)
    expect(prefixes.length).toBeGreaterThan(0)
  })
})
