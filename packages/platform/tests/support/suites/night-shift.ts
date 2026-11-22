import type { Order, OrderSource } from '@nymbalhq/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NIGHT_SHIFT_JOBS, type NightShiftJob } from '../../../src/night-shift/jobs.js'
import { runNightShift, type JobRun } from '../../../src/night-shift/runner.js'
import type { InsightRecord } from '../../../src/repositories/insight.js'
import type { Kernel } from '../kernel.js'
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
  insightEvents,
  insightRows,
  noonOf,
  numbersNotInFacts,
  resetNight,
  runRows,
  runTwice,
  searchedOn,
  seedDeadEvent,
  seedInsight,
  seedRefund,
  seedSettledProposal,
  shippedJob,
  spreadPaid,
} from '../night-shift.js'
import { openRaw, type RawReader } from '../raw.js'
import { SYNTHETIC, seedOrder } from '../report-rollups.js'
import { clockAt, openReplica, type Replica } from '../replica.js'

// The night shift's new SQL on one dialect: the refund count and its windows, the operator checks, the claim two
// replicas race for, the suppression of a subject already raised, and an insight's facts as the row and its event
// carry them. Figures go in through the rollup repository, faults through their own repositories; the night runs
// through `runNightShift`, and the tables are read back on a second connection.

