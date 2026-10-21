import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import fixtureConfig from '../../../../tests/e2e/fixtures/custom-providers/nymbal.config.js'
import {
  categoryOf,
  cliEnv,
  CUSTOM_FIXTURE_DIR,
  doctorJson,
  doctorLines,
  expectedCheckNames,
  migratedSqlite,
  onDefaultStores,
  REPO_ROOT,
  runCli,
  TEXT_STATUS,
  type CliRun,
} from '../../../../tests/support/doctor.js'

// Acceptance test for P2-09 AC-4 (spec P2-09-dev-stage, decision 4; Fable spec B2): `nymbal doctor` on a healthy,
// migrated project exits 0, in two runs of the same spawn harness. Run 1 is the repository's config on SQLite; run 2
// is tests/e2e/fixtures/custom-providers, SQLite and migrated, whose search and payments are `custom` from its
// `adapters` export. Each prints one line per check (config, a package line per package-backed provider, command store,
// migrations, every commerce slot, the three primitives), all `ok` or `warn`, in decision 4's order; `--json` gives the
// same names and statuses. Run 2's `slot search` and `slot payments` lines are ok and name `custom`. Kills: a missing
// check, a wrong order or exit code, and a doctor that ignores the `adapters` export (`adapter.custom_mismatch`).
// Spawns the built CLI (`pnpm build` first), each run on a fresh migrated SQLite file of its own.

interface Project {
  label: string
  cwd: string
  config: NymbalConfig
}

const PROJECTS: Project[] = [
  { label: 'run 1: the repository config', cwd: REPO_ROOT, config: onDefaultStores(repoConfig) },
  {
    label: 'run 2: the custom-providers fixture',
    cwd: CUSTOM_FIXTURE_DIR,
    config: onDefaultStores(fixtureConfig),
  },
]

const runs = new Map<string, { text: CliRun; json: CliRun }>()
let dir = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-p2-09-doctor-'))
  for (const [i, project] of PROJECTS.entries()) {
    const sqlitePath = join(dir, `run-${i + 1}.db`)
    await migratedSqlite(sqlitePath)
    const env = cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath })
    const text = await runCli(['doctor'], { cwd: project.cwd, env })
    const json = await runCli(['doctor', '--json'], { cwd: project.cwd, env })
    runs.set(project.label, { text, json })
  }
}, 120_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe.each(PROJECTS)('P2-09 AC-4: nymbal doctor on a healthy project ($label)', (project) => {
  it('AC-4: exits 0 with one ok or warn line per check: config, every package-backed provider, command store, migrations, every commerce slot, the three primitives', () => {
    const { text } = runs.get(project.label)!
    const lines = doctorLines(text.out)

    expect(text.code, text.out.slice(-3000)).toBe(0)
    expect(lines.map((l) => l.name).sort()).toEqual(expectedCheckNames(project.config))
    expect(
      lines.filter((l) => l.status === 'down'),
      text.out,
    ).toEqual([])
  })

  it('AC-4: the checks come in order: config, packages, command store, migrations, slots, primitives', () => {
    const { text } = runs.get(project.label)!
    const order = doctorLines(text.out).map((l) => categoryOf(l.name))

    expect(order.length).toBeGreaterThan(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBe(0)
  })

  it('AC-4: --json exits 0 and gives the same names and statuses as the text, in the same order', () => {
    const { text, json } = runs.get(project.label)!
    expect(json.code, json.out.slice(-3000)).toBe(0)
    const { checks } = doctorJson(json.stdout)
    expect(checks.map((c) => ({ name: c.name, status: TEXT_STATUS[c.status] }))).toEqual(
      doctorLines(text.out).map((l) => ({ name: l.name, status: l.status })),
    )
  })
})

describe('P2-09 AC-4: doctor builds custom slots from the adapters export', () => {
  it('AC-4: run 2 reports `slot search` and `slot payments` ok, each naming the provider custom', () => {
    const { text } = runs.get(PROJECTS[1]!.label)!
    const lines = doctorLines(text.out)
    const custom = ['search', 'payments'].map((slot) =>
      lines.find((l) => l.name === `slot ${slot}`),
    )

    expect(custom.map((l) => l?.status)).toEqual(['ok', 'ok'])
    for (const line of custom) expect(line?.detail).toMatch(/\bcustom\b/)
  })
})
