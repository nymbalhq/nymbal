import fc from 'fast-check'
import type { NymbalConfig } from '@nymbalhq/config'
import type { InsightSeverity, ToolDefinition } from '@nymbalhq/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { assistantTools } from '../../src/assistant/loop.js'
import {
  GUIDANCE_CALLER,
  GUIDED_JOBS,
  GUIDANCE_MAX_CHARS,
  runGuidance,
  type GuidanceCall,
  type GuidanceRun,
} from '../../src/night-shift/guidance.js'
import { NIGHT_SHIFT_JOBS } from '../../src/night-shift/jobs.js'
import { runNightShift } from '../../src/night-shift/runner.js'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import {
  TICK_MS,
  briefOf,
  depsFor,
  guidanceColumns,
  guidanceModel,
  opensTurn,
  seedGuided,
  seedNight,
  tickingApp,
  toolMessages,
  type GuidanceReply,
  type GuidanceRequest,
  type TickingApp,
} from '../support/guidance.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import {
  DATA_DAY,
  NOW,
  RUN_DAY,
  applyFigures,
  depsOf,
  insightEvents,
  insightRows,
  noonOf,
  resetNight,
  runRows,
  searchedOn,
} from '../support/night-shift.js'
import { openRaw, type RawReader } from '../support/raw.js'

// Guidance on SQLite through `runGuidance` over a served kernel (so the assistant's tools exist), with the model a
// stand-in in-process: the no-new-numbers guard over what the turn read, the nightly cap, read-only tools, a provider
// that fails, and a store whose provider cannot run guidance. Insights are seeded through the repository; the brief
// is read over HTTP and the two guidance columns on a second connection.

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminSession

