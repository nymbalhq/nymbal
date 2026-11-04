import { describe, expect, it } from 'vitest'
import type { ProposalView } from '@nymbalhq/types'
import * as platform from '../../src/index.js'
import {
  GOLDEN_ROWS,
  goldenScript,
  rowOf,
  type Deviation,
} from '../../../../tests/support/assistant-golden.js'
import {
  assistantStore,
  withAgents,
  type AssistantStore,
  type Configure,
} from '../support/assistant.js'
import type { RawReader } from '../support/raw.js'

// The assistant's golden set against the scripted model (tests/support/assistant-golden.ts), on a throwaway SQLite
// store the golden store fills (`goldenStore`: the demo seed, its orders and one pending proposal).
// - AC-16: the twenty questions (10 read, 6 write, 4 none, one per row of the scripted model) all pass; every write
//   question leaves its proposal pending and the store's products, orders, stock and refunds are as the golden store
//   made them.
// - AC-17: the evaluator is not vacuous: a script that answers one question wrongly, in each of six ways, fails that
//   question alone, with a reason naming the check.

/** What the tests read of a golden question and of a run's report (`golden.ts`, `eval.ts`). */
interface GoldenQuestion {
  id: string
  ask: string
  kind: 'read' | 'write' | 'none'
}
interface GoldenReport {
  passed: number
  total: number
  results: Array<{
    id: string
    ok: boolean
    reasons: string[]
    calls: string[]
    proposals: string[]
  }>
}
const GOLDEN_QUESTIONS = platform.GOLDEN_QUESTIONS as readonly GoldenQuestion[]
const goldenStore = platform.goldenStore as (app: AssistantStore['kernel']['app']) => Promise<void>
const runGolden = platform.runGolden as (
  app: AssistantStore['kernel']['app'],
  opts?: { only?: string[] },
) => Promise<GoldenReport>

interface Golden {
  store: AssistantStore
  report: GoldenReport
  /** The golden store's state before the run. */
  before: Awaited<ReturnType<typeof goldenState>>
}

async function goldenRun(opts: {
  configure?: Configure
  deviate?: Partial<Record<number, Deviation>>
}): Promise<Golden> {
  const store = await assistantStore(
    opts.configure === undefined ? {} : { configure: opts.configure },
  )
  try {
    await goldenStore(store.kernel.app)
    await store.kernel.app.relay.drain()
    const before = await goldenState(store.raw)
    store.standIn.script = goldenScript({
      currency: store.kernel.config.store.currency,
      ...(opts.deviate !== undefined && { deviate: opts.deviate }),
    })
    const report = await runGolden(store.kernel.app)
    return { store, report, before }
  } catch (error) {
    await store.close()
    throw error
  }
}

/** What a write would change: products, variants (price and stock), orders and refunds, as committed. */
async function goldenState(raw: RawReader) {
  return {
    products: await raw.rows('SELECT * FROM products ORDER BY id'),
    variants: await raw.rows('SELECT * FROM variants ORDER BY id'),
    orders: await raw.rows('SELECT * FROM orders ORDER BY id'),
    refunds: await raw.rows('SELECT * FROM order_refunds ORDER BY id'),
  }
}

/** The golden question a row of the scripted model answers. */
function questionOf(row: number) {
  const pattern = GOLDEN_ROWS.find((r) => r.row === row)!.ask
  const found = GOLDEN_QUESTIONS.filter((q) => pattern.test(q.ask.trim()))
  if (found.length !== 1)
    throw new Error(`row ${row}: ${found.length} golden questions match ${pattern}`)
  return found[0]!
}