export function nightShiftSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`night shift (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    const replicas: Replica[] = []

    beforeAll(async () => {
      k = await start()
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

    const orderOf = (source: string): Promise<Order> =>
      seedOrder(k, { source: source as OrderSource })

    /** Paid orders over the 28 baseline days and the 7 days of the week, from a storefront. */
    async function paidFigures(baseline: number, week: number): Promise<void> {
      await applyFigures(k, [
        ...spreadPaid(baseline, daysRange(34, 7)),
        ...(week > 0 ? spreadPaid(week, daysRange(6, 0)) : []),
      ])
    }

    /** `n` succeeded admin refunds of `order`, one a day back from `fromBack`. */
    async function refundsFrom(order: Order, n: number, fromBack: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(fromBack - (i % 7))) })
      }
    }

    const refundRate = [shippedJob('refund-rate')]

    async function refundNight() {
      await runTwice(k, NOW, refundRate)
      return {
        rows: await insightRows(raw, 'refund-rate'),
        events: await insightEvents(raw, 'refund-rate'),
      }
    }

    describe('AC-10: refund rate fires on a spike in the last 7 days against the 28 before', () => {
      it(`AC-10: baseline 300 paid / 4 refunds, week 70 paid / 5 refunds makes one insight about the store, with the figures it compared, rates to one decimal (${dialect})`, async () => {
        const order = await orderOf('storefront')
        await paidFigures(300, 70)
        await refundsFrom(order, 4, 30)
        await refundsFrom(order, 5, 6)

        const { rows, events } = await refundNight()

        expect(rows.map((r) => r.subject)).toEqual(['store'])
        expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
        const facts = rows[0]!.facts
        expect(facts).toMatchObject({
          refunds: 5,
          paidOrders: 70,
          baselineRefunds: 4,
          baselinePaidOrders: 300,
        })
        expect(facts['ratePercent']).toBe(Math.round((5 / 70) * 100 * 10) / 10)
        expect(facts['baselineRatePercent']).toBe(Math.round((4 / 300) * 100 * 10) / 10)
        expect(numbersNotInFacts(rows[0]!.summary, facts)).toEqual([])
      })

      it(`AC-10: baseline 400 / 8 against week 100 / 5 is exactly twice the rate and fires; 3 more refunds on the day before the baseline leave it firing with the same baseline (${dialect})`, async () => {
        const order = await orderOf('storefront')
        await paidFigures(400, 100)
        await refundsFrom(order, 8, 30)
        await refundsFrom(order, 5, 6)
        for (let i = 0; i < 3; i += 1)
          await seedRefund(k, { orderId: order.id, at: noonOf(daysBack(35)) })

        const { rows, events } = await refundNight()

        expect(rows.map((r) => r.subject)).toEqual(['store'])
        expect(events).toHaveLength(rows.length)
        expect(rows[0]!.facts['baselineRefunds']).toBe(8)
        expect(rows[0]!.facts['refunds']).toBe(5)
        expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
      })

      it(`AC-10: under the minimum (week 100 / 4), under twice the baseline (400 / 20 against 100 / 5), or no paid order in the week, writes nothing (${dialect})`, async () => {
        const cases: Array<{ baseline: [number, number]; week: [number, number] }> = [
          { baseline: [400, 4], week: [100, 4] },
          { baseline: [400, 20], week: [100, 5] },
          { baseline: [400, 4], week: [0, 5] },
        ]
        const written: number[] = []
        for (const { baseline, week } of cases) {
          await resetNight(k)
          const order = await orderOf('storefront')
          await paidFigures(baseline[0], week[0])
          await refundsFrom(order, baseline[1], 30)
          await refundsFrom(order, week[1], 6)
          const { rows, events } = await refundNight()
          const [run] = (await runRows(raw)).filter((r) => r.job === 'refund-rate')
          expect(run?.status).toBe('done')
          written.push(rows.length + events.length)
        }
        expect(written).toEqual(cases.map(() => 0))
      })
    })

    describe('AC-11: refund rate counts only refunds a shopper of a real order got', () => {
      async function weekOfFour(): Promise<Order> {
        const order = await orderOf('storefront')
        await paidFigures(400, 100)
        await refundsFrom(order, 4, 30)
        // Four counted in the week, one of them the provider's own (a dashboard refund still paid a shopper back).
        await refundsFrom(order, 3, 6)
        await seedRefund(k, {
          orderId: order.id,
          at: noonOf(daysBack(2)),
          actor: 'system:provider',
        })
        return order
      }

      it(`AC-11: a refund made at 00:30 store time on the week's first day counts on that day, which is the fifth refund of the week (${dialect})`, async () => {
        const order = await weekOfFour()
        // 23:30 UTC on the day before the week is 00:30 BST on its first day.
        await seedRefund(k, { orderId: order.id, at: new Date(`${daysBack(7)}T23:30:00.000Z`) })

        const { rows } = await refundNight()

        expect(rows.map((r) => r.subject)).toEqual(['store'])
        expect(rows[0]!.facts['refunds']).toBe(5)
        expect(rows[0]!.facts['baselineRefunds']).toBe(4)
      })

      it(`AC-11: refunds of synthetic and imported orders, a capture refunded on a cancelled order, pending and failed refunds, and one made after the data day ended in store time do not count, so four counted refunds stay under the minimum (${dialect})`, async () => {
        const order = await weekOfFour()
        const synthetic = await orderOf(SYNTHETIC)
        const imported = await orderOf('import')
        const at = noonOf(daysBack(1))
        await seedRefund(k, { orderId: synthetic.id, at })
        await seedRefund(k, { orderId: imported.id, at })
        await seedRefund(k, {
          orderId: order.id,
          at,
          actor: 'system:checkout',
          reason: 'captured for a cancelled order',
        })
        await seedRefund(k, { orderId: order.id, at, status: 'pending' })
        await seedRefund(k, { orderId: order.id, at, status: 'failed' })
        // 23:30 UTC on the data day is 00:30 BST on the run day: not in the week the night reports on.
        await seedRefund(k, { orderId: order.id, at: new Date(`${DATA_DAY}T23:30:00.000Z`) })

        const { rows, events } = await refundNight()

        expect(rows.length + events.length).toBe(0)
        const [run] = (await runRows(raw)).filter((r) => r.job === 'refund-rate')
        expect(run?.status).toBe('done')
      })
    })

    describe('AC-12: operator health raises each fault once and is quiet on a healthy store', () => {
      const health = [shippedJob('operator-health')]

      async function healthNight() {
        await runTwice(k, NOW, health)
        return {
          rows: await insightRows(raw, 'operator-health'),
          events: await insightEvents(raw, 'operator-health'),
        }
      }

      it(`AC-12: one dead event makes one events.dead insight counting it (${dialect})`, async () => {
        await seedDeadEvent(k)

        const { rows, events } = await healthNight()

        expect(rows.map((r) => r.subject)).toEqual(['events.dead'])
        expect(rows[0]!.facts['deadEvents']).toBe(1)
        expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
        expect(events.map((e) => e.insightId)).toEqual(rows.map((r) => r.id))
      })

      it(`AC-12: a proposal settled with an unknown outcome on the data day makes one insight counting only it, not one settled two days earlier nor one that failed for another reason (${dialect})`, async () => {
        await seedSettledProposal(k, noonOf(DATA_DAY))
        await seedSettledProposal(k, noonOf(daysBack(2)))
        await seedSettledProposal(k, noonOf(DATA_DAY), 'proposal.interrupted')

        const { rows, events } = await healthNight()

        expect(rows.map((r) => r.subject)).toEqual(['proposals.outcome-unknown'])
        expect(rows[0]!.facts['proposals']).toBe(1)
        expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
        expect(events).toHaveLength(rows.length)
      })

      it(`AC-12: yesterday's failed demand run makes one night-shift.failed insight naming it (${dialect})`, async () => {
        const failing: NightShiftJob = {
          id: 'demand',
          run: async () => {
            throw new Error('the rollups could not be read')
          },
        }
        await runNightShift(depsOf(k, [failing]), new Date(NOW.getTime() - DAY_MS))

        const { rows, events } = await healthNight()

        expect(rows.map((r) => r.subject)).toEqual(['night-shift.failed'])
        expect(rows[0]!.facts).toMatchObject({ failedJobs: 'demand', runs: 1 })
        expect(numbersNotInFacts(rows[0]!.summary, rows[0]!.facts)).toEqual([])
        expect(events).toHaveLength(rows.length)
      })

      it(`AC-12: a healthy store gets no operator insight and its run is done with none (${dialect})`, async () => {
        await seedSettledProposal(k, noonOf(DATA_DAY), 'proposal.interrupted')

        const { rows, events } = await healthNight()

        expect(rows.length + events.length).toBe(0)
        expect((await runRows(raw)).filter((r) => r.job === 'operator-health')).toEqual([
          { job: 'operator-health', runDay: RUN_DAY, status: 'done', insights: 0, error: null },
        ])
      })
    })

    describe('AC-15: two replicas started together run each job once', () => {
      it(`AC-15: each job is claimed by exactly one of two runs started at once on two connections, the other answers claimed: false with nothing created, and each subject has one insight and one event (${dialect})`, async () => {
        const replica = await openReplica(k.dialect, k.target, { clock: clockAt(NOW) })
        replicas.push(replica)
        await seedDeadEvent(k)
        await applyFigures(k, [searchedOn(DATA_DAY, 'wool socks', 3)])

        const [mine, theirs] = await Promise.all([
          runNightShift(depsOf(k), NOW),
          runNightShift(depsOf(replica), NOW),
        ])

        const ids: string[] = NIGHT_SHIFT_JOBS.map((j: NightShiftJob) => j.id)
        const claimedBy = (runs: JobRun[], id: string) => Number(runs.find((r) => r.job === id)?.claimed === true)
        const claims = ids.map((id) => claimedBy(mine, id) + claimedBy(theirs, id))
        expect(claims).toEqual(ids.map(() => 1))
        const unclaimed = [...mine, ...theirs].filter((r) => !r.claimed)
        expect(unclaimed.map((r) => r.job).sort()).toEqual([...ids].sort())
        expect(unclaimed.flatMap((r) => r.created)).toEqual([])

        const rows = await insightRows(raw)
        expect(rows.map((r) => `${r.job}/${r.subject}`).sort()).toEqual([
          'operator-health/events.dead',
          'zero-result-term/term:wool socks',
        ])
        expect((await insightEvents(raw)).map((e) => e.insightId).sort()).toEqual(
          rows.map((r) => r.id).sort(),
        )
        expect((await runRows(raw)).map((r) => r.job).sort()).toEqual([...ids].sort())
      })
    })

    describe('AC-16: a subject already raised is not raised again for a while', () => {
      it(`AC-16: a subject open from an earlier day and one dismissed 3 days ago are skipped; one dismissed 8 days ago and a new one fire (${dialect})`, async () => {
        const job: NightShiftJob = {
          id: 'probe-suppress',
          run: async () => [
            draft('open-earlier'),
            draft('dismissed-3'),
            draft('dismissed-8'),
            draft('fresh'),
          ],
        }
        await seedInsight(k, {
          job: job.id,
          subject: 'open-earlier',
          runDay: daysBack(9),
          status: 'open',
          dismissedAt: null,
        })
        await seedInsight(k, {
          job: job.id,
          subject: 'dismissed-3',
          runDay: daysBack(5),
          status: 'dismissed',
          dismissedAt: new Date(NOW.getTime() - 3 * DAY_MS),
        })
        await seedInsight(k, {
          job: job.id,
          subject: 'dismissed-8',
          runDay: daysBack(12),
          status: 'dismissed',
          dismissedAt: new Date(NOW.getTime() - 8 * DAY_MS),
        })

        const runs = await runNightShift(depsOf(k, [job]), NOW)

        expect(runs[0]!.created.map((r: InsightRecord) => r.subject).sort()).toEqual(['dismissed-8', 'fresh'])
        const tonight = (await insightRows(raw, job.id)).filter((r) => r.runDay === RUN_DAY)
        expect(tonight.map((r) => r.subject)).toEqual(['dismissed-8', 'fresh'])
        expect((await insightEvents(raw, job.id)).map((e) => e.subject).sort()).toEqual([
          'dismissed-8',
          'fresh',
        ])
      })
    })

    describe('AC-20: an insight row and its event carry the same figures', () => {
      it(`AC-20: list() answers the insight with the id, job, subject, day, summary and facts of its event, numbers as numbers (${dialect})`, async () => {
        const facts = { units: 3, share: 12.5, label: 'Size 42', missing: null }
        const job: NightShiftJob = {
          id: 'probe-facts',
          read: async () => null,
          detect: () => [
            { subject: 'facts', severity: 'info', summary: 'Probe of 3 units at 12.5.', facts },
          ],
        }

        await runNightShift(depsOf(k, [job]), NOW)

        const listed: InsightRecord[] = await k.store.read((tx) => k.repos.insight.list(tx, { job: job.id }))
        const events = await insightEvents(raw, job.id)
        expect(listed).toHaveLength(1)
        expect(events).toHaveLength(1)
        const [record] = listed
        const [payload] = events
        expect({
          insightId: record!.id,
          job: record!.job,
          subject: record!.subject,
          day: record!.runDay,
          summary: record!.summary,
          facts: record!.facts,
        }).toEqual({
          insightId: payload!.insightId,
          job: payload!.job,
          subject: payload!.subject,
          day: payload!.day,
          summary: payload!.summary,
          facts: payload!.facts,
        })
        expect(record!.facts).toEqual(facts)
        expect(payload!.day).toBe(RUN_DAY)
        expect(payload!.dataDay).toBe(DATA_DAY)
      })
    })
  })
}
