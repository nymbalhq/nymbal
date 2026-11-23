import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUIDED_JOBS, runGuidance, type GuidanceRun } from '../../../src/night-shift/guidance.js'
import type { InsightRecord } from '../../../src/repositories/insight.js'
import { adminSession, type AdminSession } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import { NOW, RUN_DAY, addDays, insightRows, resetNight, runRows } from '../night-shift.js'
import {
  TICK_MS,
  briefOf,
  depsFor,
  guidanceColumns,
  guidanceModel,
  NIGHT_SEEDS,
  markerOf,
  seedGuided,
  seedNight,
  tickingApp,
  type StartKernel,
  type TickingApp,
} from '../guidance.js'
import { openRaw, type RawReader } from '../raw.js'
import { unaudited } from '../write-audit.js'
import { clockAt, openReplica, type Replica } from '../replica.js'

// Guidance on one dialect: the pass createApp wires into its own runner, on the runner's tick, writing what the model
// said onto the guided insights and nothing onto the others; and the claim two passes race for, so an insight is paid
// for once. The model is a stand-in in-process; insights are written by the night or seeded through the repository,
// and read back over HTTP and on a second connection.

const GUIDED: readonly string[] = GUIDED_JOBS

/** The reply a turn gets: one sentence naming the insight it was asked about, with no figure in it. */
const WORDS: Record<string, string> = {
  'zero-result-term': 'search',
  demand: 'orders',
  'refund-rate': 'refunds',
  'stock-runway': 'stock',
  'operator-health': 'health',
  'role.content': 'content',
}
const replyFor = (job: string) =>
  `Look at what sits behind the ${WORDS[job] ?? job} figure and act on what you find.`

