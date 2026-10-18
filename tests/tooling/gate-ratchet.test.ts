import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { plan, run, type StepSpec } from '../../scripts/gate'

// Acceptance test for P1-10 (phase exit), AC-4: the gate's stryker step fails when the fresh report has a file below
// the ratchet, and passes when it is equal or above. The step is the one gate:full plans, run by the gate's own runner
// in a scratch copy of the repo's scripts and package.json, where `stryker` is a stub that writes a fixture report to
// the path stryker.config.mjs names (and exits 0, as a run with survivors does). So what decides the step is whatever
// the step runs after Stryker, against the scratch's mutation-ratchet.json.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FILE = 'packages/platform/src/services/cart-service.ts'

const created: string[] = []
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function strykerStep(): StepSpec {
  const step = plan({ full: true, base: 'HEAD', changed: [FILE], mutated: [FILE] }).steps.find(
    (s) => s.name === 'stryker',
  )
  if (step === undefined || step.skip !== undefined) {
    throw new Error(`gate:full must plan a stryker step that runs for ${FILE}`)
  }
  return step
}

/** A report where FILE has two of four valid mutants killed (50.00), plus one ignored mutant. */
function fixtureReport(): unknown {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored']
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: {
      [FILE]: {
        language: 'typescript',
        source: '',
        mutants: statuses.map((status, i) => ({
          id: String(i),
          mutatorName: 'BlockStatement',
          replacement: '{}',
          status,
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        })),
      },
    },
  }
}
const REPORT_SCORE = 50

async function scratch(ratchetScore: number): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-ratchet-')))
  created.push(dir)
  const rootPackage = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'gate-ratchet-scratch',
      private: true,
      type: 'module',
      scripts: rootPackage.scripts,
    }),
  )
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(REPO, 'stryker.config.mjs'), join(dir, 'stryker.config.mjs'))

  // node_modules: every entry linked to the repo's, except .bin, where stryker is the stub.
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  for (const entry of readdirSync(join(REPO, 'node_modules'))) {
    if (entry === '.bin') continue
    symlinkSync(join(REPO, 'node_modules', entry), join(dir, 'node_modules', entry))
  }
  for (const bin of readdirSync(join(REPO, 'node_modules/.bin'))) {
    if (bin === 'stryker') continue
    symlinkSync(join(REPO, 'node_modules/.bin', bin), join(dir, 'node_modules/.bin', bin))
  }
  const config = (await import(pathToFileURL(join(REPO, 'stryker.config.mjs')).href)) as {
    default: { jsonReporter?: { fileName?: string } }
  }
  const reportPath = config.default.jsonReporter?.fileName ?? 'reports/mutation/mutation.json'
  writeFileSync(join(dir, 'fixture-report.json'), JSON.stringify(fixtureReport()))
  const stub = join(dir, 'node_modules/.bin/stryker')
  writeFileSync(
    stub,
    `#!/bin/sh\nmkdir -p '${dirname(reportPath)}' && cp fixture-report.json '${reportPath}'\n`,
  )
  chmodSync(stub, 0o755)

  writeFileSync(
    join(dir, 'mutation-ratchet.json'),
    `${JSON.stringify(
      {
        measuredAt: '2026-10-01T00:00:00.000Z',
        command: 'fixture',
        total: 50,
        files: {
          [FILE]: ratchetScore,
          'packages/platform/src/services/order-service.ts': 80,
        },
      },
      null,
      2,
    )}\n`,
  )
  return dir
}

describe('AC-4: the gate runs the ratchet after Stryker', () => {
  const CASES = [
    { name: 'a hundredth below the ratchet', ratchet: 50.01 },
    { name: 'equal to the ratchet', ratchet: 50 },
    { name: 'above the ratchet', ratchet: 49.99 },
  ]

  it('AC-4: the stryker step is red when the fresh report scores a file below its ratchet, and ok when equal or above', async () => {
    const step = strykerStep()
    const results = await Promise.all(
      CASES.map(async (c) => {
        const cwd = await scratch(c.ratchet)
        const logs: string[] = []
        const { steps } = await run([step], {
          cwd,
          budgetMs: 120_000,
          log: (t) => logs.push(t),
        })
        return { name: c.name, status: steps[0]?.status, log: logs.join('') }
      }),
    )
    const detail = results.map((r) => `${r.name}: ${r.status}\n${r.log}`).join('\n')
    expect(
      results.map((r) => r.status),
      `step command: ${step.command}\n${detail}`,
    ).toEqual(CASES.map((c) => (c.ratchet > REPORT_SCORE ? 'red' : 'ok')))
  })
})