beforeAll(async () => {
  k = await createKernel({
    dialect: 'sqlite',
    appOptions: { nightShift: { intervalMs: 3_600_000, now: () => NOW } },
  })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

beforeEach(async () => {
  await resetNight(k)
})

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** A model that asks for nothing and answers every turn with `text`. */
const answering = (text: string) => guidanceModel(() => ({ text }))

// ---- AC-4: the guard over what the turn read ------------------------------------------------------------------

describe('AC-4: a reply is shown only when every figure in it is one the turn read', () => {
  const SUMMARY = 'Shoppers searched for tartan 5 times yesterday and found nothing.'
  const FACTS = { term: 'tartan', searches: 5 }
  /** An insight of another night the turn reads through admin_insights_list: its id, date and figure are tool data. */
  const OTHER_ID = '0193a1b2-4417-7000-8000-00000000aa01'
  const OTHER_DAY = '2026-03-27'
  const LONG = 'Look again at what shoppers typed and add what they could not find. '
    .repeat(10)
    .trim()

  const cases: Array<{ name: string; reply: string; status: 'written' | 'withheld' }> = [
    {
      name: 'a figure in neither the prompt nor any result',
      reply: 'Stock up on tartan before the 9137 orders arrive.',
      status: 'withheld',
    },
    {
      name: 'a figure only a tool result held',
      reply: 'The lamp shows 8761 units; check its listing too.',
      status: 'written',
    },
    {
      name: 'a figure from the prompt',
      reply: 'Those 5 searches found nothing; add a tartan product.',
      status: 'written',
    },
    {
      name: 'digits found only inside an id the result held',
      reply: 'Look at the 4417 searches behind it.',
      status: 'withheld',
    },
    {
      name: 'the day of a date the result held, written alone',
      reply: 'Compare it with the insight from day 27.',
      status: 'withheld',
    },
    {
      name: 'a date the result held, quoted whole',
      reply: `Compare it with the insight of ${OTHER_DAY}.`,
      status: 'written',
    },
    { name: 'a reply over 600 characters', reply: LONG, status: 'withheld' },
  ]

  it.each(cases)('AC-4: $name is $status', async ({ reply, status }) => {
    const id = await seedGuided(k, {
      job: 'zero-result-term',
      subject: 'term:tartan',
      runDay: RUN_DAY,
      severity: 'info',
      summary: SUMMARY,
      facts: FACTS,
      createdAt: NOW,
    })
    await seedGuided(k, {
      id: OTHER_ID,
      job: 'stock-runway',
      subject: 'variant:lamp',
      runDay: OTHER_DAY,
      severity: 'warning',
      summary: 'The lamp runs out soon.',
      facts: { units: 8761 },
      createdAt: noonOf('2026-03-26'),
    })
    const model = guidanceModel(
      (request: GuidanceRequest): GuidanceReply =>
        opensTurn(request)
          ? { calls: [{ name: 'admin_insights_list', args: {} }] }
          : { text: reply },
    )
    const before = (await briefOf(admin)).get(id)!

    const runs: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)

    const read = model.requests.flatMap(toolMessages).join('\n')
    expect([read.includes('8761'), read.includes(OTHER_ID), read.includes(OTHER_DAY)]).toEqual([
      true,
      true,
      true,
    ])
    expect(runs.map((r) => [r.insightId, r.status])).toEqual([[id, status]])
    const after = (await briefOf(admin)).get(id)!
    expect({ guidance: after.guidance, guidanceWithheld: after.guidanceWithheld }).toEqual(
      status === 'written'
        ? { guidance: reply, guidanceWithheld: false }
        : { guidance: null, guidanceWithheld: true },
    )
    expect({ summary: after.summary, facts: after.facts }).toEqual({
      summary: before.summary,
      facts: before.facts,
    })
    expect((await guidanceColumns(raw)).get(id)).toEqual({
      guidance: status === 'written' ? reply : null,
      status,
    })
  })

  it('AC-4: the reply is cut at the limit the spec names: one character over it is withheld, at it is written', async () => {
    const atLimit = `${'a'.repeat(GUIDANCE_MAX_CHARS - 1)}.`
    const ids: string[] = []
    for (const [n, subject] of ['term:at-limit', 'term:over-limit'].entries()) {
      ids.push(
        await seedGuided(k, {
          job: 'zero-result-term',
          subject,
          runDay: RUN_DAY,
          severity: 'info',
          summary: `Nobody found ${subject}.`,
          createdAt: new Date(NOW.getTime() + n * 60_000),
        }),
      )
    }
    const model = guidanceModel((request) => {
      const prompt = request.messages[0]?.role === 'user' ? request.messages[0].content : ''
      return { text: prompt.includes('term:over-limit') ? `${atLimit}b` : atLimit }
    })

    const runs: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)

    expect(GUIDANCE_MAX_CHARS).toBe(600)
    expect(runs.map((r) => [r.insightId, r.status, r.reason])).toEqual([
      [ids[0], 'written', undefined],
      [ids[1], 'withheld', 'too_long'],
    ])
  })

  it('AC-4: a list result cut at the limit sources none of the counts its cut field names: a reply quoting them is withheld', async () => {
    const id = await seedGuided(k, {
      job: 'zero-result-term',
      subject: 'term:tartan',
      runDay: RUN_DAY,
      severity: 'info',
      summary: SUMMARY,
      facts: FACTS,
      createdAt: NOW,
    })
    const letters = 'abcdefghij'
    for (let i = 0; i < 40; i += 1) {
      await seedGuided(k, {
        job: 'stock-runway',
        subject: `variant:lamp-${letters[i % 10]}${letters[Math.floor(i / 10)]}`,
        runDay: OTHER_DAY,
        severity: 'warning',
        summary: 'The lamp runs out soon; reorder it before the weekend. '.repeat(10).trim(),
        createdAt: noonOf('2026-03-26'),
      })
    }
    let replied = ''
    const model = guidanceModel((request: GuidanceRequest): GuidanceReply => {
      if (opensTurn(request)) return { calls: [{ name: 'admin_insights_list', args: {} }] }
      const listed = JSON.parse(toolMessages(request)[0]!) as { cut?: string }
      const [, notShown, of] = /^(\d+) of (\d+) items not shown/.exec(listed.cut ?? '') ?? []
      replied = `${notShown} of the ${of} open insights were not read; ask for fewer.`
      return { text: replied }
    })

    const runs: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)

    expect(replied).toMatch(/^\d+ of the 41 open insights were not read/)
    expect(runs.map((r) => [r.insightId, r.status, r.reason])).toEqual([
      [id, 'withheld', 'unsourced_number'],
    ])
    expect((await guidanceColumns(raw)).get(id)).toEqual({ guidance: null, status: 'withheld' })
  })
})

