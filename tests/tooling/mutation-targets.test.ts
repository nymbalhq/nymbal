// Reads: scripts/mutation-ratchet.ts, mutation-targets.json, stryker.config.mjs, stryker.integration.config.mjs
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { shortfalls } from '../../scripts/mutation-ratchet'
import type { Scores, Targets } from '../../scripts/mutation-ratchet'

// The mutation floors: every service, repository and mapper of either mutate set at or above its group's floor, scored
// the higher of its unit and integration entries. The CLI runs from this checkout's scripts in scratch git
// repositories holding a copy of the unit Stryker config, or fixture configs of both, so nothing here writes the
// checkout's own files.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/mutation-ratchet.ts')

const exec = promisify(execFile)

async function target(cwd: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(TSX, [SCRIPT, 'target'], { cwd, encoding: 'utf8' })
    return { code: 0, output: `${stdout}\n${stderr}`.trim() }
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim(),
    }
  }
}

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SERVICE = 'packages/platform/src/services/a-service.ts'
const SERVICE_AT_FLOOR = 'packages/platform/src/services/b-service.ts'
const INTEGRATION_ONLY = 'packages/platform/src/services/c-service.ts'
const UNMEASURED = 'packages/platform/src/repositories/d.ts'
const EXCEPTED = 'packages/platform/src/repositories/page.ts'
const MAPPER = 'packages/importers/src/woocommerce/mappers/money.ts'
const OUTSIDE = 'packages/platform/src/events/relay.ts'
const FILES = [SERVICE, SERVICE_AT_FLOOR, INTEGRATION_ONLY, UNMEASURED, EXCEPTED, MAPPER, OUTSIDE]

const TARGETS: Targets = {
  groups: [
    { name: 'services', glob: 'packages/platform/src/services/**/*.ts', floor: 60 },
    { name: 'repositories', glob: 'packages/platform/src/repositories/**/*.ts', floor: 50 },
    { name: 'promotions', glob: 'packages/platform/src/adapters/promotions/**/*.ts', floor: 60 },
    { name: 'mappers', glob: 'packages/importers/src/woocommerce/mappers/**/*.ts', floor: 80 },
    { name: 'assistant', glob: 'packages/platform/src/assistant/**/*.ts', floor: 75 },
    { name: 'assistant-tools', glob: 'packages/platform/src/mcp/**/*.ts', floor: 65 },
  ],
  exceptions: { [EXCEPTED]: 'an interface' },
}

const ratchet = (files: Scores): string =>
  `${JSON.stringify({ measuredAt: '2026-11-01T00:00:00.000Z', command: 'fixture', total: 50, files }, null, 2)}\n`

/** A git repository with the Stryker configs (the unit one copied by default), the fixture sources, both ratchets and a targets file. */
function scratch(
  unit: Scores,
  integration: Scores,
  targets: Targets,
  configs: Record<string, string> = {
    'stryker.config.mjs': readFileSync(join(REPO, 'stryker.config.mjs'), 'utf8'),
  },
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-targets-')))
  created.push(dir)
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  for (const [path, text] of Object.entries(configs)) write(path, text)
  FILES.forEach((path, i) => write(path, `export const n${i} = ${i}\n`))
  write('mutation-ratchet.json', ratchet(unit))
  write('mutation-ratchet.integration.json', ratchet(integration))
  write('mutation-targets.json', JSON.stringify(targets))
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=f', '-c', 'user.email=f@x', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, stdio: 'ignore' },
    )
  }
  git('init', '--quiet')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
  return dir
}

const belowLines = (output: string): string[] =>
  output
    .split('\n')
    .filter((l) => l.startsWith('below target: '))
    .map((l) => l.split(' ')[2]!)
    .sort()

