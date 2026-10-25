import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
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
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { plan, run, type StepSpec } from '../../scripts/gate'

// AC-4: the gate's stryker step fails when the fresh report has a file below the ratchet, and passes when it is equal
// or above. The step is the one gate:full plans, run by the gate's own runner in a scratch copy of the repo's scripts
// and package.json, where `stryker` is a stub that writes a fixture report to the path stryker.config.mjs names (and
// exits 0, as a run with survivors does). So what decides the step is whatever the step runs after Stryker, against
// the scratch's mutation-ratchet.json.

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
  await populate(dir, ratchetScore)
  return dir
}

/** The scratch's scripts, configs, linked node_modules, stubbed stryker and a ratchet holding FILE at `ratchetScore`. */
async function populate(dir: string, ratchetScore: number): Promise<void> {
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
    `#!/bin/sh\ntouch stryker-ran && mkdir -p '${dirname(reportPath)}' && cp fixture-report.json '${reportPath}'\n`,
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

// AC-4b: test-only changes run the ratchet. Here the whole gate runs (`gate.ts --full --only stryker`), so its own
// change detection decides the plan: each scratch is a git repository committed as the base, then one kind of path
// changes in the work tree. A Stryker input (a test under packages/platform/src, vitest.stryker.config.ts,
// stryker.config.mjs) must plan the step and run `check` after the stubbed Stryker; any other path skips it.

const TEST = 'packages/platform/src/services/cart-service.test.ts'
const exec = promisify(execFile)

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  )
}

async function repoScratch(ratchetScore: number): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-ratchet-git-')))
  created.push(dir)
  await populate(dir, ratchetScore)
  cpSync(join(REPO, 'vitest.stryker.config.ts'), join(dir, 'vitest.stryker.config.ts'))
  mkdirSync(join(dir, dirname(FILE)), { recursive: true })
  writeFileSync(join(dir, FILE), 'export const total = (a: number, b: number): number => a + b\n')
  writeFileSync(
    join(dir, TEST),
    "import { expect, it } from 'vitest'\nimport { total } from './cart-service'\n\nit('adds', () => expect(total(1, 2)).toBe(3))\n",
  )
  writeFileSync(join(dir, '.gitignore'), 'node_modules\nreports\nstryker-ran\n')
  git(dir, ['init', '--quiet'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'base'])
  return dir
}

/** Runs the gate's stryker step as `gate:full --only stryker` would, against HEAD; the step's status and whether Stryker ran. */
async function gateStryker(cwd: string): Promise<{ status: string; ran: boolean; output: string }> {
  const args = [
    join(REPO, 'node_modules/.bin/tsx'),
    'scripts/gate.ts',
    '--full',
    '--only',
    'stryker',
    '--base',
    'HEAD',
    '--json',
  ]
  let stdout = ''
  let stderr = ''
  try {
    ;({ stdout, stderr } = await exec(args[0]!, args.slice(1), { cwd, encoding: 'utf8' }))
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
  }
  const last = stdout.trim().split('\n').at(-1) ?? ''
  let status = 'no result'
  try {
    const parsed = JSON.parse(last) as { steps: Array<{ name: string; status: string }> }
    status = parsed.steps.find((s) => s.name === 'stryker')?.status ?? 'not planned'
  } catch {
    // the gate printed no JSON: the status stays 'no result' and the output says why
  }
  return { status, ran: existsSync(join(cwd, 'stryker-ran')), output: `${stdout}\n${stderr}` }
}