// ---- AC-5 and AC-10: the nightly cap ----------------------------------------------------------------------------

const GUIDED_SEVEN: Array<{ job: string; severity: InsightSeverity; letter: string }> = [
  { job: 'zero-result-term', severity: 'info', letter: 'Alder' },
  { job: 'refund-rate', severity: 'critical', letter: 'Birch' },
  { job: 'demand', severity: 'warning', letter: 'Cedar' },
  { job: 'zero-result-term', severity: 'info', letter: 'Dogwood' },
  { job: 'demand', severity: 'critical', letter: 'Elm' },
  { job: 'zero-result-term', severity: 'warning', letter: 'Fir' },
  { job: 'zero-result-term', severity: 'info', letter: 'Gum' },
]

interface Seeded {
  id: string
  summary: string
  severity: InsightSeverity
  createdAt: Date
}

/** `n` guided insights of tonight, each a minute older than the one after it. */
async function seedGuidedNight(n: number): Promise<Seeded[]> {
  const seeded: Seeded[] = []
  for (const [i, seed] of GUIDED_SEVEN.slice(0, n).entries()) {
    const summary = `Seeded ${seed.job} insight about ${seed.letter}.`
    const createdAt = new Date(NOW.getTime() - (n - i) * 60_000)
    const id = await seedGuided(k, {
      job: seed.job,
      subject: `subject:${seed.letter}`,
      runDay: RUN_DAY,
      severity: seed.severity,
      summary,
      createdAt,
    })
    seeded.push({ id, summary, severity: seed.severity, createdAt })
  }
  return seeded
}

/** The seeded insights in the order the pass takes them: the most serious first, then the oldest. */
const passOrder = (seeded: Seeded[]) =>
  [...seeded].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.createdAt.getTime() - b.createdAt.getTime(),
  )

/** The seeded insight each turn opened on, in the order the turns ran. */
const turnOrder = (model: ReturnType<typeof guidanceModel>, seeded: Seeded[]) =>
  model.turns().map(({ prompt }) => seeded.find((s) => prompt.includes(s.summary))?.id)

describe('AC-5: at most maxInsightsPerNight insights of one night are sent to the model', () => {
  it('AC-5: with 7 guided insights and the default config exactly 5 turns run, the most serious first and then the oldest; the other 2 show no guidance and are not withheld; a later pass the same night runs none', async () => {
    const seeded = await seedGuidedNight(7)
    const model = answering('Look at it again tomorrow.')

    const first: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)
    const requestsAfterFirst = model.requests.length
    const later: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)

    const order = passOrder(seeded)
    expect(turnOrder(model, seeded)).toEqual(order.slice(0, 5).map((s) => s.id))
    expect(first.map((r) => r.insightId)).toEqual(order.slice(0, 5).map((s) => s.id))
    expect(later).toEqual([])
    expect(model.requests.length).toBe(requestsAfterFirst)
    const brief = await briefOf(admin)
    const left = order.slice(5)
    expect(left.map((s) => [brief.get(s.id)?.guidance, brief.get(s.id)?.guidanceWithheld])).toEqual(
      left.map(() => [null, false]),
    )
    const columns = await guidanceColumns(raw)
    expect(seeded.filter((s) => columns.get(s.id)?.status != null)).toHaveLength(5)
  })

  it('AC-5: with nightShift.ai.maxInsightsPerNight 0 no turn runs and no insight gets a guidance status', async () => {
    const seeded = await seedGuidedNight(3)
    const model = answering('Look at it again tomorrow.')
    const config = {
      ...k.config,
      nightShift: { ...k.config.nightShift, ai: { maxInsightsPerNight: 0 } },
    } as NymbalConfig

    const runs: GuidanceRun[] = await runGuidance(depsFor(k, model.ai, { config }), RUN_DAY)

    expect(runs).toEqual([])
    expect(model.requests).toHaveLength(0)
    const columns = await guidanceColumns(raw)
    expect(seeded.map((s) => columns.get(s.id)?.status)).toEqual(seeded.map(() => null))
  })
})

