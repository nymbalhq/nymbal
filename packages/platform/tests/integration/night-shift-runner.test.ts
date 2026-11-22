import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openTransaction, type Tx } from '../../src/db/command-store.js'
import type { InsightDraft, NightShiftContext, NightShiftJob } from '../../src/night-shift/jobs.js'
import { runNightShift, type JobRun, type NightShiftDeps } from '../../src/night-shift/runner.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import {
  DATA_DAY,
  DAY_MS,
  NOW,
  RUN_DAY,
  applyFigures,
  daysBack,
  daysRange,
  depsOf,
  draft,
  funnelOn,
  insightEvents,
  insightRows,
  paidOn,
  resetNight,
  runRows,
  searchedOn,
  seedDeadEvent,
  seedRefund,
  seedSettledProposal,
  soldOn,
  spreadPaid,
} from '../support/night-shift.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { noonOf, seedOrder } from '../support/report-rollups.js'
import { clockAt, openReplica, type Replica } from '../support/replica.js'

// The runner's rules over any job: a night run again changes nothing (R1), a job that throws leaves no trace but its
// failed run, and a job of the second kind (`run`, outside any transaction) is held to the same claim, cap and
// suppression as the others.

const NEXT_NIGHT = new Date(NOW.getTime() + DAY_MS)

describe('AC-14: R1, a night run again changes nothing', () => {
  type Fault = 'stock' | 'term' | 'orders' | 'checkout' | 'refunds' | 'operator'
  const FAULTS: Fault[] = ['stock', 'term', 'orders', 'checkout', 'refunds', 'operator']

  /** The faults of the six fixtures, seeded together; orders and checkout share one storefront series. */
  async function seedFaults(k: Kernel, faults: ReadonlySet<Fault>): Promise<void> {
    if (faults.has('stock')) {
      const seeded = await seedVariant(k, 5)
      const v = { ...seeded, productName: 'Merino crew sock', sku: 'MCS-42' }
      await applyFigures(
        k,
        daysRange(27, 0).map((day) => soldOn(day, v, 1)),
      )
    }
    if (faults.has('term')) await applyFigures(k, [searchedOn(DATA_DAY, 'wool socks', 3)])
    if (faults.has('orders') || faults.has('checkout')) {
      const checkout = faults.has('checkout')
      const perDay = checkout ? 16 : 10
      const onDataDay = faults.has('orders') ? 3 : 8
      await applyFigures(k, [
        ...daysRange(7, 1).map((day) => paidOn(day, perDay)),
        paidOn(DATA_DAY, onDataDay),
        ...(checkout ? daysRange(7, 0).map((day) => funnelOn(day, { checkoutsStarted: 20 })) : []),
      ])
    }
    if (faults.has('refunds')) {
      // Paid by an agent, so the storefront series the demand faults read stays as seeded.
      const order = await seedOrder(k, { source: 'agent:scout' })
      await applyFigures(k, [
        ...spreadPaid(400, daysRange(34, 7), 'agent:scout'),
        ...spreadPaid(100, daysRange(6, 0), 'agent:scout'),
      ])
      for (let i = 0; i < 4; i += 1)
        await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(20 + i)) })
      for (let i = 0; i < 5; i += 1)
        await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(i)) })
    }
    if (faults.has('operator')) {
      await seedDeadEvent(k)
      await seedSettledProposal(k, noonOf(DATA_DAY))
      const failing: NightShiftJob = {
        id: 'demand',
        run: async () => {
          throw new Error('the rollups could not be read')
        },
      }
      await runNightShift(depsOf(k, [failing]), new Date(NOW.getTime() - DAY_MS))
    }
  }

  it('AC-14: property: for any non-empty set of the fixtures’ faults in one store, the insights and insight events after k runs of the same night (k in 2..4) equal those after one, one event per insight', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(FAULTS, { minLength: 1 }),
        fc.integer({ min: 2, max: 4 }),
        async (faults, runs) => {
          const k = await createKernel({ dialect: 'sqlite' })
          const raw = openRaw(k.dialect, k.target)
          try {
            await seedFaults(k, new Set(faults))

            await runNightShift(depsOf(k), NOW)
            const once = { rows: await insightRows(raw), events: await insightEvents(raw) }
            for (let i = 1; i < runs; i += 1) await runNightShift(depsOf(k), NOW)
            const again = { rows: await insightRows(raw), events: await insightEvents(raw) }

            expect(once.rows.length).toBeGreaterThan(0)
            expect(again).toEqual(once)
            expect(again.events.map((e) => e.insightId).sort()).toEqual(
              again.rows.map((r) => r.id).sort(),
            )
          } finally {
            await raw.close()
            await k.close()
          }
        },
      ),
      { numRuns: 6 },
    )
  }, 180_000)
})

