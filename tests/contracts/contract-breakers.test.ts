import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// P2-13 AC-3, AC-4 and AC-5 (spec P2-13-contract-tests-public), the half that says the new cases can fail: the
// published suites run on in-memory adapters with one defect each, beside a correct control with the same options
// (tests/contracts/fixtures/breakers, a vitest run of its own, read through its JSON report). Each defective adapter
// fails at least one case, every case it fails is the one its defect is about, and its control passes every case
// of the same count. Kills: a pagination case that a cursor-ignoring adapter passes; an idempotency case that a
// double refund passes; a health case that waits on a check that never settles, or skips a primitive without
// healthCheck; a downtime case that passes on a dependency that still answers (`degraded` is not `down`) or hangs on
// one that never does. Case names are matched by what they are about: pagination or cursor, idempotency, health,
// down or unreachable.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')
const CONFIG = join(HERE, 'fixtures', 'breakers', 'vitest.config.ts')

const PAGINATION = /pagin|cursor/i
const IDEMPOTENCY = /idempot/i
const HEALTH = /health/i
const DOWNTIME = /\bdown\b|unreachable/i

interface Outcome {
  passed: string[]
  failed: string[]
  /** Why the file failed outside its cases (a collection error), if it did. */
  message: string
}

const outcomes = new Map<string, Outcome>()
let runOutput = ''
const scratch = mkdtempSync(join(tmpdir(), 'p2-13-breakers-'))

beforeAll(() => {
  const report = join(scratch, 'report.json')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  const run = spawnSync(
    process.execPath,
    [VITEST, 'run', '--config', CONFIG, '--reporter=json', `--outputFile=${report}`],
    { cwd: REPO, env, encoding: 'utf8', timeout: 240_000 },
  )
  runOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-3000)
  if (!existsSync(report)) return
  const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
    testResults: Array<{
      name: string
      message?: string
      assertionResults: Array<{ fullName: string; status: string }>
    }>
  }
  for (const file of parsed.testResults) {
    const cases = file.assertionResults
    outcomes.set(basename(file.name, '.breaker.ts'), {
      passed: cases.filter((c) => c.status === 'passed').map((c) => c.fullName),
      failed: cases.filter((c) => c.status === 'failed').map((c) => c.fullName),
      message: file.message ?? '',
    })
  }
}, 300_000)

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function outcome(name: string): Outcome {
  const found = outcomes.get(name)
  if (found === undefined) {
    throw new Error(`the breakers run reported nothing for ${name}.breaker.ts:\n${runOutput}`)
  }
  return found
}

/** The defective adapter's cases against its control's: what failed, what failed off topic, what the control failed. */
function compare(broken: string, control: string, about: RegExp) {
  const bad = outcome(broken)
  const good = outcome(control)
  return {
    failed: bad.failed,
    offTopic: bad.failed.filter((name) => !about.test(name)),
    badTotal: bad.passed.length + bad.failed.length,
    controlFailed: good.failed,
    controlPassed: good.passed.length,
    why: `${broken}: ${bad.message} ${control}: ${good.message}`,
  }
}

describe('P2-13: the published suites fail an adapter with the defect they exist for', () => {
  it('AC-3: a reviews adapter that ignores the cursor fails the pagination case and nothing else; the same adapter honouring it passes every case', () => {
    const run = compare('reviews-cursor-ignored', 'reviews-control', PAGINATION)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-4: a payments adapter that refunds again on a repeated idempotency key fails the idempotency case and nothing else; the same adapter replaying passes every case', () => {
    const run = compare('payments-double-refund', 'payments-control', IDEMPOTENCY)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-5: a commerce adapter whose healthCheck never settles fails the health case and nothing else, within the case bound', () => {
    const run = compare('reviews-health-hangs', 'reviews-control', HEALTH)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-5: a primitive without healthCheck fails the health case and nothing else; the same storage with it passes every case', () => {
    const run = compare('media-no-health', 'media-control', HEALTH)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-5: an unreachable dependency that still answers (degraded, and put stores) fails the downtime cases and nothing else; a dead root passes them', () => {
    const run = compare('media-down-answers', 'media-down-control', DOWNTIME)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-5: an unreachable dependency that never answers fails the downtime cases within their bound and nothing else', () => {
    const run = compare('media-down-hangs', 'media-down-control', DOWNTIME)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })
})