describe('AC-10: a config with no nightShift.ai reads the default cap', () => {
  it('AC-10: guidanceDeps given a config the schema never parsed, with no nightShift.ai, sends 5 of 6 guided insights, as the default does', async () => {
    const seeded = await seedGuidedNight(6)
    const model = answering('Look at it again tomorrow.')
    const config = { ...k.config, nightShift: { enabled: true, at: '03:00' } } as NymbalConfig

    const runs: GuidanceRun[] = await runGuidance(depsFor(k, model.ai, { config }), RUN_DAY)

    expect(runs.map((r) => r.insightId)).toEqual(
      passOrder(seeded)
        .slice(0, 5)
        .map((s) => s.id),
    )
    expect(model.turns()).toHaveLength(runs.length)
  })
})

// ---- AC-7: read-only -------------------------------------------------------------------------------------------

describe('AC-7: a guidance turn is offered read tools without customer details, and changes nothing', () => {
  const MISS = 'search.zero_results.v1'

  /** What a turn could change: proposals, the audit trail, products, stock, orders, the search figures and misses. */
  async function storeState() {
    await k.app.relay.drain()
    return {
      proposals: await raw.rows('SELECT * FROM proposals ORDER BY id'),
      audit: await raw.rows('SELECT * FROM audit_entries ORDER BY id'),
      products: await raw.rows('SELECT * FROM products ORDER BY id'),
      variants: await raw.rows('SELECT * FROM variants ORDER BY id'),
      orders: await raw.rows('SELECT * FROM orders ORDER BY id'),
      searches: await raw.rows('SELECT * FROM report_search_days ORDER BY local_day, term'),
      misses: await raw.count('events', 'type = ?', [MISS]),
    }
  }

  it('AC-7: property: whatever tools the model asks for across the store’s whole tool list, every request offers exactly the read tools the assistant offers under customerData false, every other call is refused and listed with its code, and the store is as it was', async () => {
    const surface = k.app.assistantTools!
    const listed = surface.list(GUIDANCE_CALLER)
    const offered = assistantTools(listed, { customerData: false })
      .filter((tool: ToolDefinition) => tool.kind === 'read')
      .map((tool) => tool.name)
      .sort()
    const universe = [
      ...new Set([...listed.map((t) => t.name), 'orders_get', 'assistant_page', 'no_such_tool']),
    ]
    const product = await seedVariant(k, 5)
    const argsFor = (name: string): Record<string, unknown> =>
      name === 'products_search'
        ? { q: 'nothing-matches-this', origin: 'page' }
        : name.startsWith('admin_products_')
          ? { id: product.productId, name: 'Renamed by a turn', stock: 0 }
          : { id: product.productId }

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.constantFrom(...universe), { minLength: 1, maxLength: 9 }), {
          minLength: 1,
          maxLength: 3,
        }),
        async (drawn) => {
          // Every turn also searches as the storefront's search page does, for a term nothing matches.
          const batches = [['products_search', ...drawn[0]!], ...drawn.slice(1)]
          await resetNight(k)
          await seedGuided(k, {
            job: 'demand',
            subject: 'orders',
            runDay: RUN_DAY,
            severity: 'warning',
            summary: 'Paid orders fell below the usual week.',
            createdAt: NOW,
          })
          const model = guidanceModel((request) => {
            const step = request.index
            return step < batches.length
              ? { calls: batches[step]!.map((name) => ({ name, args: argsFor(name) })) }
              : { text: 'Nothing to change.' }
          })
          const before = await storeState()

          const [run] = (await runGuidance(depsFor(k, model.ai), RUN_DAY)) as [GuidanceRun]

          expect(model.requests.map((r) => [...r.tools].sort())).toEqual(
            model.requests.map(() => offered),
          )
          expect(run.calls.map((c: GuidanceCall) => c.name)).toEqual(batches.flat())
          const refused = run.calls.filter((c: GuidanceCall) => !offered.includes(c.name))
          expect(refused.map((c: GuidanceCall) => [c.name, c.ok, typeof c.code])).toEqual(
            refused.map((c: GuidanceCall) => [c.name, false, 'string']),
          )
          expect(await storeState()).toEqual(before)
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)
})

// ---- AC-8: a provider that fails --------------------------------------------------------------------------------