describe('the runner over jobs given in deps', () => {
  let k: Kernel
  let raw: RawReader
  const replicas: Replica[] = []

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  beforeEach(async () => {
    await resetNight(k)
  })

  afterAll(async () => {
    for (const replica of replicas.splice(0)) await replica.close()
    await raw?.close()
    await k?.close()
  })

  describe('AC-17: a job that throws leaves only its failed run', () => {
    it('AC-17: a job whose second draft cannot be written leaves its run failed with the error’s message, no insight or event from its first draft, and the job after it still runs', async () => {
      const unreadable: InsightDraft = {
        subject: 'unreadable',
        severity: 'warning',
        summary: 'A figure that cannot be read.',
        facts: {
          get count(): number {
            throw new Error('figure unavailable')
          },
        },
      }
      const throwing: NightShiftJob = {
        id: 'probe-throws',
        read: async () => null,
        detect: () => [draft('written-first'), unreadable],
      }
      const later: NightShiftJob = {
        id: 'probe-later',
        read: async () => null,
        detect: () => [draft('after')],
      }

      const runs = await runNightShift(depsOf(k, [throwing, later]), NOW)

      expect(runs.map((r: JobRun) => [r.job, r.status, r.created.length])).toEqual([
        ['probe-throws', 'failed', 0],
        ['probe-later', 'done', 1],
      ])
      expect(await runRows(raw)).toEqual([
        { job: 'probe-later', runDay: RUN_DAY, status: 'done', insights: 1, error: null },
        {
          job: 'probe-throws',
          runDay: RUN_DAY,
          status: 'failed',
          insights: 0,
          error: 'figure unavailable',
        },
      ])
      expect((await insightRows(raw)).map((r) => `${r.job}/${r.subject}`)).toEqual([
        'probe-later/after',
      ])
      expect((await insightEvents(raw)).map((e) => `${e.job}/${e.subject}`)).toEqual([
        'probe-later/after',
      ])
    })
  })

  describe('AC-21: a run job is claimed, capped and suppressed like the others, outside any transaction', () => {
    it('AC-21: across two runs on one replica and one on another, a run job is called once a night with no transaction open and its own write committed; its drafts are capped at 2, the rest surface the next night, and a throw marks its run failed', async () => {
      const replica = await openReplica(k.dialect, k.target, { clock: clockAt(NOW) })
      replicas.push(replica)
      const calls: Array<{ runDay: string; inTransaction: boolean; ownWriteSeen: number }> = []
      const probe: NightShiftJob = {
        id: 'probe-run',
        cap: 2,
        async run(deps: NightShiftDeps, ctx: NightShiftContext) {
          const marker = `probe ${ctx.runDay}`
          await deps.store.transaction((tx: Tx) =>
            deps.repos.reportRollup.apply(tx, searchedOn(ctx.dataDay, marker, 1), ctx.now),
          )
          calls.push({
            runDay: ctx.runDay,
            inTransaction: openTransaction() !== undefined,
            ownWriteSeen: await raw.count('report_search_days', 'term = ?', [marker]),
          })
          return [draft('first'), draft('second'), draft('third')]
        },
      }
      const throwing: NightShiftJob = {
        id: 'probe-run-throws',
        run: async () => {
          throw new Error('model unavailable')
        },
      }
      const jobs = [throwing, probe]

      await Promise.all([
        runNightShift(depsOf(k, jobs), NOW),
        runNightShift(depsOf(replica, jobs), NOW),
      ])
      await runNightShift(depsOf(k, jobs), NOW)
      const firstNight = await insightRows(raw, probe.id)
      await runNightShift(depsOf(k, jobs), NEXT_NIGHT)
      const both = await insightRows(raw, probe.id)

      expect(calls).toEqual([
        { runDay: RUN_DAY, inTransaction: false, ownWriteSeen: 1 },
        { runDay: '2026-07-16', inTransaction: false, ownWriteSeen: 1 },
      ])
      expect(firstNight.map((r) => r.subject)).toEqual(['first', 'second'])
      expect(both.filter((r) => r.runDay === '2026-07-16').map((r) => r.subject)).toEqual(['third'])
      expect((await insightEvents(raw, probe.id)).map((e) => e.insightId).sort()).toEqual(
        both.map((r) => r.id).sort(),
      )
      const failed = (await runRows(raw)).filter((r) => r.job === throwing.id)
      expect(failed.map((r) => [r.runDay, r.status, r.error])).toEqual([
        [RUN_DAY, 'failed', 'model unavailable'],
        ['2026-07-16', 'failed', 'model unavailable'],
      ])
    })
  })
})