export function insightGuidanceSuite(dialect: Kernel['dialect'], start: StartKernel): void {
  describe(`insight guidance (${dialect})`, () => {
    describe('AC-3: createApp runs guidance on its own runner’s tick, on the guided jobs only', () => {
      let app: TickingApp | undefined

      afterEach(async () => {
        await app?.close()
        app = undefined
        vi.useRealTimers()
      })

      it(`AC-3: after the night and its guidance pass each open zero-result-term, demand and refund-rate insight carries the model’s own text, answered over HTTP with guidanceWithheld false, while stock-runway, operator-health and the content role’s insights have no guidance and no turn (${dialect})`, async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
        // What a prompt about each insight quotes: the night's two by their sentences' fixed words, the seeded by theirs.
        const markers: Array<[string, string]> = [
          ['zero-result-term', 'wool socks'],
          ['operator-health', 'could not be delivered'],
          ...Object.entries(NIGHT_SEEDS).map(([job, seed]): [string, string] => [job, seed.summary]),
        ]
        const model = guidanceModel((request) => {
          const prompt = request.messages[0]?.role === 'user' ? request.messages[0].content : ''
          const about = markers.filter(([, marker]) => prompt.includes(marker))
          return { text: about.length === 1 ? replyFor(about[0]![0]) : 'Which insight?' }
        })
        app = await tickingApp(start, model.ai)
        await seedNight(app.k)
        const raw = app.raw

        await vi.advanceTimersByTimeAsync(TICK_MS)
        await vi.waitFor(
          async () => {
            const rows = await insightRows(raw)
            expect(rows.map((r) => r.job).sort()).toEqual([
              'demand',
              'operator-health',
              'refund-rate',
              'role.content',
              'stock-runway',
              'zero-result-term',
            ])
          },
          { timeout: 10_000 },
        )
        // The night wrote two of them on the tick that ran it; the next tick's pass picks them up if this one did not.
        await vi.advanceTimersByTimeAsync(TICK_MS)
        await vi.waitFor(
          async () => {
            const columns = await guidanceColumns(raw)
            const rows = await insightRows(raw)
            const settled = rows
              .filter((r) => GUIDED.includes(r.job))
              .map((r) => columns.get(r.id)?.status)
            expect(settled).toEqual(settled.map(() => 'written'))
          },
          { timeout: 15_000 },
        )
        await vi.advanceTimersByTimeAsync(3 * TICK_MS)

        const rows = await insightRows(raw)
        const columns = await guidanceColumns(raw)
        const brief = await briefOf(app.admin)
        const guided = rows.filter((r) => GUIDED.includes(r.job))
        const others = rows.filter((r) => !GUIDED.includes(r.job))
        expect(guided.map((r) => r.job).sort()).toEqual([...GUIDED].sort())
        expect(guided.map((r) => [r.job, columns.get(r.id)?.guidance])).toEqual(
          guided.map((r) => [r.job, replyFor(r.job)]),
        )
        expect(
          guided.map((r) => [r.job, brief.get(r.id)?.guidance, brief.get(r.id)?.guidanceWithheld]),
        ).toEqual(guided.map((r) => [r.job, replyFor(r.job), false]))
        expect(
          others.map((r) => [
            r.job,
            brief.get(r.id)?.guidance,
            brief.get(r.id)?.guidanceWithheld,
            columns.get(r.id)?.status,
          ]),
        ).toEqual(others.map((r) => [r.job, null, false, null]))

        const turnsAbout = model
          .turns()
          .map(({ prompt }) =>
            rows.filter((r) => prompt.includes(markerOf(r.summary))).map((r) => r.job),
          )
        expect(turnsAbout.map((jobs) => jobs.join('+')).sort()).toEqual([...GUIDED].sort())
        expect((await runRows(raw)).every((run) => run.runDay === RUN_DAY)).toBe(true)
      }, 60_000)
    })

    describe('AC-6: each insight is paid for once', () => {
      let k: Kernel
      let served: ServedKernel
      let raw: RawReader
      let admin: AdminSession
      const replicas: Replica[] = []

      beforeAll(async () => {
        k = await start({
          configure: (config) => config,
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
        for (const replica of replicas.splice(0)) await replica.close()
        await raw?.close()
        await served?.stop()
      })

      const SEEDS = [
        {
          job: 'zero-result-term',
          subject: 'term:tartan',
          severity: 'info',
          summary: 'Nobody found the tartan scarves.',
        },
        {
          job: 'demand',
          subject: 'orders',
          severity: 'warning',
          summary: 'Paid orders fell below the usual week.',
        },
        {
          job: 'demand',
          subject: 'checkout',
          severity: 'warning',
          summary: 'Fewer checkouts were started than usual.',
        },
        {
          job: 'refund-rate',
          subject: 'store',
          severity: 'critical',
          summary: 'Refunds rose above the usual rate.',
        },
      ] as const

      async function seedFour(): Promise<Map<string, string>> {
        const ids = new Map<string, string>()
        for (const [n, seed] of SEEDS.entries()) {
          const id = await seedGuided(k, {
            ...seed,
            runDay: RUN_DAY,
            createdAt: new Date(NOW.getTime() - (n + 1) * 60_000),
          })
          ids.set(id, seed.summary)
        }
        return ids
      }

      const reply = () => ({ text: 'Look at it again before the weekend.' })

      /** How many turns opened on each seeded insight, by id. */
      function turnsPer(
        model: ReturnType<typeof guidanceModel>,
        ids: Map<string, string>,
      ): Map<string, number> {
        const counts = new Map([...ids.keys()].map((id) => [id, 0]))
        for (const { prompt } of model.turns()) {
          for (const [id, summary] of ids)
            if (prompt.includes(summary)) counts.set(id, counts.get(id)! + 1)
        }
        return counts
      }

      it(`AC-6: the repository reads back what a claim and a settle leave: unguided answers exactly the unclaimed insights as seeded, facts parsed and guidance null; each read carries the text and status its settle wrote, and none where none was written (${dialect})`, async () => {
        const seeded = new Map<string, Omit<InsightRecord, 'id'>>()
        for (const [n, seed] of SEEDS.entries()) {
          const createdAt = new Date(NOW.getTime() - (n + 1) * 60_000)
          const facts = { searches: n + 2, term: seed.subject }
          const id = await seedGuided(k, { ...seed, facts, runDay: RUN_DAY, createdAt })
          seeded.set(id, {
            ...seed,
            runDay: RUN_DAY,
            dataDay: addDays(RUN_DAY, -1),
            status: 'open',
            facts,
            createdAt: createdAt.toISOString(),
            dismissedAt: null,
            guidance: null,
            guidanceStatus: null,
          })
        }
        const insights = k.repos.insight
        const unguided = () => k.store.read((tx) => insights.unguided(tx, RUN_DAY, GUIDED))
        const [written, withheld, pending] = [...seeded.keys()]
        const before = await unguided()
        const text = 'Look at it again before the weekend.'

        await unaudited(() =>
          k.store.transaction(async (tx) => {
            for (const id of [written!, withheld!, pending!]) await insights.claimGuidance(tx, id)
            await insights.settleGuidance(tx, written!, 'written', text)
            await insights.settleGuidance(tx, withheld!, 'withheld', null)
          }),
        )
        const claimed = new Map([
          [written, 'written'],
          [withheld, 'withheld'],
          [pending, 'pending'],
        ])
        const after = await unguided()
        const read = await k.store.read(async (tx) => {
          const found = new Map<string, InsightRecord | null>()
          for (const id of seeded.keys()) found.set(id, await insights.findById(tx, id))
          return found
        })

        expect(new Map(before.map(({ id, ...rest }) => [id, rest]))).toEqual(seeded)
        expect(after.map((r) => r.id)).toEqual(
          before.map((r) => r.id).filter((id) => !claimed.has(id)),
        )
        expect([...read].map(([id, r]) => [id, r?.guidance, r?.guidanceStatus, r?.facts])).toEqual(
          [...seeded].map(([id, s]) => [
            id,
            id === written ? text : null,
            claimed.get(id) ?? null,
            s.facts,
          ]),
        )
      })

      it(`AC-6: two passes started together on two connections run one turn per insight between them, and each insight is settled by exactly one of them (${dialect})`, async () => {
        const replica = await openReplica(k.dialect, k.target, { clock: clockAt(NOW) })
        replicas.push(replica)
        const ids = await seedFour()
        const model = guidanceModel(reply)
        const theirs = { ...k, store: replica.store, repos: replica.repos }

        const [mine, other] = await Promise.all([
          runGuidance(depsFor(k, model.ai), RUN_DAY),
          runGuidance(depsFor(theirs, model.ai), RUN_DAY),
        ])

        const settledBy = [...mine, ...other].map((run: GuidanceRun) => run.insightId).sort()
        expect(settledBy).toEqual([...ids.keys()].sort())
        expect([...turnsPer(model, ids).values()]).toEqual([...ids.keys()].map(() => 1))
        const columns = await guidanceColumns(raw)
        expect([...ids.keys()].map((id) => columns.get(id)?.status)).toEqual(
          [...ids.keys()].map(() => 'written'),
        )
      })

      it(`AC-6: the pass run twice runs one turn per insight; the second answers nothing and the brief keeps the first’s text (${dialect})`, async () => {
        const ids = await seedFour()
        const model = guidanceModel(reply)

        const first: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)
        const requestsAfterFirst = model.requests.length
        const second: GuidanceRun[] = await runGuidance(depsFor(k, model.ai), RUN_DAY)

        expect(first.map((run) => run.insightId).sort()).toEqual([...ids.keys()].sort())
        expect(second).toEqual([])
        expect(model.requests.length).toBe(requestsAfterFirst)
        expect([...turnsPer(model, ids).values()]).toEqual([...ids.keys()].map(() => 1))
        const brief = await briefOf(admin)
        expect([...ids.keys()].map((id) => brief.get(id)?.guidance)).toEqual(
          [...ids.keys()].map(() => reply().text),
        )
      })
    })
  })
}
