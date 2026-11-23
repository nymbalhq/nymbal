import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { InsightList, InsightView, ToolDefinition } from '@nymbalhq/types'
import { assistantTools as offeredBy } from '../../src/assistant/loop.js'
import { runNightShift } from '../../src/night-shift/runner.js'
import { assistantStore, type AssistantStore } from '../support/assistant.js'
import { auditRows, customerSession } from '../support/audit.js'
import { seedVariant } from '../support/kernel.js'
import { customerAccount, listedNames, toolSurface } from '../support/mcp.js'
import {
  DAY_MS,
  NOW,
  RUN_DAY,
  addDays,
  daysRange,
  depsOf,
  dismissEvents,
  insightEvents,
  insightRows,
  insightState,
  resetNight,
  runTwice,
  seedInsight,
  shippedJob,
  soldOn,
  applyFigures,
  type SoldVariant,
} from '../support/night-shift.js'

// The night shift's insights as the admin and its agents reach them: the open list over HTTP and as a tool, a dismiss
// through the admin route, and the subject a dismiss keeps quiet. One served store whose night-shift clock reads the
// fixtures' night; insights are seeded through the repository or written by a night of the shipped stock-runway job,
// and read back over HTTP and on a second connection.

const LIST = '/api/admin/insights'
const dismissPath = (id: string) => `/api/admin/insights/${id}/dismiss`

let clock = NOW
let store: AssistantStore

beforeAll(async () => {
  store = await assistantStore({
    appOptions: { nightShift: { now: () => clock, intervalMs: 3_600_000 } },
  })
}, 60_000)

afterAll(async () => {
  await store?.close()
})

beforeEach(async () => {
  clock = NOW
  await resetNight(store.kernel)
})

