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
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'

// AC-4: `nymbal doctor` on a healthy, migrated project exits 0 with one `ok` or `warn` line per check in a fixed
// order, on the repository's config and on tests/e2e/fixtures/custom-providers (`custom` search and payments, shipping
// EasyPost with its webhook secret, email Mailgun relaying to NYMBAL_E2E_SMTP_PORT, here a fake SMTP server so the
// store is healthy without Mailpit).
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
let smtp: FakeSmtpServer | undefined

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-'))
  smtp = await fakeSmtpServer()
  for (const [i, project] of PROJECTS.entries()) {
    const sqlitePath = join(dir, `run-${i + 1}.db`)
    await migratedSqlite(sqlitePath)
    const env = cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath, NYMBAL_E2E_SMTP_PORT: String(smtp.port) })
    const text = await runCli(['doctor'], { cwd: project.cwd, env })
    const json = await runCli(['doctor', '--json'], { cwd: project.cwd, env })
    runs.set(project.label, { text, json })
  }
}, 120_000)

afterAll(async () => {
  await smtp?.close()
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe.each(PROJECTS)('AC-4: nymbal doctor on a healthy project ($label)', (project) => {
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

describe('AC-4: doctor builds custom slots from the adapters export', () => {
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
