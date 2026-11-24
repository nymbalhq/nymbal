// Reads: renovate/store.json, renovate/auto-updates.json, .changeset/config.json, packages/cli/package.json
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUTO_UPDATES_PRESET, STORE_PRESET } from '../../packages/cli/src/update-check/decide'

// The two Renovate presets a store's renovate.json extends, read as Renovate reads them: JSON at the path the preset
// name points to in this repository. The store preset never merges anything itself; the auto-updates preset merges
// only vulnerability pull requests, a day after release, all in one group.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const readJson = (rel: string): Json => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Json
const asObject = (value: Json | undefined): { [key: string]: Json } =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}

/** `github>owner/repo//path` as the repository and the file Renovate reads. */
function presetTarget(preset: string): { repo: string; file: string } | null {
  const m = /^github>([^/]+\/[^/]+)\/\/(.+)$/.exec(preset)
  return m === null ? null : { repo: m[1]!, file: `${m[2]}.json` }
}

/** The path of every `automerge: true`, at any depth. */
function automergePaths(value: Json, path: string[] = []): string[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => automergePaths(v, [...path, String(i)]))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, v]) =>
    key === 'automerge' && v === true ? [[...path, key]] : automergePaths(v, [...path, key]),
  )
}

const PUBLISHED_FROM = (() => {
  const { repository } = readJson('packages/cli/package.json') as { repository: { url: string } }
  return /github\.com\/(.+?)(?:\.git)?$/.exec(repository.url)![1]!
})()

describe('AC-13: the Renovate presets', () => {
  it('AC-13: each preset name points at a JSON file in this repository, the one the packages publish from', () => {
    const targets = [STORE_PRESET, AUTO_UPDATES_PRESET].map(presetTarget)

    expect(targets).toEqual([
      { repo: PUBLISHED_FROM, file: 'renovate/store.json' },
      { repo: PUBLISHED_FROM, file: 'renovate/auto-updates.json' },
    ])
    expect(targets.map((t) => existsSync(join(ROOT, t?.file ?? 'missing')))).toEqual([true, true])
    expect(targets.map((t) => typeof readJson(t!.file))).toEqual(['object', 'object'])
  })

  it('AC-13: the store preset enables automerge nowhere, keeps native auto-merge off, reads OSV alerts and puts every vulnerability fix in one "Nymbal security" pull request', () => {
    const store = readJson('renovate/store.json')
    const top = asObject(store)

    expect(automergePaths(store)).toEqual([])
    expect(top['platformAutomerge']).toBe(false)
    expect(top['osvVulnerabilityAlerts']).toBe(true)
    expect(asObject(top['vulnerabilityAlerts'])['groupName']).toBe('Nymbal security')
  })

  it("AC-13: the store preset groups exactly the changeset fixed group's names into one Nymbal pull request", () => {
    const fixed = (readJson('.changeset/config.json') as { fixed: string[][] }).fixed[0]!
    const rules = asObject(readJson('renovate/store.json'))['packageRules']
    const grouping = (Array.isArray(rules) ? rules : [])
      .map(asObject)
      .filter((rule) => rule['groupName'] === 'Nymbal')

    expect(grouping).toHaveLength(1)
    const names = grouping[0]!['matchPackageNames']
    expect(Array.isArray(names) ? [...names].map(String).sort() : names).toEqual([...fixed].sort())
  })

  it('AC-13: the auto-updates preset extends the store preset and automerges only vulnerability pull requests, in the same group, a day after release, never through native auto-merge', () => {
    const auto = readJson('renovate/auto-updates.json')
    const top = asObject(auto)
    const alerts = asObject(top['vulnerabilityAlerts'])
    const storeAlerts = asObject(asObject(readJson('renovate/store.json'))['vulnerabilityAlerts'])

    expect(top['extends']).toContain(STORE_PRESET)
    expect(automergePaths(auto)).toEqual([['vulnerabilityAlerts', 'automerge']])
    expect(alerts['groupName']).toBe(storeAlerts['groupName'])
    expect(alerts['groupName']).toBe('Nymbal security')
    expect(alerts['minimumReleaseAge']).toBe('1 day')
    expect(top['platformAutomerge']).toBe(false)
  })
})