describe('AC-16: the golden set passes against the scripted model and leaves the store as it was', () => {
  it('AC-16: GOLDEN_QUESTIONS holds 20 unique ids, 10 read, 6 write and 4 none, one per row of the scripted model and of that row’s kind', () => {
    const ids = GOLDEN_QUESTIONS.map((q) => q.id)
    const kinds = { read: 0, write: 0, none: 0 }
    for (const q of GOLDEN_QUESTIONS) kinds[q.kind] += 1

    expect(new Set(ids).size).toBe(GOLDEN_QUESTIONS.length)
    expect(GOLDEN_QUESTIONS.length).toBe(GOLDEN_ROWS.length)
    expect(kinds).toEqual({ read: 10, write: 6, none: 4 })
    expect(GOLDEN_QUESTIONS.map((q) => rowOf(q.ask)?.kind)).toEqual(
      GOLDEN_QUESTIONS.map((q) => q.kind),
    )
    expect(new Set(GOLDEN_QUESTIONS.map((q) => rowOf(q.ask)?.row)).size).toBe(GOLDEN_ROWS.length)
    expect(GOLDEN_ROWS.map((r) => questionOf(r.row).kind)).toEqual(GOLDEN_ROWS.map((r) => r.kind))
  })

  it('AC-16: runGolden passes 20/20; each write question kept exactly one proposal, still pending; no none question called a tool; and the products, orders, stock and refunds are what goldenStore made', async () => {
    const { store, report, before } = await goldenRun({})
    try {
      expect(store.standIn.scriptErrors).toEqual([])
      expect(report.results.filter((r) => !r.ok).map((r) => [r.id, r.reasons])).toEqual([])
      expect(report.passed).toBe(report.total)
      expect(report.total).toBe(GOLDEN_QUESTIONS.length)
      expect(report.results.map((r) => r.id)).toEqual(GOLDEN_QUESTIONS.map((q) => q.id))

      const byId = new Map(report.results.map((r) => [r.id, r]))
      const writes = GOLDEN_QUESTIONS.filter((q) => q.kind === 'write')
      const kept = writes.map((q) => byId.get(q.id)!.proposals)
      expect(kept.map((ids) => ids.length)).toEqual(writes.map(() => 1))
      const statuses = await Promise.all(
        kept.flat().map(async (id) => {
          const res = await store.admin.send<ProposalView>('GET', `/api/admin/proposals/${id}`)
          return res.body.data?.status
        }),
      )
      expect(statuses).toEqual(kept.flat().map(() => 'pending'))
      expect(
        GOLDEN_QUESTIONS.filter((q) => q.kind === 'none').flatMap((q) => byId.get(q.id)!.calls),
      ).toEqual([])
      expect(await goldenState(store.raw)).toEqual(before)
    } finally {
      await store.close()
    }
  }, 120_000)
})

describe('AC-17: the evaluator fails the question the model got wrong, and only that one', () => {
  const cases: Array<{
    way: string
    row: number
    deviate?: Deviation
    configure?: Configure
    reason: RegExp
  }> = [
    {
      way: 'a required call missing',
      row: 2,
      deviate: 'skip-required-call',
      reason: /admin_products_get/,
    },
    { way: 'a never call made', row: 19, deviate: 'never-call', reason: /admin_products_delete/ },
    {
      way: 'a write applied by policy instead of proposed',
      row: 12,
      configure: withAgents({ autoApprove: ['inventory.adjust'] }),
      reason: /appl/i,
    },
    { way: 'an extra proposal', row: 11, deviate: 'extra-proposal', reason: /proposal/i },
    { way: 'an answer without its fact', row: 1, deviate: 'no-fact', reason: /answer|fact/i },
    {
      way: 'a call on a none question',
      row: 20,
      deviate: 'call-on-none',
      reason: /admin_dashboard/,
    },
  ]

  it.each(cases)(
    'AC-17: $way (row $row) fails that question alone, with a reason naming the check, and passed is one fewer than the total',
    async ({ row, deviate, configure, reason }) => {
      const { store, report } = await goldenRun({
        ...(configure !== undefined && { configure }),
        ...(deviate !== undefined && { deviate: { [row]: deviate } }),
      })
      try {
        const failed = report.results.filter((r) => !r.ok)
        expect(store.standIn.scriptErrors).toEqual([])
        expect(failed.map((r) => r.id)).toEqual([questionOf(row).id])
        expect(report.passed).toBe(report.total - 1)
        expect(failed[0]!.reasons.join('; ')).toMatch(reason)
      } finally {
        await store.close()
      }
    },
    120_000,
  )
})