async function listed(): Promise<InsightView[]> {
  const res = await store.admin.send<InsightList>('GET', LIST)
  if (res.status !== 200) throw new Error(`GET ${LIST}: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data!.items
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }

/** The brief's order, written out: severity, newer day first, then job and subject by code unit. */
function briefOrder(a: InsightView, b: InsightView): number {
  const bySeverity = SEVERITY_RANK[a.severity]! - SEVERITY_RANK[b.severity]!
  if (bySeverity !== 0) return bySeverity
  if (a.day !== b.day) return a.day > b.day ? -1 : 1
  if (a.job !== b.job) return a.job < b.job ? -1 : 1
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
  return 0
}

const factValue = fc.oneof(
  fc.integer({ min: -1_000, max: 100_000 }),
  fc.integer({ min: -400, max: 400 }).map((n) => n / 4),
  fc.string({ maxLength: 12 }),
  fc.constant(null),
)

// Jobs and subjects whose code-unit order differs from a locale's: upper case before lower, accents after both.
const seedArb = fc.record({
  job: fc.constantFrom('Zeta', 'alpha', 'beta', 'émigré'),
  subject: fc.constantFrom('B', 'a', 'b', 'variant:Ä', 'variant:z'),
  dayOffset: fc.integer({ min: 0, max: 4 }),
  status: fc.constantFrom('open' as const, 'dismissed' as const),
  severity: fc.constantFrom('info' as const, 'warning' as const, 'critical' as const),
  facts: fc.dictionary(fc.constantFrom('units', 'share', 'label', 'missing', 'rate'), factValue),
})

describe('AC-1: the open list over HTTP', () => {
  it('AC-1: property: over any mix of rows, GET /api/admin/insights answers exactly the open rows, each once, as views ordered by severity, newer day, job and subject by code unit, with facts as stored', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(seedArb, {
          minLength: 0,
          maxLength: 10,
          selector: (s) => `${s.job}|${s.subject}|${s.dayOffset}`,
        }),
        async (seeds) => {
          await resetNight(store.kernel)
          const expected: InsightView[] = []
          for (const seed of seeds) {
            const day = addDays('2026-07-10', seed.dayOffset)
            const summary = `About ${seed.subject} on ${day}.`
            const id = await seedInsight(store.kernel, {
              job: seed.job,
              subject: seed.subject,
              runDay: day,
              status: seed.status,
              dismissedAt: seed.status === 'dismissed' ? new Date(NOW.getTime() - DAY_MS) : null,
              severity: seed.severity,
              summary,
              facts: seed.facts,
            })
            if (seed.status === 'open') {
              expected.push({
                id,
                job: seed.job,
                subject: seed.subject,
                day,
                dataDay: addDays(day, -1),
                severity: seed.severity,
                summary,
                facts: seed.facts,
                status: 'open',
                createdAt: '',
                dismissedAt: null,
                guidance: null,
                guidanceWithheld: false,
              })
            }
          }
          expected.sort(briefOrder)

          const items = await listed()

          expect(items.map((i) => i.id)).toEqual(expected.map((e) => e.id))
          expect(items.map(({ createdAt: _c, ...rest }) => rest)).toEqual(
            expected.map(({ createdAt: _c, ...rest }) => rest),
          )
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)

  it('AC-1: a customer is refused 403 and a request with no session 401, while the admin reads the list', async () => {
    await seedInsight(store.kernel, {
      job: 'stock-runway',
      subject: 'variant:guarded',
      runDay: RUN_DAY,
      status: 'open',
      dismissedAt: null,
    })
    const customer = await customerSession(store.baseUrl)

    const asCustomer = await customer.send('GET', LIST)
    const anonymous = await fetch(`${store.baseUrl}${LIST}`)
    const asAdmin = await listed()

    expect([asCustomer.status, anonymous.status]).toEqual([403, 401])
    expect(asAdmin.map((i) => i.subject)).toEqual(['variant:guarded'])
  })
})

const stockRunway = [shippedJob('stock-runway')]

/** A variant with `stock` on hand that sold one unit a day over the 28 days before the night and the 8 nights after. */
async function runningLow(stock: number): Promise<SoldVariant> {
  const seeded = await seedVariant(store.kernel, stock)
  const v: SoldVariant = {
    variantId: seeded.variantId,
    productId: seeded.productId,
    productName: 'Merino crew sock',
    sku: `MCS-${seeded.variantId.slice(0, 6)}`,
  }
  await applyFigures(
    store.kernel,
    daysRange(27, -8).map((day) => soldOn(day, v, 1)),
  )
  return v
}

const nightOf = (n: number) => new Date(NOW.getTime() + n * DAY_MS)

describe('AC-2: one card through two runs and the next night', () => {
  it('AC-2: with one variant running low, the night run twice and the next night once leave one listed insight for it, of the first night, carrying what its insight.created.v1 carried', async () => {
    const v = await runningLow(5)
    const subject = `variant:${v.variantId}`

    await runTwice(store.kernel, NOW, stockRunway)
    await runNightShift(depsOf(store.kernel, stockRunway), nightOf(1))

    const mine = (await listed()).filter((i) => i.subject === subject)
    const created = (await insightEvents(store.raw, 'stock-runway')).filter(
      (p) => p.subject === subject,
    )
    expect(created).toHaveLength(1)
    expect(mine).toHaveLength(1)
    const [view] = mine
    const [payload] = created
    expect({
      id: view!.id,
      day: view!.day,
      dataDay: view!.dataDay,
      severity: view!.severity,
      summary: view!.summary,
      facts: view!.facts,
    }).toEqual({
      id: payload!.insightId,
      day: payload!.day,
      dataDay: payload!.dataDay,
      severity: payload!.severity,
      summary: payload!.summary,
      facts: payload!.facts,
    })
    expect(view!.day).toBe(RUN_DAY)
  })
})

describe('AC-3: an admin dismisses an open insight', () => {
  it('AC-3: POST …/dismiss answers the dismissed view, dismisses the row, publishes one insight.dismissed.v1 with what changed, leaves one applied insight.dismiss entry by that admin naming it, and the list no longer has it', async () => {
    const id = await seedInsight(store.kernel, {
      job: 'zero-result-term',
      subject: 'term:wool socks',
      runDay: RUN_DAY,
      status: 'open',
      dismissedAt: null,
    })
    const before = (await listed()).map((i) => i.id)

    const res = await store.admin.send<InsightView>('POST', dismissPath(id))

    const view = res.body.data
    const row = await insightState(store.raw, id)
    const events = await dismissEvents(store.raw, id)
    const entries = (await auditRows(store.raw, 'command = ?', ['insight.dismiss'])).filter((e) =>
      e.subjects.some((s) => s.type === 'insight' && s.id === id),
    )
    const after = (await listed()).map((i) => i.id)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect([view?.id, view?.status]).toEqual([id, 'dismissed'])
    expect(row).toEqual({ status: 'dismissed', dismissedAt: view?.dismissedAt })
    expect(events).toEqual([
      {
        insightId: id,
        job: 'zero-result-term',
        subject: 'term:wool socks',
        dismissedAt: view?.dismissedAt,
      },
    ])
    expect(entries.map((e) => [e.outcome, e.actorKind, e.actorId])).toEqual([
      ['applied', 'admin', store.admin.userId],
    ])
    expect(before).toContain(id)
    expect(after).toEqual(before.filter((other) => other !== id))
  })
})

describe('AC-5: a dismiss keeps its subject quiet for 7 days on the night-shift clock', () => {
  it('AC-5: dismissed at the night, the subject gets no insight on the next 7 nights while a second variant of the job fires on the first of them, and on the eighth night it gets one new open insight the list shows', async () => {
    const a = await runningLow(5)
    const subjectA = `variant:${a.variantId}`

    await runNightShift(depsOf(store.kernel, stockRunway), NOW)
    const [first] = (await insightRows(store.raw, 'stock-runway')).filter(
      (r) => r.subject === subjectA,
    )
    const dismissed = await store.admin.send<InsightView>('POST', dismissPath(first!.id))
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200)
    expect(dismissed.body.data?.dismissedAt).toBe(NOW.toISOString())

    let subjectB = ''
    for (let n = 1; n <= 7; n += 1) {
      if (n === 1) subjectB = `variant:${(await runningLow(5)).variantId}`
      clock = nightOf(n)
      await runNightShift(depsOf(store.kernel, stockRunway), nightOf(n))
    }
    const quiet = await insightRows(store.raw, 'stock-runway')

    clock = nightOf(8)
    await runNightShift(depsOf(store.kernel, stockRunway), nightOf(8))
    const rowsAfter = await insightRows(store.raw, 'stock-runway')
    const eighthDay = addDays(RUN_DAY, 8)

    expect(quiet.filter((r) => r.subject === subjectA).map((r) => [r.runDay, r.status])).toEqual([
      [RUN_DAY, 'dismissed'],
    ])
    expect(quiet.filter((r) => r.subject === subjectB).map((r) => r.runDay)).toEqual([
      addDays(RUN_DAY, 1),
    ])
    const fresh = rowsAfter.filter((r) => r.subject === subjectA && r.runDay !== RUN_DAY)
    expect(fresh.map((r) => [r.runDay, r.status])).toEqual([[eighthDay, 'open']])
    expect((await listed()).filter((i) => i.subject === subjectA).map((i) => i.id)).toEqual([
      fresh[0]!.id,
    ])
  })
})

describe('AC-6: agents read the open list and dismiss nothing', () => {
  it('AC-6: admin_insights_list is the one tool over /api/admin/insights, a read offered over MCP and to the assistant also under customerData: false, answering what the route answers; a customer is not offered it', async () => {
    for (const [subject, severity] of [
      ['variant:one', 'critical'],
      ['variant:two', 'info'],
    ] as const) {
      await seedInsight(store.kernel, {
        job: 'stock-runway',
        subject,
        runDay: RUN_DAY,
        status: 'open',
        dismissedAt: null,
        severity,
        facts: { stock: 3, share: 12.5, label: 'Size 42', missing: null },
      })
    }
    const tools = toolSurface(store.kernel.app)
    const listedTools = (await tools.list(store.caller)) as ToolDefinition[]
    const customer = await customerAccount(store.kernel, store.baseUrl)

    const result = await tools.call('admin_insights_list', {}, store.caller)
    const route = await store.admin.send<InsightList>('GET', LIST)

    const overInsights = listedTools.filter((t) => t.route.path.startsWith(LIST))
    expect(overInsights.map((t) => [t.name, t.kind, t.route.method])).toEqual([
      ['admin_insights_list', 'read', 'GET'],
    ])
    const offered = (customerData?: boolean) =>
      offeredBy(listedTools, customerData === undefined ? {} : { customerData })
        .map((t) => t.name)
        .filter((name) => name.startsWith('admin_insights_'))
    expect([offered(), offered(false)]).toEqual([['admin_insights_list'], ['admin_insights_list']])
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content.map((c) => c.text).join(''))).toEqual(route.body.data)
    expect(route.body.data?.items).toHaveLength(2)
    expect(
      (await listedNames(tools, customer.caller)).filter((n) => n.startsWith('admin_insights_')),
    ).toEqual([])
  })
})