describe('AC-1: mutation:ratchet target against fixture ratchets and floors', () => {
  it('AC-1: exits 1 naming the file a hundredth under its floor, the integration-measured file on neither its unit 0, the unmeasured file at 0 and a stale exception; and 0 once each is lifted', async () => {
    const unit: Scores = {
      [SERVICE]: 59.99,
      [SERVICE_AT_FLOOR]: 60,
      [INTEGRATION_ONLY]: 0,
      [EXCEPTED]: 0,
      [MAPPER]: 80,
      [OUTSIDE]: 0,
    }
    const integration: Scores = { [INTEGRATION_ONLY]: 61.5 }
    const stale = 'packages/platform/src/services/gone.ts'
    const red = await target(
      scratch(unit, integration, {
        ...TARGETS,
        exceptions: { ...TARGETS.exceptions, [stale]: 'gone' },
      }),
    )
    expect(red.code, red.output).toBe(1)
    expect(belowLines(red.output), red.output).toEqual([SERVICE, UNMEASURED].sort())
    expect(red.output).toContain(`below target: ${SERVICE} 59.99 < 60 (services)`)
    expect(red.output).toContain(`below target: ${UNMEASURED} 0 < 50 (repositories)`)
    expect(red.output).toContain(`target: stale exception: ${stale}`)
    expect(red.output).toContain(`exception: ${EXCEPTED}: an interface`)
    expect(red.output).toMatch(/mutation target: 2 file\(s\) below their floor, 1 stale/)

    const green = await target(
      scratch({ ...unit, [SERVICE]: 60, [UNMEASURED]: 50 }, integration, TARGETS),
    )
    expect(green.code, green.output).toBe(0)
    expect(belowLines(green.output)).toEqual([])
    // Six group files, one of them excepted; the relay is in no group.
    expect(green.output).toContain('mutation target: 5 files at or above their floor')
  })

  // A file only the integration tests reach is left out of the unit mutate set and mutated by the integration config
  // alone; its floor still holds, through its integration entry.
  it('AC-1: a file only the integration config mutates is held to its floor by its integration entry, and an exception for it is not stale', async () => {
    const configs = {
      'stryker.config.mjs': `export default { mutate: ['packages/platform/src/services/**/*.ts', 'packages/platform/src/repositories/**/*.ts', '!${INTEGRATION_ONLY}'] }\n`,
      'stryker.integration.config.mjs': `export default { mutate: ['${INTEGRATION_ONLY}'] }\n`,
    }
    const unit: Scores = { [SERVICE]: 60, [SERVICE_AT_FLOOR]: 60, [UNMEASURED]: 50, [EXCEPTED]: 0 }
    const below = await target(scratch(unit, { [INTEGRATION_ONLY]: 59.99 }, TARGETS, configs))
    expect(below.code, below.output).toBe(1)
    expect(belowLines(below.output), below.output).toEqual([INTEGRATION_ONLY])
    expect(below.output).toContain(`below target: ${INTEGRATION_ONLY} 59.99 < 60 (services)`)

    const excused = await target(
      scratch(
        unit,
        { [INTEGRATION_ONLY]: 59.99 },
        { ...TARGETS, exceptions: { ...TARGETS.exceptions, [INTEGRATION_ONLY]: 'why' } },
        configs,
      ),
    )
    expect(excused.code, excused.output).toBe(0)
    expect(excused.output).toContain(`exception: ${INTEGRATION_ONLY}: why`)
    expect(excused.output).not.toContain('stale exception')

    const held = await target(scratch(unit, { [INTEGRATION_ONLY]: 60 }, TARGETS, configs))
    expect(held.code, held.output).toBe(0)
    // a-, b- and c-service, d.ts; page.ts excepted; the mapper and the relay are in neither fixture set.
    expect(held.output).toContain('mutation target: 4 files at or above their floor')
  })

  it('AC-1: a stale exception alone fails the check', async () => {
    const all: Scores = Object.fromEntries(FILES.map((f) => [f, 100]))
    const { code, output } = await target(
      scratch(all, {}, { ...TARGETS, exceptions: { 'packages/importers/x.ts': 'never there' } }),
    )
    expect(code, output).toBe(1)
    expect(belowLines(output)).toEqual([])
    expect(output).toContain('target: stale exception: packages/importers/x.ts')
  })

  it('AC-1: property: the files named are exactly the group files whose higher entry is below their floor, less the exceptions', () => {
    const groupFiles = FILES.filter((f) => f !== OUTSIDE)
    const cents = fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined })
    const entries = fc.tuple(...FILES.map(() => cents)).map((xs) => {
      const scores: Scores = {}
      xs.forEach((x, i) => {
        if (x !== undefined) scores[FILES[i]!] = x / 100
      })
      return scores
    })
    fc.assert(
      fc.property(
        entries,
        entries,
        fc.tuple(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 })),
        fc.subarray(groupFiles),
        (unit, integration, [serviceFloor, repoFloor], excepted) => {
          const targets: Targets = {
            groups: [
              { ...TARGETS.groups[0]!, floor: serviceFloor / 100 },
              { ...TARGETS.groups[1]!, floor: repoFloor / 100 },
              TARGETS.groups[3]!,
            ],
            exceptions: Object.fromEntries(excepted.map((f) => [f, 'why'])),
          }
          const floorOf = (f: string): number =>
            f.includes('/services/')
              ? serviceFloor / 100
              : f.includes('/repositories/')
                ? repoFloor / 100
                : 80
          const expected = groupFiles
            .filter((f) => !excepted.includes(f))
            .filter((f) => Math.max(unit[f] ?? 0, integration[f] ?? 0) < floorOf(f))
            .sort()
          const got = shortfalls(targets, FILES, unit, integration)
          expect(got.below.map((s) => s.file)).toEqual(expected)
          for (const s of got.below) {
            expect(s.score).toBe(Math.max(unit[s.file] ?? 0, integration[s.file] ?? 0))
            expect(s.score).toBeLessThan(s.floor)
          }
          expect(got.stale).toEqual([])
          expect(got.excepted).toEqual([...excepted].sort())
        },
      ),
      { numRuns: 300 },
    )
  })
})

// Whether the committed ratchets meet these floors is release:check's mutation item, not this test's: the floor holds
// the release, never the gate.
describe('AC-2: the committed floors', () => {
  it('AC-2: mutation-targets.json holds services 60, repositories 50, promotions 60, mappers 80, assistant 75, assistant-tools 65 with the one exception', () => {
    const committed = JSON.parse(
      readFileSync(join(REPO, 'mutation-targets.json'), 'utf8'),
    ) as Targets
    expect(committed.groups.map((g) => [g.name, g.glob, g.floor])).toEqual(
      TARGETS.groups.map((g) => [g.name, g.glob, g.floor]),
    )
    // The services' composition root left the unit mutate set, so its exception went with it.
    expect(Object.keys(committed.exceptions).sort()).toEqual([
      'packages/platform/src/repositories/page.ts',
    ])
  })
})
