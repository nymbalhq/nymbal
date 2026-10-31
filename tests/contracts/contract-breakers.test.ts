import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// AC-3, AC-4 and AC-5, the half that says the cases can fail: the published suites run on in-memory adapters with one
// defect each, beside a correct control with the same options (tests/contracts/fixtures/breakers, a vitest run of its
// own, read through its JSON report). Each defective adapter fails at least one case, every case it fails is the one
// its defect is about, and its control passes every case of the same count. Case names are matched by what they are
// about: pagination or cursor, idempotency, health, down or unreachable.
// The document store suite's replaceCollection cases run the same way: an in-memory store whose replaceCollection is
// not atomic, merges instead of replacing, or empties the collection before a source that then throws, beside the
// real in-memory store as the control. Each defective store fails only cases named for replaceCollection, among them
// the one about its defect (a reader during the replace, the exact new set, a failing source).
// The webhook suite runs the same way on the kernel's test provider: one twin mints a delivery id per call, one hands
// on a kernel event type, one hands on class-instance payloads; each fails only the case named for its defect, and the
// provider itself passes every case.
// The email feedback suite runs the same way on the kernel's test email provider: one twin mints a delivery id per
// call, one hands on a feedback event with no recipient, one leaves its bounce type out of producesEvents; each fails
// only the case named for its defect, and the provider itself passes every case.
// The shipping tracking suite runs the same way on the kernel's test shipping provider: one twin mints a delivery id
// per call, one hands on a numberless copy beside each tracking event, one leaves its tracking type out of
// producesEvents; each fails only the case named for its defect, and the provider itself passes every case.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')
const CONFIG = join(HERE, 'fixtures', 'breakers', 'vitest.config.ts')

const PAGINATION = /pagin|cursor/i
const IDEMPOTENCY = /idempot/i
const HEALTH = /health/i
const DOWNTIME = /\bdown\b|unreachable/i
const REPLACE = /replaceCollection/
const CONCURRENT_READER = /reader|concurren|partial/i
const STALE_KEYS = /stale|exact/i
const FAILING_SOURCE = /fail|throw|reject/i
const WEBHOOK_IDEMPOTENCY = /\bidempotency:/
const WEBHOOK_NAMESPACE = /\bnamespace:/
const FEEDBACK_REPLAY = /\breplay:/
const FEEDBACK_SHAPE = /\bshape:/
const TRACKING_REPLAY = /\breplay:/
const TRACKING_SHAPE = /\bshape:/

interface Outcome {
  passed: string[]
  failed: string[]
  /** Why the file failed outside its cases (a collection error), if it did. */
  message: string
}

const outcomes = new Map<string, Outcome>()
let runOutput = ''
const scratch = mkdtempSync(join(tmpdir(), 'contracts-breakers-'))

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

describe('the published suites fail an adapter with the defect they exist for', () => {
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

describe('the published document store suite fails a replaceCollection with the defect it exists for', () => {
  it('AC-1: a document store whose replaceCollection is not atomic fails the concurrent-reader replaceCollection case, and only replaceCollection cases; the real in-memory store passes every case', () => {
    const run = compare('documents-replace-not-atomic', 'documents-control', REPLACE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(
      run.failed.filter((name) => CONCURRENT_READER.test(name)).length,
      run.why,
    ).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-1: a document store whose replaceCollection keeps the old keys fails the exact-new-set replaceCollection case, and only replaceCollection cases', () => {
    const run = compare('documents-replace-merges', 'documents-control', REPLACE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.failed.filter((name) => STALE_KEYS.test(name)).length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-1: a document store whose replaceCollection empties the collection before a source that throws fails the failing-source replaceCollection case, and only replaceCollection cases', () => {
    const run = compare('documents-replace-failure-empties', 'documents-control', REPLACE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.failed.filter((name) => FAILING_SOURCE.test(name)).length, run.why).toBeGreaterThan(
      0,
    )
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })
})

describe('the published webhook suite fails a provider with the defect it exists for', () => {
  it('AC-7: a provider that mints a new delivery id on every call fails the idempotency case and nothing else; the test provider passes every case', () => {
    const run = compare('webhook-fresh-delivery-id', 'webhook-control', WEBHOOK_IDEMPOTENCY)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-7: a provider that hands on a kernel event type (payment.captured.v1) fails the namespace case and nothing else; the test provider passes every case', () => {
    const run = compare('webhook-kernel-namespace', 'webhook-control', WEBHOOK_NAMESPACE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('a provider whose event payloads are class instances, which the kernel refuses, fails the namespace case and nothing else; the test provider passes every case', () => {
    const run = compare('webhook-class-payload', 'webhook-control', WEBHOOK_NAMESPACE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })
})

describe('the published email feedback suite fails a provider with the defect it exists for', () => {
  it('AC-8: an email provider that mints a new delivery id on every call fails the replay case and nothing else; the test email provider passes every case', () => {
    const run = compare(
      'email-feedback-fresh-delivery-id',
      'email-feedback-control',
      FEEDBACK_REPLAY,
    )

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-8: an email provider that hands on a declared, versioned bounce with no recipient fails the shape case and nothing else; the test email provider passes every case', () => {
    const run = compare('email-feedback-no-recipient', 'email-feedback-control', FEEDBACK_SHAPE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-8: an email provider whose bounce type is missing from producesEvents, which the route refuses, fails the shape case and nothing else', () => {
    const run = compare('email-feedback-undeclared', 'email-feedback-control', FEEDBACK_SHAPE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })
})

describe('the published shipping tracking suite fails a provider with the defect it exists for', () => {
  it('AC-7: a shipping provider that mints a new delivery id on every call fails the replay case and nothing else; the test shipping provider passes every case', () => {
    const run = compare(
      'shipping-tracking-fresh-delivery-id',
      'shipping-tracking-control',
      TRACKING_REPLAY,
    )

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-7: a shipping provider that hands on, beside each correct tracking event, a declared, versioned copy with no tracking number fails the shape case and nothing else; the test shipping provider passes every case', () => {
    const run = compare(
      'shipping-tracking-no-tracking-number',
      'shipping-tracking-control',
      TRACKING_SHAPE,
    )

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-7: a shipping provider whose tracking type is missing from producesEvents, which the route refuses, fails the shape case and nothing else', () => {
    const run = compare('shipping-tracking-undeclared', 'shipping-tracking-control', TRACKING_SHAPE)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })
})
