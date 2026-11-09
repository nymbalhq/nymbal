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
// The shipping suite's words case runs the same way on the kernel's test shipping provider with all three words: each
// twin declares a word without its method, has a method without its word, declares tracking with no webhook, labels
// without rates, an unknown word or one twice, and fails only the words case; a twin that buys a new label on a repeated
// rate id fails only the labels cases; one with no word runs no rates, labels or tracking case at all.
// The reviews suite's submit case runs the same way: an adapter without submit that stores a review anyway, beside the
// one that refuses it (seeded through `seed`), and a submit adapter that drops the customer and order beside the
// control; each fails only the submit case.

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
const REVIEW_SUBMIT = /\bsubmit:/
const SHIPPING_WORDS = /\bwords:/
const SHIPPING_LABELS = /\blabels:/
const REFUND_LIST = /\brefund list:/

interface Outcome {
  passed: string[]
  failed: string[]
  /** The cases' own titles, without the describe blocks around them. */
  passedTitles: string[]
  failedTitles: string[]
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
      assertionResults: Array<{ fullName: string; title: string; status: string }>
    }>
  }
  for (const file of parsed.testResults) {
    const cases = file.assertionResults
    outcomes.set(basename(file.name, '.breaker.ts'), {
      passed: cases.filter((c) => c.status === 'passed').map((c) => c.fullName),
      failed: cases.filter((c) => c.status === 'failed').map((c) => c.fullName),
      passedTitles: cases.filter((c) => c.status === 'passed').map((c) => c.title),
      failedTitles: cases.filter((c) => c.status === 'failed').map((c) => c.title),
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

  for (const [broken, defect] of [
    ['payments-key-lost', 'loses each refund’s key'],
    ['payments-other-intents', 'returns another payment’s refund'],
    ['payments-lookup-refunds', 'moves money while it lists'],
  ] as const) {
    it(`AC-3: a payments adapter that ${defect} fails the refund list cases and nothing else; the same adapter without the defect passes every case`, () => {
      const run = compare(broken, 'payments-control', REFUND_LIST)

      expect(run.failed.length, run.why).toBeGreaterThan(0)
      expect(run.offTopic, run.why).toEqual([])
      expect(run.controlFailed, run.why).toEqual([])
      expect(run.controlPassed).toBe(run.badTotal)
    })
  }

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

describe('the published reviews suite certifies a provider without on-site reviews', () => {
  // Kills: a suite that only reads what submitReview stored, so a no-submit adapter cannot be certified, or one that
  // never asks a no-submit adapter to refuse, so one that silently stores passes.
  it('AC-12: an adapter whose capabilities lack submit yet stores a submitted review fails the submit case and nothing else; the same adapter refusing with ReviewRefusedError reviews.submit_unsupported, seeded through seed, passes every case', () => {
    const run = compare('reviews-no-submit-stores', 'reviews-read-only', REVIEW_SUBMIT)

    expect(run.failed.length, run.why).toBeGreaterThan(0)
    expect(run.offTopic, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
    expect(run.controlPassed).toBe(run.badTotal)
  })

  it('AC-12: a submit adapter that files the review without the submission’s customerId and orderId fails the submit case and nothing else; the same adapter keeping them passes every case', () => {
    const run = compare('reviews-drops-identity', 'reviews-control', REVIEW_SUBMIT)

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

/** The word a shipping case is under: the text before its first colon. */
const wordOf = (title: string): string => title.slice(0, title.indexOf(':'))

/** The twin's failed cases by word, and the cases it ran that its control did not pass. */
function shippingRun(broken: string, about: RegExp) {
  const bad = outcome(broken)
  const good = outcome('shipping-control')
  return {
    failedWords: bad.failedTitles.map(wordOf),
    offTopic: bad.failed.filter((name) => !about.test(name)),
    ranOffControl: [...bad.passedTitles, ...bad.failedTitles].filter(
      (title) => !good.passedTitles.includes(title),
    ),
    controlFailed: good.failed,
    why: `${broken}: ${bad.message} ${bad.failed.join(' | ')} shipping-control: ${good.message}`,
  }
}

describe('the published shipping suite fails an adapter whose words and methods disagree', () => {
  // Kills: a suite that trusts the list, so a shipping adapter ships a rejecting stub, or a word the kernel acts on with
  // no method behind it.
  it.each([
    ['declares rates without a rate method', 'shipping-rates-no-method'],
    ['declares labels without a createLabel method', 'shipping-labels-no-method'],
    ['declares tracking without a startTracking method', 'shipping-tracking-no-method'],
    ['has rate without declaring rates', 'shipping-rate-undeclared'],
    ['has createLabel without declaring labels', 'shipping-label-undeclared'],
    ['has startTracking without declaring tracking', 'shipping-start-tracking-undeclared'],
    ['declares tracking without receiveWebhook', 'shipping-tracking-no-webhook'],
    ['declares labels without rates', 'shipping-labels-without-rates'],
    ['declares a word the slot does not have', 'shipping-unknown-word'],
    ['declares a word twice', 'shipping-word-twice'],
  ])(
    'AC-1: a shipping adapter that %s (%s) fails the words case and nothing else; the test shipping provider with all three words passes every case',
    (_defect, broken) => {
      const run = shippingRun(broken, SHIPPING_WORDS)

      expect(run.failedWords, run.why).toEqual(['words'])
      expect(run.offTopic, run.why).toEqual([])
      expect(run.ranOffControl, run.why).toEqual([])
      expect(run.controlFailed, run.why).toEqual([])
    },
  )

  // Kills: a retried label buy (its answer lost on the way back) charging the store for a second label.
  it('AC-2: a shipping adapter that answers a new tracking number each time one rate id is bought fails the labels cases and nothing else; the test shipping provider passes every case', () => {
    const run = shippingRun('shipping-label-buys-again', SHIPPING_LABELS)

    expect(run.failedWords, run.why).toEqual(['labels'])
    expect(run.offTopic, run.why).toEqual([])
    expect(run.ranOffControl, run.why).toEqual([])
    expect(run.controlFailed, run.why).toEqual([])
  })

  it('AC-2: on a shipping adapter with no word and none of the methods, no rates, labels or tracking case runs and none fails: the words and health cases are all it runs', () => {
    const none = outcome('shipping-no-words')

    expect(none.failed, none.message).toEqual([])
    expect(none.passedTitles.map(wordOf).sort()).toEqual(['health', 'words'])
    expect(outcome('shipping-control').passedTitles.map(wordOf).sort()).toEqual([
      'health',
      'labels',
      'labels',
      'rates',
      'tracking',
      'words',
    ])
  })
})
