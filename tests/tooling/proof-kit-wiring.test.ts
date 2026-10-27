// Reads: compose.yaml, package.json, vitest.config.ts, packages/proof-kit/tests/**
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { POSTGRES_URL, plan } from '../../scripts/gate'

// AC-18 (gate and pnpm test; the CI half is in ci-workflow.test.ts): `gate:full` runs the proof-kit-services project
// after `compose up` with both service URLs set, and `pnpm test` runs the proof-kit project and leaves
// proof-kit-services out.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const KIT_TESTS = join(REPO, 'packages/proof-kit/tests')
const SERVICES = 'proof-kit-services'

/** Whether a shell command runs the given Vitest project (`--project x`, `--project=x`, quoted or not). */
function runsProject(command: string, project: string): boolean {
  return new RegExp(`\\bvitest\\b[^;&|\\n]*--project(?:=|\\s+)['"]?${project}['"]?(?:\\s|$)`).test(
    command,
  )
}

/** `NAME=value` assignments that prefix a command. */
function assignments(command: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of command.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=('[^']*'|"[^"]*"|\S+)/g)) {
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** The host port compose.yaml publishes for a container port of the mailpit service (its default). */
function composeMailpitPort(containerPort: number): string {
  const compose = readFileSync(join(REPO, 'compose.yaml'), 'utf8')
  const block = compose.slice(compose.indexOf('\n  mailpit:'))
  const m = new RegExp(`\\$\\{NYMBAL_MAILPIT_\\w+:-(\\d+)\\}:${containerPort}\\b`).exec(block)
  if (m === null)
    throw new Error(`compose.yaml: no mailpit mapping for container port ${containerPort}`)
  return m[1]!
}

function envWithoutVitest(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITEST') || key.startsWith('NYMBAL_TEST_')) continue
    env[key] = value
  }
  return env
}

/** The test files `vitest list` selects for these arguments, repo-relative. */
function listed(args: string[]): {
  status: number | null
  files: Array<{ file: string; project: string }>
  out: string
} {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: envWithoutVitest(),
    timeout: 50_000,
  })
  const out = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) return { status: result.status, files: [], out }
  const start = result.stdout.indexOf('[')
  const rows = JSON.parse(result.stdout.slice(start)) as Array<{
    file: string
    projectName?: string
  }>
  return {
    status: result.status,
    files: rows.map((r) => ({ file: r.file.replace(REPO, ''), project: r.projectName ?? '' })),
    out,
  }
}

/** Test files on disk under a directory, repo-relative; `recursive` false keeps only its own level. */
function testFilesOnDisk(dir: string, recursive: boolean): string[] {
  const out: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (recursive) out.push(...testFilesOnDisk(full, true))
    } else if (entry.endsWith('.test.ts')) out.push(full.replace(REPO, ''))
  }
  return out.sort()
}

/** Shell words, honouring single and double quotes. */
function words(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

describe('AC-18: gate:full runs proof-kit-services after compose up, with both URLs', () => {
  it('AC-18: the gate:full plan has a step running proof-kit-services that needs and follows compose up, with the Postgres and Mailpit URLs compose serves', () => {
    const { steps } = plan({
      full: true,
      base: 'HEAD',
      changed: [],
      mutated: [],
      services: 'compose',
    })
    const names = steps.map((s) => s.name)
    const kit = steps.filter((s) => runsProject(s.command, SERVICES))
    expect(kit.map((s) => s.name)).toHaveLength(1)

    const step = kit[0]!
    expect(names.indexOf(step.name)).toBeGreaterThan(names.indexOf('compose up'))
    expect(step.needs ?? []).toContain('compose up')
    expect(step.skip).toBeUndefined()

    const env = assignments(step.command)
    const postgresStep = steps.find((s) => runsProject(s.command, 'integration-postgres'))
    expect(env.NYMBAL_TEST_POSTGRES_URL).toBe(
      assignments(postgresStep?.command ?? '').NYMBAL_TEST_POSTGRES_URL ?? POSTGRES_URL,
    )
    expect(new URL(env.NYMBAL_TEST_MAILPIT_URL ?? 'missing:').port).toBe(composeMailpitPort(8025))
    expect(new URL(`smtp://${env.NYMBAL_TEST_MAILPIT_SMTP ?? 'localhost:11025'}`).port).toBe(
      composeMailpitPort(1025),
    )
  })

  it('AC-18: the plain gate plan does not run proof-kit-services (it needs services the plain gate does not start)', () => {
    const quick = plan({ full: false, base: 'HEAD', changed: [], mutated: [] })
    const full = plan({ full: true, base: 'HEAD', changed: [], mutated: [], services: 'compose' })
    const count = (steps: Array<{ command: string }>): number =>
      steps.filter((s) => runsProject(s.command, SERVICES)).length
    expect(count(quick.steps)).toBeLessThan(count(full.steps))
    expect(count(quick.steps)).toBe(0)
  })
})

describe('AC-18: pnpm test runs proof-kit and excludes proof-kit-services', () => {
  it('AC-18: the files `pnpm test` selects hold every packages/proof-kit/tests/*.test.ts and none under tests/services', () => {
    const script = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts.test!
    const argv = words(script)
    expect(argv.slice(0, 2)).toEqual(['vitest', 'run'])

    const all = listed([])
    expect(all.status, all.out).toBe(0)
    const inProject = (project: string): string[] =>
      all.files
        .filter((f) => f.project === project)
        .map((f) => f.file)
        .sort()
    const topLevel = testFilesOnDisk(KIT_TESTS, false)
    const services = testFilesOnDisk(join(KIT_TESTS, 'services'), true)
    expect(topLevel.length).toBeGreaterThan(0)
    expect(services.length).toBeGreaterThan(0)
    expect(inProject('proof-kit')).toEqual(topLevel)
    expect(inProject(SERVICES)).toEqual(services)

    const selected = listed(argv.slice(2))
    expect(selected.status, selected.out).toBe(0)
    const files = new Set(selected.files.map((f) => f.file))
    expect(topLevel.filter((f) => !files.has(f))).toEqual([])
    expect(services.filter((f) => files.has(f))).toEqual([])
  }, 60_000)
})