describe('AC-8: a provider that fails leaves that insight failed and the night as it was', () => {
  const TEXT = 'Look at the search terms again tomorrow.'

  it.each([
    { name: 'throws', fault: 'throw' as const },
    { name: 'outlasts turnMs', fault: 'hang' as const },
    { name: 'answers nothing', fault: 'empty' as const },
  ])(
    'AC-8: a provider that $name on the first insight leaves it failed; the next still gets its turn; every run row and insight is as the night left it',
    async ({ fault }) => {
      await applyFigures(k, [searchedOn(DATA_DAY, 'wool socks', 3)])
      const failing = await seedGuided(k, {
        job: 'refund-rate',
        subject: 'store',
        runDay: RUN_DAY,
        severity: 'critical',
        summary: 'Refunds rose above the usual rate.',
        createdAt: NOW,
      })
      await runNightShift(depsOf(k), NOW)
      const night = { runs: await runRows(raw), insights: await insightRows(raw) }
      const written = night.insights.find((r) => r.job === 'zero-result-term')!
      const model = guidanceModel((request): GuidanceReply => {
        const prompt = request.messages[0]?.role === 'user' ? request.messages[0].content : ''
        if (!prompt.includes('Refunds rose above the usual rate.')) return { text: TEXT }
        return fault === 'empty' ? { text: '' } : fault
      })
      const deps = { ...depsFor(k, model.ai), limits: { maxSteps: 4, turnMs: 300 } }

      const runs: GuidanceRun[] = await runGuidance(deps, RUN_DAY)

      expect(runs.map((r) => [r.insightId, r.status])).toEqual([
        [failing, 'failed'],
        [written.id, 'written'],
      ])
      const brief = await briefOf(admin)
      expect(
        [failing, written.id].map((id) => [
          brief.get(id)?.guidance,
          brief.get(id)?.guidanceWithheld,
        ]),
      ).toEqual([
        [null, false],
        [TEXT, false],
      ])
      expect((await guidanceColumns(raw)).get(failing)).toEqual({
        guidance: null,
        status: 'failed',
      })
      expect({ runs: await runRows(raw), insights: await insightRows(raw) }).toEqual(night)
    },
  )
})

// ---- AC-9: off ---------------------------------------------------------------------------------------------------

describe('AC-9: a store whose provider cannot run guidance gets the brief it has today', () => {
  const apps: TickingApp[] = []

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
    vi.useRealTimers()
  })

  const start = (opts: Parameters<Parameters<typeof tickingApp>[0]>[0]) =>
    createKernel({ dialect: 'sqlite', ...opts })

  it('AC-9: with ai none, or a provider without the tools capability, the night writes the insights and events a provider with tools gets, and no insight has a guidance status', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const noTools = guidanceModel(() => ({ text: 'Should never be asked.' }), ['complete', 'chat'])
    const withTools = answering('Look at it again tomorrow.')
    for (const ai of ['none' as const, noTools.ai, withTools.ai])
      apps.push(await tickingApp(start, ai))
    for (const app of apps) await seedNight(app.k)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    await vi.waitFor(
      async () => {
        for (const app of apps) {
          expect((await runRows(app.raw)).map((r) => r.status)).toEqual(
            NIGHT_SHIFT_JOBS.map(() => 'done'),
          )
        }
        const rows = await insightRows(apps[2]!.raw)
        const columns = await guidanceColumns(apps[2]!.raw)
        const guided = rows.filter((r) => (GUIDED_JOBS as readonly string[]).includes(r.job))
        expect(guided.map((r) => columns.get(r.id)?.status)).toEqual(guided.map(() => 'written'))
      },
      { timeout: 15_000 },
    )
    await vi.advanceTimersByTimeAsync(3 * TICK_MS)

    const shapeOf = async (app: TickingApp) => ({
      insights: (await insightRows(app.raw)).map(({ id: _id, ...rest }) => rest),
      events: (await insightEvents(app.raw)).map(({ insightId: _id, ...rest }) => rest),
    })
    const [none, without, withProvider] = await Promise.all(apps.map(shapeOf))
    expect(none).toEqual(withProvider)
    expect(without).toEqual(withProvider)
    for (const app of apps.slice(0, 2)) {
      const statuses = [...(await guidanceColumns(app.raw)).values()].map((c) => c.status)
      expect(statuses).toEqual(statuses.map(() => null))
    }
    expect(noTools.requests).toHaveLength(0)
  }, 60_000)
})