describe('AC-4b: a change set with a Stryker input and no mutate-set file still runs the ratchet', () => {
  const CHANGES = [
    {
      // The control: a mutate-set file planned the step before AC-4b, so a red here is the scratch working.
      name: 'only a mutate-set file',
      ratchet: 50.01,
      input: true,
      change: (d: string) => appendFileSync(join(d, FILE), '// changed\n'),
    },
    {
      name: 'only a co-located platform test, the ratchet a hundredth above the report',
      ratchet: 50.01,
      input: true,
      change: (d: string) =>
        appendFileSync(join(d, TEST), "it('adds zero', () => expect(total(0, 0)).toBe(0))\n"),
    },
    {
      name: 'only a co-located platform test, the ratchet equal to the report',
      ratchet: 50,
      input: true,
      change: (d: string) =>
        appendFileSync(join(d, TEST), "it('adds zero', () => expect(total(0, 0)).toBe(0))\n"),
    },
    {
      name: 'only vitest.stryker.config.ts',
      ratchet: 50.01,
      input: true,
      change: (d: string) => appendFileSync(join(d, 'vitest.stryker.config.ts'), '// changed\n'),
    },
    {
      name: 'only stryker.config.mjs',
      ratchet: 50.01,
      input: true,
      change: (d: string) => appendFileSync(join(d, 'stryker.config.mjs'), '// changed\n'),
    },
    {
      name: 'only a test outside packages/platform/src',
      ratchet: 50.01,
      input: false,
      change: (d: string) => {
        mkdirSync(join(d, 'packages/sdk/src'), { recursive: true })
        writeFileSync(
          join(d, 'packages/sdk/src/client.test.ts'),
          "import { it } from 'vitest'\nit('runs', () => {})\n",
        )
      },
    },
    {
      name: 'only documentation',
      ratchet: 50.01,
      input: false,
      change: (d: string) => {
        mkdirSync(join(d, 'docs'), { recursive: true })
        writeFileSync(join(d, 'docs/notes.md'), '# notes\n')
      },
    },
  ]

  it('AC-4b: a Stryker input alone plans the stryker step and its check reds a lowered file; no Stryker input skips it', async () => {
    const results = await Promise.all(
      CHANGES.map(async (c) => {
        const dir = await repoScratch(c.ratchet)
        c.change(dir)
        return { name: c.name, ...(await gateStryker(dir)) }
      }),
    )
    const detail = results.map((r) => `--- ${r.name}: ${r.status}\n${r.output}`).join('\n')
    expect(
      results.map((r) => `${r.name}: ${r.status}, stryker ${r.ran ? 'ran' : 'did not run'}`),
      detail,
    ).toEqual(
      CHANGES.map((c) => {
        const status = !c.input ? 'skipped' : c.ratchet > REPORT_SCORE ? 'red' : 'ok'
        return `${c.name}: ${status}, stryker ${c.input ? 'ran' : 'did not run'}`
      }),
    )
  }, 120_000)
})

// The plain gate's ratchet step hands the gate's base to `check --static`, so a change to a measured mutate-set file
// whose unit test file did not change is red before anything slow runs (2026-10-25). Resolved through the real runner:
// the step `plan` makes, run by the gate's runner in a git scratch holding the real scripts, with the ratchet holding
// only the file the scratch has.
describe('the ratchet step warns of a measured file changed without its unit test', () => {
  const ratchetStep = (): StepSpec => {
    const step = plan({ full: false, base: 'HEAD', changed: [FILE], mutated: [FILE] }).steps.find(
      (s) => s.name === 'ratchet',
    )
    if (step === undefined || step.skip !== undefined)
      throw new Error('the plain gate plans a ratchet step')
    return step
  }
  // The warning is the whole effect: the step stays ok (a refusal hit 4 of 5 good changes when replayed over dev),
  // and the gate's log carries the line for the builder and the reviewer.
  const CASES = [
    { name: 'the service alone', entry: 50, test: false, status: 'ok', warns: true },
    { name: 'the service and its unit test', entry: 50, test: true, status: 'ok', warns: false },
    {
      name: 'the service alone, entry 0 (unmeasured)',
      entry: 0,
      test: false,
      status: 'ok',
      warns: false,
    },
  ]

  it('ok in every case; the gate log carries the warning naming the unit test only when the service changed alone', async () => {
    const step = ratchetStep()
    const results = await Promise.all(
      CASES.map(async (c) => {
        const dir = await repoScratch(c.entry)
        writeFileSync(
          join(dir, 'mutation-ratchet.json'),
          `${JSON.stringify({ measuredAt: '2026-10-01T00:00:00.000Z', command: 'fixture', total: c.entry, files: { [FILE]: c.entry } }, null, 2)}\n`,
        )
        git(dir, ['commit', '--quiet', '-am', 'ratchet'])
        appendFileSync(join(dir, FILE), '// changed\n')
        if (c.test)
          appendFileSync(join(dir, TEST), "it('adds zero', () => expect(total(0, 0)).toBe(0))\n")
        const logs: string[] = []
        const { steps } = await run([step], {
          cwd: dir,
          budgetMs: 120_000,
          log: (t) => logs.push(t),
        })
        return { name: c.name, status: steps[0]?.status, log: logs.join('') }
      }),
    )
    const detail = results.map((r) => `--- ${r.name}: ${r.status}\n${r.log}`).join('\n')
    expect(
      results.map((r) => `${r.name}: ${r.status}`),
      `step command: ${step.command}\n${detail}`,
    ).toEqual(CASES.map((c) => `${c.name}: ${c.status}`))
    const warned = (log: string): boolean =>
      log.split('\n').some((l) => /warning:/.test(l) && l.includes(TEST))
    expect(
      results.map((r) => `${r.name}: ${warned(r.log) ? 'warns' : 'quiet'}`),
      detail,
    ).toEqual(CASES.map((c) => `${c.name}: ${c.warns ? 'warns' : 'quiet'}`))
  }, 120_000)
})
